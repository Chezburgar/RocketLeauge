import type { Team } from '../physics/car';
import { copyInput, emptyInput, type CarInput } from '../physics/input';
import { DEFAULT_LOADOUT, type Loadout, type MatchEvent, type PlayerInfo } from '../game/types';
import { api } from './api';
import { PeerLink } from './peer';
import { decodeInputs, makeRoomCode } from './protocol';
import { Lobby, Signal, type RoomInfo } from './signal';

export interface RoomSettings {
  teamSize: 1 | 2 | 3;
  duration: number;
  botsFill: boolean;
  botSkill: number;
  isPublic: boolean;
  replays: boolean;
}

export interface RosterEntry {
  slot: number;
  name: string;
  team: Team;
  isBot: boolean;
  skill?: number;
  loadout: Loadout;
  peer?: string;
  accountId?: string;
}

interface Remote {
  link: PeerLink;
  slot: number;
  name: string;
  inputs: Map<number, CarInput>;
  last: CarInput;
  ready: boolean;
}

export const BOT_NAMES = ['Nova', 'Blitz', 'Rook', 'Vex', 'Juno', 'Ace', 'Spark', 'Echo', 'Drift', 'Comet', 'Bolt', 'Pixel'];

/** Host side of an online room: signalling, admission, rosters and input buffers. */
export class HostNet {
  readonly code = makeRoomCode();
  readonly peerId = 'host-' + Math.random().toString(36).slice(2, 10);
  signal: Signal;
  lobby: Lobby | null = null;
  settings: RoomSettings;
  roster: RosterEntry[] = [];
  remotes = new Map<string, Remote>();
  started = false;
  hostName: string;
  /** called when the roster changes during a running match (add/remove cars) */
  onRosterChange: ((roster: RosterEntry[]) => void) | null = null;
  onChat: ((slot: number, text: string) => void) | null = null;
  onLobbyUpdate: (() => void) | null = null;
  getTick: () => number = () => 0;
  /** snapshot of full match state for late joiners */
  getStartPayload: (() => unknown) | null = null;

  constructor(hostName: string, hostLoadout: Loadout, hostAccountId: string, settings: RoomSettings) {
    this.settings = settings;
    this.hostName = hostName;
    this.signal = new Signal(this.code, this.peerId);
    this.roster.push({ slot: 0, name: hostName, team: 0, isBot: false, loadout: hostLoadout, accountId: hostAccountId });
  }

  async open() {
    await this.signal.connect();
    this.signal.on((m) => {
      if (m.type === 'join') void this.handleJoin(m.from, m.data as { ticket: string; name: string; loadout: Loadout });
      if (m.type === 'discover') this.signal.send(m.from, 'room', this.roomInfo());
    });
    if (this.settings.isPublic) {
      this.lobby = new Lobby('host-' + this.code);
      try {
        await this.lobby.connect();
        await this.lobby.advertise(this.roomInfo());
      } catch (e) {
        console.warn('lobby advertise failed', e);
      }
    }
  }

  roomInfo(): RoomInfo {
    const humans = this.roster.filter((r) => !r.isBot).length;
    const ts = this.settings.teamSize;
    return { code: this.code, host: this.hostName, mode: `${ts}v${ts}`, players: humans, max: ts * 2, status: this.started ? 'playing' : 'lobby', ts: Date.now() };
  }

  private refreshAdvert() {
    if (this.lobby) void this.lobby.advertise(this.roomInfo());
  }

  private freeSlot(preferTeam?: Team): number {
    const ts = this.settings.teamSize;
    const count = (t: Team) => this.roster.filter((r) => r.team === t && !r.isBot).length;
    const teams: Team[] = preferTeam !== undefined ? [preferTeam, (1 - preferTeam) as Team] : count(0) <= count(1) ? [0, 1] : [1, 0];
    for (const team of teams) {
      const humans = count(team);
      if (humans >= ts) continue;
      const base = team === 0 ? 0 : 3;
      // prefer replacing a bot slot, else an empty slot
      for (let s = base; s < base + ts; s++) {
        const e = this.roster.find((r) => r.slot === s);
        if (!e || e.isBot) return s;
      }
    }
    return -1;
  }

  private async handleJoin(from: string, data: { ticket: string; name: string; loadout: Loadout }) {
    if (this.remotes.has(from)) return;
    let who: { id: string; name: string } | null = null;
    try {
      who = await api.verifyTicket(data.ticket);
    } catch {
      who = null;
    }
    if (!who) {
      this.signal.send(from, 'reject', { reason: 'Your account could not be verified.' });
      return;
    }
    if (this.roster.some((r) => r.accountId === who!.id && !r.isBot)) {
      this.signal.send(from, 'reject', { reason: 'You are already in this match.' });
      return;
    }
    const slot = this.freeSlot();
    if (slot < 0) {
      this.signal.send(from, 'reject', { reason: 'The match is full.' });
      return;
    }
    this.roster = this.roster.filter((r) => r.slot !== slot);
    const entry: RosterEntry = { slot, name: who.name, team: slot < 3 ? 0 : 1, isBot: false, loadout: sanitizeLoadout(data.loadout), peer: from, accountId: who.id };
    this.roster.push(entry);
    this.signal.send(from, 'accept', { slot });
    const link = new PeerLink(this.signal, from, true);
    const remote: Remote = { link, slot, name: who.name, inputs: new Map(), last: emptyInput(), ready: false };
    this.remotes.set(from, remote);
    link.onOpen = () => {
      remote.ready = true;
      link.sendR({ t: 'welcome', code: this.code, slot: remote.slot, settings: this.settings, roster: this.roster, started: this.started });
      if (this.started && this.getStartPayload) link.sendR({ t: 'start', slot: remote.slot, ...(this.getStartPayload() as object) });
      this.broadcastRoster();
    };
    link.onUnreliable = (buf) => {
      const d = decodeInputs(buf);
      if (!d) return;
      const first = d.lastTick - d.inputs.length + 1;
      d.inputs.forEach((inp, i) => remote.inputs.set(first + i, inp));
    };
    link.onReliable = (msg) => this.handleReliable(remote, msg);
    link.onClose = () => this.dropRemote(from);
    this.onRosterChange?.(this.roster);
    this.broadcastRoster();
    this.refreshAdvert();
    this.onLobbyUpdate?.();
  }

  private handleReliable(remote: Remote, msg: any) {
    switch (msg?.t) {
      case 'ping':
        remote.link.sendR({ t: 'pong', ts: msg.ts, tick: this.getTick() });
        break;
      case 'chat':
        if (typeof msg.text === 'string') this.onChat?.(remote.slot, msg.text.slice(0, 80));
        break;
      case 'team':
        if (!this.started) this.switchTeam(remote.slot, msg.team === 1 ? 1 : 0);
        break;
      case 'loadout': {
        const e = this.roster.find((r) => r.slot === remote.slot);
        if (e) {
          e.loadout = sanitizeLoadout(msg.loadout);
          this.onRosterChange?.(this.roster);
          this.broadcastRoster();
        }
        break;
      }
    }
  }

  switchTeam(slot: number, team: Team): number {
    const e = this.roster.find((r) => r.slot === slot);
    if (!e || e.team === team) return slot;
    const target = this.freeSlot(team);
    if (target < 0 || (target < 3 ? 0 : 1) !== team) return slot;
    this.roster = this.roster.filter((r) => r.slot !== target);
    e.slot = target;
    e.team = team;
    if (e.peer) {
      const rem = this.remotes.get(e.peer);
      if (rem) rem.slot = target;
    }
    this.broadcastRoster();
    this.onLobbyUpdate?.();
    return target;
  }

  private dropRemote(peer: string) {
    const r = this.remotes.get(peer);
    if (!r) return;
    this.remotes.delete(peer);
    const e = this.roster.find((x) => x.peer === peer);
    if (e) {
      if (this.started && this.settings.botsFill) {
        e.isBot = true;
        e.peer = undefined;
        e.accountId = undefined;
        e.name = BOT_NAMES[e.slot % BOT_NAMES.length];
        e.skill = this.settings.botSkill;
      } else this.roster = this.roster.filter((x) => x !== e);
    }
    this.onRosterChange?.(this.roster);
    this.broadcastRoster();
    this.refreshAdvert();
    this.onLobbyUpdate?.();
  }

  /** Fill empty slots with bots (called at match start). */
  fillBots() {
    if (!this.settings.botsFill) return;
    const ts = this.settings.teamSize;
    let n = 0;
    for (const team of [0, 1] as Team[]) {
      const base = team === 0 ? 0 : 3;
      for (let s = base; s < base + ts; s++) {
        if (this.roster.some((r) => r.slot === s)) continue;
        this.roster.push({ slot: s, name: BOT_NAMES[(s + n++) % BOT_NAMES.length], team, isBot: true, skill: this.settings.botSkill, loadout: botLoadout(s) });
      }
    }
  }

  startMatch() {
    this.started = true;
    this.fillBots();
    this.refreshAdvert();
  }

  broadcastRoster() {
    this.broadcastR({ t: 'roster', roster: this.roster, settings: this.settings, started: this.started });
  }

  broadcastR(msg: unknown) {
    for (const r of this.remotes.values()) if (r.ready) r.link.sendR(msg);
  }

  broadcastU(buf: ArrayBuffer) {
    for (const r of this.remotes.values()) if (r.ready) r.link.sendU(buf);
  }

  sendEvent(e: MatchEvent) {
    this.broadcastR({ t: 'ev', e });
  }

  sendStats(players: (PlayerInfo | null)[]) {
    const stats = players.filter(Boolean).map((p) => ({ slot: p!.slot, stats: p!.stats }));
    this.broadcastR({ t: 'stats', stats });
  }

  /** Input used for a remote-controlled slot at a given tick. */
  inputFor(slot: number, tick: number): CarInput | null {
    for (const r of this.remotes.values()) {
      if (r.slot !== slot) continue;
      const inp = r.inputs.get(tick);
      if (inp) {
        copyInput(inp, r.last);
      }
      // forget old inputs
      if (r.inputs.size > 240) for (const k of r.inputs.keys()) if (k < tick - 60) r.inputs.delete(k);
      return r.last;
    }
    return null;
  }

  isRemoteSlot(slot: number) {
    for (const r of this.remotes.values()) if (r.slot === slot) return true;
    return false;
  }

  close() {
    for (const r of this.remotes.values()) {
      r.link.sendR({ t: 'closed' });
      r.link.close();
    }
    this.remotes.clear();
    void this.lobby?.advertise(null);
    this.lobby?.close();
    this.signal.close();
  }
}

export function sanitizeLoadout(l: unknown): Loadout {
  const o = (l && typeof l === 'object' ? l : {}) as Partial<Loadout>;
  const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
  return {
    body: pick(o.body, ['breaker', 'wedge', 'titan', 'viper'] as const, DEFAULT_LOADOUT.body),
    accent: typeof o.accent === 'number' ? o.accent & 0xffffff : DEFAULT_LOADOUT.accent,
    shade: typeof o.shade === 'number' ? Math.abs(Math.floor(o.shade)) % 4 : 0,
    wheels: pick(o.wheels, ['classic', 'spoke', 'turbine', 'neon', 'star'] as const, DEFAULT_LOADOUT.wheels),
    boost: pick(o.boost, ['flame', 'neon', 'plasma', 'sparkle', 'bubbles', 'lightning', 'rainbow'] as const, DEFAULT_LOADOUT.boost),
    explosion: pick(o.explosion, ['classic', 'fireworks', 'singularity', 'electro', 'confetti', 'voxel', 'shockwave', 'inferno'] as const, DEFAULT_LOADOUT.explosion),
    anthem: typeof o.anthem === 'string' ? o.anthem.slice(0, 80) : DEFAULT_LOADOUT.anthem,
    topper: pick(o.topper, ['none', 'cone', 'crown', 'halo', 'antenna', 'horns'] as const, 'none'),
  };
}

export function botLoadout(seed: number): Loadout {
  const bodies = ['breaker', 'wedge', 'titan', 'viper'] as const;
  const wheels = ['classic', 'spoke', 'turbine', 'neon', 'star'] as const;
  const boosts = ['flame', 'neon', 'plasma', 'sparkle', 'lightning'] as const;
  const exps = ['classic', 'fireworks', 'voxel', 'shockwave', 'electro'] as const;
  const accents = [0xdedede, 0x222222, 0xffd23b, 0x3bff8a, 0xff3b6b, 0x9a4bff];
  return {
    body: bodies[seed % bodies.length],
    accent: accents[(seed * 7) % accents.length],
    shade: seed % 4,
    wheels: wheels[(seed * 3) % wheels.length],
    boost: boosts[(seed * 5) % boosts.length],
    explosion: exps[(seed * 2) % exps.length],
    anthem: 'none',
    topper: 'none',
  };
}
