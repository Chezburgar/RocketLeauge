import * as THREE from 'three';
import {
  ARENA_CORNER_R,
  ARENA_FILLET,
  ARENA_HALF_L,
  ARENA_HALF_W,
  GOAL_DEPTH,
  GOAL_HALF_W,
} from '../physics/constants';

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return { c, ctx };
}

/** Grass pitch with mowing stripes, field lines and team tints. Maps world x∈[-W,W], z∈[-L-GD, L+GD]. */
export function makeFieldTexture(maxAniso: number): THREE.CanvasTexture {
  const W = ARENA_HALF_W;
  const L = ARENA_HALF_L + GOAL_DEPTH;
  const ppm = 20; // pixels per metre
  const { c, ctx } = canvas(Math.round(W * 2 * ppm), Math.round(L * 2 * ppm));
  const X = (x: number) => (x + W) * ppm;
  const Z = (z: number) => (z + L) * ppm;

  // stripes along z
  const stripe = 6.4;
  for (let z = -L, i = 0; z < L; z += stripe, i++) {
    ctx.fillStyle = i % 2 ? '#2f7a32' : '#35873a';
    ctx.fillRect(0, Z(z), c.width, stripe * ppm + 1);
  }
  // subtle diagonal checker for texture
  ctx.globalAlpha = 0.05;
  for (let x = -W; x < W; x += stripe) {
    ctx.fillStyle = '#000';
    ctx.fillRect(X(x), 0, (stripe * ppm) / 2, c.height);
  }
  ctx.globalAlpha = 1;
  // team tints (blue defends -z)
  const g = ctx.createLinearGradient(0, Z(-L), 0, Z(L));
  g.addColorStop(0, 'rgba(40,110,255,0.16)');
  g.addColorStop(0.42, 'rgba(40,110,255,0.03)');
  g.addColorStop(0.5, 'rgba(0,0,0,0)');
  g.addColorStop(0.58, 'rgba(255,120,20,0.03)');
  g.addColorStop(1, 'rgba(255,120,20,0.16)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  // noise speckle
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  // lines
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 0.28 * ppm;
  const inset = ARENA_FILLET - 0.2;
  roundRect(ctx, X(-W + inset), Z(-ARENA_HALF_L + inset), (W - inset) * 2 * ppm, (ARENA_HALF_L - inset) * 2 * ppm, (ARENA_CORNER_R - inset) * ppm);
  ctx.stroke();
  // halfway line + circle
  ctx.beginPath();
  ctx.moveTo(X(-W + inset), Z(0));
  ctx.lineTo(X(W - inset), Z(0));
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(X(0), Z(0), 9.5 * ppm, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(X(0), Z(0), 0.6 * ppm, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  // goal boxes
  for (const s of [-1, 1]) {
    const gl = s * ARENA_HALF_L;
    ctx.strokeStyle = s < 0 ? 'rgba(140,190,255,0.9)' : 'rgba(255,190,120,0.9)';
    ctx.strokeRect(X(-GOAL_HALF_W - 6), Math.min(Z(gl), Z(gl - s * 12)), (GOAL_HALF_W + 6) * 2 * ppm, 12 * ppm);
    ctx.beginPath();
    ctx.arc(X(0), Z(gl - s * 12), 6 * ppm, s < 0 ? 0 : Math.PI, s < 0 ? Math.PI : Math.PI * 2);
    ctx.stroke();
    // goal line glow
    ctx.fillStyle = s < 0 ? 'rgba(90,160,255,0.95)' : 'rgba(255,150,60,0.95)';
    ctx.fillRect(X(-GOAL_HALF_W), Z(gl) - 0.2 * ppm, GOAL_HALF_W * 2 * ppm, 0.4 * ppm);
    // goal interior floor hex hatch
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = s < 0 ? '#6fb0ff' : '#ffb06f';
    ctx.lineWidth = 0.08 * ppm;
    for (let x = -GOAL_HALF_W; x <= GOAL_HALF_W; x += 1.2) {
      ctx.beginPath();
      ctx.moveTo(X(x), Z(gl));
      ctx.lineTo(X(x), Z(gl + s * GOAL_DEPTH));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 0.28 * ppm;
  }
  // centre logo ring
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(X(0), Z(0), 5 * ppm, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Hexagon grid used on the glass walls and goal nets (white on transparent). */
export function makeHexTexture(lineWidth = 3, size = 256, glow = true): THREE.CanvasTexture {
  const { c, ctx } = canvas(size, Math.round(size * Math.sqrt(3)));
  const r = size / 4;
  const h = (Math.sqrt(3) / 2) * r;
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.lineWidth = lineWidth;
  if (glow) {
    ctx.shadowColor = 'rgba(255,255,255,0.8)';
    ctx.shadowBlur = 6;
  }
  const hex = (cx: number, cy: number) => {
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) {
      const a = (Math.PI / 3) * i;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  for (let col = -1; col < 4; col++)
    for (let row = -1; row < 5; row++) {
      const cx = col * r * 1.5 * 2 + (row % 2 ? r * 1.5 : 0);
      const cy = row * h;
      hex(cx, cy);
    }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Radial soft blob (shadows / glows). */
export function makeRadialTexture(inner = 'rgba(0,0,0,0.75)', outer = 'rgba(0,0,0,0)'): THREE.CanvasTexture {
  const { c, ctx } = canvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Text banner texture (used for stadium signage). */
export function makeBannerTexture(text: string, sub: string, color: string, w = 1024, h = 256): THREE.CanvasTexture {
  const { c, ctx } = canvas(w, h);
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, '#07091a');
  g.addColorStop(0.5, '#10163a');
  g.addColorStop(1, '#07091a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 8;
  ctx.strokeRect(8, 8, w - 16, h - 16);
  ctx.fillStyle = '#ffffff';
  ctx.font = `900 ${Math.round(h * 0.42)}px "Arial Black", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = color;
  ctx.shadowBlur = 24;
  ctx.fillText(text, w / 2, h * 0.45);
  ctx.shadowBlur = 0;
  ctx.fillStyle = color;
  ctx.font = `700 ${Math.round(h * 0.14)}px Arial, sans-serif`;
  ctx.fillText(sub, w / 2, h * 0.8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Carbon-ish panel texture for the ramps. */
export function makePanelTexture(): THREE.CanvasTexture {
  const { c, ctx } = canvas(256, 256);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 3;
  for (let i = 0; i <= 256; i += 64) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 256);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(256, i);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.06)';
  for (let i = 0; i < 256; i += 8) ctx.fillRect(i, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
