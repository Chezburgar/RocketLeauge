import { Quaternion, Vector3 } from 'three';
import { DT } from '../physics/constants';
import { copyInput, emptyInput, quantizeInput, type CarInput } from '../physics/input';
import { MAX_CARS, World, type WorldEvent } from '../physics/world';
import { captureFrame, copyFrame, lerpFrame, newFrame, ReplayBuffer, type Frame } from '../render/frame';
import { Bot } from './bot';
import { Match, PHASE_IDS, type MatchSettings } from './match';
import { emptyStats, type MatchEvent, type Phase, type PlayerInfo } from './types';
import type { HostNet, RosterEntry, RoomSettings } from '../net/host';
import type { PeerLink } from '../net/peer';
import { decodeSnapshot, encodeInputs, encodeSnapshot } from '../net/protocol';

export interface GameSession {
  readonly kind: 'offline' | 'host' | 'client';
  localSlot: number;
  players: (PlayerInfo | null)[];
  readonly phase: Phase;
  readonly phaseTime: number;
  readonly clock: number;
  readonly overtime: boolean;
  readonly scores: [number, number];
  readonly settings: MatchSettings;
  readonly world: World;
  lastGoal: Extract<MatchEvent, { type: 'goal' }> | null;
  winner: number;
  mvp: number;
  /** Frames recorded for the most recent goal replay. */
  replayFrames: Frame[] | null;
  update(dt: number, input: CarInput): void;
  renderFrame(): Frame;
  drain(): { world: WorldEvent[]; match: MatchEvent[] };
  skipReplay(): void;
  chat(text: string): void;
  rematch(): void;
  canRematch(): boolean;
  pingMs(): number;
  dispose(): void;
}

const REPLAY_SECONDS = 6;

/** Offline games and online hosts: the authoritative simulation. */
export class LocalSession implements GameSession {
  readonly kind: 'offline' | 'host';
  readonly match: Match;
  localSlot: number;
  bots = new Map<number, Bot>();
  private acc = 0;
  private prev = newFrame();
  private cur = newFrame();
  private out = newFrame();
  private replay = new ReplayBuffer(Math.round(REPLAY_SECONDS * 30) + 10);
  replayFrames: Frame[] | null = null;
  private localInput = emptyInput();
  private lastInputs: (CarInput | null)[] = new Array(MAX_CARS).fill(null);
  private matchEvents: MatchEvent[] = [];
  private statsTimer = 0;
  private net: HostNet | null;

  constructor(match: Match, localSlot: number, net: HostNet | null = null) {
    this.match = match;
    this.localSlot = localSlot;
    this.net = net;
    this.kind = net ? 'host' : 'offline';
    for (const p of match.players) if (p?.isBot) this.bots.set(p.slot, new Bot(p.slot, p.skill ?? 0.6));
    captureFrame(match.world, this.cur);
    copyFrame(this.cur, this.prev);
    if (net) {
      net.getTick = () => this.match.world.tick;
      net.getStartPayload = () => this.startPayload();
      net.onChat = (slot, text) => {
        const e: MatchEvent = { type: 'chat', slot, text };
        this.matchEvents.push(e);
        net.sendEvent(e);
      };
      net.onRosterChange = (roster) => this.applyRoster(roster);
    }
  }

  get world() {
    return this.match.world;
  }
  get players() {
    return this.match.players;
  }
  get phase() {
    return this.match.phase;
  }
  get phaseTime() {
    return this.match.phaseTime;
  }
  get clock() {
    return this.match.clock;
  }
  get overtime() {
    return this.match.overtime;
  }
  get scores() {
    return this.match.scores;
  }
  get settings() {
    return this.match.settings;
  }
  get lastGoal() {
    return this.match.lastGoal;
  }
  get winner() {
    return this.match.winner;
  }
  get mvp() {
    return this.match.mvp;
  }

  startPayload() {
    return {
      settings: this.match.settings,
      players: this.match.players,
      state: Array.from(this.match.world.serialize()),
      scores: this.match.scores,
    };
  }

  /** Roster changed while playing (someone joined / left). */
  private applyRoster(roster: RosterEntry[]) {
    const m = this.match;
    for (let s = 0; s < MAX_CARS; s++) {
      const e = roster.find((r) => r.slot === s);
      const p = m.players[s];
      if (!e) {
        if (p) {
          m.removePlayer(s);
          this.bots.delete(s);
        }
        continue;
      }
      if (!p) {
        m.addPlayer({ slot: s, name: e.name, team: e.team, isBot: e.isBot, skill: e.skill, loadout: e.loadout, stats: emptyStats(), accountId: e.accountId });
      } else {
        p.name = e.name;
        p.isBot = e.isBot;
        p.loadout = e.loadout;
        p.accountId = e.accountId;
      }
      if (e.isBot && !this.bots.has(s)) this.bots.set(s, new Bot(s, e.skill ?? 0.6));
      if (!e.isBot) this.bots.delete(s);
    }
  }

  update(dt: number, input: CarInput) {
    copyInput(input, this.localInput);
    if (this.net) quantizeInput(this.localInput);
    this.acc += Math.min(dt, 0.25);
    const m = this.match;
    while (this.acc >= DT) {
      this.acc -= DT;
      copyFrame(this.cur, this.prev);
      const inputs: (CarInput | null)[] = [];
      const nextTick = m.world.tick + 1;
      for (let s = 0; s < MAX_CARS; s++) {
        if (!m.players[s]) {
          inputs.push(null);
          continue;
        }
        let inp: CarInput | null = null;
        if (s === this.localSlot) inp = this.localInput;
        else if (this.bots.has(s)) inp = this.bots.get(s)!.update(m.world);
        else if (this.net) inp = this.net.inputFor(s, nextTick);
        inputs.push(inp);
        this.lastInputs[s] = inp;
      }
      if (m.phase === 'replay' || m.phase === 'ended') {
        // hold the world still while the replay plays / after the match
        m.tick(new Array(MAX_CARS).fill(null));
      } else m.tick(inputs);
      captureFrame(m.world, this.cur);
      if (m.world.tick % 4 === 0 && m.phase !== 'replay') this.replay.pushFrame(this.cur);
      for (const e of m.events) {
        if (e.type === 'goal') {
          // keep ~1.5 s after the goal in the buffer before cutting the replay
          this.replayFrames = null;
          this.goalFrames = null;
          this.pendingReplayCut = 180;
        }
        if (e.type === 'replay') this.replayFrames = this.goalFrames ?? this.replay.snapshot(Math.round(REPLAY_SECONDS * 30));
        if (e.type === 'kickoff') this.replayFrames = null;
        this.matchEvents.push(e);
        this.net?.sendEvent(e);
      }
      if (this.pendingReplayCut > 0 && --this.pendingReplayCut === 0) this.goalFrames = this.replay.snapshot(Math.round(REPLAY_SECONDS * 30));
      m.events.length = 0;
      if (this.net && m.world.tick % 4 === 0) {
        const h = { tick: m.world.tick, phase: PHASE_IDS.indexOf(m.phase), phaseTime: m.phaseTime, clock: m.clock, overtime: m.overtime, scores: m.scores };
        this.net.broadcastU(encodeSnapshot(h, m.world, this.lastInputs));
      }
    }
    if (this.net) {
      this.statsTimer -= dt;
      if (this.statsTimer <= 0) {
        this.statsTimer = 1.5;
        this.net.sendStats(m.players);
      }
    }
  }
  private pendingReplayCut = 0;
  private goalFrames: Frame[] | null = null;

  renderFrame(): Frame {
    lerpFrame(this.prev, this.cur, this.acc / DT, this.out);
    return this.out;
  }

  drain() {
    const world = this.match.worldEvents.splice(0);
    const match = this.matchEvents.splice(0);
    return { world, match };
  }

  skipReplay() {
    this.match.skipReplay();
  }

  chat(text: string) {
    const e: MatchEvent = { type: 'chat', slot: this.localSlot, text: text.slice(0, 80) };
    this.matchEvents.push(e);
    this.net?.sendEvent(e);
  }

  canRematch() {
    return true;
  }

  rematch() {
    this.replayFrames = null;
    this.goalFrames = null;
    this.match.restart();
    this.net?.sendEvent({ type: 'kickoff' });
  }

  pingMs() {
    return 0;
  }

  dispose() {
    this.net?.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

interface StartPayload {
  slot: number;
  settings: MatchSettings;
  players: (PlayerInfo | null)[];
  state: number[];
  scores: [number, number];
}

/** Online client: predicts locally, rolls back to host snapshots, re-simulates. */
export class ClientSession implements GameSession {
  readonly kind = 'client' as const;
  localSlot: number;
  players: (PlayerInfo | null)[];
  world = new World();
  phase: Phase = 'countdown';
  phaseTime = 3;
  clock = 300;
  overtime = false;
  scores: [number, number] = [0, 0];
  settings: MatchSettings;
  lastGoal: Extract<MatchEvent, { type: 'goal' }> | null = null;
  winner = -1;
  mvp = -1;
  replayFrames: Frame[] | null = null;
  private link: PeerLink;
  private history = new Map<number, CarInput>();
  private others: CarInput[] = [];
  private acc = 0;
  private prev = newFrame();
  private cur = newFrame();
  private out = newFrame();
  private replay = new ReplayBuffer(Math.round(REPLAY_SECONDS * 30) + 10);
  private matchEvents: MatchEvent[] = [];
  private worldEvents: WorldEvent[] = [];
  private pendingSnap: ReturnType<typeof decodeSnapshot> = null;
  private lastSnapTick = -1;
  private snapRecvTime = 0;
  private hostTickAtRecv = 0;
  private rtt = 0.1;
  private pingTimer = 0;
  private offsets: { pos: Vector3; quat: Quaternion }[] = [];
  private ballOffset = new Vector3();
  private sendCounter = 0;
  private started = false;
  private pendingReplayCut = 0;
  private goalFrames: Frame[] | null = null;
  onClosed: ((reason: string) => void) | null = null;
  onRoster: ((roster: RosterEntry[], settings: RoomSettings) => void) | null = null;

  constructor(link: PeerLink, start: StartPayload) {
    this.link = link;
    this.localSlot = start.slot;
    this.settings = start.settings;
    this.players = start.players.map((p) => (p ? { ...p } : null));
    this.scores = start.scores;
    this.world.deserialize(new Float32Array(start.state));
    for (let i = 0; i < MAX_CARS; i++) {
      this.others.push(emptyInput());
      this.offsets.push({ pos: new Vector3(), quat: new Quaternion() });
    }
    captureFrame(this.world, this.cur);
    copyFrame(this.cur, this.prev);
    this.started = true;
    link.onUnreliable = (buf) => {
      const s = decodeSnapshot(buf);
      if (s && s.header.tick > this.lastSnapTick) {
        this.pendingSnap = s;
        this.snapRecvTime = performance.now();
        this.hostTickAtRecv = s.header.tick;
      }
    };
    link.onReliable = (msg) => this.onReliable(msg);
    link.onClose = () => this.onClosed?.('The host ended the match.');
  }

  private onReliable(msg: any) {
    switch (msg?.t) {
      case 'ev': {
        const e = msg.e as MatchEvent;
        if (e.type === 'goal') {
          this.lastGoal = e;
          this.pendingReplayCut = 180;
          this.replayFrames = null;
          this.goalFrames = null;
        }
        if (e.type === 'replay') this.replayFrames = this.goalFrames ?? this.replay.snapshot(Math.round(REPLAY_SECONDS * 30));
        if (e.type === 'end') {
          this.winner = e.winner;
          this.mvp = e.mvp;
        }
        if (e.type === 'kickoff') {
          this.replayFrames = null;
          this.goalFrames = null;
        }
        this.matchEvents.push(e);
        break;
      }
      case 'stats':
        for (const s of msg.stats as { slot: number; stats: PlayerInfo['stats'] }[]) {
          const p = this.players[s.slot];
          if (p) p.stats = s.stats;
        }
        break;
      case 'roster': {
        const roster = msg.roster as RosterEntry[];
        for (let s = 0; s < MAX_CARS; s++) {
          const e = roster.find((r) => r.slot === s);
          if (!e) {
            this.players[s] = null;
            continue;
          }
          const p = this.players[s];
          if (p) {
            p.name = e.name;
            p.isBot = e.isBot;
            p.loadout = e.loadout;
            p.team = e.team;
          } else this.players[s] = { slot: s, name: e.name, team: e.team, isBot: e.isBot, loadout: e.loadout, stats: emptyStats() };
        }
        this.onRoster?.(roster, msg.settings);
        break;
      }
      case 'pong': {
        const rtt = (performance.now() - msg.ts) / 1000;
        this.rtt = this.rtt * 0.7 + rtt * 0.3;
        break;
      }
      case 'closed':
        this.onClosed?.('The host ended the match.');
        break;
    }
  }

  private estimatedHostTick() {
    return this.hostTickAtRecv + ((performance.now() - this.snapRecvTime) / 1000 + this.rtt / 2) / DT;
  }

  private rollback() {
    const s = this.pendingSnap;
    this.pendingSnap = null;
    if (!s) return;
    this.lastSnapTick = s.header.tick;
    const h = s.header;
    this.phase = PHASE_IDS[h.phase] ?? 'playing';
    this.phaseTime = h.phaseTime;
    this.clock = h.clock;
    this.overtime = h.overtime;
    this.scores = h.scores;
    // remember where things were drawn
    const w = this.world;
    const oldPos: (Vector3 | null)[] = [];
    const oldQuat: (Quaternion | null)[] = [];
    for (let i = 0; i < MAX_CARS; i++) {
      const c = w.cars[i];
      oldPos.push(c && !c.demolished ? c.pos.clone() : null);
      oldQuat.push(c && !c.demolished ? c.quat.clone() : null);
    }
    const oldBall = w.ball.pos.clone();
    const localTick = w.tick;
    w.deserialize(s.state);
    for (let i = 0; i < MAX_CARS; i++) copyInput(s.inputs[i], this.others[i]);
    if (w.tick > localTick || localTick - w.tick > 90) {
      // we fell behind the host (or way ahead) – just take the snapshot
    } else {
      w.muteEvents = true;
      const inputs: (CarInput | null)[] = [];
      for (let t = w.tick + 1; t <= localTick; t++) {
        for (let i = 0; i < MAX_CARS; i++) inputs[i] = i === this.localSlot ? this.history.get(t) ?? this.others[i] : this.others[i];
        if (this.phase === 'replay' || this.phase === 'ended') w.step(new Array(MAX_CARS).fill(null));
        else w.step(inputs);
      }
      w.events.length = 0;
      w.muteEvents = false;
    }
    // smooth out the correction visually
    for (let i = 0; i < MAX_CARS; i++) {
      const c = w.cars[i];
      const op = oldPos[i];
      const oq = oldQuat[i];
      const off = this.offsets[i];
      if (!c || c.demolished || !op || !oq) {
        off.pos.set(0, 0, 0);
        off.quat.identity();
        continue;
      }
      const d = new Vector3().subVectors(op, c.pos);
      if (d.length() > 4) {
        off.pos.set(0, 0, 0);
        off.quat.identity();
        continue;
      }
      off.pos.add(d);
      // rotation offset: oldQuat * inverse(newQuat)
      const q = oq.clone().multiply(c.quat.clone().invert());
      off.quat.premultiply(q);
    }
    const bd = oldBall.sub(w.ball.pos);
    if (bd.length() < 4) this.ballOffset.add(bd);
    else this.ballOffset.set(0, 0, 0);
    captureFrame(w, this.cur);
    copyFrame(this.cur, this.prev);
  }

  update(dt: number, input: CarInput) {
    if (!this.started) return;
    this.rollback();
    // clock sync: stay ahead of the host by half a round trip + a small buffer
    const lead = Math.ceil(this.rtt / 2 / DT) + 4;
    const target = this.estimatedHostTick() + lead;
    const w = this.world;
    this.acc += Math.min(dt, 0.25);
    let steps = Math.floor(this.acc / DT);
    this.acc -= steps * DT;
    const diff = target - (w.tick + steps);
    if (diff > 30 || diff < -30) steps = Math.max(0, steps + Math.round(diff)); // big correction
    else if (diff > 3) steps += 1;
    else if (diff < -3) steps = Math.max(0, steps - 1);
    steps = Math.min(steps, 40);
    const mine = quantizeInput(copyInput(input));
    for (let k = 0; k < steps; k++) {
      copyFrame(this.cur, this.prev);
      const t = w.tick + 1;
      this.history.set(t, copyInput(mine));
      this.history.delete(t - 200);
      const inputs: (CarInput | null)[] = [];
      for (let i = 0; i < MAX_CARS; i++) inputs[i] = i === this.localSlot ? mine : this.others[i];
      if (this.phase === 'replay' || this.phase === 'ended') w.step(new Array(MAX_CARS).fill(null));
      else w.step(inputs);
      for (const e of w.events) if (e.type !== 'goal' && e.type !== 'demo') this.worldEvents.push(e);
      w.events.length = 0;
      captureFrame(w, this.cur);
      if (w.tick % 4 === 0 && this.phase !== 'replay') this.replay.pushFrame(this.cur);
      if (this.pendingReplayCut > 0 && --this.pendingReplayCut === 0) this.goalFrames = this.replay.snapshot(Math.round(REPLAY_SECONDS * 30));
      // send our recent inputs (redundant copies cover packet loss)
      if (++this.sendCounter % 2 === 0) {
        const list: CarInput[] = [];
        for (let tt = t - 7; tt <= t; tt++) list.push(this.history.get(tt) ?? mine);
        this.link.sendU(encodeInputs(t, list), 45);
      }
    }
    // decay smoothing offsets
    const k = Math.exp(-dt * 10);
    for (const o of this.offsets) {
      o.pos.multiplyScalar(k);
      o.quat.slerp(new Quaternion(), 1 - k);
    }
    this.ballOffset.multiplyScalar(Math.exp(-dt * 12));
    this.pingTimer -= dt;
    if (this.pingTimer <= 0) {
      this.pingTimer = 1;
      this.link.sendR({ t: 'ping', ts: performance.now() });
    }
  }

  renderFrame(): Frame {
    lerpFrame(this.prev, this.cur, this.acc / DT, this.out);
    for (let i = 0; i < MAX_CARS; i++) {
      const c = this.out.cars[i];
      if (!c.present) continue;
      c.pos.add(this.offsets[i].pos);
      c.quat.premultiply(this.offsets[i].quat);
    }
    this.out.ballPos.add(this.ballOffset);
    return this.out;
  }

  drain() {
    return { world: this.worldEvents.splice(0), match: this.matchEvents.splice(0) };
  }

  skipReplay() {
    /* only the host can skip online */
  }

  chat(text: string) {
    this.link.sendR({ t: 'chat', text: text.slice(0, 80) });
  }

  canRematch() {
    return false;
  }

  rematch() {}

  pingMs() {
    return Math.round(this.rtt * 1000);
  }

  dispose() {
    this.link.close();
  }
}
