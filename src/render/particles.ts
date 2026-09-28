import * as THREE from 'three';

export const SHAPE_SOFT = 0;
export const SHAPE_SQUARE = 1;
export const SHAPE_RING = 2;
export const SHAPE_SPARK = 3;

export interface SpawnOpts {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  color: THREE.Color;
  colorEnd?: THREE.Color;
  life: number;
  size: number;
  sizeEnd?: number;
  gravity?: number;
  drag?: number;
  alpha?: number;
  shape?: number;
  /** attraction towards a point (for implosions) */
  attract?: THREE.Vector3;
  attractStrength?: number;
  floor?: boolean;
}

const vert = `
attribute float aSize;
attribute float aAlpha;
attribute float aShape;
attribute vec3 aColor;
varying vec3 vColor;
varying float vAlpha;
varying float vShape;
uniform float uScale;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vShape = aShape;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aAlpha <= 0.0 ? 0.0 : clamp(aSize * uScale / max(0.1, -mv.z), 0.0, 256.0);
}`;

const frag = `
varying vec3 vColor;
varying float vAlpha;
varying float vShape;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float d = length(p);
  float a;
  if (vShape < 0.5) {
    a = smoothstep(0.5, 0.0, d);
    a *= a;
  } else if (vShape < 1.5) {
    a = step(max(abs(p.x), abs(p.y)), 0.42);
  } else if (vShape < 2.5) {
    a = smoothstep(0.08, 0.0, abs(d - 0.36));
  } else {
    float cross = max(smoothstep(0.1, 0.0, abs(p.x)) * smoothstep(0.5, 0.0, abs(p.y)), smoothstep(0.1, 0.0, abs(p.y)) * smoothstep(0.5, 0.0, abs(p.x)));
    a = max(cross, smoothstep(0.25, 0.0, d));
  }
  if (a * vAlpha < 0.004) discard;
  gl_FragColor = vec4(vColor, a * vAlpha);
}`;

/** CPU-simulated point particles rendered in a single draw call. */
export class ParticleSystem {
  readonly points: THREE.Points;
  private cap: number;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private shape: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private a0: Float32Array;
  private c0: Float32Array;
  private c1: Float32Array;
  private att: Float32Array;
  private floorFlag: Uint8Array;
  private cursor = 0;
  private uniforms = { uScale: { value: 800 } };
  alive = 0;

  constructor(capacity: number, additive: boolean) {
    this.cap = capacity;
    const n = capacity;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.shape = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.s0 = new Float32Array(n);
    this.s1 = new Float32Array(n);
    this.a0 = new Float32Array(n);
    this.c0 = new Float32Array(n * 3);
    this.c1 = new Float32Array(n * 3);
    this.att = new Float32Array(n * 4);
    this.floorFlag = new Uint8Array(n);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aShape', new THREE.BufferAttribute(this.shape, 1).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 10 : 9;
  }

  setScale(viewportHeightPx: number, fovDeg: number) {
    this.uniforms.uScale.value = viewportHeightPx / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  }

  spawn(o: SpawnOpts) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.cap;
    const i3 = i * 3;
    this.pos[i3] = o.x;
    this.pos[i3 + 1] = o.y;
    this.pos[i3 + 2] = o.z;
    this.vel[i3] = o.vx ?? 0;
    this.vel[i3 + 1] = o.vy ?? 0;
    this.vel[i3 + 2] = o.vz ?? 0;
    this.c0[i3] = o.color.r;
    this.c0[i3 + 1] = o.color.g;
    this.c0[i3 + 2] = o.color.b;
    const ce = o.colorEnd ?? o.color;
    this.c1[i3] = ce.r;
    this.c1[i3 + 1] = ce.g;
    this.c1[i3 + 2] = ce.b;
    this.life[i] = o.life;
    this.maxLife[i] = o.life;
    this.s0[i] = o.size;
    this.s1[i] = o.sizeEnd ?? o.size;
    this.a0[i] = o.alpha ?? 1;
    this.grav[i] = o.gravity ?? 0;
    this.drag[i] = o.drag ?? 0;
    this.shape[i] = o.shape ?? SHAPE_SOFT;
    this.floorFlag[i] = o.floor ? 1 : 0;
    if (o.attract) {
      this.att[i * 4] = o.attract.x;
      this.att[i * 4 + 1] = o.attract.y;
      this.att[i * 4 + 2] = o.attract.z;
      this.att[i * 4 + 3] = o.attractStrength ?? 0;
    } else this.att[i * 4 + 3] = 0;
    this.size[i] = o.size;
    this.alpha[i] = this.a0[i];
    this.col[i3] = o.color.r;
    this.col[i3 + 1] = o.color.g;
    this.col[i3 + 2] = o.color.b;
  }

  update(dt: number) {
    let alive = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) this.alpha[i] = 0;
        continue;
      }
      alive++;
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];
      const i3 = i * 3;
      const drag = Math.max(0, 1 - this.drag[i] * dt);
      let vx = this.vel[i3] * drag;
      let vy = this.vel[i3 + 1] * drag - this.grav[i] * dt;
      let vz = this.vel[i3 + 2] * drag;
      const as = this.att[i * 4 + 3];
      if (as !== 0) {
        vx += (this.att[i * 4] - this.pos[i3]) * as * dt;
        vy += (this.att[i * 4 + 1] - this.pos[i3 + 1]) * as * dt;
        vz += (this.att[i * 4 + 2] - this.pos[i3 + 2]) * as * dt;
      }
      this.pos[i3] += vx * dt;
      this.pos[i3 + 1] += vy * dt;
      this.pos[i3 + 2] += vz * dt;
      if (this.floorFlag[i] && this.pos[i3 + 1] < 0.05) {
        this.pos[i3 + 1] = 0.05;
        vy = Math.abs(vy) * 0.3;
        vx *= 0.7;
        vz *= 0.7;
      }
      this.vel[i3] = vx;
      this.vel[i3 + 1] = vy;
      this.vel[i3 + 2] = vz;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      // fade in quickly, fade out towards the end
      this.alpha[i] = this.a0[i] * Math.min(1, t * 12) * (1 - t * t);
      this.col[i3] = this.c0[i3] + (this.c1[i3] - this.c0[i3]) * t;
      this.col[i3 + 1] = this.c0[i3 + 1] + (this.c1[i3 + 1] - this.c0[i3 + 1]) * t;
      this.col[i3 + 2] = this.c0[i3 + 2] + (this.c1[i3 + 2] - this.c0[i3 + 2]) * t;
    }
    this.alive = alive;
    const g = this.points.geometry;
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.aShape as THREE.BufferAttribute).needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
  }
}

/** Instanced tumbling cubes / confetti quads with simple floor bounces. */
export class DebrisSystem {
  readonly mesh: THREE.InstancedMesh;
  private cap: number;
  private data: Float32Array; // per instance: px py pz vx vy vz rx ry rz wx wy wz life max scale
  private cursor = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private stride = 15;

  constructor(capacity: number, geometry: THREE.BufferGeometry, material: THREE.Material) {
    this.cap = capacity;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.data = new Float32Array(capacity * this.stride);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, zero);
      this.mesh.setColorAt(i, white);
    }
  }

  spawn(p: THREE.Vector3, v: THREE.Vector3, color: THREE.Color, scale: number, life: number) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.cap;
    const d = this.data;
    const o = i * this.stride;
    d[o] = p.x; d[o + 1] = p.y; d[o + 2] = p.z;
    d[o + 3] = v.x; d[o + 4] = v.y; d[o + 5] = v.z;
    d[o + 6] = Math.random() * 6; d[o + 7] = Math.random() * 6; d[o + 8] = Math.random() * 6;
    d[o + 9] = (Math.random() - 0.5) * 16; d[o + 10] = (Math.random() - 0.5) * 16; d[o + 11] = (Math.random() - 0.5) * 16;
    d[o + 12] = life; d[o + 13] = life; d[o + 14] = scale;
    this.mesh.setColorAt(i, color);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number, gravity = 9, flutter = 0) {
    const d = this.data;
    let any = false;
    for (let i = 0; i < this.cap; i++) {
      const o = i * this.stride;
      if (d[o + 12] <= 0) continue;
      any = true;
      d[o + 12] -= dt;
      const drag = 1 - (flutter > 0 ? 2.2 : 0.3) * dt;
      d[o + 3] *= drag;
      d[o + 5] *= drag;
      d[o + 4] = d[o + 4] * drag - gravity * dt;
      if (flutter > 0) {
        d[o + 3] += Math.sin(d[o + 12] * 7 + i) * flutter * dt;
        d[o + 5] += Math.cos(d[o + 12] * 6 + i) * flutter * dt;
      }
      d[o] += d[o + 3] * dt;
      d[o + 1] += d[o + 4] * dt;
      d[o + 2] += d[o + 5] * dt;
      const sc = d[o + 14];
      if (d[o + 1] < sc * 0.5) {
        d[o + 1] = sc * 0.5;
        d[o + 4] = Math.abs(d[o + 4]) * 0.35;
        d[o + 3] *= 0.6;
        d[o + 5] *= 0.6;
        d[o + 9] *= 0.6;
        d[o + 11] *= 0.6;
      }
      d[o + 6] += d[o + 9] * dt;
      d[o + 7] += d[o + 10] * dt;
      d[o + 8] += d[o + 11] * dt;
      const t = d[o + 12] / d[o + 13];
      const k = sc * Math.min(1, t * 4);
      this.e.set(d[o + 6], d[o + 7], d[o + 8]);
      this.q.setFromEuler(this.e);
      this.v.set(d[o], d[o + 1], d[o + 2]);
      this.s.set(k, k, k);
      this.m4.compose(this.v, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m4);
      if (d[o + 12] <= 0) {
        this.m4.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.m4);
      }
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
