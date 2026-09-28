import { Vector3 } from 'three';
import type { GameSession } from '../game/session';
import { TEAM_NAMES, type MatchEvent } from '../game/types';
import type { Frame } from '../render/frame';
import type { GameView } from '../render/view';
import { clear, h } from './dom';

const QUICK_CHAT = ['Nice shot!', 'What a save!', 'Great pass!', 'Thanks!'];
export { QUICK_CHAT };

function fmtClock(sec: number, overtime: boolean) {
  const s = Math.max(0, overtime ? Math.floor(sec) : Math.ceil(sec));
  const m = Math.floor(s / 60);
  return (overtime ? '+' : '') + m + ':' + String(s % 60).padStart(2, '0');
}

export class Hud {
  readonly root: HTMLElement;
  private scorebug: HTMLElement;
  private sB: HTMLElement;
  private sO: HTMLElement;
  private clock: HTMLElement;
  private boost: HTMLElement;
  private boostArc: SVGCircleElement;
  private boostNum: HTMLElement;
  private center: HTMLElement;
  private feed: HTMLElement;
  private chat: HTMLElement;
  private corner: HTMLElement;
  private replayTag: HTMLElement;
  private replayHint: HTMLElement;
  private ballcam: HTMLElement;
  private board: HTMLElement;
  private plates: HTMLElement[] = [];
  private chatInput: HTMLElement | null = null;
  private fps = 0;
  private fpsAcc = 0;
  private fpsN = 0;
  showFps = false;
  showPlates = true;
  private boardVisible = false;
  private centerTimer = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.sB = h('div', { class: 'sc b' }, '0');
    this.sO = h('div', { class: 'sc o' }, '0');
    this.clock = h('div', { class: 'clock' }, '5:00');
    this.scorebug = h('div', { class: 'scorebug' }, this.sB, this.clock, this.sO);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    const bg = document.createElementNS(ns, 'circle');
    bg.setAttribute('cx', '50');
    bg.setAttribute('cy', '50');
    bg.setAttribute('r', '42');
    bg.setAttribute('fill', 'rgba(6,10,24,0.75)');
    bg.setAttribute('stroke', 'rgba(255,255,255,0.12)');
    bg.setAttribute('stroke-width', '8');
    const arc = document.createElementNS(ns, 'circle');
    arc.setAttribute('cx', '50');
    arc.setAttribute('cy', '50');
    arc.setAttribute('r', '42');
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', '#ffb347');
    arc.setAttribute('stroke-width', '8');
    arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('transform', 'rotate(135 50 50)');
    arc.style.filter = 'drop-shadow(0 0 4px #ff8a2a)';
    svg.append(bg, arc);
    this.boostArc = arc;
    this.boostNum = h('div', { class: 'num' }, '33');
    this.boost = h('div', { class: 'boost-meter' }, svg, this.boostNum, h('div', { class: 'lbl' }, 'BOOST'));
    this.center = h('div', { class: 'hidden' });
    this.feed = h('div', { class: 'feed' });
    this.chat = h('div', { class: 'chat' });
    this.corner = h('div', { class: 'hud-corner' });
    this.replayTag = h('div', { class: 'replay-tag hidden' }, 'REPLAY');
    this.replayHint = h('div', { class: 'replay-hint hidden' }, 'Press JUMP to skip');
    this.ballcam = h('div', { class: 'ballcam' }, 'BALL CAM');
    this.board = h('div', { class: 'scoreboard card hidden' });
    root.append(this.scorebug, this.boost, this.center, this.feed, this.chat, this.corner, this.replayTag, this.replayHint, this.ballcam, this.board);
    for (let i = 0; i < 6; i++) {
      const p = h('div', { class: 'nameplate hidden' });
      this.plates.push(p);
      root.appendChild(p);
    }
    this.hide();
  }

  show() {
    this.root.classList.remove('hidden');
  }
  hide() {
    this.root.classList.add('hidden');
    this.closeChat();
    this.clearDemo();
  }

  private bigText(text: string, ms = 900, color = '') {
    clear(this.center);
    this.center.className = 'big-center';
    this.center.style.color = color;
    this.center.textContent = text;
    // restart animation
    void this.center.offsetWidth;
    this.centerTimer = ms / 1000;
  }

  private addFeed(text: string, team: number | null) {
    const f = h('div', { class: 'f' + (team === 0 ? ' b' : team === 1 ? ' o' : '') }, text);
    this.feed.prepend(f);
    while (this.feed.children.length > 5) this.feed.lastChild?.remove();
    setTimeout(() => f.remove(), 4500);
  }

  private demoEl: HTMLElement | null = null;
  private demoTimer: number | null = null;

  /** Shown to the player whose car was destroyed, with a respawn countdown. */
  showDemolished(by: string) {
    this.clearDemo();
    const sub = h('div', { class: 's' }, `by ${by}  ·  respawning in 3`);
    const el = h('div', { class: 'demo-banner' }, h('div', { class: 't' }, 'DEMOLISHED'), sub);
    this.root.appendChild(el);
    this.demoEl = el;
    let n = 3;
    this.demoTimer = window.setInterval(() => {
      n--;
      if (n <= 0) this.clearDemo();
      else sub.textContent = `by ${by}  ·  respawning in ${n}`;
    }, 1000);
  }

  /** Shown to the attacker. */
  showDemoHit(victim: string) {
    this.clearDemo();
    const el = h('div', { class: 'demo-hit' }, `DEMOLITION!  ${victim}`);
    this.root.appendChild(el);
    this.demoEl = el;
    this.demoTimer = window.setTimeout(() => this.clearDemo(), 1400);
  }

  private clearDemo() {
    if (this.demoTimer !== null) {
      clearInterval(this.demoTimer);
      clearTimeout(this.demoTimer);
    }
    this.demoTimer = null;
    this.demoEl?.remove();
    this.demoEl = null;
  }

  addChat(name: string, team: number, text: string) {
    const m = h('div', { class: 'm' }, h('b', { class: team === 0 ? 'b' : 'o' }, name + ': '), text);
    this.chat.appendChild(m);
    while (this.chat.children.length > 6) this.chat.firstChild?.remove();
    setTimeout(() => m.remove(), 9000);
  }

  openChat(send: (text: string) => void, onClose: () => void) {
    if (this.chatInput) return;
    const input = h('input', { maxlength: '80', placeholder: 'Say something… (Enter to send, Esc to cancel)' }) as HTMLInputElement;
    const wrap = h('div', { class: 'chat-input' }, input);
    this.root.appendChild(wrap);
    this.chatInput = wrap;
    setTimeout(() => input.focus(), 0);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const t = input.value.trim();
        if (t) send(t);
        this.closeChat();
        onClose();
      } else if (e.key === 'Escape') {
        this.closeChat();
        onClose();
      }
    });
  }

  closeChat() {
    this.chatInput?.remove();
    this.chatInput = null;
  }

  get chatOpen() {
    return !!this.chatInput;
  }

  setScoreboard(v: boolean) {
    this.boardVisible = v;
    this.board.classList.toggle('hidden', !v);
  }

  onEvent(e: MatchEvent, s: GameSession) {
    const name = (slot: number) => s.players[slot]?.name ?? '???';
    const team = (slot: number) => s.players[slot]?.team ?? 0;
    switch (e.type) {
      case 'countdown':
        this.bigText(String(e.n), 800);
        break;
      case 'go':
        this.bigText('GO!', 700, '#7dffb0');
        break;
      case 'overtime':
        this.bigText('OVERTIME', 1800, '#ffc23d');
        break;
      case 'goal': {
        clear(this.center);
        this.center.className = 'goal-banner';
        this.center.style.color = '';
        const col = e.team === 0 ? '#5a9cff' : '#ff9a4a';
        const scorer = e.scorer >= 0 ? name(e.scorer) : '';
        this.center.append(h('div', { class: 'g', style: `color:${col};text-shadow:0 0 40px ${col}` }, e.ownGoal ? 'OWN GOAL!' : 'GOAL!'));
        if (scorer) this.center.append(h('div', { class: 'who' }, (e.ownGoal ? 'Oops, ' : 'Scored by ') + scorer + (e.assister >= 0 ? `  ·  Assist ${name(e.assister)}` : '')));
        this.center.append(h('div', { class: 'spd' }, `${Math.round(e.speed * 3.6)} KM/H`));
        this.centerTimer = 3;
        if (scorer) this.addFeed(`${scorer} scored!`, e.team);
        break;
      }
      case 'save':
        this.addFeed(`${name(e.slot)} – SAVE!`, team(e.slot));
        break;
      case 'shot':
        this.addFeed(`${name(e.slot)} – Shot on goal`, team(e.slot));
        break;
      case 'demo':
        this.addFeed(`${name(e.attacker)} DEMOLISHED ${name(e.victim)}`, team(e.attacker));
        break;
      case 'chat':
        this.addChat(name(e.slot), team(e.slot), e.text);
        break;
      case 'lastSeconds':
        if (e.n <= 3) this.bigText(String(e.n), 600, '#ff6b6b');
        break;
      case 'replay':
      case 'kickoff':
        this.center.className = 'hidden';
        this.centerTimer = 0;
        break;
    }
  }

  update(dt: number, s: GameSession, f: Frame, view: GameView, replaying: boolean) {
    // fps
    this.fpsAcc += dt;
    this.fpsN++;
    if (this.fpsAcc > 0.5) {
      this.fps = Math.round(this.fpsN / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsN = 0;
    }
    const lines: string[] = [];
    if (this.showFps) lines.push(`${this.fps} FPS`);
    if (s.kind === 'client') lines.push(`PING ${s.pingMs()} ms`);
    if (s.kind === 'host') lines.push('HOSTING');
    this.corner.textContent = lines.join('  ·  ');
    // scorebug
    const freeplay = s.settings.freeplay;
    this.scorebug.classList.toggle('hidden', freeplay);
    this.sB.textContent = String(s.scores[0]);
    this.sO.textContent = String(s.scores[1]);
    const unlimited = s.settings.duration <= 0;
    this.clock.textContent = unlimited ? '∞' : fmtClock(s.clock, s.overtime);
    this.clock.classList.toggle('ot', s.overtime);
    this.clock.classList.toggle('low', !s.overtime && !unlimited && s.clock <= 30);
    // boost
    const me = f.cars[s.localSlot];
    const b = me?.present ? Math.round(me.boost) : 0;
    this.boostNum.textContent = String(b);
    const circ = 2 * Math.PI * 42 * 0.75;
    this.boostArc.setAttribute('stroke-dasharray', `${(circ * b) / 100} ${2 * Math.PI * 42}`);
    this.boost.classList.toggle('hidden', replaying || !me?.present);
    // center fade
    if (this.centerTimer > 0) {
      this.centerTimer -= dt;
      if (this.centerTimer <= 0) this.center.className = 'hidden';
    }
    this.replayTag.classList.toggle('hidden', !replaying);
    this.replayHint.classList.toggle('hidden', !replaying || s.kind === 'client');
    this.ballcam.classList.toggle('hidden', !view.ballCam || replaying);
    // nameplates
    for (let i = 0; i < 6; i++) {
      const p = this.plates[i];
      const c = f.cars[i];
      const pl = s.players[i];
      if (!this.showPlates || !c.present || c.demolished || !pl || i === s.localSlot || replaying) {
        p.classList.add('hidden');
        continue;
      }
      const sp = view.project(_v.copy(c.pos).setY(c.pos.y + 1.1));
      if (!sp) {
        p.classList.add('hidden');
        continue;
      }
      p.classList.remove('hidden');
      p.className = 'nameplate ' + (pl.team === 0 ? 'b' : 'o');
      if (p.textContent !== pl.name) p.textContent = pl.name;
      p.style.left = sp.x + 'px';
      p.style.top = sp.y + 'px';
      const d = c.pos.distanceTo(view.camera.position);
      p.style.opacity = String(Math.max(0.35, Math.min(1, 40 / d)));
    }
    if (this.boardVisible) this.renderBoard(s);
  }

  renderBoard(s: GameSession, into: HTMLElement = this.board) {
    clear(into);
    const rows: HTMLElement[] = [];
    for (const team of [0, 1]) {
      const ps = s.players.filter((p) => p && p.team === team).sort((a, b) => b!.stats.score - a!.stats.score);
      rows.push(
        h('tr', null, h('th', { style: `color:${team === 0 ? '#7fb0ff' : '#ffac6b'}` }, `${TEAM_NAMES[team]}  ${s.scores[team]}`), h('th', null, 'SCORE'), h('th', null, 'GOALS'), h('th', null, 'ASSISTS'), h('th', null, 'SAVES'), h('th', null, 'SHOTS'), h('th', null, 'DEMOS')),
      );
      for (const p of ps) {
        if (!p) continue;
        rows.push(
          h('tr', { class: (team === 0 ? 'b' : 'o') + (p.slot === s.localSlot ? ' me' : '') },
            h('td', null, p.name, p.isBot ? h('span', { class: 'bot' }, '  BOT') : null, s.mvp === p.slot ? '  ★ MVP' : null),
            h('td', null, p.stats.score), h('td', null, p.stats.goals), h('td', null, p.stats.assists), h('td', null, p.stats.saves), h('td', null, p.stats.shots), h('td', null, p.stats.demos)),
        );
      }
    }
    into.appendChild(h('table', null, ...rows));
  }
}

const _v = new Vector3();
