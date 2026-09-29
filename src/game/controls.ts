import { emptyInput, type CarInput } from '../physics/input';

export type Action = 'fullscreen' | 'ballcam' | 'pause' | 'scoreboard' | 'scoreboardUp' | 'chat' | 'quick1' | 'quick2' | 'quick3' | 'quick4' | 'skip' | 'any';

export const KEY_HELP: [string, string][] = [
  ['W / S', 'Throttle / reverse · pitch in the air'],
  ['A / D', 'Steer · yaw in the air'],
  ['Space / Right mouse', 'Jump (twice = double jump / dodge with a direction)'],
  ['Shift / Left mouse', 'Boost'],
  ['X', 'Powerslide · free air roll (hold)'],
  ['Q / E', 'Air roll left / right'],
  ['C', 'Toggle ball cam'],
  ['Tab', 'Scoreboard'],
  ['T', 'Chat · 1-4 quick chat'],
  ['P (or Esc)', 'Pause menu'],
  ['F', 'Toggle fullscreen'],
];
export const PAD_HELP: [string, string][] = [
  ['RT / LT', 'Throttle / reverse'],
  ['Left stick', 'Steer · pitch & yaw in the air'],
  ['A', 'Jump'],
  ['B', 'Boost'],
  ['X', 'Powerslide · free air roll'],
  ['LB / RB', 'Air roll left / right'],
  ['Y', 'Toggle ball cam'],
  ['Back', 'Scoreboard'],
  ['Start', 'Pause menu'],
];

const DEAD = 0.14;
const dz = (v: number) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));

/** Keyboard + mouse + gamepad input. */
export class Controls {
  private keys = new Set<string>();
  private mouse = new Set<number>();
  private padPrev: boolean[] = [];
  /** when false, driving input is ignored (menus / typing) */
  enabled = true;
  onAction: ((a: Action) => void) | null = null;
  lastDevice: 'keyboard' | 'gamepad' = 'keyboard';

  constructor() {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      this.lastDevice = 'keyboard';
      if (!e.repeat) {
        this.onAction?.('any');
        const map: Record<string, Action> = { KeyC: 'ballcam', KeyP: 'pause', Escape: 'pause', KeyF: 'fullscreen', Tab: 'scoreboard', KeyT: 'chat', Digit1: 'quick1', Digit2: 'quick2', Digit3: 'quick3', Digit4: 'quick4', Space: 'skip' };
        const a = map[e.code];
        if (a) this.onAction?.(a);
      }
      if (this.enabled && ['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Tab') this.onAction?.('scoreboardUp');
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouse.clear();
    });
    window.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement)?.closest?.('.ui-interactive')) return;
      this.mouse.add(e.button);
    });
    window.addEventListener('mouseup', (e) => this.mouse.delete(e.button));
    window.addEventListener('contextmenu', (e) => {
      if (this.enabled) e.preventDefault();
    });
  }

  private k(...codes: string[]) {
    return codes.some((c) => this.keys.has(c));
  }

  /** Poll gamepad buttons for menu-style actions. Call once per frame. */
  pollActions() {
    const pad = this.pad();
    if (!pad) return;
    const map: [number, Action][] = [
      [3, 'ballcam'],
      [9, 'pause'],
      [8, 'scoreboard'],
      [0, 'skip'],
    ];
    pad.buttons.forEach((b, i) => {
      const was = this.padPrev[i] ?? false;
      if (b.pressed && !was) {
        this.lastDevice = 'gamepad';
        this.onAction?.('any');
        const m = map.find(([idx]) => idx === i);
        if (m) this.onAction?.(m[1]);
      }
      if (!b.pressed && was && i === 8) this.onAction?.('scoreboardUp');
      this.padPrev[i] = b.pressed;
    });
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  sample(out: CarInput = emptyInput()): CarInput {
    Object.assign(out, emptyInput());
    if (!this.enabled) return out;
    // keyboard
    const fwd = this.k('KeyW', 'ArrowUp') ? 1 : 0;
    const back = this.k('KeyS', 'ArrowDown') ? 1 : 0;
    const left = this.k('KeyA', 'ArrowLeft') ? 1 : 0;
    const right = this.k('KeyD', 'ArrowRight') ? 1 : 0;
    out.throttle = fwd - back;
    out.steer = right - left;
    out.pitch = fwd - back;
    out.yaw = right - left;
    out.roll = (this.k('KeyE') ? 1 : 0) - (this.k('KeyQ') ? 1 : 0);
    out.jump = this.k('Space') || this.mouse.has(2);
    out.boost = this.k('ShiftLeft', 'ShiftRight') || this.mouse.has(0);
    out.handbrake = this.k('KeyX');
    // gamepad
    const pad = this.pad();
    if (pad) {
      const lx = dz(pad.axes[0] ?? 0);
      const ly = dz(pad.axes[1] ?? 0);
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      const any = Math.abs(lx) + Math.abs(ly) + rt + lt > 0 || pad.buttons.some((b) => b.pressed);
      if (any) {
        this.lastDevice = 'gamepad';
        out.throttle = Math.max(-1, Math.min(1, out.throttle + rt - lt));
        out.steer = Math.max(-1, Math.min(1, out.steer + lx));
        out.yaw = out.steer;
        out.pitch = Math.max(-1, Math.min(1, out.pitch - ly));
        out.jump = out.jump || !!pad.buttons[0]?.pressed;
        out.boost = out.boost || !!pad.buttons[1]?.pressed;
        out.handbrake = out.handbrake || !!pad.buttons[2]?.pressed;
        const rl = (pad.buttons[5]?.pressed ? 1 : 0) - (pad.buttons[4]?.pressed ? 1 : 0);
        if (rl) out.roll = rl;
      }
    }
    return out;
  }
}
