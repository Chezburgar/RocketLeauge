import * as THREE from 'three';
import type { BoostId, ExplosionId } from '../game/types';
import { DebrisSystem, ParticleSystem, SHAPE_RING, SHAPE_SOFT, SHAPE_SPARK, SHAPE_SQUARE } from './particles';
import { makeRadialTexture } from './textures';

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);

export const EXPLOSION_NAMES: Record<ExplosionId, string> = {
  classic: 'Classic Burst',
  fireworks: 'Fireworks',
  singularity: 'Singularity',
  electro: 'Electroshock',
  confetti: 'Confetti Party',
  voxel: 'Voxel Blast',
  shockwave: 'Shockwave',
  inferno: 'Inferno',
};
export const BOOST_NAMES: Record<BoostId, string> = {
  flame: 'Standard Flame',
  neon: 'Neon Stream',
  plasma: 'Plasma',
  sparkle: 'Sparkles',
  bubbles: 'Bubbles',
  lightning: 'Lightning',
  rainbow: 'Rainbow',
};

interface Ring {
  mesh: THREE.Mesh;
  t: number;
  life: number;
  from: number;
  to: number;
  delay: number;
}
interface Bolt {
  line: THREE.LineSegments;
  t: number;
  life: number;
  a: THREE.Vector3;
  b: THREE.Vector3;
  regen: number;
}
interface Timed {
  at: number;
  fn: () => void;
}

/** All transient visual effects: boost trails, hits, demolitions and goal explosions. */
export class Effects {
  readonly group = new THREE.Group();
  readonly add: ParticleSystem;
  readonly norm: ParticleSystem;
  private cubes: DebrisSystem;
  private confetti: DebrisSystem;
  private rings: Ring[] = [];
  private ringGeo = new THREE.TorusGeometry(1, 0.08, 6, 48);
  private discGeo = new THREE.RingGeometry(0.8, 1, 48);
  private bolts: Bolt[] = [];
  private flashes: { sprite: THREE.Sprite; light: THREE.PointLight; t: number; life: number; size: number }[] = [];
  private flashTex = makeRadialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');
  private cores: { mesh: THREE.Mesh; t: number; life: number }[] = [];
  private timers: Timed[] = [];
  private time = 0;
  shake = 0;
  quality = 2;

  constructor() {
    this.add = new ParticleSystem(9000, true);
    this.norm = new ParticleSystem(4000, false);
    this.group.add(this.add.points, this.norm.points);
    const cubeMat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.2, flatShading: true, emissive: 0x222222 });
    this.cubes = new DebrisSystem(500, new THREE.BoxGeometry(1, 1, 1), cubeMat);
    const confMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    this.confetti = new DebrisSystem(900, new THREE.PlaneGeometry(1, 0.6), confMat);
    this.group.add(this.cubes.mesh, this.confetti.mesh);
  }

  setViewport(heightPx: number, fov: number) {
    this.add.setScale(heightPx, fov);
    this.norm.setScale(heightPx, fov);
  }

  private later(delay: number, fn: () => void) {
    this.timers.push({ at: this.time + delay, fn });
  }

  private ring(pos: THREE.Vector3, color: THREE.Color, from: number, to: number, life: number, flat: boolean, delay = 0, thick = false) {
    const mat = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(3.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(thick ? this.ringGeo : this.discGeo, mat);
    mesh.position.copy(pos);
    if (flat) mesh.rotation.x = -Math.PI / 2;
    else mesh.lookAt(pos.x, pos.y, 0);
    mesh.visible = delay <= 0;
    mesh.scale.setScalar(from);
    this.group.add(mesh);
    this.rings.push({ mesh, t: 0, life, from, to, delay });
  }

  private flash(pos: THREE.Vector3, color: THREE.Color, size: number, life: number, intensity = 40) {
    const mat = new THREE.SpriteMaterial({ map: this.flashTex, color: color.clone().multiplyScalar(1.4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.8 });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(pos);
    size *= 0.6;
    sprite.scale.setScalar(size);
    const light = new THREE.PointLight(color, intensity * 0.35, 50, 1.6);
    light.position.copy(pos);
    this.group.add(sprite, light);
    this.flashes.push({ sprite, light, t: 0, life, size });
  }

  private bolt(a: THREE.Vector3, b: THREE.Vector3, color: THREE.Color, life: number) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(16 * 6), 3));
    const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: color.clone().multiplyScalar(4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.group.add(line);
    const bolt = { line, t: 0, life, a: a.clone(), b: b.clone(), regen: 0 };
    this.regenBolt(bolt);
    this.bolts.push(bolt);
  }

  private regenBolt(bolt: Bolt) {
    const arr = (bolt.line.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
    const segs = 16;
    let px = bolt.a.x, py = bolt.a.y, pz = bolt.a.z;
    const len = bolt.a.distanceTo(bolt.b);
    for (let i = 0; i < segs; i++) {
      const t = (i + 1) / segs;
      const j = i === segs - 1 ? 0 : len * 0.06;
      const nx = bolt.a.x + (bolt.b.x - bolt.a.x) * t + rnd(-j, j);
      const ny = bolt.a.y + (bolt.b.y - bolt.a.y) * t + rnd(-j, j);
      const nz = bolt.a.z + (bolt.b.z - bolt.a.z) * t + rnd(-j, j);
      arr.set([px, py, pz, nx, ny, nz], i * 6);
      px = nx; py = ny; pz = nz;
    }
    bolt.line.geometry.attributes.position.needsUpdate = true;
  }

  private burst(pos: THREE.Vector3, n: number, speed: [number, number], color: THREE.Color, colorEnd: THREE.Color, size: [number, number], life: [number, number], opts: { gravity?: number; drag?: number; shape?: number; up?: number; normal?: boolean; floor?: boolean } = {}) {
    const sys = opts.normal ? this.norm : this.add;
    const count = Math.round(n * (this.quality >= 2 ? 1 : this.quality === 1 ? 0.6 : 0.35));
    for (let i = 0; i < count; i++) {
      _v.randomDirection();
      if (opts.up) _v.y = Math.abs(_v.y) * opts.up + (1 - opts.up) * _v.y;
      const s = rnd(speed[0], speed[1]);
      sys.spawn({
        x: pos.x, y: pos.y, z: pos.z,
        vx: _v.x * s, vy: _v.y * s, vz: _v.z * s,
        color, colorEnd, life: rnd(life[0], life[1]), size: rnd(size[0], size[1]), sizeEnd: 0.1,
        gravity: opts.gravity ?? 0, drag: opts.drag ?? 1.2, shape: opts.shape ?? SHAPE_SOFT, floor: opts.floor,
      });
    }
  }

  // ── goal explosions ────────────────────────────────────────────────
  goalExplosion(type: ExplosionId, pos: THREE.Vector3, team: THREE.Color, accent: THREE.Color) {
    const p = pos.clone();
    const hot = team.clone().lerp(WHITE, 0.35);
    this.shake = Math.max(this.shake, 1.2);
    switch (type) {
      case 'fireworks': {
        this.flash(p, team, 14, 0.5, 30);
        this.burst(p, 150, [4, 14], hot, team, [0.4, 0.9], [0.5, 1.2], { gravity: 4 });
        const colors = [team, accent, new THREE.Color(1, 0.3, 0.6), new THREE.Color(0.4, 1, 0.5), new THREE.Color(1, 0.9, 0.3)];
        for (let k = 0; k < 9; k++) {
          const target = new THREE.Vector3(p.x + rnd(-14, 14), rnd(12, 19), p.z - Math.sign(p.z) * rnd(4, 18));
          const col = colors[k % colors.length];
          const delay = 0.1 + k * 0.16;
          const flight = 0.7;
          this.later(delay, () => {
            // rocket trail
            for (let i = 0; i < 30; i++) {
              const t = i / 30;
              this.later(t * flight, () => {
                const x = p.x + (target.x - p.x) * t, y = p.y + (target.y - p.y) * t, z = p.z + (target.z - p.z) * t;
                this.add.spawn({ x, y, z, vx: rnd(-0.5, 0.5), vy: rnd(-1, 0), vz: rnd(-0.5, 0.5), color: new THREE.Color(1, 0.8, 0.5), life: 0.5, size: 0.35, sizeEnd: 0.05, shape: SHAPE_SPARK });
              });
            }
            this.later(flight, () => {
              this.flash(target, col, 10, 0.4, 20);
              this.burst(target, 260, [6, 11], col.clone().lerp(WHITE, 0.3), col, [0.35, 0.7], [1.0, 1.8], { gravity: 3.5, drag: 1.4, shape: SHAPE_SPARK });
              this.burst(target, 60, [1, 3], WHITE, col, [0.2, 0.4], [1.5, 2.2], { gravity: 1.5, shape: SHAPE_SPARK });
            });
          });
        }
        break;
      }
      case 'singularity': {
        const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x000000 }));
        core.position.copy(p);
        this.group.add(core);
        this.cores.push({ mesh: core, t: 0, life: 1.3 });
        const purple = new THREE.Color(0.6, 0.2, 1);
        for (let i = 0; i < 700 * (this.quality >= 2 ? 1 : 0.5); i++) {
          _v.randomDirection().multiplyScalar(rnd(6, 14)).add(p);
          this.add.spawn({ x: _v.x, y: Math.max(0.2, _v.y), z: _v.z, color: purple.clone().lerp(team, Math.random()), colorEnd: WHITE, life: 0.8, size: 0.3, sizeEnd: 0.05, attract: p, attractStrength: 9, drag: 2.5 });
        }
        this.ring(p, purple, 12, 1, 0.8, false, 0, true);
        this.later(0.85, () => {
          this.shake = 1.8;
          this.flash(p, purple, 30, 0.7, 60);
          this.ring(p, purple, 1, 26, 0.9, false, 0, true);
          this.ring(p.clone().setY(0.2), team, 1, 22, 1.1, true);
          this.burst(p, 600, [10, 30], WHITE, purple, [0.3, 0.8], [0.6, 1.4], { drag: 1.8, shape: SHAPE_SPARK });
          this.burst(p, 200, [2, 8], team, purple, [1.2, 2.4], [1.0, 1.8], { drag: 1.0 });
        });
        break;
      }
      case 'electro': {
        const blue = new THREE.Color(0.4, 0.8, 1);
        this.flash(p, blue, 20, 0.9, 50);
        for (let k = 0; k < 14; k++) {
          const end = new THREE.Vector3(p.x + rnd(-16, 16), Math.random() < 0.6 ? 0 : rnd(2, 12), p.z - Math.sign(p.z) * rnd(0, 16));
          this.later(k * 0.05, () => this.bolt(p, end, k % 3 === 0 ? team : blue, 0.5 + Math.random() * 0.4));
          this.later(k * 0.05 + 0.02, () => this.burst(end, 30, [2, 7], WHITE, blue, [0.2, 0.4], [0.3, 0.7], { gravity: 6, shape: SHAPE_SPARK, floor: true }));
        }
        this.burst(p, 400, [8, 22], WHITE, blue, [0.25, 0.5], [0.4, 1.0], { gravity: 5, shape: SHAPE_SPARK, floor: true });
        this.ring(p, blue, 1, 18, 0.6, false, 0, true);
        this.later(0.3, () => this.flash(p, team, 16, 0.3, 30));
        this.later(0.6, () => this.flash(p, blue, 12, 0.3, 30));
        break;
      }
      case 'confetti': {
        this.flash(p, team, 12, 0.4, 25);
        const cols = [0xff3b6b, 0xffd23b, 0x3bff8a, 0x3bb6ff, 0xb03bff, 0xffffff];
        for (let i = 0; i < 520 * (this.quality >= 2 ? 1 : 0.6); i++) {
          _v.randomDirection();
          _v.y = Math.abs(_v.y) * 1.3 + 0.3;
          _v.multiplyScalar(rnd(6, 18));
          if (Math.sign(_v.z) === Math.sign(p.z)) _v.z *= -0.5;
          _c.setHex(cols[i % cols.length]);
          this.confetti.spawn(p, _v, _c, rnd(0.18, 0.3), rnd(2.5, 4));
        }
        this.burst(p, 200, [4, 12], WHITE, team, [0.3, 0.6], [0.4, 0.9], { shape: SHAPE_SPARK });
        this.later(0.25, () => this.burst(p, 120, [6, 14], accent, team, [0.3, 0.5], [0.5, 1.0], { shape: SHAPE_SPARK, gravity: 4 }));
        break;
      }
      case 'voxel': {
        this.flash(p, team, 16, 0.5, 40);
        for (let i = 0; i < 260 * (this.quality >= 2 ? 1 : 0.6); i++) {
          _v.randomDirection();
          _v.y = Math.abs(_v.y) + 0.2;
          _v.multiplyScalar(rnd(5, 20));
          if (Math.sign(_v.z) === Math.sign(p.z)) _v.z *= -0.6;
          _c.copy(i % 3 === 0 ? accent : team).lerp(WHITE, Math.random() * 0.3);
          this.cubes.spawn(p, _v, _c, rnd(0.25, 0.7), rnd(2.2, 3.5));
        }
        this.burst(p, 120, [5, 12], hot, team, [0.6, 1.2], [0.3, 0.7], { shape: SHAPE_SQUARE });
        this.ring(p.clone().setY(0.15), team, 1, 20, 0.8, true);
        break;
      }
      case 'shockwave': {
        this.flash(p, team, 24, 0.6, 60);
        for (let k = 0; k < 3; k++) {
          this.ring(p, team.clone().lerp(WHITE, k * 0.25), 1, 20 + k * 8, 0.9 + k * 0.2, false, k * 0.18, true);
          this.ring(p.clone().setY(0.2), team, 1, 18 + k * 10, 1.0 + k * 0.2, true, k * 0.18);
        }
        // dust ring along the floor
        for (let i = 0; i < 260 * (this.quality >= 2 ? 1 : 0.5); i++) {
          const a = Math.random() * Math.PI * 2;
          const s = rnd(10, 20);
          this.norm.spawn({ x: p.x, y: 0.4, z: p.z, vx: Math.cos(a) * s, vy: rnd(0.5, 2), vz: Math.sin(a) * s, color: new THREE.Color(0.55, 0.5, 0.45), life: rnd(1, 1.8), size: rnd(1.0, 1.8), sizeEnd: 2.8, drag: 2.2, alpha: 0.3 });
        }
        this.burst(p, 300, [14, 26], WHITE, team, [0.3, 0.6], [0.4, 0.8], { drag: 2, shape: SHAPE_SPARK });
        break;
      }
      case 'inferno': {
        const fire = new THREE.Color(1, 0.55, 0.12);
        const red = new THREE.Color(0.8, 0.1, 0.02);
        this.flash(p, fire, 22, 0.8, 70);
        this.burst(p, 500, [4, 14], new THREE.Color(1, 0.9, 0.5), red, [1.0, 2.2], [0.6, 1.4], { gravity: -3, drag: 1.6 });
        this.burst(p, 200, [2, 6], fire, red, [1.5, 3.0], [1.0, 1.8], { gravity: -5, drag: 1.2 });
        for (let i = 0; i < 160; i++) {
          _v.randomDirection();
          this.norm.spawn({ x: p.x + _v.x * 2, y: p.y + _v.y * 2, z: p.z + _v.z * 2, vx: _v.x * 3, vy: rnd(3, 7), vz: _v.z * 3, color: new THREE.Color(0.15, 0.12, 0.1), life: rnd(2, 3.2), size: rnd(2, 3), sizeEnd: 6, drag: 1, alpha: 0.5 });
        }
        this.burst(p, 200, [8, 20], fire, red, [0.2, 0.35], [1, 2], { gravity: 8, shape: SHAPE_SPARK, floor: true });
        this.ring(p.clone().setY(0.2), fire, 1, 16, 0.8, true);
        break;
      }
      case 'classic':
      default: {
        this.flash(p, team, 22, 0.6, 50);
        this.ring(p, team.clone().lerp(WHITE, 0.4), 1, 22, 0.7, false, 0, true);
        this.ring(p.clone().setY(0.2), team, 1, 16, 0.9, true);
        this.burst(p, 450, [10, 28], WHITE, team, [0.3, 0.7], [0.5, 1.2], { drag: 1.6, shape: SHAPE_SPARK, gravity: 3 });
        this.burst(p, 160, [3, 9], hot, team, [1.5, 3], [0.6, 1.3], { drag: 1.2 });
        for (let i = 0; i < 90; i++) {
          _v.randomDirection();
          this.norm.spawn({ x: p.x, y: p.y, z: p.z, vx: _v.x * 6, vy: _v.y * 4 + 1, vz: _v.z * 6, color: new THREE.Color(0.35, 0.35, 0.4), life: rnd(1.5, 2.5), size: 1.6, sizeEnd: 4, drag: 1.5, alpha: 0.25 });
        }
      }
    }
  }

  demolition(pos: THREE.Vector3, team: THREE.Color) {
    const fire = new THREE.Color(1, 0.55, 0.15);
    this.flash(pos, fire, 10, 0.4, 30);
    this.burst(pos, 180, [4, 14], new THREE.Color(1, 0.9, 0.6), new THREE.Color(0.8, 0.15, 0.02), [0.5, 1.2], [0.4, 0.9], { gravity: -2, drag: 1.5 });
    for (let i = 0; i < 26; i++) {
      _v.randomDirection();
      _v.y = Math.abs(_v.y) + 0.3;
      _v.multiplyScalar(rnd(4, 10));
      _c.copy(team).multiplyScalar(0.6);
      this.cubes.spawn(pos, _v, i % 2 ? _c : _c2.setHex(0x222222), rnd(0.12, 0.3), rnd(1.5, 2.5));
    }
    for (let i = 0; i < 40; i++) {
      _v.randomDirection();
      this.norm.spawn({ x: pos.x, y: pos.y, z: pos.z, vx: _v.x * 2, vy: rnd(1, 3), vz: _v.z * 2, color: new THREE.Color(0.12, 0.12, 0.12), life: rnd(1.2, 2), size: 1.2, sizeEnd: 3, drag: 1, alpha: 0.6 });
    }
    this.shake = Math.max(this.shake, 0.4);
  }

  ballHit(pos: THREE.Vector3, strength: number, color: THREE.Color) {
    if (strength < 6) return;
    const n = Math.min(60, strength * 2);
    this.burst(pos, n, [strength * 0.2, strength * 0.5], WHITE, color, [0.12, 0.25], [0.2, 0.45], { gravity: 8, shape: SHAPE_SPARK });
    if (strength > 18) {
      this.ring(pos, color, 0.8, 4, 0.25, false, 0, true);
      this.shake = Math.max(this.shake, 0.15);
    }
  }

  landDust(pos: THREE.Vector3, amount: number) {
    for (let i = 0; i < amount; i++) {
      const a = Math.random() * Math.PI * 2;
      this.norm.spawn({ x: pos.x, y: 0.15, z: pos.z, vx: Math.cos(a) * 2, vy: 0.4, vz: Math.sin(a) * 2, color: new THREE.Color(0.5, 0.55, 0.45), life: 0.6, size: 0.5, sizeEnd: 1.2, drag: 3, alpha: 0.35 });
    }
  }

  padPickup(pos: THREE.Vector3, big: boolean) {
    const c = new THREE.Color(1, 0.7, 0.2);
    this.burst(pos, big ? 60 : 14, [2, big ? 7 : 4], new THREE.Color(1, 0.95, 0.7), c, [0.15, 0.3], [0.3, 0.6], { up: 0.8, shape: SHAPE_SPARK, gravity: 4 });
  }

  /** Emit boost exhaust for one car this frame. */
  boost(type: BoostId, origin: THREE.Vector3, back: THREE.Vector3, carVel: THREE.Vector3, team: THREE.Color, accent: THREE.Color, dt: number) {
    const rate = this.quality >= 2 ? 180 : this.quality === 1 ? 110 : 60;
    const n = Math.max(1, Math.round(rate * dt));
    for (let i = 0; i < n; i++) {
      const jitter = 0.06;
      const x = origin.x + rnd(-jitter, jitter);
      const y = origin.y + rnd(-jitter, jitter);
      const z = origin.z + rnd(-jitter, jitter);
      const s = rnd(4, 8);
      const vx = back.x * s + carVel.x * 0.3 + rnd(-0.6, 0.6);
      const vy = back.y * s + carVel.y * 0.3 + rnd(-0.6, 0.6);
      const vz = back.z * s + carVel.z * 0.3 + rnd(-0.6, 0.6);
      switch (type) {
        case 'neon':
          this.add.spawn({ x, y, z, vx: vx * 0.5, vy: vy * 0.5, vz: vz * 0.5, color: accent.clone().multiplyScalar(2), colorEnd: team, life: 0.45, size: 0.4, sizeEnd: 0.15, drag: 3 });
          break;
        case 'plasma':
          this.add.spawn({ x, y, z, vx, vy, vz, color: new THREE.Color(0.7, 0.4, 2), colorEnd: new THREE.Color(0.1, 0.4, 1), life: 0.35, size: 0.45, sizeEnd: 0.05, drag: 2 });
          if (Math.random() < 0.3) this.add.spawn({ x, y, z, vx: vx + rnd(-3, 3), vy: vy + rnd(-3, 3), vz: vz + rnd(-3, 3), color: WHITE, colorEnd: new THREE.Color(0.6, 0.3, 1), life: 0.3, size: 0.15, shape: SHAPE_SPARK });
          break;
        case 'sparkle':
          if (i % 2 === 0) this.add.spawn({ x, y, z, vx: vx * 0.4 + rnd(-1, 1), vy: vy * 0.4 + rnd(-1, 1), vz: vz * 0.4 + rnd(-1, 1), color: new THREE.Color(1.6, 1.4, 0.8), colorEnd: accent, life: rnd(0.5, 0.9), size: rnd(0.2, 0.4), sizeEnd: 0.05, drag: 2, shape: SHAPE_SPARK, gravity: 1 });
          break;
        case 'bubbles':
          if (i % 2 === 0) this.norm.spawn({ x, y, z, vx: vx * 0.3, vy: vy * 0.3 + 0.8, vz: vz * 0.3, color: new THREE.Color(0.7, 0.9, 1), life: rnd(0.6, 1.1), size: rnd(0.2, 0.45), sizeEnd: 0.5, drag: 2.5, shape: SHAPE_RING, alpha: 0.9, gravity: -1.5 });
          break;
        case 'lightning':
          this.add.spawn({ x, y, z, vx: vx + rnd(-4, 4), vy: vy + rnd(-4, 4), vz: vz + rnd(-4, 4), color: new THREE.Color(1.2, 1.5, 2), colorEnd: team, life: 0.18, size: 0.25, sizeEnd: 0.05, shape: SHAPE_SPARK });
          break;
        case 'rainbow': {
          _c.setHSL((this.time * 0.8 + i * 0.01) % 1, 1, 0.6).multiplyScalar(1.8);
          this.add.spawn({ x, y, z, vx: vx * 0.6, vy: vy * 0.6, vz: vz * 0.6, color: _c, life: 0.5, size: 0.45, sizeEnd: 0.1, drag: 2.5 });
          break;
        }
        case 'flame':
        default:
          this.add.spawn({ x, y, z, vx, vy, vz, color: new THREE.Color(1.6, 1.0, 0.4), colorEnd: new THREE.Color(0.8, 0.12, 0.02), life: 0.28, size: 0.5, sizeEnd: 0.1, drag: 2 });
          if (i % 3 === 0) this.norm.spawn({ x, y, z, vx: vx * 0.4, vy: vy * 0.4 + 0.6, vz: vz * 0.4, color: new THREE.Color(0.25, 0.25, 0.28), life: 0.8, size: 0.4, sizeEnd: 1.4, drag: 2, alpha: 0.35 });
      }
    }
  }

  /** Streaks behind a supersonic car. */
  supersonic(origin: THREE.Vector3, carVel: THREE.Vector3) {
    if (Math.random() > 0.6) return;
    this.add.spawn({ x: origin.x + rnd(-0.3, 0.3), y: origin.y + rnd(0, 0.3), z: origin.z + rnd(-0.3, 0.3), vx: carVel.x * 0.1, vy: 0, vz: carVel.z * 0.1, color: new THREE.Color(1.2, 1.2, 1.4), life: 0.25, size: 0.18, sizeEnd: 0.02 });
  }

  ballTrail(pos: THREE.Vector3, speed: number, color: THREE.Color) {
    if (speed < 25) return;
    const k = Math.min(1, (speed - 25) / 30);
    this.add.spawn({ x: pos.x + rnd(-0.3, 0.3), y: pos.y + rnd(-0.3, 0.3), z: pos.z + rnd(-0.3, 0.3), color: color.clone().multiplyScalar(1 + k), life: 0.3, size: 1.2 * k + 0.3, sizeEnd: 0.1, alpha: 0.5 * k });
  }

  update(dt: number) {
    this.time += dt;
    for (let i = this.timers.length - 1; i >= 0; i--) {
      if (this.timers[i].at <= this.time) {
        const t = this.timers[i];
        this.timers.splice(i, 1);
        t.fn();
      }
    }
    this.add.update(dt);
    this.norm.update(dt);
    this.cubes.update(dt, 9, 0);
    this.confetti.update(dt, 2.2, 5);
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      if (r.delay > 0) {
        r.delay -= dt;
        r.mesh.visible = r.delay <= 0;
        continue;
      }
      r.t += dt;
      const k = r.t / r.life;
      const e = 1 - Math.pow(1 - Math.min(1, k), 3);
      r.mesh.scale.setScalar(r.from + (r.to - r.from) * e);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - k);
      if (k >= 1) {
        this.group.remove(r.mesh);
        (r.mesh.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
      }
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      const k = f.t / f.life;
      f.sprite.material.opacity = Math.max(0, 1 - k);
      f.sprite.scale.setScalar(f.size * (1 + k * 0.5));
      f.light.intensity *= 0.9;
      if (k >= 1) {
        this.group.remove(f.sprite, f.light);
        f.sprite.material.dispose();
        f.light.dispose();
        this.flashes.splice(i, 1);
      }
    }
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.t += dt;
      b.regen -= dt;
      if (b.regen <= 0) {
        b.regen = 0.05;
        this.regenBolt(b);
      }
      (b.line.material as THREE.LineBasicMaterial).opacity = Math.random() * (1 - b.t / b.life);
      if (b.t >= b.life) {
        this.group.remove(b.line);
        b.line.geometry.dispose();
        (b.line.material as THREE.Material).dispose();
        this.bolts.splice(i, 1);
      }
    }
    for (let i = this.cores.length - 1; i >= 0; i--) {
      const c = this.cores[i];
      c.t += dt;
      const k = c.t / c.life;
      c.mesh.scale.setScalar(k < 0.65 ? 0.3 + k * 2.5 : Math.max(0.01, (1 - k) * 6));
      c.mesh.rotation.y += dt * 3;
      if (k >= 1) {
        this.group.remove(c.mesh);
        c.mesh.geometry.dispose();
        this.cores.splice(i, 1);
      }
    }
    this.shake = Math.max(0, this.shake - dt * 2.2);
  }

  clear() {
    this.add.clear();
    this.norm.clear();
  }
}
