import * as THREE from 'three';
import { WHEELS } from '../physics/car';
import { TEAM_SHADES, type BodyId, type Loadout, type TopperId, type WheelId } from '../game/types';

/*
 * Low-poly car bodies.
 *
 * Each hull is lofted through a handful of cross-sections (front to back) and mirrored, so the
 * cabin, windscreen and side glass come out of the same surface. Flared arches, side pods,
 * lights and the per-body parts (wings, fins, bumpers…) are added on top. Everything is flat
 * shaded, around 2k triangles per car including wheels.
 *
 * Body space: x forward, y up, z right; y = 0 is 7 cm above the ground.
 */

type P = [number, number];
type Zone = 'body' | 'glass' | 'roof';

/** Cross-section: half profile as (z, y) points from bottom centre, round the side, to top centre. */
interface Section {
  x: number;
  pts: P[];
  /** what the span from this section to the next one is (hood / windscreen / roof) */
  zone: Zone;
}

const STRIPE = 0.055;

/**
 * Build a cross-section from its key lines: bottom, tub (inboard of the wheels), shoulder
 * (widest line, over the wheels), belt (top of the doors) and roof edge / centre line.
 */
function sec(x: number, yb: number, wb: number, wt: number, yt: number, ws: number, ys: number, wd: number, yd: number, wr: number, yr: number, yc: number, zone: Zone = 'body'): Section {
  const crown = (z: number) => yc - (yc - yr) * (z / wr) * (z / wr);
  return {
    x,
    zone,
    pts: [
      [0, yb],
      [wb, yb],
      [wt, yt],
      [ws, ys],
      [wd, yd],
      [wr, yr],
      [Math.min(STRIPE, wr * 0.5), crown(Math.min(STRIPE, wr * 0.5))],
      [0, yc],
    ],
  };
}

interface Light {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  /** tilt back from vertical (rad) */
  tilt: number;
}

interface BodyDef {
  secs: Section[];
  stripe: boolean;
  /** all-glass canopy instead of a painted roof */
  canopy?: boolean;
  /** arches in dark cladding instead of paint */
  cladding?: boolean;
  headlight: Light;
  taillight: Light;
  exhaust: P;
  mirror?: P;
  details(k: Kit): void;
}

/** Everything a body's detail function needs. */
interface Kit {
  m: Materials;
  add(geo: THREE.BufferGeometry, mat: THREE.Material, shadow?: boolean): THREE.Mesh;
}

// ── geometry helpers ─────────────────────────────────────────────────────────

/** Triangle soup collected per material, turned into one mesh per material. */
class Soup {
  private map = new Map<THREE.Material, number[]>();
  private e1 = new THREE.Vector3();
  private e2 = new THREE.Vector3();

  tri(mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
    if (this.e1.subVectors(b, a).cross(this.e2.subVectors(c, a)).lengthSq() < 1e-12) return;
    let arr = this.map.get(mat);
    if (!arr) this.map.set(mat, (arr = []));
    arr.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }

  quad(mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) {
    this.tri(mat, a, b, c);
    this.tri(mat, a, c, d);
  }

  meshes() {
    const out: THREE.Mesh[] = [];
    for (const [mat, arr] of this.map) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      g.computeVertexNormals();
      out.push(new THREE.Mesh(g, mat));
    }
    return out;
  }
}

const v3 = (x: number, [z, y]: P, side: number) => new THREE.Vector3(x, y, z * side);

/** Point `j` of the hull profile at `x` (interpolated between sections). */
function pointAt(secs: Section[], x: number, j: number): P {
  for (let i = 0; i < secs.length - 1; i++) {
    const a = secs[i];
    const b = secs[i + 1];
    if (x >= a.x && x <= b.x) {
      const t = (x - a.x) / (b.x - a.x);
      return [a.pts[j][0] + (b.pts[j][0] - a.pts[j][0]) * t, a.pts[j][1] + (b.pts[j][1] - a.pts[j][1]) * t];
    }
  }
  return secs[x < secs[0].x ? 0 : secs.length - 1].pts[j];
}

/** Loft the mirrored hull through its sections and cap both ends. */
function loftHull(soup: Soup, def: BodyDef, m: Materials) {
  const { secs } = def;
  const segMat = (zone: Zone, j: number): THREE.Material => {
    if (j <= 1) return m.dark; // underbody + tub
    if (j === 2) return m.lower; // underside of the shoulder, over the wheels
    if (j === 3) return m.paint;
    const top = def.stripe && j === 6 ? m.accent : m.paint;
    if (zone === 'glass') return j === 4 ? m.paint : m.glass;
    if (zone === 'roof') return j === 4 || def.canopy ? m.glass : top;
    return top;
  };
  for (let i = 0; i < secs.length - 1; i++) {
    const A = secs[i];
    const B = secs[i + 1];
    for (let j = 0; j < A.pts.length - 1; j++) {
      const mat = segMat(A.zone, j);
      for (const s of [1, -1]) {
        const a = v3(A.x, A.pts[j], s);
        const b = v3(B.x, B.pts[j], s);
        const c = v3(B.x, B.pts[j + 1], s);
        const d = v3(A.x, A.pts[j + 1], s);
        // winding keeps normals pointing out on both mirrored halves
        if (s > 0) soup.quad(mat, a, b, c, d);
        else soup.quad(mat, a, d, c, b);
      }
    }
  }
  capSection(soup, secs[0], -1, m.dark);
  capSection(soup, secs[secs.length - 1], 1, m.dark);
}

/** Close the hull at a section with a flat face facing `dir` along x. */
function capSection(soup: Soup, s: Section, dir: number, mat: THREE.Material) {
  const ring: THREE.Vector2[] = [];
  for (const [z, y] of s.pts) ring.push(new THREE.Vector2(z, y));
  for (let i = s.pts.length - 2; i >= 1; i--) ring.push(new THREE.Vector2(-s.pts[i][0], s.pts[i][1]));
  const tris = THREE.ShapeUtils.triangulateShape(ring, []);
  const n = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  for (const [i0, i1, i2] of tris) {
    const a = new THREE.Vector3(s.x, ring[i0].y, ring[i0].x);
    const b = new THREE.Vector3(s.x, ring[i1].y, ring[i1].x);
    const c = new THREE.Vector3(s.x, ring[i2].y, ring[i2].x);
    n.subVectors(b, a).cross(e1.subVectors(c, a));
    if (n.x * dir >= 0) soup.tri(mat, a, b, c);
    else soup.tri(mat, a, c, b);
  }
}

/** A side-view polygon (x, y) extruded across z0..z1. */
function slab(points: P[], z0: number, z1: number, bevel = 0) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const depth = Math.max(0.001, z1 - z0 - bevel * 2);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 1 });
  g.translate(0, 0, z0 + bevel);
  return g;
}

/** Arch over a wheel: ring sector around (cx, cy) between radii r0 and r1, across z0..z1. */
function arch(cx: number, cy: number, r0: number, r1: number, z0: number, z1: number, seg = 7, a0 = 0.1, a1 = Math.PI - 0.1) {
  const pts: P[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = a0 + ((a1 - a0) * i) / seg;
    pts.push([cx + Math.cos(a) * r1, cy + Math.sin(a) * r1]);
  }
  for (let i = seg; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / seg;
    pts.push([cx + Math.cos(a) * r0, cy + Math.sin(a) * r0]);
  }
  return slab(pts, z0, z1, 0.008);
}

function box(w: number, h: number, d: number, x: number, y: number, z: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Mirror a geometry across z (returns a new one with fixed winding). */
function mirrorZ(g: THREE.BufferGeometry) {
  const c = g.clone();
  c.scale(1, 1, -1);
  // flip triangle winding so the faces still point outwards
  const idx = c.getIndex();
  if (idx) {
    const a = idx.array as Uint16Array | Uint32Array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = t;
    }
    idx.needsUpdate = true;
  } else {
    const p = c.getAttribute('position');
    for (let i = 0; i < p.count; i += 3) {
      const x = p.getX(i + 1), y = p.getY(i + 1), z = p.getZ(i + 1);
      p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
      p.setXYZ(i + 2, x, y, z);
    }
  }
  c.computeVertexNormals();
  return c;
}

// ── wheel geometry (shared by all bodies) ────────────────────────────────────
const FRONT = WHEELS.find((w) => w.front)!;
const REAR = WHEELS.find((w) => !w.front)!;
const GROUND = -0.07; // ground height in body space
const FRONT_W = 0.13;
const REAR_W = 0.15;
const WHEEL_OUT = 0.04; // visual wheels sit a little wider than the physics ones
const FW = { x: FRONT.x, y: GROUND + FRONT.radius, r: FRONT.radius, z: Math.abs(FRONT.z) + WHEEL_OUT, w: FRONT_W };
const RW = { x: REAR.x, y: GROUND + REAR.radius, r: REAR.radius, z: Math.abs(REAR.z) + WHEEL_OUT, w: REAR_W };

// ── bodies ───────────────────────────────────────────────────────────────────
const BODIES: Record<BodyId, BodyDef> = {
  // balanced all-rounder: fastback cabin, big rear wing, centre stripe
  breaker: {
    secs: [
      sec(-0.62, 0.07, 0.16, 0.21, 0.13, 0.33, 0.24, 0.315, 0.3, 0.22, 0.31, 0.315),
      sec(-0.57, 0.03, 0.19, 0.24, 0.11, 0.385, 0.25, 0.36, 0.325, 0.25, 0.335, 0.34),
      sec(-0.45, 0.01, 0.2, 0.24, 0.1, 0.405, 0.26, 0.375, 0.335, 0.33, 0.345, 0.355, 'glass'),
      sec(-0.27, 0, 0.2, 0.24, 0.1, 0.405, 0.26, 0.375, 0.34, 0.255, 0.47, 0.485, 'roof'),
      sec(-0.03, 0, 0.2, 0.24, 0.1, 0.4, 0.26, 0.37, 0.34, 0.25, 0.475, 0.49, 'glass'),
      sec(0.2, 0, 0.2, 0.23, 0.1, 0.39, 0.25, 0.36, 0.315, 0.3, 0.325, 0.34),
      sec(0.42, 0, 0.19, 0.22, 0.09, 0.38, 0.225, 0.345, 0.28, 0.25, 0.295, 0.305),
      sec(0.62, 0.02, 0.18, 0.2, 0.08, 0.36, 0.18, 0.32, 0.215, 0.22, 0.225, 0.23),
      sec(0.73, 0.05, 0.14, 0.16, 0.08, 0.3, 0.13, 0.27, 0.155, 0.18, 0.16, 0.165),
    ],
    stripe: true,
    headlight: { x: 0.69, y: 0.175, z: 0.225, w: 0.1, h: 0.035, tilt: 1.0 },
    taillight: { x: -0.617, y: 0.255, z: 0.21, w: 0.13, h: 0.03, tilt: 0.1 },
    exhaust: [-0.62, 0.12],
    mirror: [0.17, 0.35],
    details({ add, m }) {
      // rear wing on two struts, with end plates
      const wing = slab([[-0.62, 0.465], [-0.47, 0.49], [-0.46, 0.505], [-0.62, 0.49]], -0.37, 0.37, 0.006);
      add(wing, m.accent);
      for (const s of [-1, 1]) {
        add(slab([[-0.56, 0.33], [-0.52, 0.33], [-0.53, 0.48], [-0.57, 0.48]], s * 0.2 - 0.012, s * 0.2 + 0.012), m.dark);
        add(slab([[-0.64, 0.44], [-0.45, 0.47], [-0.45, 0.53], [-0.62, 0.52]], s * 0.37 - (s > 0 ? 0 : 0.015), s * 0.37 + (s > 0 ? 0.015 : 0)), m.paint);
      }
      // splitter + diffuser
      add(slab([[0.66, 0.02], [0.77, 0.035], [0.77, 0.05], [0.66, 0.05]], -0.26, 0.26), m.dark);
      add(slab([[-0.66, 0.02], [-0.55, 0.02], [-0.55, 0.1], [-0.63, 0.1]], -0.28, 0.28), m.dark);
      // hood vents
      for (const s of [-1, 1]) add(slab([[0.3, 0.3], [0.44, 0.285], [0.44, 0.297], [0.3, 0.312]], s * 0.17 - 0.035, s * 0.17 + 0.035), m.dark);
    },
  },

  // long, low wedge with a raked screen, ducktail and splitter
  wedge: {
    secs: [
      sec(-0.64, 0.06, 0.18, 0.23, 0.12, 0.36, 0.2, 0.35, 0.29, 0.25, 0.31, 0.315),
      sec(-0.58, 0.02, 0.2, 0.25, 0.1, 0.41, 0.22, 0.385, 0.27, 0.27, 0.285, 0.29),
      sec(-0.44, 0, 0.2, 0.25, 0.1, 0.42, 0.23, 0.39, 0.27, 0.34, 0.28, 0.285, 'glass'),
      sec(-0.24, 0, 0.2, 0.25, 0.1, 0.42, 0.23, 0.39, 0.27, 0.27, 0.37, 0.38, 'roof'),
      sec(-0.08, 0, 0.2, 0.25, 0.1, 0.42, 0.23, 0.39, 0.27, 0.27, 0.375, 0.385, 'glass'),
      sec(0.27, 0, 0.2, 0.24, 0.09, 0.41, 0.21, 0.38, 0.235, 0.32, 0.245, 0.255),
      sec(0.5, 0, 0.19, 0.22, 0.08, 0.4, 0.18, 0.36, 0.195, 0.26, 0.205, 0.21),
      sec(0.7, 0.02, 0.18, 0.2, 0.06, 0.38, 0.12, 0.34, 0.13, 0.24, 0.135, 0.14),
      sec(0.8, 0.03, 0.15, 0.17, 0.05, 0.34, 0.07, 0.31, 0.08, 0.2, 0.085, 0.09),
    ],
    stripe: false,
    headlight: { x: 0.745, y: 0.105, z: 0.25, w: 0.12, h: 0.025, tilt: 1.25 },
    taillight: { x: -0.643, y: 0.25, z: 0.2, w: 0.2, h: 0.028, tilt: 0.05 },
    exhaust: [-0.64, 0.12],
    mirror: [0.24, 0.26],
    details({ add, m }) {
      // ducktail lip and splitter in the accent colour
      add(slab([[-0.66, 0.3], [-0.6, 0.29], [-0.6, 0.305], [-0.665, 0.325]], -0.33, 0.33), m.accent);
      add(slab([[0.76, 0.01], [0.84, 0.02], [0.84, 0.035], [0.76, 0.035]], -0.29, 0.29), m.accent);
      // side intakes ahead of the rear arches
      for (const s of [-1, 1]) {
        const g = slab([[-0.14, 0.08], [0.02, 0.08], [-0.04, 0.2], [-0.14, 0.2]], 0.35, 0.405);
        add(s > 0 ? g : mirrorZ(g), m.dark);
      }
      // rear diffuser
      add(slab([[-0.68, 0.02], [-0.56, 0.02], [-0.56, 0.09], [-0.65, 0.09]], -0.3, 0.3), m.dark);
    },
  },

  // tall, boxy truck with bumpers, cladding and a light bar
  titan: {
    secs: [
      sec(-0.63, 0.06, 0.2, 0.26, 0.14, 0.4, 0.28, 0.39, 0.36, 0.3, 0.37, 0.375),
      sec(-0.585, 0.03, 0.22, 0.27, 0.12, 0.42, 0.29, 0.405, 0.37, 0.37, 0.375, 0.38, 'glass'),
      sec(-0.52, 0.02, 0.22, 0.27, 0.12, 0.42, 0.29, 0.405, 0.37, 0.31, 0.555, 0.565, 'roof'),
      sec(0.1, 0, 0.22, 0.27, 0.12, 0.42, 0.29, 0.405, 0.37, 0.31, 0.56, 0.57, 'glass'),
      sec(0.27, 0, 0.22, 0.27, 0.11, 0.42, 0.28, 0.4, 0.35, 0.34, 0.36, 0.37),
      sec(0.62, 0, 0.21, 0.26, 0.1, 0.41, 0.26, 0.39, 0.325, 0.3, 0.335, 0.34),
      sec(0.71, 0.03, 0.2, 0.24, 0.1, 0.39, 0.22, 0.37, 0.28, 0.28, 0.29, 0.295),
    ],
    stripe: false,
    cladding: true,
    headlight: { x: 0.713, y: 0.225, z: 0.25, w: 0.1, h: 0.05, tilt: 0.35 },
    taillight: { x: -0.633, y: 0.29, z: 0.3, w: 0.06, h: 0.08, tilt: 0 },
    exhaust: [-0.66, 0.1],
    mirror: [0.24, 0.39],
    details({ add, m }) {
      // bumpers
      add(slab([[0.68, 0.02], [0.8, 0.03], [0.8, 0.15], [0.68, 0.16]], -0.44, 0.44, 0.01), m.dark);
      add(slab([[-0.7, 0.03], [-0.6, 0.02], [-0.6, 0.15], [-0.7, 0.14]], -0.43, 0.43, 0.01), m.dark);
      // tow hooks
      for (const s of [-1, 1]) add(box(0.05, 0.04, 0.04, 0.82, 0.08, s * 0.28), m.accent);
      // roof rack + light bar
      for (const s of [-1, 1]) add(box(0.5, 0.025, 0.025, -0.2, 0.585, s * 0.26), m.dark);
      add(box(0.05, 0.05, 0.5, 0.06, 0.6, 0), m.dark);
      add(box(0.012, 0.03, 0.44, 0.087, 0.6, 0), m.headlight, false);
      add(box(0.46, 0.02, 0.03, -0.2, 0.6, 0), m.accent);
      // grille bars
      for (let i = 0; i < 3; i++) add(box(0.012, 0.012, 0.3, 0.712, 0.1 + i * 0.045, 0), m.accent, false);
    },
  },

  // sleek fighter: pointed nose, glass canopy, twin fins
  viper: {
    secs: [
      sec(-0.6, 0.07, 0.15, 0.2, 0.13, 0.32, 0.23, 0.3, 0.28, 0.14, 0.29, 0.295),
      sec(-0.54, 0.03, 0.18, 0.23, 0.11, 0.385, 0.24, 0.355, 0.295, 0.16, 0.315, 0.32),
      sec(-0.4, 0.01, 0.19, 0.23, 0.1, 0.4, 0.25, 0.36, 0.3, 0.17, 0.33, 0.335, 'glass'),
      sec(-0.2, 0, 0.19, 0.23, 0.1, 0.4, 0.25, 0.36, 0.3, 0.15, 0.425, 0.445, 'roof'),
      sec(0.02, 0, 0.19, 0.23, 0.1, 0.39, 0.24, 0.35, 0.29, 0.14, 0.42, 0.44, 'glass'),
      sec(0.27, 0, 0.18, 0.21, 0.09, 0.37, 0.22, 0.33, 0.26, 0.15, 0.27, 0.278),
      sec(0.55, 0.01, 0.16, 0.19, 0.08, 0.335, 0.17, 0.29, 0.2, 0.13, 0.207, 0.212),
      sec(0.76, 0.03, 0.1, 0.12, 0.06, 0.2, 0.1, 0.18, 0.115, 0.08, 0.12, 0.123),
      sec(0.88, 0.05, 0.035, 0.045, 0.06, 0.07, 0.075, 0.06, 0.08, 0.03, 0.084, 0.085),
    ],
    stripe: true,
    canopy: true,
    headlight: { x: 0.7, y: 0.14, z: 0.2, w: 0.1, h: 0.02, tilt: 1.3 },
    taillight: { x: -0.603, y: 0.24, z: 0.19, w: 0.14, h: 0.025, tilt: 0.1 },
    exhaust: [-0.61, 0.13],
    details({ add, m }) {
      // twin fins
      for (const s of [-1, 1]) {
        const fin = slab([[-0.62, 0.28], [-0.4, 0.29], [-0.56, 0.5], [-0.66, 0.5]], s * 0.23 - 0.012, s * 0.23 + 0.012);
        add(fin, m.accent);
      }
      // nose canards + intake
      for (const s of [-1, 1]) {
        const g = slab([[0.62, 0.075], [0.74, 0.07], [0.74, 0.082], [0.62, 0.095]], 0.16, 0.27);
        add(s > 0 ? g : mirrorZ(g), m.dark);
      }
      add(slab([[-0.64, 0.03], [-0.54, 0.03], [-0.54, 0.1], [-0.61, 0.1]], -0.24, 0.24), m.dark);
    },
  },
};

export const BODY_NAMES: Record<BodyId, string> = { breaker: 'Breaker', wedge: 'Wedge', titan: 'Titan', viper: 'Viper' };
export const WHEEL_NAMES: Record<WheelId, string> = { classic: 'Classic', spoke: 'Spoke', turbine: 'Turbine', neon: 'Neon Ring', star: 'Star' };
export const TOPPER_NAMES: Record<TopperId, string> = { none: 'None', cone: 'Traffic Cone', crown: 'Crown', halo: 'Halo', antenna: 'Antenna', horns: 'Horns' };

// the body sits this far above the physics origin (origin is 0.17 m above ground at rest)
const BODY_Y = -0.1;

export interface CarVisual {
  root: THREE.Group;
  body: THREE.Group;
  wheels: { pivot: THREE.Group; spin: THREE.Group; front: boolean; radius: number; baseY: number }[];
  flame: THREE.Mesh;
  flameCore: THREE.Mesh;
  exhaustLocal: THREE.Vector3;
  dispose(): void;
}

interface Materials {
  paint: THREE.Material;
  lower: THREE.Material;
  accent: THREE.Material;
  dark: THREE.Material;
  glass: THREE.Material;
  headlight: THREE.Material;
  taillight: THREE.Material;
  wheelGlow: THREE.Material;
  teamGlow: THREE.Material;
  tire: THREE.Material;
  rim: THREE.Material;
}

// ── wheels ───────────────────────────────────────────────────────────────────
function wheelMesh(style: WheelId, radius: number, width: number, m: Materials) {
  const g = new THREE.Group();
  // tyre: lathe with rounded shoulders
  const ri = radius * 0.68;
  const hw = width / 2;
  const prof = [
    new THREE.Vector2(ri, -hw),
    new THREE.Vector2(radius * 0.93, -hw),
    new THREE.Vector2(radius, -hw * 0.6),
    new THREE.Vector2(radius, hw * 0.6),
    new THREE.Vector2(radius * 0.93, hw),
    new THREE.Vector2(ri, hw),
  ];
  const tireGeo = new THREE.LatheGeometry(prof, 16);
  tireGeo.rotateX(Math.PI / 2);
  const tire = new THREE.Mesh(tireGeo, m.tire);
  tire.castShadow = true;
  g.add(tire);

  const face = hw - 0.008;
  const addBoth = (mesh: THREE.Mesh) => {
    const a = mesh.clone();
    a.position.z = face;
    const b = mesh.clone();
    b.position.z = -face;
    b.rotation.y = Math.PI;
    g.add(a, b);
  };
  const disc = (mat: THREE.Material, rr: number, seg: number, depth = 0.012) => {
    const d = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr, depth, seg), mat);
    d.rotation.x = Math.PI / 2;
    return d;
  };
  // rim lip
  const lip = new THREE.Mesh(new THREE.TorusGeometry(ri * 0.97, ri * 0.07, 3, 16), m.rim);
  addBoth(lip);
  const r = ri * 0.95;
  switch (style) {
    case 'classic': {
      addBoth(disc(m.dark, r, 12, 0.006));
      addBoth(disc(m.rim, r * 0.28, 8, 0.024));
      for (let i = 0; i < 5; i++) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(r * 0.95, r * 0.24, 0.018), m.rim);
        s.geometry.translate(r * 0.47, 0, 0);
        s.rotation.z = (i / 5) * Math.PI * 2;
        addBoth(s);
      }
      break;
    }
    case 'spoke': {
      addBoth(disc(m.dark, r, 12, 0.006));
      addBoth(disc(m.rim, r * 0.26, 8, 0.02));
      for (let i = 0; i < 10; i++) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(r * 1.9, r * 0.07, 0.012), m.rim);
        s.rotation.z = (i / 10) * Math.PI + 0.15;
        addBoth(s);
      }
      break;
    }
    case 'turbine': {
      addBoth(disc(m.rim, r, 12));
      for (let i = 0; i < 7; i++) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(r * 0.75, r * 0.15, 0.028), m.wheelGlow);
        const a = (i / 7) * Math.PI * 2;
        s.position.set(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, 0);
        s.rotation.z = a + 0.6;
        addBoth(s);
      }
      addBoth(disc(m.dark, r * 0.22, 6, 0.03));
      break;
    }
    case 'neon': {
      addBoth(disc(m.tire, r * 0.92, 12));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.78, r * 0.09, 4, 16), m.wheelGlow);
      addBoth(ring);
      addBoth(disc(m.rim, r * 0.25, 6, 0.02));
      break;
    }
    case 'star': {
      addBoth(disc(m.dark, r, 12, 0.006));
      const pts: THREE.Vector2[] = [];
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
        const rr = i % 2 ? r * 0.42 : r * 0.98;
        pts.push(new THREE.Vector2(Math.cos(a) * rr, Math.sin(a) * rr));
      }
      const geo = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: 0.014, bevelEnabled: false });
      geo.translate(0, 0, -0.007);
      addBoth(new THREE.Mesh(geo, m.rim));
      break;
    }
  }
  return g;
}

// ── toppers ──────────────────────────────────────────────────────────────────
function topperMesh(id: TopperId, accent: THREE.Color): THREE.Object3D | null {
  const g = new THREE.Group();
  switch (id) {
    case 'none':
      return null;
    case 'cone': {
      const m = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.6, flatShading: true });
      const w = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, flatShading: true });
      const c = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.26, 6), m);
      c.position.y = 0.15;
      const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.068, 0.05, 6), w);
      stripe.position.y = 0.12;
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.025, 0.22), m);
      base.position.y = 0.015;
      g.add(c, stripe, base);
      break;
    }
    case 'crown': {
      const m = new THREE.MeshStandardMaterial({ color: 0xffc629, metalness: 0.9, roughness: 0.25, flatShading: true });
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.11, 0.07, 8, 1, true), m);
      ring.position.y = 0.05;
      g.add(ring);
      const gemMat = new THREE.MeshStandardMaterial({ color: 0xff2255, emissive: 0x660011 });
      for (let i = 0; i < 8; i++) {
        const sp = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.09, 4), m);
        const a = (i / 8) * Math.PI * 2;
        sp.position.set(Math.cos(a) * 0.115, 0.12, Math.sin(a) * 0.115);
        g.add(sp);
        if (i % 2 === 0) {
          const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.018), gemMat);
          gem.position.set(Math.cos(a) * 0.125, 0.05, Math.sin(a) * 0.125);
          g.add(gem);
        }
      }
      break;
    }
    case 'halo': {
      const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.9, 0.5).multiplyScalar(3), toneMapped: false });
      const t = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.018, 6, 20), m);
      t.rotation.x = Math.PI / 2;
      t.position.y = 0.22;
      g.add(t);
      break;
    }
    case 'antenna': {
      const m = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.4 });
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.45, 4), m);
      rod.position.set(-0.05, 0.22, 0.12);
      const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05, 0), new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.8, flatShading: true }));
      ball.position.set(-0.05, 0.46, 0.12);
      g.add(rod, ball);
      break;
    }
    case 'horns': {
      const m = new THREE.MeshStandardMaterial({ color: 0xf2e8d0, roughness: 0.5, flatShading: true });
      for (const s of [-1, 1]) {
        const h = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.2, 5), m);
        h.position.set(0.02, 0.08, s * 0.12);
        h.rotation.x = s * 0.6;
        g.add(h);
      }
      break;
    }
  }
  return g;
}

/** A light lens: thin tilted slab, mirrored to both sides. */
function lights(add: Kit['add'], l: Light, mat: THREE.Material, front: boolean) {
  for (const s of [-1, 1]) {
    const g = new THREE.BoxGeometry(0.014, l.h, l.w);
    g.rotateZ(front ? -l.tilt : l.tilt);
    g.translate(l.x, l.y, s * l.z);
    add(g, mat, false);
  }
}

export function buildCar(loadout: Loadout, team: number): CarVisual {
  const def = BODIES[loadout.body] ?? BODIES.breaker;
  const primary = new THREE.Color(TEAM_SHADES[team as 0 | 1][loadout.shade % 4]);
  const accent = new THREE.Color(loadout.accent);
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = BODY_Y;
  root.add(body);

  const m: Materials = {
    paint: new THREE.MeshPhysicalMaterial({ color: primary, metalness: 0.35, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.25, flatShading: true }),
    lower: new THREE.MeshStandardMaterial({ color: primary.clone().multiplyScalar(0.45), metalness: 0.3, roughness: 0.55, flatShading: true }),
    accent: new THREE.MeshStandardMaterial({ color: accent, metalness: 0.3, roughness: 0.45, flatShading: true }),
    dark: new THREE.MeshStandardMaterial({ color: 0x15171d, metalness: 0.2, roughness: 0.7, flatShading: true }),
    glass: new THREE.MeshStandardMaterial({ color: 0x1a2a44, metalness: 0.7, roughness: 0.08, flatShading: true }),
    headlight: new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 0.95).multiplyScalar(2.2), toneMapped: false }),
    taillight: new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.1, 0.1).multiplyScalar(1.8), toneMapped: false }),
    // wheel accents glow softly (they're on screen all the time)
    wheelGlow: new THREE.MeshStandardMaterial({ color: accent.clone().multiplyScalar(0.6), emissive: accent, emissiveIntensity: 0.55, roughness: 0.5, flatShading: true }),
    teamGlow: new THREE.MeshBasicMaterial({ color: primary.clone().multiplyScalar(1.6), toneMapped: false }),
    tire: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9, flatShading: true }),
    rim: new THREE.MeshStandardMaterial({ color: accent.clone().lerp(new THREE.Color(0x9a9a9a), 0.35), metalness: 0.6, roughness: 0.4, flatShading: true }),
  };

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, shadow = true) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = shadow;
    body.add(mesh);
    return mesh;
  };

  // hull
  const soup = new Soup();
  loftHull(soup, def, m);
  for (const mesh of soup.meshes()) {
    mesh.castShadow = true;
    body.add(mesh);
  }

  // flared arches over the wheels, side pods between them
  const archMat = def.cladding ? m.dark : m.paint;
  for (const s of [-1, 1]) {
    const f = arch(FW.x, FW.y, FW.r + 0.018, FW.r + 0.065, FW.z - FW.w / 2 - 0.02, FW.z + FW.w / 2 + 0.022);
    const r = arch(RW.x, RW.y, RW.r + 0.018, RW.r + 0.068, RW.z - RW.w / 2 - 0.02, RW.z + RW.w / 2 + 0.022);
    add(s > 0 ? f : mirrorZ(f), archMat);
    add(s > 0 ? r : mirrorZ(r), archMat);
    const x0 = RW.x + RW.r + 0.04;
    const x1 = FW.x - FW.r - 0.035;
    const pod = slab([[x0, 0.0], [x1, 0.0], [x1 + 0.02, 0.13], [x1 - 0.03, 0.2], [x0 + 0.03, 0.22], [x0 - 0.015, 0.14]], 0.2, 0.375, 0.01);
    add(s > 0 ? pod : mirrorZ(pod), m.lower);
    const sill = box(x1 - x0 - 0.02, 0.025, 0.02, (x0 + x1) / 2, 0.015, s * 0.378);
    add(sill, m.accent, false);
  }

  // mirrors, sitting on the belt line by the windscreen
  if (def.mirror) {
    const mx = def.mirror[0];
    const [wd, yd] = pointAt(def.secs, mx, 4);
    for (const s of [-1, 1]) {
      const g = slab([[mx - 0.03, yd + 0.012], [mx + 0.03, yd + 0.012], [mx + 0.02, yd + 0.055], [mx - 0.035, yd + 0.05]], wd - 0.04, wd + 0.06, 0.004);
      add(s > 0 ? g : mirrorZ(g), m.paint);
      const cap = box(0.008, 0.03, 0.05, mx - 0.036, yd + 0.032, s * (wd + 0.03));
      add(cap, m.dark, false);
    }
  }

  // lights, grille glow
  lights(add, def.headlight, m.headlight, true);
  lights(add, def.taillight, m.taillight, false);
  const tl = def.taillight;
  add(box(0.01, 0.012, tl.z * 2 - tl.w * 0.4, tl.x - 0.002, tl.y - 0.03, 0), m.taillight, false);
  const nose = def.secs[def.secs.length - 1];
  add(box(0.012, 0.018, Math.max(0.08, nose.pts[3][0] * 1.1), nose.x + 0.004, (nose.pts[2][1] + nose.pts[3][1]) / 2, 0), m.teamGlow, false);

  def.details({ m, add });

  // exhaust / booster
  const ex = def.exhaust;
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.085, 0.1, 8), m.dark);
  nozzle.rotation.z = Math.PI / 2;
  nozzle.position.set(ex[0] - 0.02, ex[1], 0);
  body.add(nozzle);
  const nozzleGlow = new THREE.Mesh(new THREE.CircleGeometry(0.055, 8), m.teamGlow);
  nozzleGlow.rotation.y = -Math.PI / 2;
  nozzleGlow.position.set(ex[0] - 0.072, ex[1], 0);
  body.add(nozzleGlow);

  // boost flame (additive cone, hidden when not boosting)
  const flameGeo = new THREE.ConeGeometry(0.1, 0.7, 10, 1, true);
  flameGeo.rotateZ(Math.PI / 2);
  flameGeo.translate(-0.35, 0, 0);
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const flame = new THREE.Mesh(flameGeo, flameMat);
  flame.position.set(ex[0] - 0.08, ex[1], 0);
  flame.visible = false;
  body.add(flame);
  const coreGeo = new THREE.ConeGeometry(0.05, 0.4, 8, 1, true);
  coreGeo.rotateZ(Math.PI / 2);
  coreGeo.translate(-0.2, 0, 0);
  const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.95, 0.8).multiplyScalar(3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const flameCore = new THREE.Mesh(coreGeo, coreMat);
  flameCore.position.copy(flame.position);
  flameCore.visible = false;
  body.add(flameCore);

  // topper on the middle of the roof
  const top = topperMesh(loadout.topper, accent);
  if (top) {
    const i = def.secs.findIndex((sc) => sc.zone === 'roof');
    const a = def.secs[i];
    const b = def.secs[i + 1];
    top.position.set((a.x + b.x) / 2, (a.pts[7][1] + b.pts[7][1]) / 2 + 0.005, 0);
    body.add(top);
  }

  // wheels
  const wheels: CarVisual['wheels'] = [];
  for (const w of WHEELS) {
    const pivot = new THREE.Group();
    const spin = new THREE.Group();
    const width = w.front ? FRONT_W : REAR_W;
    spin.add(wheelMesh(loadout.wheels, w.radius, width, m));
    pivot.add(spin);
    const z = Math.sign(w.z) * (Math.abs(w.z) + WHEEL_OUT);
    const baseY = w.radius - 0.17;
    pivot.position.set(w.x, baseY, z);
    root.add(pivot);
    wheels.push({ pivot, spin, front: w.front, radius: w.radius, baseY });
  }

  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).receiveShadow = false;
  });

  const mats = [...Object.values(m), flameMat, coreMat];
  return {
    root,
    body,
    wheels,
    flame,
    flameCore,
    exhaustLocal: new THREE.Vector3(ex[0] - 0.12, ex[1] + BODY_Y, 0),
    dispose() {
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          // toppers bring their own materials
          const mat = mesh.material as THREE.Material;
          if (!mats.includes(mat)) mat.dispose();
        }
      });
      mats.forEach((mat) => mat.dispose());
    },
  };
}
