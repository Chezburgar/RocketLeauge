import './ui/styles.css';
import * as THREE from 'three';
import { audio, type Track } from './audio/audio';
import { anthemById, setCustomAnthems } from './audio/anthems';
import { GAME_NAME } from './config';
import { Controls, KEY_HELP, PAD_HELP } from './game/controls';
import { Match } from './game/match';
import { ClientSession, LocalSession, type GameSession } from './game/session';
import { loadLoadout, loadSettings, saveLoadoutLocal, saveSettings, type Settings } from './game/settings';
import { emptyStats, TEAM_COLORS, type Loadout, type MatchEvent, type PlayerInfo } from './game/types';
import { api, publicUrl, type Account } from './net/api';
import { formatBackupCode, getDeviceKey, setDeviceKey } from './net/device';
import { BOT_NAMES, botLoadout, HostNet, sanitizeLoadout, type RoomSettings, type RosterEntry } from './net/host';
import { PeerLink } from './net/peer';
import { Lobby, Signal, type RoomInfo } from './net/signal';
import { BALL_RADIUS, DT } from './physics/constants';
import { emptyInput } from './physics/input';
import type { WorldEvent } from './physics/world';
import { World } from './physics/world';
import { crowdCheer } from './render/arena';
import { captureFrame, copyFrame, lerpFrame, newFrame, type Frame } from './render/frame';
import { GameView } from './render/view';
import { AdminPanel } from './ui/admin';
import { btn, clear, h, logoSvg, seg, slider, toast } from './ui/dom';
import { buildGarage } from './ui/garage';
import { Hud, QUICK_CHAT } from './ui/hud';

const ACCOUNT_CACHE = 'bl.account';

class App {
  view: GameView;
  hud: Hud;
  controls = new Controls();
  ui = document.getElementById('ui')!;
  settings: Settings = loadSettings();
  loadout: Loadout = loadLoadout();
  account: Account | null = null;
  offlineOnly = false;
  session: GameSession | null = null;
  state: 'title' | 'gate' | 'menu' | 'game' = 'title';
  private menuWorld = new World();
  private menuFrame = newFrame();
  private previewTeam = 0;
  private last = performance.now();
  private paused = false;
  private pauseEl: HTMLElement | null = null;
  private postEl: HTMLElement | null = null;
  private replayT = 0;
  private replayFrame = newFrame();
  private replayBallWasVisible = true;
  private hostNet: HostNet | null = null;
  private clientSignal: Signal | null = null;
  private clientLink: PeerLink | null = null;
  private roomEl: HTMLElement | null = null;
  private roomRoster: RosterEntry[] = [];
  private roomSettings: RoomSettings | null = null;
  private roomCode = '';
  private browseLobby: Lobby | null = null;
  private pollTimer: number | null = null;
  private matchEnded = false;
  private statsSaved = false;
  private goalCamTimer = 0;
  private inputBuf = emptyInput();

  constructor() {
    const canvas = document.getElementById('gl') as HTMLCanvasElement;
    this.view = new GameView(canvas, this.settings.quality);
    this.applySettings();
    this.hud = new Hud(document.getElementById('hud')!);
    // showcase car for menus
    const car = this.menuWorld.addCar(0, 0);
    car.reset(0, 0, Math.PI * 0.8);
    this.menuWorld.ball.reset(4.5, BALL_RADIUS, 3);
    this.menuWorld.frozen = false;
    for (let i = 0; i < 90; i++) this.menuWorld.step([]);
    this.view.setCar(0, this.loadout, 0);
    this.controls.onAction = (a) => this.onAction(a);
    audio.music.onTrackChange = () => this.renderNowPlaying();
    requestAnimationFrame((t) => this.loop(t));
    this.showTitle();
    void this.loadContent();
  }

  // ── content ──────────────────────────────────────────────────────────────
  async loadContent() {
    try {
      const c = await api.publicContent();
      setCustomAnthems(c.anthems ?? []);
      if (c.menu && c.menu.songs.length) {
        const tracks: Track[] = c.menu.songs.map((s) => ({ id: s.id, title: s.title, artist: s.artist, url: publicUrl(s.path), duration: s.duration ?? undefined }));
        audio.music.setPlaylist(c.menu.playlist.name, tracks, c.menu.playlist.mode, new Date(c.menu.epoch).getTime());
      } else audio.music.setPlaylist('', [], 'order', 0);
    } catch (e) {
      console.warn('content load failed', e);
    }
  }

  applySettings() {
    const s = this.settings;
    this.view.camSettings = { ...s.camera };
    this.view.ballCam = s.ballCam;
    audio.volumes = { ...s.volumes };
    audio.applyVolumes();
    if (this.hud) {
      this.hud.showFps = s.showFps;
      this.hud.showPlates = s.nameplates;
    }
    if (this.view.quality !== s.quality) this.view.setQuality(s.quality);
  }

  // ── main loop ────────────────────────────────────────────────────────────
  private loop(t: number) {
    requestAnimationFrame((tt) => this.loop(tt));
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    this.controls.pollActions();
    const s = this.session;
    let frame: Frame;
    let replaying = false;
    if (s && this.state === 'game') {
      const typing = this.hud.chatOpen || (this.paused && s.kind === 'offline');
      this.controls.enabled = !typing && !this.paused;
      const input = this.controls.sample(this.inputBuf);
      if (!(this.paused && s.kind === 'offline')) s.update(dt, input);
      const { world, match } = s.drain();
      for (const e of world) this.onWorldEvent(e, s);
      for (const e of match) this.onMatchEvent(e, s);
      this.view.setPadStates(s.world.pads.map((p) => p.timer));
      replaying = s.phase === 'replay' && !!s.replayFrames && s.replayFrames.length > 2;
      if (replaying) frame = this.replayStep(s, dt);
      else {
        frame = s.renderFrame();
        this.view.ballHidden = s.phase === 'goal' || (s.phase === 'freeplay' && s.world.goalScored);
      }
      // camera mode
      if (replaying) this.view.setCamMode('replay');
      else if (s.phase === 'ended') this.view.setCamMode('goal');
      else this.view.setCamMode('car');
      this.view.focusSlot = s.localSlot;
      // engine sound
      const me = frame.cars[s.localSlot];
      if (me?.present && !me.demolished && !replaying && s.phase !== 'ended') {
        audio.updateEngine(me.vel.length(), input.throttle, me.boosting, me.onGround, true);
      } else audio.updateEngine(0, 0, false, true, false);
      this.hud.update(dt, s, frame, this.view, replaying);
    } else {
      this.controls.enabled = false;
      const car = this.menuWorld.cars[0]!;
      car.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI * 0.8 - Math.PI / 2);
      captureFrame(this.menuWorld, this.menuFrame);
      frame = this.menuFrame;
      this.view.ballHidden = this.state !== 'title' && this.state !== 'gate';
    }
    this.view.applyFrame(frame, dt, true);
    this.view.updateCamera(frame, dt);
    this.view.render();
  }

  private replayStep(s: GameSession, dt: number): Frame {
    const frames = s.replayFrames!;
    this.replayT += dt * 30;
    const i = Math.min(frames.length - 2, Math.floor(this.replayT));
    const a = frames[i];
    const b = frames[i + 1];
    lerpFrame(a, b, Math.min(1, this.replayT - i), this.replayFrame);
    this.view.ballHidden = false;
    // re-fire the goal explosion when the ball disappears in the replay
    if (this.replayBallWasVisible && !this.replayFrame.ballVisible && s.lastGoal) this.fireGoalExplosion(s, s.lastGoal, a.ballPos);
    this.replayBallWasVisible = this.replayFrame.ballVisible;
    if (!this.replayFrame.ballVisible && b.ballVisible === false) this.replayFrame.ballPos.copy(a.ballPos);
    return this.replayFrame;
  }

  // ── input actions ────────────────────────────────────────────────────────
  private onAction(a: string) {
    if (a === 'any') {
      audio.unlock();
      if (this.state === 'title') {
        audio.music.start();
        void this.enterGate();
      }
      return;
    }
    if (this.state !== 'game' || !this.session) return;
    const s = this.session;
    if (this.hud.chatOpen) return;
    switch (a) {
      case 'ballcam':
        this.view.ballCam = !this.view.ballCam;
        break;
      case 'pause':
        if (this.postEl) break;
        this.togglePause();
        break;
      case 'scoreboard':
        this.hud.setScoreboard(true);
        break;
      case 'scoreboardUp':
        this.hud.setScoreboard(false);
        break;
      case 'chat':
        this.hud.openChat((t) => s.chat(t), () => {});
        break;
      case 'quick1':
      case 'quick2':
      case 'quick3':
      case 'quick4':
        s.chat(QUICK_CHAT[Number(a.slice(-1)) - 1]);
        break;
      case 'skip':
        if (s.phase === 'replay') s.skipReplay();
        break;
    }
  }

  // ── events → sound / effects / hud ──────────────────────────────────────
  private onWorldEvent(e: WorldEvent, s: GameSession) {
    const me = s.world.cars[s.localSlot];
    const dist = (x: number, y: number, z: number) => (me ? Math.hypot(me.pos.x - x, me.pos.y - y, me.pos.z - z) : 20);
    switch (e.type) {
      case 'touch': {
        audio.ballHit(e.strength, dist(e.x, e.y, e.z));
        const team = s.world.cars[e.car]?.team ?? 0;
        this.view.effects.ballHit(new THREE.Vector3(e.x, e.y, e.z), e.strength, new THREE.Color(TEAM_COLORS[team]));
        if (e.strength > 25) audio.cheer(0.3, 1.2);
        break;
      }
      case 'ballBounce': {
        const b = s.world.ball.pos;
        audio.bounce(e.strength, dist(b.x, b.y, b.z));
        break;
      }
      case 'jump':
        if (e.car === s.localSlot) audio.jump();
        break;
      case 'flip':
        if (e.car === s.localSlot) audio.flip();
        break;
      case 'pad': {
        const p = s.world.pads[e.pad];
        if (e.car === s.localSlot) audio.pad(e.big);
        if (p) this.view.effects.padPickup(new THREE.Vector3(p.x, 0.3, p.z), e.big);
        break;
      }
      case 'bump':
        if (e.attacker === s.localSlot || e.victim === s.localSlot) audio.bump(e.strength);
        break;
      case 'demo':
        // clients get demolitions from the host as match events
        break;
    }
  }

  private fireGoalExplosion(s: GameSession, g: Extract<MatchEvent, { type: 'goal' }>, pos?: THREE.Vector3) {
    const scorer = g.scorer >= 0 ? s.players[g.scorer] : null;
    const explosion = scorer && !g.ownGoal ? scorer.loadout.explosion : 'classic';
    const accent = new THREE.Color(scorer?.loadout.accent ?? 0xffffff);
    const p = pos ? pos.clone() : new THREE.Vector3(g.x, g.y, g.z);
    this.view.effects.goalExplosion(explosion, p, new THREE.Color(TEAM_COLORS[g.team]), accent);
  }

  private onMatchEvent(e: MatchEvent, s: GameSession) {
    this.hud.onEvent(e, s);
    switch (e.type) {
      case 'countdown':
        audio.countdown(e.n);
        break;
      case 'go':
        audio.go();
        break;
      case 'lastSeconds':
        if (e.n <= 3) audio.countdown(e.n);
        break;
      case 'goal': {
        this.fireGoalExplosion(s, e);
        this.view.goalFocus.set(e.x, e.y, e.z);
        audio.horn();
        audio.cheer(1, 4);
        crowdCheer.value = performance.now() / 1000 + 4;
        const scorer = e.scorer >= 0 && !e.ownGoal ? s.players[e.scorer] : null;
        const anthem = anthemById(scorer?.loadout.anthem);
        if (anthem) void audio.playAnthem(anthem.url, 10);
        this.replayT = 0;
        this.replayBallWasVisible = true;
        break;
      }
      case 'replay':
        this.replayT = 0;
        this.replayBallWasVisible = true;
        break;
      case 'kickoff':
        this.view.ballHidden = false;
        this.view.effects.clear();
        if (this.postEl) {
          this.postEl.remove();
          this.postEl = null;
          this.matchEnded = false;
          this.statsSaved = false;
        }
        break;
      case 'save':
        audio.cheer(0.6, 2);
        break;
      case 'demo':
        this.view.effects.demolition(new THREE.Vector3(e.x, e.y, e.z), new THREE.Color(TEAM_COLORS[s.players[e.victim]?.team ?? 0]));
        audio.demo();
        break;
      case 'overtime':
        audio.cheer(0.7, 2.5);
        break;
      case 'end':
        this.matchEnded = true;
        audio.cheer(1, 5);
        setTimeout(() => this.showPost(s), 1800);
        void this.saveStats(s, e.winner, e.mvp);
        break;
    }
  }

  private async saveStats(s: GameSession, winner: number, mvp: number) {
    if (this.statsSaved || s.settings.freeplay || !this.account || this.offlineOnly) return;
    this.statsSaved = true;
    const p = s.players[s.localSlot];
    if (!p) return;
    try {
      const stats = await api.addStats({
        games: 1,
        wins: p.team === winner ? 1 : 0,
        goals: p.stats.goals,
        assists: p.stats.assists,
        saves: p.stats.saves,
        shots: p.stats.shots,
        mvps: mvp === s.localSlot ? 1 : 0,
        demos: p.stats.demos,
      });
      this.account.stats = stats;
      this.cacheAccount();
    } catch (err) {
      console.warn('stats save failed', err);
    }
  }

  // ── screens ──────────────────────────────────────────────────────────────
  private show(el: HTMLElement) {
    clear(this.ui);
    this.ui.appendChild(el);
  }

  showTitle() {
    this.state = 'title';
    this.view.setCamMode('title');
    const el = h('div', { id: 'title', class: 'screen vignette', onClick: () => this.onAction('any') },
      h('div', { class: 'logo' }, logoSvg(150), h('div', { class: 'word' }, h('span', null, GAME_NAME.split(' ')[0]), h('span', { class: 'l2' }, GAME_NAME.split(' ').slice(1).join(' ') || ''))),
      h('div', { class: 'press' }, 'PRESS ANY BUTTON TO START'),
      h('div', { class: 'title-foot' }, 'Keyboard, mouse & gamepad supported · Best with headphones'),
    );
    this.show(el);
  }

  private cacheAccount() {
    try {
      if (this.account) localStorage.setItem(ACCOUNT_CACHE, JSON.stringify(this.account));
    } catch {
      /* ignore */
    }
  }

  async enterGate() {
    if (this.state !== 'title') return;
    this.state = 'gate';
    this.view.setCamMode('title');
    this.show(h('div', { class: 'screen vignette' }, h('div', { class: 'card center-card' }, h('h1', null, 'CONNECTING'), h('div', { class: 'spinner' }), h('p', null, 'Checking this device…'))));
    await getDeviceKey();
    try {
      this.account = await api.login();
      this.offlineOnly = false;
    } catch (e) {
      // server unreachable – previously approved devices may still play offline
      const cached = (() => {
        try {
          return JSON.parse(localStorage.getItem(ACCOUNT_CACHE) ?? 'null') as Account | null;
        } catch {
          return null;
        }
      })();
      if (cached?.status === 'approved') {
        this.account = cached;
        this.offlineOnly = true;
        toast('Offline – online play and saving are unavailable right now', true, 5000);
        this.enterMenu();
        return;
      }
      this.showGateError((e as Error).message);
      return;
    }
    this.routeAccount();
  }

  private routeAccount() {
    const a = this.account;
    if (!a) return this.showSignup();
    this.cacheAccount();
    if (a.status === 'approved') {
      if (a.loadout && Object.keys(a.loadout).length) {
        this.loadout = sanitizeLoadout(a.loadout);
        saveLoadoutLocal(this.loadout);
        this.view.setCar(0, this.loadout, this.previewTeam);
      }
      this.enterMenu();
    } else if (a.status === 'pending') this.showPending();
    else this.showDenied();
  }

  private showGateError(msg: string) {
    this.show(h('div', { class: 'screen vignette' }, h('div', { class: 'card center-card' },
      h('h1', null, "CAN'T CONNECT"),
      h('p', null, 'The account server could not be reached. Check your internet connection and try again.'),
      h('div', { class: 'err' }, msg),
      h('div', { class: 'row', style: 'margin-top:14px' }, btn('Retry', () => { this.state = 'title'; void this.enterGate(); }, '')),
    )));
  }

  private showSignup() {
    const name = h('input', { class: 'field', maxlength: '16', placeholder: 'Your player name', autocomplete: 'off' }) as HTMLInputElement;
    const err = h('div', { class: 'err' });
    const submit = async () => {
      err.textContent = '';
      const n = name.value.trim();
      if (!/^[A-Za-z0-9 _.\-]{2,16}$/.test(n)) {
        err.textContent = 'Use 2–16 letters, numbers, spaces, _ . -';
        return;
      }
      go.disabled = true;
      try {
        this.account = await api.register(n);
        this.routeAccount();
      } catch (e) {
        err.textContent = (e as Error).message;
        go.disabled = false;
      }
    };
    const go = btn('Request access', () => void submit(), 'orange');
    name.addEventListener('keydown', (e) => e.key === 'Enter' && void submit());
    const restore = h('div', { class: 'small', style: 'margin-top:18px' }, 'Already have an account on another browser? ', h('span', { class: 'link', onClick: () => this.showRestore() }, 'Restore with a backup code'));
    this.show(h('div', { class: 'screen vignette' }, h('div', { class: 'card center-card' },
      h('h1', null, 'CREATE YOUR PLAYER'),
      h('p', null, 'Accounts are tied to this device – no email or password. Pick a name and the admin will approve your access.'),
      name, err,
      h('div', { class: 'row', style: 'margin-top:10px' }, go),
      restore,
    )));
    setTimeout(() => name.focus(), 50);
  }

  private showRestore() {
    const code = h('input', { class: 'field', style: 'font-size:16px', placeholder: 'XXXXXXXX-XXXXXXXX-…', autocomplete: 'off' }) as HTMLInputElement;
    const err = h('div', { class: 'err' });
    this.show(h('div', { class: 'screen vignette' }, h('div', { class: 'card center-card' },
      h('h1', null, 'RESTORE ACCOUNT'),
      h('p', null, 'Paste the backup code from Profile → Backup code on your other device.'),
      code, err,
      h('div', { class: 'row', style: 'margin-top:10px' },
        btn('Back', () => this.showSignup(), 'ghost'),
        btn('Restore', async () => {
          if (!(await setDeviceKey(code.value))) {
            err.textContent = 'That code doesn\'t look right.';
            return;
          }
          try {
            const a = await api.login();
            if (!a) {
              err.textContent = 'No account found for that code.';
              return;
            }
            this.account = a;
            this.routeAccount();
          } catch (e) {
            err.textContent = (e as Error).message;
          }
        }, 'orange'),
      ),
    )));
  }

  private showPending() {
    const a = this.account!;
    const status = h('p', null, 'Hang tight – you can play as soon as the admin approves you. This screen updates automatically.');
    this.show(h('div', { class: 'screen vignette' }, h('div', { class: 'card center-card' },
      h('h1', null, 'ACCESS REQUESTED'),
      h('div', { style: 'font-size:28px;margin:10px 0' }, a.name, ' ', h('span', { class: 'badge pending' }, 'pending')),
      status,
      h('div', { class: 'spinner' }),
      h('div', { class: 'row' }, btn('Check now', () => void this.pollStatus(), 'sm')),
    )));
    this.startPolling();
  }

  private showDenied() {
    const a = this.account!;
    const name = h('input', { class: 'field', maxlength: '16', value: a.name }) as HTMLInputElement;
    const err = h('div', { class: 'err' });
    const banned = a.status === 'banned';
    this.show(h('div', { class: 'screen vignette' }, h('div', { class: 'card center-card' },
      h('h1', null, banned ? 'BANNED' : 'ACCESS DENIED'),
      h('p', null, banned ? 'This device has been banned by the admin.' : 'The admin declined this request. You can ask again (maybe with your real name?).'),
      banned ? null : name,
      err,
      banned ? null : h('div', { class: 'row', style: 'margin-top:10px' }, btn('Request again', async () => {
        try {
          this.account = await api.rerequest(name.value.trim());
          this.routeAccount();
        } catch (e) {
          err.textContent = (e as Error).message;
        }
      }, 'orange')),
    )));
    if (!banned) this.startPolling();
  }

  private startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(() => void this.pollStatus(), 8000);
  }

  private async pollStatus() {
    try {
      const a = await api.login();
      if (!a) return;
      const changed = a.status !== this.account?.status;
      this.account = a;
      if (changed) {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
        if (a.status === 'approved') toast('You\'re in! Welcome, ' + a.name);
        this.routeAccount();
      }
    } catch {
      /* keep polling */
    }
  }

  enterMenu() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.state = 'menu';
    audio.music.start();
    audio.stopCrowd();
    audio.stopEngine();
    this.showMain();
  }

  private renderNowPlaying() {
    const np = document.querySelector('.now-playing');
    if (!np) return;
    const t = audio.music.current;
    const meta = np.querySelector('.meta');
    if (!meta) return;
    clear(meta as HTMLElement);
    meta.append(
      h('div', { class: 'small', style: 'font-size:12px;letter-spacing:2px' }, audio.music.playlistName ? 'NOW PLAYING · ' + audio.music.playlistName.toUpperCase() : 'NOW PLAYING'),
      h('div', { class: 't' }, t?.title ?? '—'),
      h('div', { class: 'a' }, t?.artist ?? ''),
    );
  }

  showMain() {
    this.view.setCamMode('menu');
    this.view.focusSlot = 0;
    this.view.setCar(0, this.loadout, this.previewTeam);
    const a = this.account!;
    const st = a.stats ?? {};
    const level = 1 + Math.floor(((st.goals ?? 0) * 3 + (st.games ?? 0) * 5 + (st.wins ?? 0) * 5) / 20);
    const item = (label: string, sub: string, fn: () => void, cls = '') =>
      h('button', { class: 'menu-item ' + cls, onClick: fn }, h('span', null, label), h('small', null, sub));
    const items = [
      item('Play', 'Online, exhibition & free play', () => this.showPlay()),
      item('Garage', 'Cars, boosts, goal explosions, anthems', () => this.showGarage()),
      item('Profile', 'Stats & backup code', () => this.showProfile()),
      item('Options', 'Graphics, camera, audio, controls', () => this.showOptions()),
    ];
    if (a.is_admin && !this.offlineOnly) items.push(item('Admin', 'Requests, players & menu music', () => this.showAdmin(), 'admin-item'));
    items.push(item('Quit', 'Back to the title screen', () => { audio.music.stop(); this.showTitle(); }));
    const np = h('div', { class: 'card now-playing' },
      h('div', { class: 'disc' }),
      h('div', { class: 'meta' }),
      h('button', { class: 'icon-btn', title: 'Skip song', onClick: () => audio.music.skip() }, '⏭'),
    );
    const el = h('div', { id: 'main', class: 'screen shade-left' },
      h('div', { class: 'menu-brand' }, logoSvg(48), GAME_NAME),
      h('div', { class: 'menu-left' }, ...items),
      h('div', { class: 'card player-card' }, h('div', { class: 'avatar' }, a.name.slice(0, 1).toUpperCase()), h('div', null, h('div', { class: 'nm' }, a.name), h('div', { class: 'lv' }, `Level ${level} · ${st.wins ?? 0} wins`))),
      np,
      h('div', { class: 'top-right' }, this.offlineOnly ? h('span', { class: 'badge denied' }, 'offline') : h('span', { class: 'badge approved' }, 'online'), a.is_admin ? h('span', { class: 'badge admin' }, 'admin') : null),
    );
    this.show(el);
    this.renderNowPlaying();
  }

  private subScreen(title: string, onBack: () => void, ...content: (HTMLElement | null)[]) {
    return h('div', { class: 'screen sub vignette' },
      h('div', { class: 'sub-head' }, btn('◀ Back', onBack, 'ghost sm back'), h('h2', null, title)),
      ...content,
    );
  }

  // ── play ─────────────────────────────────────────────────────────────────
  showPlay() {
    const card = (icon: string, title: string, desc: string, fn: () => void) =>
      h('div', { class: 'card mode-card', onClick: fn }, h('div', { class: 'ico' }, icon), h('h3', null, title), h('p', null, desc));
    this.show(this.subScreen('PLAY', () => this.showMain(),
      h('div', { class: 'play-grid' },
        card('🌐', 'Online', this.offlineOnly ? 'Unavailable while offline' : 'Host a room or join friends with a code. Bots can fill empty spots.', () => (this.offlineOnly ? toast('Online play needs a connection', true) : this.showOnline())),
        card('🤖', 'Exhibition', '1v1, 2v2 or 3v3 against bots.', () => this.showExhibition()),
        card('⚽', 'Free Play', 'Just you and the ball. Practice aerials, flicks and wall shots.', () => this.startOffline({ teamSize: 1, skill: 0, duration: 0, freeplay: true })),
      ),
    ));
  }

  private showExhibition() {
    let size = 2, skill = 0.6, duration = 300;
    this.show(this.subScreen('EXHIBITION', () => this.showPlay(),
      h('div', { class: 'card panel' },
        h('div', { class: 'opts' },
          h('label', null, 'Team size'), seg<number>([[1, '1v1'], [2, '2v2'], [3, '3v3']], size, (v) => (size = v)),
          h('label', null, 'Bot skill'), seg<number>([[0.35, 'Rookie'], [0.6, 'Pro'], [0.9, 'All-Star']], skill, (v) => (skill = v)),
          h('label', null, 'Match length'), seg<number>([[180, '3 min'], [300, '5 min'], [600, '10 min'], [0, 'Unlimited']], duration, (v) => (duration = v)),
        ),
        h('div', { class: 'row', style: 'justify-content:flex-start' }, btn('Start match', () => this.startOffline({ teamSize: size, skill, duration, freeplay: false }), 'orange')),
      ),
    ));
  }

  private myPlayer(slot: number, team: 0 | 1): PlayerInfo {
    return { slot, name: this.account?.name ?? 'Player', team, isBot: false, loadout: { ...this.loadout }, stats: emptyStats(), accountId: this.account?.id };
  }

  startOffline(o: { teamSize: number; skill: number; duration: number; freeplay: boolean }) {
    const match = new Match({ duration: o.duration, freeplay: o.freeplay, replays: !o.freeplay });
    match.addPlayer(this.myPlayer(0, 0));
    if (!o.freeplay) {
      let n = Math.floor(Math.random() * BOT_NAMES.length);
      for (let i = 1; i < o.teamSize; i++) match.addPlayer({ slot: i, name: BOT_NAMES[n++ % BOT_NAMES.length], team: 0, isBot: true, skill: o.skill, loadout: botLoadout(i + n), stats: emptyStats() });
      for (let i = 0; i < o.teamSize; i++) match.addPlayer({ slot: 3 + i, name: BOT_NAMES[n++ % BOT_NAMES.length], team: 1, isBot: true, skill: o.skill, loadout: botLoadout(3 + i + n), stats: emptyStats() });
    }
    match.startKickoff();
    this.beginSession(new LocalSession(match, 0));
  }

  private beginSession(s: GameSession) {
    this.session = s;
    this.state = 'game';
    this.paused = false;
    this.matchEnded = false;
    this.statsSaved = false;
    this.replayT = 0;
    clear(this.ui);
    for (let i = 0; i < 6; i++) {
      const p = s.players[i];
      this.view.setCar(i, p ? p.loadout : null, p ? p.team : 0);
    }
    this.view.focusSlot = s.localSlot;
    this.view.ballCam = this.settings.ballCam;
    this.view.effects.clear();
    this.view.setCamMode('car');
    this.hud.show();
    this.hud.showFps = this.settings.showFps;
    this.hud.showPlates = this.settings.nameplates;
    audio.music.stop();
    audio.startCrowd();
    audio.startEngine();
    // keep car visuals in sync when players join / change
    const sync = () => {
      if (this.session !== s) return;
      for (let i = 0; i < 6; i++) {
        const p = s.players[i];
        this.view.setCar(i, p ? p.loadout : null, p ? p.team : 0);
      }
      setTimeout(sync, 1000);
    };
    setTimeout(sync, 1000);
  }

  endSession(reason?: string) {
    const s = this.session;
    this.session = null;
    s?.dispose();
    this.hostNet = null;
    this.clientSignal?.close();
    this.clientSignal = null;
    this.clientLink = null;
    this.pauseEl?.remove();
    this.pauseEl = null;
    this.postEl?.remove();
    this.postEl = null;
    this.paused = false;
    this.hud.hide();
    this.hud.setScoreboard(false);
    audio.stopAnthem();
    audio.stopEngine();
    this.view.effects.clear();
    for (let i = 1; i < 6; i++) this.view.setCar(i, null, 0);
    this.view.setCar(0, this.loadout, this.previewTeam);
    this.enterMenu();
    if (reason) toast(reason, true, 4000);
  }

  private togglePause() {
    const s = this.session;
    if (!s) return;
    if (this.pauseEl) {
      this.pauseEl.remove();
      this.pauseEl = null;
      this.paused = false;
      return;
    }
    this.paused = true;
    const el = h('div', { class: 'screen', style: 'background:rgba(0,0,0,0.45)' }, h('div', { class: 'card pause-menu' },
      h('h2', null, s.kind === 'offline' ? 'PAUSED' : 'MENU'),
      btn('Resume', () => this.togglePause()),
      s.kind !== 'client' && !s.settings.freeplay ? btn('Restart match', () => { this.togglePause(); s.rematch(); }) : null,
      btn(this.view.ballCam ? 'Ball cam: ON' : 'Ball cam: OFF', () => { this.view.ballCam = !this.view.ballCam; this.togglePause(); }),
      btn('Options', () => { this.togglePause(); this.showOptions(true); }),
      btn(s.kind === 'host' ? 'End match for everyone' : 'Leave match', () => this.endSession(), 'red'),
    ));
    this.pauseEl = el;
    this.ui.appendChild(el);
  }

  private showPost(s: GameSession) {
    if (this.session !== s || this.postEl) return;
    const me = s.players[s.localSlot];
    const won = me && me.team === s.winner;
    const mvp = s.mvp >= 0 ? s.players[s.mvp] : null;
    const board = h('div', { class: 'card', style: 'padding:14px 18px;width:min(820px,94vw)' });
    this.hud.renderBoard(s, board);
    const winCol = s.winner === 0 ? '#5a9cff' : '#ff9a4a';
    const el = h('div', { class: 'screen post' },
      h('div', { class: 'winner', style: `color:${winCol};text-shadow:0 0 40px ${winCol}` }, won ? 'VICTORY' : me ? 'DEFEAT' : (s.winner === 0 ? 'BLUE' : 'ORANGE') + ' WINS'),
      mvp ? h('div', { class: 'mvp' }, `★ MVP · ${mvp.name} · ${mvp.stats.score} pts`) : null,
      board,
      h('div', { class: 'row', style: 'margin-top:18px' },
        s.canRematch() ? btn('Rematch', () => { this.postEl?.remove(); this.postEl = null; s.rematch(); this.matchEnded = false; this.statsSaved = false; }, 'orange') : h('div', { class: 'small' }, 'Waiting for the host…'),
        btn('Main menu', () => this.endSession()),
      ),
    );
    this.postEl = el;
    this.ui.appendChild(el);
    const anthem = anthemById(mvp?.loadout.anthem);
    if (anthem) void audio.playAnthem(anthem.url, 12);
  }

  // ── online ───────────────────────────────────────────────────────────────
  private showOnline(tab: 'create' | 'join' = 'create') {
    const body = h('div', { class: 'card panel' });
    const tabs = h('div', { class: 'tabs' });
    const render = () => {
      clear(tabs);
      tabs.append(
        h('div', { class: 'tab' + (tab === 'create' ? ' active' : ''), onClick: () => { tab = 'create'; render(); } }, h('span', null, 'Create room')),
        h('div', { class: 'tab' + (tab === 'join' ? ' active' : ''), onClick: () => { tab = 'join'; render(); } }, h('span', null, 'Join room')),
      );
      clear(body);
      if (tab === 'create') {
        const st: RoomSettings = { teamSize: 2, duration: 300, botsFill: true, botSkill: 0.6, isPublic: true, replays: true };
        body.append(
          h('div', { class: 'opts' },
            h('label', null, 'Mode'), seg<number>([[1, '1v1'], [2, '2v2'], [3, '3v3']], st.teamSize, (v) => (st.teamSize = v as 1 | 2 | 3)),
            h('label', null, 'Match length'), seg<number>([[180, '3 min'], [300, '5 min'], [600, '10 min'], [0, 'Unlimited']], st.duration, (v) => (st.duration = v)),
            h('label', null, 'Empty spots'), seg<string>([['bots', 'Fill with bots'], ['none', 'Leave empty']], 'bots', (v) => (st.botsFill = v === 'bots')),
            h('label', null, 'Bot skill'), seg<number>([[0.35, 'Rookie'], [0.6, 'Pro'], [0.9, 'All-Star']], st.botSkill, (v) => (st.botSkill = v)),
            h('label', null, 'Visibility'), seg<string>([['public', 'Public'], ['private', 'Private (code only)']], 'public', (v) => (st.isPublic = v === 'public')),
          ),
          h('div', { class: 'row', style: 'justify-content:flex-start' }, btn('Create room', () => void this.hostRoom(st), 'orange')),
        );
      } else {
        const code = h('input', { class: 'field', style: 'width:220px;text-transform:uppercase;letter-spacing:6px', maxlength: '5', placeholder: 'CODE' }) as HTMLInputElement;
        code.addEventListener('keydown', (e) => e.key === 'Enter' && void this.joinRoom(code.value));
        const list = h('div', { class: 'room-list' }, h('div', { class: 'small' }, 'Looking for public rooms…'));
        body.append(
          h('div', { class: 'row', style: 'justify-content:flex-start;margin-bottom:18px' }, code, btn('Join', () => void this.joinRoom(code.value), 'orange')),
          h('h3', { style: 'margin:0 0 8px' }, 'Public rooms'),
          list,
        );
        void this.browseRooms(list);
      }
    };
    render();
    this.show(this.subScreen('ONLINE', () => { this.browseLobby?.close(); this.browseLobby = null; this.showPlay(); }, tabs, body));
  }

  private async browseRooms(list: HTMLElement) {
    const draw = (rooms: RoomInfo[]) => {
      clear(list);
      if (!rooms.length) list.appendChild(h('div', { class: 'empty-state' }, 'No public rooms right now – create one!'));
      for (const r of rooms)
        list.appendChild(h('div', { class: 'room-row' },
          h('div', { class: 'c' }, r.code),
          h('div', { class: 'h' }, `${r.host}'s room · ${r.mode}`),
          h('div', { class: 'small' }, `${r.players}/${r.max} players · ${r.status}`),
          btn('Join', () => void this.joinRoom(r.code), 'sm'),
        ));
    };
    try {
      if (!this.browseLobby) {
        this.browseLobby = new Lobby('viewer-' + Math.random().toString(36).slice(2));
        await this.browseLobby.connect();
      }
      this.browseLobby.onChange = draw;
      draw(this.browseLobby.rooms);
    } catch (e) {
      clear(list);
      list.appendChild(h('div', { class: 'err' }, (e as Error).message));
    }
  }

  private async hostRoom(st: RoomSettings) {
    const a = this.account!;
    const net = new HostNet(a.name, { ...this.loadout }, a.id, st);
    try {
      toast('Creating room…');
      await net.open();
    } catch (e) {
      toast((e as Error).message, true);
      net.close();
      return;
    }
    this.browseLobby?.close();
    this.browseLobby = null;
    this.hostNet = net;
    this.roomCode = net.code;
    this.roomSettings = st;
    this.roomRoster = net.roster;
    net.onLobbyUpdate = () => {
      this.roomRoster = net.roster;
      this.renderRoom(true);
    };
    this.renderRoom(true);
  }

  private renderRoom(isHost: boolean) {
    if (this.state === 'game') return;
    const st = this.roomSettings!;
    const ts = st.teamSize;
    const col = (team: 0 | 1) => {
      const base = team === 0 ? 0 : 3;
      const slots: HTMLElement[] = [];
      for (let s = base; s < base + ts; s++) {
        const e = this.roomRoster.find((r) => r.slot === s && !r.isBot);
        slots.push(e ? h('div', { class: 'slot' }, e.name, e.slot === this.mySlot() ? h('span', { class: 'small' }, 'you') : null) : h('div', { class: 'slot empty' }, st.botsFill ? 'Bot' : 'Open'));
      }
      return h('div', { class: 'team-col ' + (team === 0 ? 'blue' : 'orange') }, h('h4', null, team === 0 ? 'BLUE' : 'ORANGE'), ...slots,
        this.mySlotTeam() !== team ? btn('Join ' + (team === 0 ? 'blue' : 'orange'), () => this.switchTeam(team), 'sm ghost') : null);
    };
    const copy = h('button', { class: 'icon-btn', onClick: () => { void navigator.clipboard?.writeText(this.roomCode); toast('Code copied'); } }, 'Copy');
    const el = this.subScreen('ROOM', () => this.leaveRoom(),
      h('div', { class: 'card panel', style: 'max-width:900px' },
        h('div', { class: 'row', style: 'justify-content:space-between' },
          h('div', null, h('div', { class: 'small' }, 'ROOM CODE'), h('div', { class: 'row', style: 'justify-content:flex-start' }, h('div', { class: 'room-code' }, this.roomCode), copy)),
          h('div', { class: 'small', style: 'text-align:right' }, `${ts}v${ts} · ${st.duration ? st.duration / 60 + ' min' : 'unlimited'} · ${st.botsFill ? 'bots fill' : 'no bots'} · ${st.isPublic ? 'public' : 'private'}`),
        ),
        h('div', { class: 'teams' }, col(0), col(1)),
        h('div', { class: 'row', style: 'justify-content:flex-start' },
          isHost ? btn('Start match', () => this.startHostedMatch(), 'orange') : h('div', { class: 'small' }, 'Waiting for the host to start…'),
          btn('Leave', () => this.leaveRoom(), 'ghost'),
        ),
        h('p', { class: 'small' }, 'Share the code with friends. Players can also join after the match has started.'),
      ),
    );
    this.roomEl = el;
    this.show(el);
  }

  private mySlot() {
    if (this.hostNet) return this.hostNet.roster.find((r) => !r.isBot && !r.peer)?.slot ?? 0;
    return this.clientSlot;
  }
  private mySlotTeam() {
    const s = this.mySlot();
    return s < 3 ? 0 : 1;
  }
  private clientSlot = -1;

  private switchTeam(team: 0 | 1) {
    if (this.hostNet) {
      const slot = this.mySlot();
      this.hostNet.switchTeam(slot, team);
      this.roomRoster = this.hostNet.roster;
      this.renderRoom(true);
    } else this.clientLink?.sendR({ t: 'team', team });
  }

  private leaveRoom() {
    this.hostNet?.close();
    this.hostNet = null;
    this.clientLink?.close();
    this.clientLink = null;
    this.clientSignal?.close();
    this.clientSignal = null;
    this.showOnline();
  }

  private startHostedMatch() {
    const net = this.hostNet;
    if (!net) return;
    net.startMatch();
    const st = net.settings;
    const match = new Match({ duration: st.duration, replays: st.replays });
    for (const r of net.roster) match.addPlayer({ slot: r.slot, name: r.name, team: r.team, isBot: r.isBot, skill: r.skill, loadout: r.loadout, stats: emptyStats(), accountId: r.accountId });
    match.startKickoff();
    const mySlot = net.roster.find((r) => !r.isBot && !r.peer)?.slot ?? 0;
    const session = new LocalSession(match, mySlot, net);
    net.broadcastRoster();
    for (const [, remote] of net.remotes) if (remote.ready) remote.link.sendR({ t: 'start', slot: remote.slot, ...(session.startPayload() as object) });
    this.beginSession(session);
  }

  private async joinRoom(codeRaw: string) {
    const code = codeRaw.trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) {
      toast('Enter the 5-character room code', true);
      return;
    }
    toast('Joining ' + code + '…');
    let ticket: string;
    try {
      ticket = await api.ticket();
    } catch (e) {
      toast((e as Error).message, true);
      return;
    }
    const sig = new Signal(code, 'peer-' + Math.random().toString(36).slice(2, 10));
    try {
      await sig.connect();
    } catch (e) {
      toast((e as Error).message, true);
      return;
    }
    this.clientSignal = sig;
    const result = await new Promise<{ host: string; slot: number } | { reason: string }>((resolve) => {
      const off = sig.on((m) => {
        if (m.type === 'accept') {
          off();
          resolve({ host: m.from, slot: (m.data as { slot: number }).slot });
        } else if (m.type === 'reject') {
          off();
          resolve({ reason: (m.data as { reason: string }).reason });
        }
      });
      sig.send('*', 'join', { ticket, name: this.account!.name, loadout: this.loadout });
      setTimeout(() => {
        off();
        resolve({ reason: 'Room not found (or the host is offline).' });
      }, 10000);
    });
    if ('reason' in result) {
      sig.close();
      this.clientSignal = null;
      toast(result.reason, true, 4000);
      return;
    }
    this.browseLobby?.close();
    this.browseLobby = null;
    this.clientSlot = result.slot;
    this.roomCode = code;
    const link = new PeerLink(sig, result.host, false);
    this.clientLink = link;
    link.onReliable = (msg) => {
      if (msg.t === 'welcome' || msg.t === 'roster') {
        this.roomRoster = msg.roster;
        this.roomSettings = msg.settings;
        if (typeof msg.slot === 'number') this.clientSlot = msg.slot;
        const mine = this.roomRoster.find((r) => r.accountId === this.account?.id);
        if (mine) this.clientSlot = mine.slot;
        if (this.state !== 'game') this.renderRoom(false);
      } else if (msg.t === 'start') {
        const session = new ClientSession(link, msg);
        session.onClosed = (reason) => {
          if (this.session === session) this.endSession(reason);
        };
        this.beginSession(session);
      } else if (msg.t === 'closed') {
        this.leaveRoom();
        toast('The host closed the room', true);
      }
    };
    link.onClose = () => {
      if (this.state !== 'game') {
        toast('Disconnected from the room', true);
        this.leaveRoom();
      }
    };
  }

  // ── garage ───────────────────────────────────────────────────────────────
  private saveTimer: number | null = null;
  showGarage() {
    this.view.setCamMode('garage');
    const el = buildGarage({
      loadout: { ...this.loadout },
      onChange: (l) => {
        this.loadout = l;
        saveLoadoutLocal(l);
        this.view.setCar(0, l, this.previewTeam);
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => {
          if (!this.offlineOnly) void api.saveLoadout(l).catch(() => {});
          if (this.account) this.account.loadout = l as unknown as Record<string, unknown>;
          this.cacheAccount();
        }, 800);
      },
      onPreviewTeam: (t) => {
        this.previewTeam = t;
        this.view.setCar(0, this.loadout, t);
      },
      onTestExplosion: () => {
        const car = this.menuWorld.cars[0]!;
        // a few metres behind the car as seen from the garage camera
        const away = car.pos.clone().sub(this.view.camera.position).setY(0).normalize();
        const p = car.pos.clone().addScaledVector(away, 9).add(new THREE.Vector3(0, 2.5, 0));
        this.view.effects.goalExplosion(this.loadout.explosion, p, new THREE.Color(TEAM_COLORS[this.previewTeam as 0 | 1]), new THREE.Color(this.loadout.accent));
        audio.horn();
        const a = anthemById(this.loadout.anthem);
        if (a) void audio.playAnthem(a.url, 8);
      },
      onPlayAnthem: (id) => {
        const a = anthemById(id);
        if (a) void audio.playAnthem(a.url, 10);
      },
      onBack: () => {
        audio.stopAnthem();
        this.showMain();
      },
    });
    this.show(el);
  }

  // ── profile ──────────────────────────────────────────────────────────────
  private async showProfile() {
    const a = this.account!;
    const st = a.stats ?? {};
    const key = await getDeviceKey();
    const codeBox = h('div', { class: 'small', style: 'font-family:monospace;font-size:15px;word-break:break-all;margin:10px 0;display:none' }, formatBackupCode(key));
    const statCell = (label: string, v: number | undefined) => h('div', { class: 'card', style: 'padding:14px;text-align:center' }, h('div', { style: 'font-family:var(--display);font-size:34px' }, String(v ?? 0)), h('div', { class: 'small' }, label));
    this.show(this.subScreen('PROFILE', () => this.showMain(),
      h('div', { class: 'split' },
        h('div', { class: 'card panel' },
          h('div', { class: 'row', style: 'justify-content:flex-start;gap:16px' }, h('div', { class: 'avatar', style: 'width:72px;height:72px;font-size:36px' }, a.name.slice(0, 1).toUpperCase()),
            h('div', null, h('div', { style: 'font-size:32px' }, a.name), h('span', { class: 'badge ' + a.status }, a.status), a.is_admin ? h('span', { class: 'badge admin', style: 'margin-left:6px' }, 'admin') : null)),
          h('p', { class: 'small' }, 'Device: ' + (a.device ?? '—')),
          h('h3', null, 'Backup code'),
          h('p', { class: 'small' }, 'Your account lives on this device. Keep this code somewhere safe – it restores your account if you clear your browser or switch browsers. Anyone with this code can log in as you.'),
          codeBox,
          h('div', { class: 'row', style: 'justify-content:flex-start' },
            btn('Show code', () => (codeBox.style.display = codeBox.style.display === 'none' ? 'block' : 'none'), 'sm ghost'),
            btn('Copy code', () => { void navigator.clipboard?.writeText(formatBackupCode(key)); toast('Backup code copied'); }, 'sm'),
          ),
        ),
        h('div', null,
          h('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:10px' },
            statCell('Games', st.games), statCell('Wins', st.wins), statCell('Goals', st.goals), statCell('Assists', st.assists),
            statCell('Saves', st.saves), statCell('Shots', st.shots), statCell('MVPs', st.mvps), statCell('Demos', st.demos)),
        ),
      ),
    ));
  }

  // ── options ──────────────────────────────────────────────────────────────
  showOptions(fromGame = false) {
    const s = this.settings;
    let tab: 'graphics' | 'camera' | 'audio' | 'controls' = 'camera';
    const body = h('div', { class: 'card panel', style: 'max-width:860px' });
    const tabs = h('div', { class: 'tabs' });
    const save = () => {
      saveSettings(s);
      this.applySettings();
    };
    const row = (label: string, ctl: HTMLElement) => [h('label', null, label), ctl];
    const render = () => {
      clear(tabs);
      for (const [id, label] of [['camera', 'Camera'], ['graphics', 'Graphics'], ['audio', 'Audio'], ['controls', 'Controls']] as const)
        tabs.appendChild(h('div', { class: 'tab' + (tab === id ? ' active' : ''), onClick: () => { tab = id; render(); } }, h('span', null, label)));
      clear(body);
      if (tab === 'graphics') {
        body.appendChild(h('div', { class: 'opts' },
          ...row('Quality', seg<number>([[0, 'Low'], [1, 'Medium'], [2, 'High']], s.quality, (v) => { s.quality = v; save(); })),
          ...row('Show FPS', seg<string>([['on', 'On'], ['off', 'Off']], s.showFps ? 'on' : 'off', (v) => { s.showFps = v === 'on'; save(); })),
          ...row('Nameplates', seg<string>([['on', 'On'], ['off', 'Off']], s.nameplates ? 'on' : 'off', (v) => { s.nameplates = v === 'on'; save(); })),
        ));
      } else if (tab === 'camera') {
        const c = s.camera;
        body.appendChild(h('div', { class: 'opts' },
          ...row('Field of view', slider(60, 110, 1, c.fov, (v) => { c.fov = v; save(); }, (v) => v + '°')),
          ...row('Distance', slider(2, 4, 0.05, c.distance, (v) => { c.distance = v; save(); }, (v) => v.toFixed(2))),
          ...row('Height', slider(0.5, 2, 0.05, c.height, (v) => { c.height = v; save(); }, (v) => v.toFixed(2))),
          ...row('Angle', slider(-12, 0, 1, c.angle, (v) => { c.angle = v; save(); }, (v) => v + '°')),
          ...row('Stiffness', slider(0, 1, 0.05, c.stiffness, (v) => { c.stiffness = v; save(); }, (v) => v.toFixed(2))),
          ...row('Swivel speed', slider(1, 10, 0.5, c.swivel, (v) => { c.swivel = v; save(); }, (v) => v.toFixed(1))),
          ...row('Camera shake', seg<string>([['on', 'On'], ['off', 'Off']], c.shake ? 'on' : 'off', (v) => { c.shake = v === 'on'; save(); })),
          ...row('Ball cam default', seg<string>([['on', 'On'], ['off', 'Off']], s.ballCam ? 'on' : 'off', (v) => { s.ballCam = v === 'on'; save(); })),
        ));
      } else if (tab === 'audio') {
        const v = s.volumes;
        const pct = (x: number) => Math.round(x * 100) + '%';
        body.appendChild(h('div', { class: 'opts' },
          ...row('Master', slider(0, 1, 0.01, v.master, (x) => { v.master = x; save(); }, pct)),
          ...row('Menu music', slider(0, 1, 0.01, v.music, (x) => { v.music = x; save(); }, pct)),
          ...row('Effects', slider(0, 1, 0.01, v.sfx, (x) => { v.sfx = x; save(); }, pct)),
          ...row('Anthems', slider(0, 1, 0.01, v.anthem, (x) => { v.anthem = x; save(); }, pct)),
        ));
      } else {
        const list = (title: string, items: [string, string][]) =>
          h('div', null, h('h3', null, title), h('div', { class: 'keys' }, ...items.flatMap(([k, d]) => [h('div', { class: 'k' }, k), h('div', null, d)])));
        body.appendChild(h('div', { class: 'split' }, list('Keyboard & mouse', KEY_HELP), list('Gamepad', PAD_HELP)));
      }
    };
    render();
    const el = this.subScreen('OPTIONS', () => {
      if (fromGame) {
        clear(this.ui);
        this.togglePause();
      } else this.showMain();
    }, tabs, body);
    if (fromGame) {
      el.style.background = 'rgba(0,0,0,0.6)';
      clear(this.ui);
      this.ui.appendChild(el);
    } else this.show(el);
  }

  // ── admin ────────────────────────────────────────────────────────────────
  private showAdmin() {
    const panel = new AdminPanel(this.account!.id, () => this.showMain());
    panel.onMusicChanged = () => void this.loadContent();
    this.show(panel.el);
    void panel.open();
  }
}

(window as unknown as { __bl: App }).__bl = new App();
