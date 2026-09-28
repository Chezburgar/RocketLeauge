import { Quaternion, Vector3 } from 'three';
import { Ball, BALL_INERTIA } from './ball';
import { Car, type Team } from './car';
import {
  ARENA_HALF_L,
  BALL_MASS,
  BALL_RADIUS,
  BIG_PAD_RADIUS,
  BIG_PAD_RESPAWN,
  BIG_PADS,
  BOOST_MAX,
  BUMP_COOLDOWN,
  CAR_HALF,
  CAR_HITBOX_OFFSET,
  curve,
  DEMO_RESPAWN_TIME,
  DT,
  GOAL_H,
  GOAL_HALF_W,
  HIT_CURVE,
  HIT_FORWARD_SCALE,
  HIT_MAX_DELTA,
  HIT_Z_SCALE,
  SMALL_PAD_RADIUS,
  SMALL_PAD_RESPAWN,
  SMALL_PADS,
} from './constants';
import { emptyInput, type CarInput } from './input';

export const MAX_CARS = 6;

export interface Pad {
  x: number;
  z: number;
  big: boolean;
  timer: number; // > 0 while recharging
}

export type WorldEvent =
  | { type: 'touch'; car: number; strength: number; tick: number; x: number; y: number; z: number }
  | { type: 'goal'; team: Team; tick: number; speed: number; x: number; y: number; z: number }
  | { type: 'demo'; attacker: number; victim: number; tick: number; x: number; y: number; z: number }
  | { type: 'bump'; attacker: number; victim: number; tick: number; strength: number }
  | { type: 'pad'; car: number; pad: number; big: boolean; tick: number }
  | { type: 'jump'; car: number; tick: number; double: boolean }
  | { type: 'flip'; car: number; tick: number }
  | { type: 'ballBounce'; strength: number; tick: number }
  | { type: 'respawn'; car: number; tick: number };

// respawn spots (blue; orange mirrored)
const RESPAWNS: [number, number][] = [
  [-23.04, -46.08],
  [-26.88, -46.08],
  [23.04, -46.08],
  [26.88, -46.08],
];

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _n = new Vector3();
const _p = new Vector3();
const _qi = new Quaternion();
const _fwd = new Vector3();

interface OBB {
  c: Vector3;
  ax: Vector3[];
  h: number[];
}
function carOBB(car: Car, out: OBB) {
  car.hitboxCenter(out.c);
  out.ax[0].set(1, 0, 0).applyQuaternion(car.quat);
  out.ax[1].set(0, 1, 0).applyQuaternion(car.quat);
  out.ax[2].set(0, 0, 1).applyQuaternion(car.quat);
  return out;
}
const mkOBB = (): OBB => ({
  c: new Vector3(),
  ax: [new Vector3(), new Vector3(), new Vector3()],
  h: [CAR_HALF.x, CAR_HALF.y, CAR_HALF.z],
});
const obbA = mkOBB();
const obbB = mkOBB();
const _axis = new Vector3();
const _T = new Vector3();

/** Separating-axis test between two oriented boxes. Returns depth, normal (A→B) and contact point. */
function obbOverlap(A: OBB, B: OBB, outN: Vector3, outP: Vector3): number {
  _T.subVectors(B.c, A.c);
  let best = Infinity;
  let bestKind = 0; // 0 = face A, 1 = face B, 2 = edge
  const test = (L: Vector3, kind: number, bias: number) => {
    const len = L.length();
    if (len < 1e-6) return true;
    L.multiplyScalar(1 / len);
    let rA = 0;
    let rB = 0;
    for (let i = 0; i < 3; i++) {
      rA += A.h[i] * Math.abs(A.ax[i].dot(L));
      rB += B.h[i] * Math.abs(B.ax[i].dot(L));
    }
    const dist = _T.dot(L);
    const overlap = rA + rB - Math.abs(dist);
    if (overlap < 0) return false;
    if (overlap * bias < best) {
      best = overlap * bias;
      bestKind = kind;
      outN.copy(L).multiplyScalar(dist < 0 ? -1 : 1);
      outP.x = overlap; // stash real depth
    }
    return true;
  };
  for (let i = 0; i < 3; i++) if (!test(_axis.copy(A.ax[i]), 0, 1)) return -1;
  for (let i = 0; i < 3; i++) if (!test(_axis.copy(B.ax[i]), 1, 1)) return -1;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) if (!test(_axis.crossVectors(A.ax[i], B.ax[j]), 2, 1.1)) return -1;
  const depth = outP.x;
  // contact point
  if (bestKind === 0) {
    // deepest vertex of B towards A
    outP.copy(B.c);
    for (let i = 0; i < 3; i++) outP.addScaledVector(B.ax[i], B.h[i] * (B.ax[i].dot(outN) > 0 ? -1 : 1));
    outP.addScaledVector(outN, depth * 0.5);
  } else if (bestKind === 1) {
    outP.copy(A.c);
    for (let i = 0; i < 3; i++) outP.addScaledVector(A.ax[i], A.h[i] * (A.ax[i].dot(outN) > 0 ? 1 : -1));
    outP.addScaledVector(outN, -depth * 0.5);
  } else {
    outP.addVectors(A.c, B.c).multiplyScalar(0.5);
  }
  return depth;
}

export class World {
  tick = 0;
  ball = new Ball();
  cars: (Car | null)[] = new Array(MAX_CARS).fill(null);
  pads: Pad[] = [];
  lastHitTick: number[] = new Array(MAX_CARS).fill(-100);
  events: WorldEvent[] = [];
  /** cars cannot drive during the kickoff countdown */
  frozen = false;
  /** set once the ball crosses a goal line; the match decides what happens next */
  goalScored = false;
  /** stop recording events (used during rollback re-simulation) */
  muteEvents = false;

  constructor() {
    BIG_PADS.forEach(([x, z]) => this.pads.push({ x, z, big: true, timer: 0 }));
    SMALL_PADS.forEach(([x, z]) => this.pads.push({ x, z, big: false, timer: 0 }));
  }

  addCar(slot: number, team: Team) {
    const c = new Car(slot, team);
    this.cars[slot] = c;
    return c;
  }

  removeCar(slot: number) {
    this.cars[slot] = null;
  }

  private emit(e: WorldEvent) {
    if (!this.muteEvents) this.events.push(e);
  }

  step(inputs: (CarInput | null | undefined)[]) {
    this.tick++;
    const none = emptyInput();
    // cars
    for (let i = 0; i < MAX_CARS; i++) {
      const car = this.cars[i];
      if (!car) continue;
      if (car.demolished) {
        car.respawnTimer -= DT;
        if (car.respawnTimer <= 0) this.respawn(car);
        continue;
      }
      const inp = this.frozen ? none : inputs[i] ?? none;
      const hadJumped = car.hasJumped;
      const hadDouble = car.hasDoubleJumped;
      const hadFlip = car.hasFlipped;
      car.step(inp, DT);
      if (this.frozen) {
        // hold position during countdown but let the suspension settle
        car.vel.x = car.vel.z = 0;
      }
      if (!hadJumped && car.hasJumped) this.emit({ type: 'jump', car: i, tick: this.tick, double: false });
      if (!hadDouble && car.hasDoubleJumped) this.emit({ type: 'jump', car: i, tick: this.tick, double: true });
      if (!hadFlip && car.hasFlipped) this.emit({ type: 'flip', car: i, tick: this.tick });
    }
    // ball
    if (!this.frozen && !this.goalScored) {
      this.ball.step(DT);
      if (this.ball.lastImpact > 2) this.emit({ type: 'ballBounce', strength: this.ball.lastImpact, tick: this.tick });
    }
    // collisions
    for (let i = 0; i < MAX_CARS; i++) {
      const a = this.cars[i];
      if (!a || a.demolished) continue;
      if (!this.frozen && !this.goalScored) this.carBall(a);
      for (let j = i + 1; j < MAX_CARS; j++) {
        const b = this.cars[j];
        if (!b || b.demolished) continue;
        this.carCar(a, b);
      }
    }
    this.boostPads();
    // goal line
    if (!this.goalScored) {
      const bz = this.ball.pos.z;
      if (Math.abs(bz) > ARENA_HALF_L + BALL_RADIUS && Math.abs(this.ball.pos.x) < GOAL_HALF_W + 1 && this.ball.pos.y < GOAL_H + 1) {
        this.goalScored = true;
        const b = this.ball.pos;
        this.emit({ type: 'goal', team: bz > 0 ? 0 : 1, tick: this.tick, speed: this.ball.vel.length(), x: b.x, y: b.y, z: b.z });
      }
    }
  }

  respawn(car: Car) {
    const [x, z] = RESPAWNS[(car.id + this.tick) % RESPAWNS.length];
    const s = car.team === 0 ? 1 : -1;
    car.reset(x * s, z * s, car.team === 0 ? 0 : Math.PI);
    this.emit({ type: 'respawn', car: car.id, tick: this.tick });
  }

  /** Goal explosions shove nearby cars away. */
  explode(x: number, y: number, z: number, radius: number, strength: number) {
    for (const car of this.cars) {
      if (!car || car.demolished) continue;
      _a.set(car.pos.x - x, car.pos.y - y, car.pos.z - z);
      const d = _a.length();
      if (d > radius || d < 1e-3) continue;
      const f = 1 - d / radius;
      const k = strength * Math.pow(f, 0.8);
      _a.multiplyScalar(k / d);
      _a.y = Math.max(_a.y, 0) + k * 0.45;
      car.vel.add(_a);
      // tumble a little (deterministic from the car id so replays / clients agree)
      const s = Math.sin(car.id * 12.9898 + this.tick) * 0.5;
      car.angVel.x += s * k * 0.25;
      car.angVel.z += (0.5 - Math.abs(s)) * k * 0.25;
    }
  }

  demolish(victim: Car, attacker: Car) {
    this.emit({ type: 'demo', attacker: attacker.id, victim: victim.id, tick: this.tick, x: victim.pos.x, y: victim.pos.y, z: victim.pos.z });
    victim.demolished = true;
    victim.respawnTimer = DEMO_RESPAWN_TIME;
    victim.vel.set(0, 0, 0);
    victim.angVel.set(0, 0, 0);
    victim.pos.set(0, -50, 0);
  }

  private carBall(car: Car) {
    const ball = this.ball;
    const hc = car.hitboxCenter(_a);
    _qi.copy(car.quat).invert();
    const local = _b.subVectors(ball.pos, hc).applyQuaternion(_qi);
    const cx = Math.max(-CAR_HALF.x, Math.min(CAR_HALF.x, local.x));
    const cy = Math.max(-CAR_HALF.y, Math.min(CAR_HALF.y, local.y));
    const cz = Math.max(-CAR_HALF.z, Math.min(CAR_HALF.z, local.z));
    const closest = _p.set(cx, cy, cz).applyQuaternion(car.quat).add(hc);
    const delta = _n.subVectors(ball.pos, closest);
    let dist = delta.length();
    if (dist >= BALL_RADIUS) return;
    if (dist < 1e-4) {
      // centre inside the hitbox – push out along car up
      car.up(delta);
      dist = 0;
    } else delta.multiplyScalar(1 / dist);
    const n = delta;
    const pen = BALL_RADIUS - dist;
    ball.pos.addScaledVector(n, pen * 0.9);
    car.pos.addScaledVector(n, -pen * 0.1);

    const vCar = car.pointVelocity(closest, _c);
    const rel = _a.subVectors(ball.vel, vCar);
    const vn = rel.dot(n);
    const firstTouch = this.lastHitTick[car.id] !== this.tick - 1;
    const relSpeed = Math.min(_fwd.subVectors(ball.vel, car.vel).length(), HIT_MAX_DELTA);
    if (vn < 0) {
      const mCar = car.effectiveMass(closest, n);
      const mEff = 1 / (1 / BALL_MASS + 1 / mCar);
      const jn = -(1 + 0.05) * vn * mEff;
      ball.vel.addScaledVector(n, jn / BALL_MASS);
      car.applyImpulse(_b.copy(n).multiplyScalar(-jn), closest);
      // friction → ball spin
      const r = _b.copy(n).multiplyScalar(-BALL_RADIUS);
      const slip = _c.copy(ball.angVel).cross(r).add(ball.vel).sub(car.pointVelocity(closest, _fwd));
      slip.addScaledVector(n, -slip.dot(n));
      const s = slip.length();
      if (s > 1e-4) {
        slip.multiplyScalar(1 / s);
        const jt = Math.min((BALL_MASS * s) / 3.5, 0.35 * jn);
        ball.vel.addScaledVector(slip, -jt / BALL_MASS);
        ball.angVel.add(r.cross(slip).multiplyScalar(-jt / BALL_INERTIA));
      }
    }
    if (firstTouch) {
      // the arcade "extra impulse" that gives hits their punch
      if (relSpeed > 0) {
        const hitDir = _b.subVectors(ball.pos, car.pos);
        hitDir.y *= HIT_Z_SCALE;
        hitDir.normalize();
        const fwd = car.forward(_fwd);
        hitDir.addScaledVector(fwd, -hitDir.dot(fwd) * (1 - HIT_FORWARD_SCALE)).normalize();
        ball.vel.addScaledVector(hitDir, relSpeed * curve(HIT_CURVE, relSpeed));
      }
      this.emit({ type: 'touch', car: car.id, strength: relSpeed, tick: this.tick, x: closest.x, y: closest.y, z: closest.z });
    }
    this.lastHitTick[car.id] = this.tick;
  }

  private carCar(a: Car, b: Car) {
    // quick reject
    if (a.pos.distanceToSquared(b.pos) > 4) return;
    carOBB(a, obbA);
    carOBB(b, obbB);
    const n = _n;
    const p = _p;
    const depth = obbOverlap(obbA, obbB, n, p);
    if (depth < 0) return;
    // separate
    a.pos.addScaledVector(n, -depth * 0.5);
    b.pos.addScaledVector(n, depth * 0.5);
    const va = a.pointVelocity(p, _a);
    const vb = b.pointVelocity(p, _b);
    const vn = _c.subVectors(vb, va).dot(n);
    const approach = -vn;
    if (vn < 0) {
      const ma = a.effectiveMass(p, n);
      const mb = b.effectiveMass(p, n);
      const j = (-(1 + 0.2) * vn) / (1 / ma + 1 / mb);
      b.applyImpulse(_c.copy(n).multiplyScalar(j), p);
      a.applyImpulse(_c.copy(n).multiplyScalar(-j), p);
    }
    // bumps & demolitions
    this.tryBump(a, b, n, p, approach);
    _c.copy(n).negate();
    this.tryBump(b, a, _c, p, approach);
  }

  private tryBump(att: Car, vic: Car, nToVictim: Vector3, p: Vector3, approach: number) {
    if (approach < 2) return;
    const fwd = att.forward(_fwd);
    if (fwd.dot(nToVictim) < 0.45) return;
    // contact must be on the attacker's front half
    _qi.copy(att.quat).invert();
    const lp = _a.subVectors(p, att.pos).applyQuaternion(_qi);
    if (lp.x < CAR_HITBOX_OFFSET.x) return;
    if (vic.bumpCooldown > 0 && vic.lastBumper === att.id) return;
    const speed = att.vel.dot(nToVictim);
    if (speed < 3) return;
    vic.bumpCooldown = BUMP_COOLDOWN;
    vic.lastBumper = att.id;
    if (att.supersonic && att.team !== vic.team) {
      this.demolish(vic, att);
      return;
    }
    const onGround = vic.onGround;
    const amount = onGround
      ? curve([[0, 0], [12.5, 11], [20, 15.3]], speed)
      : curve([[0, 0], [12.5, 13], [20, 19]], speed);
    const upward = onGround ? curve([[0, 0], [12.5, 2.78], [20, 4.17]], speed) : 0;
    const dir = _b.copy(nToVictim);
    if (onGround) {
      dir.y = 0;
      dir.normalize();
    }
    vic.vel.addScaledVector(dir, amount * 0.6).y += upward;
    this.emit({ type: 'bump', attacker: att.id, victim: vic.id, tick: this.tick, strength: speed });
  }

  private boostPads() {
    for (let pi = 0; pi < this.pads.length; pi++) {
      const pad = this.pads[pi];
      if (pad.timer > 0) {
        pad.timer -= DT;
        continue;
      }
      const r = pad.big ? BIG_PAD_RADIUS : SMALL_PAD_RADIUS;
      for (const car of this.cars) {
        if (!car || car.demolished || car.boost >= BOOST_MAX) continue;
        if (car.pos.y > (pad.big ? 1.68 : 1.65)) continue;
        const dx = car.pos.x - pad.x;
        const dz = car.pos.z - pad.z;
        if (dx * dx + dz * dz > r * r) continue;
        car.boost = Math.min(BOOST_MAX, car.boost + (pad.big ? 100 : 12));
        pad.timer = pad.big ? BIG_PAD_RESPAWN : SMALL_PAD_RESPAWN;
        this.emit({ type: 'pad', car: car.id, pad: pi, big: pad.big, tick: this.tick });
        break;
      }
    }
  }

  // ── state (for netcode rollback & replays) ───────────────────────────
  static stateSize() {
    return 4 + 9 + MAX_CARS * (1 + Car.STATE_SIZE + 1) + BIG_PADS.length + SMALL_PADS.length;
  }

  serialize(out = new Float32Array(World.stateSize())) {
    let o = 0;
    out[o++] = this.tick;
    out[o++] = this.frozen ? 1 : 0;
    out[o++] = this.goalScored ? 1 : 0;
    out[o++] = 0;
    const b = this.ball;
    out[o++] = b.pos.x; out[o++] = b.pos.y; out[o++] = b.pos.z;
    out[o++] = b.vel.x; out[o++] = b.vel.y; out[o++] = b.vel.z;
    out[o++] = b.angVel.x; out[o++] = b.angVel.y; out[o++] = b.angVel.z;
    for (let i = 0; i < MAX_CARS; i++) {
      const car = this.cars[i];
      out[o++] = car ? 1 + car.team : 0;
      if (car) car.writeState(out, o);
      o += Car.STATE_SIZE;
      out[o++] = Math.max(-100, this.lastHitTick[i] - this.tick);
    }
    for (const p of this.pads) out[o++] = p.timer;
    return out;
  }

  /** Restore physics state. Cars present in the snapshot but missing locally are created. */
  deserialize(a: Float32Array) {
    let o = 0;
    this.tick = a[o++];
    this.frozen = a[o++] === 1;
    this.goalScored = a[o++] === 1;
    o++;
    const b = this.ball;
    b.pos.set(a[o++], a[o++], a[o++]);
    b.vel.set(a[o++], a[o++], a[o++]);
    b.angVel.set(a[o++], a[o++], a[o++]);
    for (let i = 0; i < MAX_CARS; i++) {
      const flag = a[o++];
      if (flag > 0) {
        const team = (flag - 1) as Team;
        let car = this.cars[i];
        if (!car || car.team !== team) car = this.addCar(i, team);
        car.readState(a, o);
      } else if (this.cars[i]) this.cars[i] = null;
      o += Car.STATE_SIZE;
      this.lastHitTick[i] = this.tick + a[o++];
    }
    for (const p of this.pads) p.timer = a[o++];
  }
}
