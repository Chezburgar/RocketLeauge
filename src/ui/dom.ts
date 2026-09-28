import { audio } from '../audio/audio';

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & { class?: string; style?: string };

/** Tiny hyperscript helper. `on*` attributes become event listeners. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        const ev = k.slice(2).toLowerCase();
        el.addEventListener(ev, (e) => {
          if (ev === 'click') audio.click();
          (v as (e: Event) => void)(e);
        });
        if (ev === 'click') el.addEventListener('mouseenter', () => audio.hover());
      } else if (k === 'class') el.className = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k === 'html') el.innerHTML = String(v);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  const add = (c: Child | Child[]) => {
    if (Array.isArray(c)) c.forEach(add);
    else if (c === null || c === undefined || c === false) return;
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  };
  children.forEach(add);
  return el;
}

export function clear(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

let toastTimer: number | null = null;
export function toast(msg: string, error = false, ms = 3000) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast' + (error ? ' error' : '') }, msg);
  document.body.appendChild(t);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.remove(), ms);
}

/** Skewed button. */
export function btn(label: string, onClick: () => void, cls = '') {
  return h('button', { class: 'btn ' + cls, onClick }, h('span', null, label));
}

/** Segmented control. */
export function seg<T extends string | number>(options: [T, string][], value: T, onChange: (v: T) => void) {
  const wrap = h('div', { class: 'seg' });
  const render = (v: T) => {
    clear(wrap);
    for (const [val, label] of options)
      wrap.appendChild(
        h('button', {
          class: val === v ? 'on' : '',
          onClick: () => {
            render(val);
            onChange(val);
          },
        }, label),
      );
  };
  render(value);
  return wrap;
}

export function slider(min: number, max: number, step: number, value: number, onInput: (v: number) => void, fmt: (v: number) => string = (v) => String(v)) {
  const val = h('span', { class: 'v' }, fmt(value));
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) }) as HTMLInputElement;
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    val.textContent = fmt(v);
    onInput(v);
  });
  return h('div', { class: 'slider-row' }, input, val);
}

export function timeAgo(iso: string | null) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return Math.floor(s / 86400) + ' d ago';
}

export function fmtDuration(sec: number | null | undefined) {
  if (!sec || !isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Original emblem: a hexagonal crest with a ball and a boost streak. */
export function logoSvg(size = 150) {
  const s = `
  <svg viewBox="0 0 200 200" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="lgA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5fd3ff"/><stop offset="1" stop-color="#1a43a0"/></linearGradient>
      <linearGradient id="lgB" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb14a"/><stop offset="1" stop-color="#ff5a1a"/></linearGradient>
      <radialGradient id="lgC" cx="0.35" cy="0.35" r="0.8"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#9fb4d8"/></radialGradient>
    </defs>
    <polygon points="100,6 184,52 184,148 100,194 16,148 16,52" fill="#07102a" stroke="url(#lgA)" stroke-width="10"/>
    <polygon points="100,26 166,62 166,138 100,174 34,138 34,62" fill="none" stroke="#2a64d8" stroke-width="3" opacity="0.7"/>
    <path d="M30 128 L118 96 L112 112 L170 92 L96 142 L102 124 Z" fill="url(#lgB)"/>
    <circle cx="122" cy="80" r="30" fill="url(#lgC)"/>
    <path d="M122 50 L134 66 L128 86 L110 88 L104 70 Z" fill="#23304d" opacity="0.85"/>
    <path d="M96 76 L104 70 M134 66 L150 70 M128 86 L136 104 M110 88 L100 100" stroke="#23304d" stroke-width="4" stroke-linecap="round" opacity="0.85"/>
  </svg>`;
  const span = document.createElement('span');
  span.innerHTML = s;
  return span.firstElementChild as SVGElement;
}
