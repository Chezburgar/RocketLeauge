import * as THREE from 'three';
import { WHEELS } from '../physics/car';
import { TEAM_SHADES, type BodyId, type Loadout, type TopperId, type WheelId } from '../game/types';

type P = [number, number];

/** Extrude a side profile (x forward, y up) across the car's width with chamfered edges. */
function profile(points: P[], width: number, bevel = 0.025): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 1,
  });
  geo.translate(0, 0, -(width - bevel * 2) / 2);
  return geo;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

interface BodyDef {
  hull: P[];
  hullWidth: number;
  cabin: P[];
  cabinWidth: number;
  fender: { w: number; h: number; y: number; len: number };
  spoiler?: { x: number; y: number; w: number; chord: number; strut: number };
  fins?: boolean;
  bumper?: boolean;
  roofY: number;
  roofX: number;
  lights: { front: [number, number]; rear: [number, number] };
  exhaust: [number, number];
}

const BODIES: Record<BodyId, BodyDef> = {
  // balanced all-rounder with a tall wing
  breaker: {
    hull: [[-0.58, 0.0], [0.6, 0.0], [0.74, 0.07], [0.72, 0.17], [0.32, 0.24], [0.16, 0.27], [-0.42, 0.29], [-0.58, 0.26], [-0.62, 0.12]],
    hullWidth: 0.58,
    cabin: [[0.2, 0.25], [0.02, 0.43], [-0.26, 0.44], [-0.44, 0.28]],
    cabinWidth: 0.46,
    fender: { w: 0.2, h: 0.12, y: 0.13, len: 0.36 },
    spoiler: { x: -0.52, y: 0.46, w: 0.7, chord: 0.16, strut: 0.17 },
    roofY: 0.45,
    roofX: -0.12,
    lights: { front: [0.72, 0.13], rear: [-0.6, 0.2] },
    exhaust: [-0.62, 0.1],
  },
  // low flat wedge
  wedge: {
    hull: [[-0.62, 0.0], [0.66, 0.0], [0.8, 0.05], [0.78, 0.1], [0.25, 0.2], [-0.48, 0.25], [-0.64, 0.22], [-0.66, 0.1]],
    hullWidth: 0.66,
    cabin: [[0.22, 0.2], [0.02, 0.34], [-0.34, 0.35], [-0.5, 0.24]],
    cabinWidth: 0.48,
    fender: { w: 0.18, h: 0.09, y: 0.1, len: 0.4 },
    spoiler: { x: -0.58, y: 0.3, w: 0.72, chord: 0.2, strut: 0.06 },
    roofY: 0.36,
    roofX: -0.16,
    lights: { front: [0.76, 0.08], rear: [-0.64, 0.17] },
    exhaust: [-0.66, 0.08],
  },
  // tall armoured truck
  titan: {
    hull: [[-0.6, -0.02], [0.62, -0.02], [0.7, 0.05], [0.7, 0.24], [0.4, 0.3], [-0.58, 0.32], [-0.62, 0.28]],
    hullWidth: 0.7,
    cabin: [[0.36, 0.29], [0.24, 0.52], [-0.3, 0.53], [-0.4, 0.31]],
    cabinWidth: 0.6,
    fender: { w: 0.22, h: 0.16, y: 0.16, len: 0.4 },
    bumper: true,
    roofY: 0.54,
    roofX: -0.03,
    lights: { front: [0.71, 0.16], rear: [-0.61, 0.24] },
    exhaust: [-0.62, 0.12],
  },
  // sleek fighter with twin fins
  viper: {
    hull: [[-0.56, 0.0], [0.56, 0.0], [0.86, 0.05], [0.84, 0.1], [0.4, 0.18], [0.1, 0.22], [-0.4, 0.26], [-0.58, 0.22], [-0.6, 0.1]],
    hullWidth: 0.56,
    cabin: [[0.3, 0.19], [0.12, 0.36], [-0.12, 0.38], [-0.34, 0.25]],
    cabinWidth: 0.36,
    fender: { w: 0.2, h: 0.1, y: 0.12, len: 0.42 },
    fins: true,
    roofY: 0.39,
    roofX: 0.0,
    lights: { front: [0.82, 0.08], rear: [-0.58, 0.18] },
    exhaust: [-0.6, 0.1],
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

function wheelMesh(style: WheelId, radius: number, width: number, accent: THREE.Color, rimMat: THREE.Material, tireMat: THREE.Material, glowMat: THREE.Material) {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 12), tireMat);
  tire.rotation.x = Math.PI / 2;
  tire.castShadow = true;
  g.add(tire);
  const face = width / 2 + 0.004;
  const addBoth = (m: THREE.Mesh) => {
    const a = m.clone();
    a.position.z = face;
    const b = m.clone();
    b.position.z = -face;
    b.rotation.y = Math.PI;
    g.add(a, b);
  };
  const r = radius * 0.66;
  const disc = (mat: THREE.Material, rr = r, seg = 10) => {
    const d = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr, 0.012, seg), mat);
    d.rotation.x = Math.PI / 2;
    return d;
  };
  switch (style) {
    case 'classic': {
      addBoth(disc(rimMat));
      for (let i = 0; i < 5; i++) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(r * 1.9, r * 0.28, 0.02), rimMat);
        s.rotation.z = (i / 5) * Math.PI;
        addBoth(s);
      }
      break;
    }
    case 'spoke': {
      const hub = disc(rimMat, r * 0.3, 8);
      addBoth(hub);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.95, r * 0.08, 4, 14), rimMat);
      addBoth(ring);
      for (let i = 0; i < 10; i++) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(r * 1.9, r * 0.06, 0.012), rimMat);
        s.rotation.z = (i / 10) * Math.PI;
        addBoth(s);
      }
      break;
    }
    case 'turbine': {
      addBoth(disc(rimMat));
      for (let i = 0; i < 7; i++) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(r * 0.8, r * 0.16, 0.03), glowMat);
        const a = (i / 7) * Math.PI * 2;
        s.position.set(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, 0);
        s.rotation.z = a + 0.6;
        addBoth(s);
      }
      break;
    }
    case 'neon': {
      addBoth(disc(tireMat, r * 0.9));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.8, r * 0.1, 4, 16), glowMat);
      addBoth(ring);
      addBoth(disc(rimMat, r * 0.25, 6));
      break;
    }
    case 'star': {
      const pts: THREE.Vector2[] = [];
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
        const rr = i % 2 ? r * 0.42 : r;
        pts.push(new THREE.Vector2(Math.cos(a) * rr, Math.sin(a) * rr));
      }
      const star = new THREE.Mesh(new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: 0.012, bevelEnabled: false }), rimMat);
      addBoth(star);
      break;
    }
  }
  return g;
}

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
      for (let i = 0; i < 8; i++) {
        const sp = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.09, 4), m);
        const a = (i / 8) * Math.PI * 2;
        sp.position.set(Math.cos(a) * 0.115, 0.12, Math.sin(a) * 0.115);
        g.add(sp);
        if (i % 2 === 0) {
          const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.018), new THREE.MeshStandardMaterial({ color: 0xff2255, emissive: 0x660011 }));
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

export function buildCar(loadout: Loadout, team: number): CarVisual {
  const def = BODIES[loadout.body] ?? BODIES.breaker;
  const primary = new THREE.Color(TEAM_SHADES[team as 0 | 1][loadout.shade % 4]);
  const accent = new THREE.Color(loadout.accent);
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = BODY_Y;
  root.add(body);

  const paint = new THREE.MeshStandardMaterial({ color: primary, metalness: 0.3, roughness: 0.42, flatShading: true });
  const accentMat = new THREE.MeshStandardMaterial({ color: accent, metalness: 0.25, roughness: 0.5, flatShading: true });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171d, metalness: 0.2, roughness: 0.7, flatShading: true });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0b1320, metalness: 0.6, roughness: 0.15, flatShading: true });
  const headlight = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 0.95).multiplyScalar(5), toneMapped: false });
  const taillight = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.1, 0.1).multiplyScalar(4), toneMapped: false });
  const glowMat = new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(3.5), toneMapped: false });
  const teamGlow = new THREE.MeshBasicMaterial({ color: primary.clone().multiplyScalar(3.5), toneMapped: false });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9, flatShading: true });
  const rimMat = new THREE.MeshStandardMaterial({ color: accent.clone().lerp(new THREE.Color(0xcccccc), 0.35), metalness: 0.85, roughness: 0.25, flatShading: true });
  const mats = [paint, accentMat, dark, glass, headlight, taillight, glowMat, teamGlow, tireMat, rimMat];

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, shadow = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    body.add(m);
    return m;
  };

  // hull + cabin
  add(profile(def.hull, def.hullWidth), paint);
  add(profile(def.cabin, def.cabinWidth, 0.02), glass);
  // roof panel in paint
  {
    const c = def.cabin;
    const roof: P[] = [[c[1][0] - 0.02, c[1][1] - 0.035], [c[1][0], c[1][1]], [c[2][0], c[2][1]], [c[2][0] + 0.02, c[2][1] - 0.035]];
    add(profile(roof, def.cabinWidth + 0.02, 0.012), paint);
  }
  // side stripe
  add(box(def.hull[1][0] - def.hull[0][0] - 0.2, 0.035, def.hullWidth + 0.012, (def.hull[1][0] + def.hull[0][0]) / 2, 0.12, 0), accentMat, false);
  // underbody
  add(box(1.1, 0.06, def.hullWidth - 0.1, 0.05, -0.01, 0), dark);

  // fenders over the wheels
  for (const w of WHEELS) {
    const f = def.fender;
    for (const s of [-1, 1]) {
      const z = s * (Math.abs(w.z) + 0.05);
      const len = f.len * (w.front ? 1 : 1.08);
      const shape: P[] = [[-len / 2, 0], [len / 2, 0], [len / 2 - 0.05, f.h], [-len / 2 + 0.06, f.h]];
      const g = profile(shape, f.w, 0.015);
      g.translate(w.x, f.y + (w.front ? 0 : 0.02), z);
      add(g, accentMat);
    }
  }
  // side pods between wheels
  for (const s of [-1, 1]) add(box(0.46, 0.07, 0.08, 0.08, 0.05, s * (def.hullWidth / 2 + 0.03)), dark);

  // lights
  for (const s of [-1, 1]) {
    add(box(0.03, 0.035, 0.12, def.lights.front[0], def.lights.front[1], s * (def.hullWidth / 2 - 0.1)), headlight, false);
    add(box(0.03, 0.04, 0.14, def.lights.rear[0], def.lights.rear[1], s * (def.hullWidth / 2 - 0.1)), taillight, false);
  }
  // grille glow strip in team colour
  add(box(0.02, 0.02, def.hullWidth * 0.5, def.lights.front[0] + 0.01, def.lights.front[1] - 0.05, 0), teamGlow, false);

  // spoiler
  if (def.spoiler) {
    const sp = def.spoiler;
    const wing = profile([[-sp.chord / 2, 0], [sp.chord / 2, 0.02], [sp.chord / 2 - 0.02, 0.045], [-sp.chord / 2, 0.035]], sp.w, 0.01);
    wing.translate(sp.x, sp.y, 0);
    add(wing, accentMat);
    for (const s of [-1, 1]) add(box(0.04, sp.strut, 0.025, sp.x + 0.02, sp.y - sp.strut / 2, s * sp.w * 0.3), dark);
    for (const s of [-1, 1]) add(box(sp.chord + 0.04, 0.09, 0.012, sp.x, sp.y + 0.02, s * sp.w / 2), paint);
  }
  if (def.fins) {
    for (const s of [-1, 1]) {
      const fin = profile([[0, 0], [0.2, 0], [0.02, 0.2], [-0.05, 0.2]], 0.025, 0.006);
      fin.translate(-0.55, 0.22, s * 0.2);
      add(fin, accentMat);
    }
  }
  if (def.bumper) {
    add(box(0.08, 0.1, def.hullWidth + 0.04, 0.72, 0.06, 0), dark);
    add(box(0.06, 0.08, def.hullWidth + 0.02, -0.63, 0.06, 0), dark);
    // roof light bar
    add(box(0.06, 0.04, def.cabinWidth * 0.8, def.roofX + 0.15, def.roofY + 0.02, 0), headlight, false);
  }

  // exhaust / booster
  const ex = def.exhaust;
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.1, 8), dark);
  nozzle.rotation.z = Math.PI / 2;
  nozzle.position.set(ex[0] - 0.02, ex[1], 0);
  body.add(nozzle);
  const nozzleGlow = new THREE.Mesh(new THREE.CircleGeometry(0.06, 8), teamGlow);
  nozzleGlow.rotation.y = -Math.PI / 2;
  nozzleGlow.position.set(ex[0] - 0.075, ex[1], 0);
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
  const flameCore = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.95, 0.8).multiplyScalar(3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  flameCore.position.copy(flame.position);
  flameCore.visible = false;
  body.add(flameCore);

  // topper
  const top = topperMesh(loadout.topper, accent);
  if (top) {
    top.position.set(def.roofX, def.roofY + 0.005, 0);
    body.add(top);
  }

  // wheels
  const wheels: CarVisual['wheels'] = [];
  for (const w of WHEELS) {
    const pivot = new THREE.Group();
    const spin = new THREE.Group();
    const width = w.front ? 0.13 : 0.15;
    const mesh = wheelMesh(loadout.wheels, w.radius, width, accent, rimMat, tireMat, glowMat);
    spin.add(mesh);
    pivot.add(spin);
    const z = Math.sign(w.z) * (Math.abs(w.z) + 0.04);
    const baseY = w.radius - 0.17;
    pivot.position.set(w.x, baseY, z);
    root.add(pivot);
    wheels.push({ pivot, spin, front: w.front, radius: w.radius, baseY });
  }

  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).receiveShadow = false;
  });

  return {
    root,
    body,
    wheels,
    flame,
    flameCore,
    exhaustLocal: new THREE.Vector3(ex[0] - 0.12, ex[1] + BODY_Y, 0),
    dispose() {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      mats.forEach((m) => m.dispose());
      flameMat.dispose();
    },
  };
}
