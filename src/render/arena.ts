import * as THREE from 'three';
import {
  ARENA_CORNER_R,
  ARENA_FILLET,
  ARENA_H,
  ARENA_HALF_L,
  ARENA_HALF_W,
  BIG_PADS,
  GOAL_DEPTH,
  GOAL_H,
  GOAL_HALF_W,
  SMALL_PADS,
} from '../physics/constants';
import { TEAM_COLORS } from '../game/types';
import { GAME_NAME, GAME_TAGLINE } from '../config';
import { makeBannerTexture, makeFieldTexture, makeHexTexture, makePanelTexture, makeRadialTexture } from './textures';

interface PerimPt {
  x: number;
  z: number;
  nx: number;
  nz: number;
  endWall: boolean;
}

/** Walk around the rounded-rectangle arena outline. */
function perimeter(halfW: number, halfL: number, rc: number, arcSegs: number, extraX: number[] = []): PerimPt[] {
  const pts: PerimPt[] = [];
  const sx = halfW - rc;
  const sz = halfL - rc;
  const straight = (x0: number, z0: number, x1: number, z1: number, nx: number, nz: number, end: boolean, stops: number[]) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(2, Math.ceil(len / 6));
    const ts = new Set<number>();
    for (let i = 0; i < n; i++) ts.add(i / n);
    for (const s of stops) {
      const t = (s - x0) / (x1 - x0);
      if (t > 0 && t < 1) ts.add(t);
    }
    [...ts].sort((a, b) => a - b).forEach((t) => pts.push({ x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, nx, nz, endWall: end }));
  };
  const arc = (cx: number, cz: number, a0: number) => {
    for (let i = 0; i < arcSegs; i++) {
      const a = a0 + (i / arcSegs) * (Math.PI / 2);
      pts.push({ x: cx + Math.cos(a) * rc, z: cz + Math.sin(a) * rc, nx: Math.cos(a), nz: Math.sin(a), endWall: false });
    }
  };
  // +z end wall (from +x to -x), then corners etc. Counter-clockwise seen from above (+y).
  straight(sx, halfL, -sx, halfL, 0, 1, true, extraX.map((v) => -v).concat(extraX));
  arc(-sx, sz, Math.PI / 2);
  straight(-halfW, sz, -halfW, -sz, -1, 0, false, []);
  arc(-sx, -sz, Math.PI);
  straight(-sx, -halfL, sx, -halfL, 0, -1, true, extraX.concat(extraX.map((v) => -v)));
  arc(sx, -sz, -Math.PI / 2);
  straight(halfW, -sz, halfW, sz, 1, 0, false, []);
  arc(sx, sz, 0);
  return pts;
}

export interface ArenaRefs {
  group: THREE.Group;
  pads: { mesh: THREE.Object3D; glow: THREE.Mesh; big: boolean; x: number; z: number }[];
  crowdMaterial?: THREE.Material;
  update(time: number): void;
}

export function buildArena(maxAniso: number, quality: number): ArenaRefs {
  const group = new THREE.Group();
  group.name = 'arena';
  const W = ARENA_HALF_W;
  const L = ARENA_HALF_L;
  const H = ARENA_H;
  const rf = ARENA_FILLET;
  const rc = ARENA_CORNER_R;
  const updaters: ((t: number) => void)[] = [];

  // ── floor ───────────────────────────────────────────────────────────
  const fieldTex = makeFieldTexture(maxAniso);
  const floorShape = new THREE.Shape();
  {
    const hw = W - rf + 0.05;
    const hl = L - rf + 0.05;
    const r = rc - rf;
    floorShape.moveTo(-hw + r, -hl);
    floorShape.lineTo(hw - r, -hl);
    floorShape.absarc(hw - r, -hl + r, r, -Math.PI / 2, 0, false);
    floorShape.lineTo(hw, hl - r);
    floorShape.absarc(hw - r, hl - r, r, 0, Math.PI / 2, false);
    floorShape.lineTo(-hw + r, hl);
    floorShape.absarc(-hw + r, hl - r, r, Math.PI / 2, Math.PI, false);
    floorShape.lineTo(-hw, -hl + r);
    floorShape.absarc(-hw + r, -hl + r, r, Math.PI, Math.PI * 1.5, false);
  }
  const floorGeo = new THREE.ShapeGeometry(floorShape, 12);
  floorGeo.rotateX(-Math.PI / 2); // shape (x, y) → world (x, -z), facing up
  // compute UVs from world xz (texture covers goal depth too)
  const setFieldUV = (geo: THREE.BufferGeometry) => {
    const pos = geo.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = (pos.getX(i) + W) / (2 * W);
      uv[i * 2 + 1] = 1 - (pos.getZ(i) + L + GOAL_DEPTH) / (2 * (L + GOAL_DEPTH));
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  };
  setFieldUV(floorGeo);
  const floorMat = new THREE.MeshStandardMaterial({ map: fieldTex, roughness: 0.92, metalness: 0 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.receiveShadow = true;
  group.add(floor);

  // ── walls (swept profile) ──────────────────────────────────────────
  const pts = perimeter(W, L, rc, quality > 1 ? 14 : 9, [GOAL_HALF_W]);
  type Row = { inset: number; y: number; v: number };
  const filletSegs = quality > 1 ? 10 : 6;
  const lowRows: Row[] = [];
  for (let i = 0; i <= filletSegs; i++) {
    const a = (i / filletSegs) * (Math.PI / 2);
    lowRows.push({ inset: rf * (1 - Math.sin(a)), y: rf * (1 - Math.cos(a)), v: 0 });
  }
  const wallRows: Row[] = [
    { inset: 0, y: rf, v: 0 },
    { inset: 0, y: GOAL_H, v: 0 },
    { inset: 0, y: (GOAL_H + H - rf) / 2, v: 0 },
    { inset: 0, y: H - rf, v: 0 },
  ];
  const topRows: Row[] = [];
  for (let i = 0; i <= filletSegs; i++) {
    const a = (i / filletSegs) * (Math.PI / 2);
    topRows.push({ inset: rf * (1 - Math.cos(a)), y: H - rf + rf * Math.sin(a), v: 0 });
  }

  const sweep = (rows: Row[], colorFn: (x: number, y: number, z: number) => THREE.Color, skipMouth: boolean) => {
    const positions: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    const n = pts.length;
    let dist = 0;
    const cum: number[] = [0];
    for (let i = 1; i <= n; i++) {
      const a = pts[i - 1];
      const b = pts[i % n];
      dist += Math.hypot(b.x - a.x, b.z - a.z);
      cum.push(dist);
    }
    const P = (p: PerimPt, r: Row) => [p.x - p.nx * r.inset, r.y, p.z - p.nz * r.inset];
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      for (let j = 0; j < rows.length - 1; j++) {
        const r0 = rows[j];
        const r1 = rows[j + 1];
        if (skipMouth && a.endWall && b.endWall) {
          const mx = (a.x + b.x) / 2;
          const my = (r0.y + r1.y) / 2;
          if (Math.abs(mx) < GOAL_HALF_W && my < GOAL_H) continue;
        }
        const p00 = P(a, r0), p10 = P(b, r0), p01 = P(a, r1), p11 = P(b, r1);
        const quad = [p00, p10, p11, p00, p11, p01];
        const quv = [
          [cum[i], r0.y], [cum[i + 1], r0.y], [cum[i + 1], r1.y],
          [cum[i], r0.y], [cum[i + 1], r1.y], [cum[i], r1.y],
        ];
        for (let k = 0; k < 6; k++) {
          positions.push(...quad[k]);
          const c = colorFn(quad[k][0], quad[k][1], quad[k][2]);
          colors.push(c.r, c.g, c.b);
          uvs.push(quv[k][0] / 8, quv[k][1] / 8);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    return geo;
  };

  const blue = new THREE.Color(TEAM_COLORS[0]);
  const orange = new THREE.Color(TEAM_COLORS[1]);
  const tmpC = new THREE.Color();
  const teamTint = (z: number, base: THREE.Color, amount: number) => {
    const t = THREE.MathUtils.clamp((z / L + 1) / 2, 0, 1);
    tmpC.copy(blue).lerp(orange, THREE.MathUtils.smoothstep(t, 0.3, 0.7));
    return base.clone().lerp(tmpC, amount);
  };

  const panelTex = makePanelTexture();
  const rampMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: panelTex,
    roughness: 0.55,
    metalness: 0.35,
    side: THREE.DoubleSide,
  });
  const rampGeo = sweep(lowRows, (x, y, z) => teamTint(z, new THREE.Color(0x1b2233), 0.35), true);
  const ramps = new THREE.Mesh(rampGeo, rampMat);
  ramps.receiveShadow = true;
  group.add(ramps);

  const hexTex = makeHexTexture(3, 256, true);
  hexTex.repeat.set(1, 1);
  const glassMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveMap: hexTex,
    emissiveIntensity: 0.22,
    transparent: true,
    opacity: 0.14,
    roughness: 0.1,
    metalness: 0.2,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const wallGeo = sweep(wallRows, (x, y, z) => teamTint(z, new THREE.Color(0x6a8cff), 0.7), true);
  const walls = new THREE.Mesh(wallGeo, glassMat);
  walls.renderOrder = 2;
  group.add(walls);
  const topGeo = sweep(topRows, (x, y, z) => teamTint(z, new THREE.Color(0x4a5cff), 0.6), false);
  const top = new THREE.Mesh(topGeo, glassMat);
  top.renderOrder = 2;
  group.add(top);

  // glowing trim lines along the top of the ramps and the ceiling edge
  const trim = (y: number, inset: number, width: number, intensity: number) => {
    const n = pts.length;
    const positions: number[] = [];
    const colors: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if (a.endWall && b.endWall && Math.abs((a.x + b.x) / 2) < GOAL_HALF_W && y < GOAL_H) continue;
      const p = (q: PerimPt, dy: number) => [q.x - q.nx * inset, y + dy, q.z - q.nz * inset];
      const quad = [p(a, 0), p(b, 0), p(b, width), p(a, 0), p(b, width), p(a, width)];
      for (const v of quad) {
        positions.push(...v);
        const c = teamTint(v[2], new THREE.Color(0xffffff), 1);
        colors.push(c.r * intensity, c.g * intensity, c.b * intensity);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false }));
    group.add(m);
  };
  trim(rf - 0.02, 0.01, 0.18, 3.6);
  trim(H - rf - 0.2, 0.01, 0.12, 2.6);
  trim(GOAL_H + 0.8, 0.01, 0.08, 2.0);

  // ramp end caps beside each goal mouth
  {
    const capPos: number[] = [];
    for (const sz of [-1, 1])
      for (const sx of [-1, 1]) {
        const x = sx * GOAL_HALF_W;
        const prof: [number, number][] = [];
        for (let i = 0; i <= filletSegs; i++) {
          const a = (i / filletSegs) * (Math.PI / 2);
          prof.push([L - rf * (1 - Math.sin(a)), rf * (1 - Math.cos(a))]);
        }
        const base: [number, number] = [L, 0];
        for (let i = 0; i < prof.length - 1; i++) {
          capPos.push(x, base[1], sz * base[0], x, prof[i][1], sz * prof[i][0], x, prof[i + 1][1], sz * prof[i + 1][0]);
        }
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(capPos, 3));
    geo.computeVertexNormals();
    group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x1b2233, roughness: 0.6, metalness: 0.3, side: THREE.DoubleSide })));
  }

  // ── ceiling ─────────────────────────────────────────────────────────
  {
    const ceil = new THREE.Mesh(
      floorGeo.clone(),
      new THREE.MeshBasicMaterial({ color: 0x0a1030, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }),
    );
    ceil.position.y = H;
    ceil.renderOrder = 3;
    group.add(ceil);
  }

  // ── goals ───────────────────────────────────────────────────────────
  const netTex = makeHexTexture(4, 128, false);
  for (const team of [0, 1]) {
    const s = team === 0 ? -1 : 1;
    const color = new THREE.Color(TEAM_COLORS[team]);
    const g = new THREE.Group();
    const netMat = new THREE.MeshStandardMaterial({
      color: color.clone().multiplyScalar(0.4),
      emissive: color,
      emissiveIntensity: 1.8,
      emissiveMap: netTex,
      alphaMap: netTex,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    netTex.wrapS = netTex.wrapT = THREE.RepeatWrapping;
    netTex.repeat.set(5, 2.5);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_HALF_W * 2, GOAL_H), netMat);
    back.position.set(0, GOAL_H / 2, s * (L + GOAL_DEPTH));
    g.add(back);
    for (const sx of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_DEPTH, GOAL_H), netMat);
      side.rotation.y = Math.PI / 2;
      side.position.set(sx * GOAL_HALF_W, GOAL_H / 2, s * (L + GOAL_DEPTH / 2));
      g.add(side);
    }
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_HALF_W * 2, GOAL_DEPTH), netMat);
    roof.rotation.x = Math.PI / 2;
    roof.position.set(0, GOAL_H, s * (L + GOAL_DEPTH / 2));
    g.add(roof);
    // floor inside the goal
    const gfGeo = new THREE.PlaneGeometry(GOAL_HALF_W * 2, GOAL_DEPTH + rf);
    gfGeo.rotateX(-Math.PI / 2);
    gfGeo.translate(0, 0.002, s * (L + (GOAL_DEPTH - rf) / 2));
    setFieldUV(gfGeo);
    const gf = new THREE.Mesh(gfGeo, floorMat);
    gf.receiveShadow = true;
    g.add(gf);
    // frame
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: 4.5, roughness: 0.4 });
    const post = new THREE.BoxGeometry(0.35, GOAL_H + 0.35, 0.35);
    for (const sx of [-1, 1]) {
      const p = new THREE.Mesh(post, frameMat);
      p.position.set(sx * (GOAL_HALF_W + 0.1), (GOAL_H + 0.35) / 2, s * (L + 0.1));
      g.add(p);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(GOAL_HALF_W * 2 + 0.55, 0.35, 0.35), frameMat);
    bar.position.set(0, GOAL_H + 0.1, s * (L + 0.1));
    g.add(bar);
    // back light strip
    const strip = new THREE.Mesh(new THREE.BoxGeometry(GOAL_HALF_W * 2, 0.12, 0.12), new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(5), toneMapped: false }));
    strip.position.set(0, 0.08, s * (L + GOAL_DEPTH - 0.1));
    g.add(strip);
    // goal-area wall glow above the goal
    const glowTex = makeRadialTexture(`rgba(${color.r * 255 | 0},${color.g * 255 | 0},${color.b * 255 | 0},0.6)`, 'rgba(0,0,0,0)');
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 16),
      new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    );
    glow.position.set(0, GOAL_H + 2, s * (L + 0.3));
    g.add(glow);
    group.add(g);
  }

  // ── boost pads ─────────────────────────────────────────────────────
  const pads: ArenaRefs['pads'] = [];
  const padBaseMat = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.5, metalness: 0.6 });
  const bigGlowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.62, 0.15).multiplyScalar(1.35), toneMapped: false, transparent: true, opacity: 0.92 });
  const smallGlowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.55, 0.12).multiplyScalar(1.05), toneMapped: false, transparent: true, opacity: 0.9 });
  const bigBase = new THREE.CylinderGeometry(1.5, 1.7, 0.12, 12);
  const smallBase = new THREE.CylinderGeometry(0.8, 0.9, 0.06, 10);
  const orb = new THREE.IcosahedronGeometry(0.55, 0);
  const smallDisc = new THREE.CylinderGeometry(0.5, 0.5, 0.05, 8);
  const addPad = (x: number, z: number, big: boolean) => {
    const base = new THREE.Mesh(big ? bigBase : smallBase, padBaseMat);
    base.position.set(x, big ? 0.06 : 0.03, z);
    base.receiveShadow = true;
    group.add(base);
    const glow = new THREE.Mesh(big ? orb : smallDisc, (big ? bigGlowMat : smallGlowMat).clone());
    glow.position.set(x, big ? 1.1 : 0.08, z);
    group.add(glow);
    pads.push({ mesh: base, glow, big, x, z });
  };
  BIG_PADS.forEach(([x, z]) => addPad(x, z, true));
  SMALL_PADS.forEach(([x, z]) => addPad(x, z, false));

  // ── stadium outside ─────────────────────────────────────────────────
  const stadium = buildStadium(quality);
  group.add(stadium.group);
  updaters.push(stadium.update);

  return {
    group,
    pads,
    update(time: number) {
      for (const u of updaters) u(time);
      for (const p of pads) {
        if (p.big) {
          p.glow.rotation.y = time * 1.5;
          p.glow.position.y = 1.1 + Math.sin(time * 2 + p.x) * 0.12;
        }
      }
    },
  };
}

function buildStadium(quality: number) {
  const group = new THREE.Group();
  const W = ARENA_HALF_W;
  const L = ARENA_HALF_L;
  // ground
  const ground = new THREE.Mesh(new THREE.CircleGeometry(420, 32), new THREE.MeshStandardMaterial({ color: 0x0b0f1c, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  group.add(ground);

  // stands: stepped tiers around the arena
  const standMat = new THREE.MeshStandardMaterial({ color: 0x1a2035, roughness: 0.85, flatShading: true });
  const tiers = [
    { off: 12, y0: 0, y1: 10, depth: 18 },
    { off: 32, y0: 12, y1: 26, depth: 20 },
  ];
  const crowdPositions: THREE.Vector3[] = [];
  for (const t of tiers) {
    const inner = perimeter(W + t.off, L + t.off + 6, ARENA_CORNER_R + t.off, 6);
    const outer = perimeter(W + t.off + t.depth, L + t.off + 6 + t.depth, ARENA_CORNER_R + t.off + t.depth, 6);
    const pos: number[] = [];
    const n = inner.length;
    for (let i = 0; i < n; i++) {
      const a = inner[i], b = inner[(i + 1) % n], c = outer[(i + 1) % n], d = outer[i];
      // sloped seating surface
      pos.push(a.x, t.y0, a.z, b.x, t.y0, b.z, c.x, t.y1, c.z, a.x, t.y0, a.z, c.x, t.y1, c.z, d.x, t.y1, d.z);
      // back wall
      pos.push(d.x, t.y1, d.z, c.x, t.y1, c.z, c.x, t.y1 + 3, c.z, d.x, t.y1, d.z, c.x, t.y1 + 3, c.z, d.x, t.y1 + 3, d.z);
      // crowd seats
      const rows = 5;
      for (let r = 0; r < rows; r++) {
        const f = (r + 0.5) / rows;
        const segLen = Math.hypot(b.x - a.x, b.z - a.z);
        const per = Math.max(1, Math.floor(segLen / 1.6));
        for (let k = 0; k < per; k++) {
          if (Math.random() < 0.18) continue;
          const u = (k + Math.random() * 0.3) / per;
          const ix = a.x + (b.x - a.x) * u, iz = a.z + (b.z - a.z) * u;
          const ox = d.x + (c.x - d.x) * u, oz = d.z + (c.z - d.z) * u;
          crowdPositions.push(new THREE.Vector3(ix + (ox - ix) * f, t.y0 + (t.y1 - t.y0) * f, iz + (oz - iz) * f));
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, standMat);
    m.material.side = THREE.DoubleSide;
    group.add(m);
  }

  // crowd (instanced, animated in the vertex shader)
  const maxCrowd = quality > 1 ? 6000 : quality > 0 ? 3500 : 1500;
  const count = Math.min(maxCrowd, crowdPositions.length);
  const personGeo = new THREE.BoxGeometry(0.6, 1.1, 0.5);
  personGeo.translate(0, 0.55, 0);
  const crowdMat = new THREE.MeshLambertMaterial({ vertexColors: false });
  const timeUniform = { value: 0 };
  const exciteUniform = { value: 0 };
  crowdMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    shader.uniforms.uExcite = exciteUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uExcite;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float ph = float(gl_InstanceID) * 12.9898;
         float bob = abs(sin(uTime * (3.0 + fract(ph) * 3.0) + ph)) * (0.08 + uExcite * 0.9);
         transformed.y += bob;`,
      );
  };
  const crowd = new THREE.InstancedMesh(personGeo, crowdMat, count);
  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();
  const palette = [0x2f7bff, 0xff7a1a, 0xe8e8e8, 0x2a2a2a, 0x2f7bff, 0xff7a1a, 0x9a4bff, 0x33cc88];
  // shuffle positions so the cap drops random people
  for (let i = crowdPositions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [crowdPositions[i], crowdPositions[j]] = [crowdPositions[j], crowdPositions[i]];
  }
  for (let i = 0; i < count; i++) {
    const p = crowdPositions[i];
    m4.makeRotationY(Math.atan2(-p.x, -p.z));
    m4.setPosition(p);
    crowd.setMatrixAt(i, m4);
    const blueSide = p.z < 0;
    const pick = Math.random() < 0.55 ? (blueSide ? palette[0] : palette[1]) : palette[Math.floor(Math.random() * palette.length)];
    col.setHex(pick).multiplyScalar(0.55 + Math.random() * 0.35);
    crowd.setColorAt(i, col);
  }
  group.add(crowd);

  // light towers
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x2a3040, roughness: 0.6, metalness: 0.5, flatShading: true });
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.95, 0.85).multiplyScalar(7), toneMapped: false });
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const t = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.4, 48, 6), towerMat);
      pole.position.y = 24;
      t.add(pole);
      const head = new THREE.Mesh(new THREE.BoxGeometry(12, 6, 1.5), towerMat);
      head.position.y = 50;
      t.add(head);
      for (let i = 0; i < 4; i++)
        for (let j = 0; j < 2; j++) {
          const lamp = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 2), lampMat);
          lamp.position.set(-4.2 + i * 2.8, 48.8 + j * 2.5, 0.8);
          t.add(lamp);
        }
      t.position.set(sx * (W + 58), 0, sz * (L + 50));
      t.lookAt(0, 30, 0);
      group.add(t);
    }

  // banners above the end walls & sides
  const bannerTexB = makeBannerTexture(GAME_NAME, GAME_TAGLINE, '#4f9dff');
  const bannerTexO = makeBannerTexture(GAME_NAME, GAME_TAGLINE, '#ff9a3c');
  for (const s of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(40, 10), new THREE.MeshBasicMaterial({ map: s < 0 ? bannerTexB : bannerTexO, toneMapped: false }));
    b.position.set(0, 34, s * (L + 38));
    b.lookAt(0, 20, 0);
    group.add(b);
    const side = new THREE.Mesh(new THREE.PlaneGeometry(48, 12), new THREE.MeshBasicMaterial({ map: s < 0 ? bannerTexB : bannerTexO, toneMapped: false }));
    side.position.set(s * (W + 40), 34, 0);
    side.lookAt(0, 20, 0);
    group.add(side);
  }

  // roof ring truss
  const ringMat = new THREE.MeshStandardMaterial({ color: 0x151a28, roughness: 0.7, metalness: 0.4, flatShading: true });
  {
    const outer = perimeter(W + 56, L + 62, ARENA_CORNER_R + 50, 8);
    const pos: number[] = [];
    const inner = perimeter(W + 44, L + 50, ARENA_CORNER_R + 38, 8);
    const n = inner.length;
    for (let i = 0; i < n; i++) {
      const a = inner[i], b = inner[(i + 1) % n], c = outer[(i + 1) % n], d = outer[i];
      pos.push(a.x, 40, a.z, b.x, 40, b.z, c.x, 44, c.z, a.x, 40, a.z, c.x, 44, c.z, d.x, 44, d.z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, ringMat);
    m.material.side = THREE.DoubleSide;
    group.add(m);
  }

  // sky dome + stars
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {},
    vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vPos;
      void main(){
        float h = normalize(vPos).y;
        vec3 top = vec3(0.012, 0.018, 0.06);
        vec3 mid = vec3(0.05, 0.05, 0.16);
        vec3 hor = vec3(0.22, 0.12, 0.32);
        vec3 c = mix(hor, mid, smoothstep(0.0, 0.25, h));
        c = mix(c, top, smoothstep(0.25, 0.8, h));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 24, 12), skyMat);
  group.add(sky);
  const starGeo = new THREE.BufferGeometry();
  const sp: number[] = [];
  for (let i = 0; i < 1500; i++) {
    const v = new THREE.Vector3().randomDirection();
    if (v.y < 0.08) v.y = Math.abs(v.y) + 0.08;
    v.normalize().multiplyScalar(850);
    sp.push(v.x, v.y, v.z);
  }
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.8 }));
  group.add(stars);

  // distant low-poly skyline
  const cityMat = new THREE.MeshStandardMaterial({ color: 0x0d1122, emissive: 0x0a0f25, roughness: 1, flatShading: true });
  const winMat = new THREE.MeshBasicMaterial({ color: 0xffd28a });
  for (let i = 0; i < 70; i++) {
    const a = (i / 70) * Math.PI * 2 + Math.random() * 0.05;
    const r = 330 + Math.random() * 120;
    const h = 20 + Math.random() * 90;
    const w = 12 + Math.random() * 20;
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), cityMat);
    b.position.set(Math.cos(a) * r, h / 2 - 2, Math.sin(a) * r);
    b.rotation.y = -a;
    group.add(b);
    if (Math.random() < 0.6) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.6, 0.8), winMat);
      win.position.set(Math.cos(a) * (r - w / 2 - 0.1), h * (0.3 + Math.random() * 0.6), Math.sin(a) * (r - w / 2 - 0.1));
      win.lookAt(0, win.position.y, 0);
      group.add(win);
    }
  }

  let excite = 0;
  return {
    group,
    crowdMat,
    update(time: number) {
      timeUniform.value = time;
      excite = Math.max(0, excite - 0.01);
      exciteUniform.value = excite + (crowdCheer.value > time ? 0.6 : 0);
    },
  };
}

/** Raise to make the crowd jump (time in seconds until which they cheer). */
export const crowdCheer = { value: 0 };
