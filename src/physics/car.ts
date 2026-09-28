import { Quaternion, Vector3 } from 'three';
import { arenaNormal, arenaSDF } from './arena';
import {
  AIR_PITCH_DAMP,
  AIR_PITCH_TORQUE,
  AIR_ROLL_DAMP,
  AIR_ROLL_TORQUE,
  AIR_YAW_DAMP,
  AIR_YAW_TORQUE,
  BOOST_ACCEL_AIR,
  BOOST_ACCEL_GROUND,
  BOOST_MIN_TIME,
  BOOST_START,
  BOOST_USE,
  BRAKE_ACCEL,
  CAR_HALF,
  CAR_HITBOX_OFFSET,
  CAR_INERTIA,
  CAR_MASS,
  CAR_REST_HEIGHT,
  COAST_DECEL,
  curve,
  DODGE_DEADZONE,
  DOUBLEJUMP_WINDOW,
  FLIP_BACKWARD_SCALE,
  FLIP_FORWARD_SCALE,
  FLIP_INITIAL_VEL,
  FLIP_SIDE_SCALE,
  FLIP_TORQUE_TIME,
  FLIP_Z_DAMP,
  FLIP_Z_DAMP_TIME,
  GRAVITY,
  JUMP_HOLD_ACCEL,
  JUMP_IMPULSE,
  JUMP_MAX_TIME,
  JUMP_MIN_TIME,
  MAX_ANG_SPEED,
  MAX_CAR_SPEED,
  POWERSLIDE_STEER_CURVE,
  STEER_CURVE,
  STICKY_FORCE_SCALE,
  SUPERSONIC_MAINTAIN,
  SUPERSONIC_START,
  SUSP_DAMP,
  SUSP_MAX_FORCE,
  SUSP_STIFFNESS,
  THROTTLE_AIR_ACCEL,
  THROTTLE_CURVE,
} from './constants';
import type { CarInput } from './input';

export type Team = 0 | 1; // 0 = blue (defends -z), 1 = orange (defends +z)

interface WheelDef {
  x: number;
  z: number;
  radius: number;
  front: boolean;
  restLen: number;
}

const MOUNT_Y = 0.1;
const FRONT_X = 0.5125;
const BACK_X = -0.3375;
const WHEELBASE = FRONT_X - BACK_X;
const STICKY_TOTAL = GRAVITY * (1 + STICKY_FORCE_SCALE);
function makeWheel(x: number, z: number, radius: number, front: boolean): WheelDef {
  // choose a natural spring length so the car sits level at CAR_REST_HEIGHT
  const share = front ? -BACK_X / WHEELBASE : FRONT_X / WHEELBASE;
  const load = (CAR_MASS * STICKY_TOTAL * share) / 2;
  const eq = MOUNT_Y - (radius - CAR_REST_HEIGHT);
  return { x, z, radius, front, restLen: eq + load / SUSP_STIFFNESS };
}
export const WHEELS: WheelDef[] = [
  makeWheel(FRONT_X, -0.259, 0.125, true),
  makeWheel(FRONT_X, 0.259, 0.125, true),
  makeWheel(BACK_X, -0.295, 0.15, false),
  makeWheel(BACK_X, 0.295, 0.15, false),
];
const MAX_EXTRA_TRAVEL = 0.06;

// hitbox sample points (corners + edge midpoints) in local space
const HITBOX_POINTS: Vector3[] = [];
for (const sx of [-1, 0, 1])
  for (const sy of [-1, 0, 1])
    for (const sz of [-1, 0, 1]) {
      const zeros = (sx === 0 ? 1 : 0) + (sy === 0 ? 1 : 0) + (sz === 0 ? 1 : 0);
      if (zeros > 1) continue; // corners (0 zeros) and edge midpoints (1 zero)
      HITBOX_POINTS.push(
        new Vector3(
          CAR_HITBOX_OFFSET.x + sx * CAR_HALF.x,
          CAR_HITBOX_OFFSET.y + sy * CAR_HALF.y,
          CAR_HITBOX_OFFSET.z + sz * CAR_HALF.z,
        ),
      );
    }

const INV_I = new Vector3(1 / CAR_INERTIA.x, 1 / CAR_INERTIA.y, 1 / CAR_INERTIA.z);

// scratch
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _n = new Vector3();
const _q = new Quaternion();
const _qi = new Quaternion();
const _fwd = new Vector3();
const _up = new Vector3();
const _right = new Vector3();
const _avgN = new Vector3();
// helper-method scratch (kept separate so helpers never clobber step()'s temporaries)
const _ha = new Vector3();
const _hb = new Vector3();
const _hc = new Vector3();
const _hqi = new Quaternion();

export interface WheelContact {
  inContact: boolean;
  length: number; // current suspension length
  point: Vector3; // wheel centre (world)
  normal: Vector3;
}

export class Car {
  id: number;
  team: Team;
  pos = new Vector3(0, CAR_REST_HEIGHT, 0);
  vel = new Vector3();
  quat = new Quaternion();
  angVel = new Vector3();
  boost = BOOST_START;

  // jump / flip state
  isJumping = false;
  jumpTime = 0;
  hasJumped = false;
  airTime = 0; // time since jump ended (for double jump window)
  hasDoubleJumped = false;
  hasFlipped = false;
  isFlipping = false;
  flipTime = 0;
  flipFwd = 0;
  flipSide = 0;
  prevJump = false;
  autoFlipTime = 0;
  autoFlipDir = 0;

  boostTime = 0; // > 0 while boost is (being) applied (min boost time)
  isBoosting = false;
  supersonic = false;
  supersonicTime = 0;
  demolished = false;
  respawnTimer = 0;
  bodyContact = false;
  bumpCooldown = 0;
  lastBumper = -1;
  wheelsInContact = 0;
  handbrake = 0;
  steerAngle = 0;

  wheels: WheelContact[] = WHEELS.map(() => ({
    inContact: false,
    length: 0,
    point: new Vector3(),
    normal: new Vector3(0, 1, 0),
  }));

  constructor(id: number, team: Team) {
    this.id = id;
    this.team = team;
  }

  get onGround() {
    return this.wheelsInContact >= 3;
  }

  forward(out: Vector3) {
    return out.set(1, 0, 0).applyQuaternion(this.quat);
  }
  up(out: Vector3) {
    return out.set(0, 1, 0).applyQuaternion(this.quat);
  }
  right(out: Vector3) {
    return out.set(0, 0, 1).applyQuaternion(this.quat);
  }
  hitboxCenter(out: Vector3) {
    return out.set(CAR_HITBOX_OFFSET.x, CAR_HITBOX_OFFSET.y, CAR_HITBOX_OFFSET.z).applyQuaternion(this.quat).add(this.pos);
  }

  /** Place the car on the floor at (x, z) facing yaw (0 = +z). */
  reset(x: number, z: number, yaw: number) {
    this.pos.set(x, CAR_REST_HEIGHT, z);
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    this.quat.setFromAxisAngle(_a.set(0, 1, 0), yaw - Math.PI / 2);
    this.boost = BOOST_START;
    this.isJumping = this.hasJumped = this.hasDoubleJumped = this.hasFlipped = this.isFlipping = false;
    this.jumpTime = this.airTime = this.flipTime = 0;
    this.autoFlipTime = 0;
    this.boostTime = 0;
    this.isBoosting = false;
    this.supersonic = false;
    this.supersonicTime = 0;
    this.demolished = false;
    this.respawnTimer = 0;
    this.wheelsInContact = 4;
    this.handbrake = 0;
  }

  /** Apply an impulse J (world) at world point p. */
  applyImpulse(J: Vector3, p: Vector3) {
    this.vel.addScaledVector(J, 1 / CAR_MASS);
    _hb.subVectors(p, this.pos).cross(J);
    this.applyAngularImpulse(_hb);
  }

  applyAngularImpulse(L: Vector3) {
    // ω += R · I⁻¹ · Rᵀ · L
    _hqi.copy(this.quat).invert();
    _hc.copy(L).applyQuaternion(_hqi).multiply(INV_I).applyQuaternion(this.quat);
    this.angVel.add(_hc);
  }

  /** Effective mass of the car at world point p along unit direction n. */
  effectiveMass(p: Vector3, n: Vector3) {
    _ha.subVectors(p, this.pos);
    _hb.copy(_ha).cross(n);
    _hqi.copy(this.quat).invert();
    _hc.copy(_hb).applyQuaternion(_hqi).multiply(INV_I).applyQuaternion(this.quat);
    _hc.cross(_ha);
    return 1 / (1 / CAR_MASS + _hc.dot(n));
  }

  /** Velocity of a world point rigidly attached to the car. */
  pointVelocity(p: Vector3, out: Vector3) {
    _ha.subVectors(p, this.pos);
    return out.copy(this.angVel).cross(_ha).add(this.vel);
  }

  private updateWheelContacts() {
    const up = this.up(_up);
    let count = 0;
    for (let i = 0; i < WHEELS.length; i++) {
      const w = WHEELS[i];
      const c = this.wheels[i];
      const maxLen = w.restLen + MAX_EXTRA_TRAVEL;
      // mount point
      _a.set(w.x, MOUNT_Y, w.z).applyQuaternion(this.quat).add(this.pos);
      // sphere-trace the wheel along -up until it touches a surface
      let t = 0;
      let hit = false;
      for (let it = 0; it < 8; it++) {
        const px = _a.x - up.x * t;
        const py = _a.y - up.y * t;
        const pz = _a.z - up.z * t;
        const d = arenaSDF(px, py, pz) - w.radius;
        if (d < 0.002) {
          hit = true;
          break;
        }
        t += d;
        if (t > maxLen) break;
      }
      c.length = Math.min(t, maxLen);
      c.point.copy(_a).addScaledVector(up, -c.length);
      if (hit && t <= maxLen) {
        arenaNormal(c.point.x, c.point.y, c.point.z, c.normal);
        // only count surfaces facing the underside of the car
        if (c.normal.dot(up) > 0.35) {
          c.inContact = true;
          count++;
          continue;
        }
      }
      c.inContact = false;
      c.normal.copy(up);
    }
    this.wheelsInContact = count;
  }

  step(input: CarInput, dt: number) {
    if (this.demolished) return;
    const fwd = this.forward(_fwd);
    const up = this.up(_up);
    const right = this.right(_right);

    this.updateWheelContacts();
    const grounded = this.onGround;
    const anyContact = this.wheelsInContact > 0;
    const jumpPressed = input.jump && !this.prevJump;

    // ── landing resets ──────────────────────────────────────────────────
    if (grounded && !this.isJumping && this.vel.dot(up) < 1.0) {
      this.hasJumped = false;
      this.hasDoubleJumped = false;
      this.hasFlipped = false;
      this.isFlipping = false;
      this.airTime = 0;
    }

    // ── gravity ─────────────────────────────────────────────────────────
    this.vel.y -= GRAVITY * dt;

    // ── boost ───────────────────────────────────────────────────────────
    const wantsBoost = input.boost && this.boost > 0;
    if (wantsBoost && this.boostTime <= 0) this.boostTime = BOOST_MIN_TIME;
    this.isBoosting = this.boost > 0 && (wantsBoost || this.boostTime > 0);
    if (this.isBoosting) {
      this.boost = Math.max(0, this.boost - BOOST_USE * dt);
      const acc = grounded ? BOOST_ACCEL_GROUND : BOOST_ACCEL_AIR;
      this.vel.addScaledVector(fwd, acc * dt);
    }
    if (this.boostTime > 0) this.boostTime -= dt;

    const forwardSpeed = this.vel.dot(fwd);
    this.handbrake = input.handbrake ? Math.min(1, this.handbrake + dt * 5) : Math.max(0, this.handbrake - dt * 2);

    if (anyContact) {
      // average contact normal
      _avgN.set(0, 0, 0);
      for (const c of this.wheels) if (c.inContact) _avgN.add(c.normal);
      _avgN.normalize();

      // ── suspension ──
      for (let i = 0; i < WHEELS.length; i++) {
        const c = this.wheels[i];
        if (!c.inContact) continue;
        const w = WHEELS[i];
        _d.set(w.x, MOUNT_Y, w.z).applyQuaternion(this.quat).add(this.pos);
        this.pointVelocity(_d, _b);
        const compVel = -_b.dot(up) * Math.max(0.3, c.normal.dot(up));
        let f = SUSP_STIFFNESS * (w.restLen - c.length) + SUSP_DAMP * compVel;
        f = Math.max(0, Math.min(SUSP_MAX_FORCE, f));
        _n.copy(up).multiplyScalar(f * dt);
        this.applyImpulse(_n, _d);
      }

      // ── sticky force ──
      let sticky = STICKY_FORCE_SCALE;
      if (Math.abs(input.throttle) < 0.01 || Math.abs(forwardSpeed) < 0.25) sticky += 1 - Math.abs(up.y);
      this.vel.addScaledVector(_avgN, -sticky * GRAVITY * dt);

      // ── throttle / brake ──
      const wheelShare = this.wheelsInContact / 4;
      const throttle = this.isBoosting ? 1 : input.throttle;
      let accel = 0;
      if (Math.abs(throttle) > 0.01) {
        const sameDir = forwardSpeed * throttle >= 0 || Math.abs(forwardSpeed) < 0.25;
        if (sameDir) accel = throttle * curve(THROTTLE_CURVE, Math.abs(forwardSpeed));
        else accel = -Math.sign(forwardSpeed) * BRAKE_ACCEL;
      } else if (Math.abs(forwardSpeed) > 0.01) {
        accel = -Math.sign(forwardSpeed) * Math.min(COAST_DECEL, Math.abs(forwardSpeed) / dt);
      }
      if (this.isBoosting && accel < 0) accel = 0;
      // handbrake adds a bit of longitudinal drag
      if (this.handbrake > 0 && Math.abs(throttle) < 0.01 && Math.abs(forwardSpeed) > 0.01)
        accel -= Math.sign(forwardSpeed) * 3 * this.handbrake;
      // drive along the forward direction flattened onto the contact plane
      _a.copy(fwd).addScaledVector(_avgN, -fwd.dot(_avgN)).normalize();
      const fs = this.vel.dot(_a);
      const dv = accel * dt * wheelShare;
      if (dv * fs < 0 && Math.sign(fs + dv) !== Math.sign(fs)) {
        // brakes / coasting stop the car but never reverse it within a tick
        this.vel.addScaledVector(_a, -fs);
      } else this.vel.addScaledVector(_a, dv);

      // ── steering + lateral tyre friction (sequential impulses) ──
      const steerCurve = this.handbrake > 0.5 ? POWERSLIDE_STEER_CURVE : STEER_CURVE;
      this.steerAngle = input.steer * curve(steerCurve, Math.abs(forwardSpeed));
      const cs = Math.cos(this.steerAngle);
      const sn = Math.sin(this.steerAngle);
      for (let iter = 0; iter < 3; iter++) {
        for (let i = 0; i < WHEELS.length; i++) {
          const c = this.wheels[i];
          if (!c.inContact) continue;
          const w = WHEELS[i];
          // wheel lateral axis (front wheels are steered)
          if (w.front) _a.copy(right).multiplyScalar(cs).addScaledVector(fwd, -sn);
          else _a.copy(right);
          _a.addScaledVector(c.normal, -_a.dot(c.normal)).normalize();
          // contact point = wheel centre - normal * radius
          _d.copy(c.point).addScaledVector(c.normal, -w.radius);
          this.pointVelocity(_d, _b);
          const latSpeed = _b.dot(_a);
          const lonSpeed = Math.abs(_b.dot(fwd));
          const slipRatio = Math.abs(latSpeed) / Math.max(0.01, Math.abs(latSpeed) + lonSpeed);
          let friction = 1 - 0.8 * slipRatio; // lateral friction curve {0:1, 1:0.2}
          if (this.handbrake > 0) friction *= 1 - 0.92 * this.handbrake;
          // apply at the centre-of-mass height so cornering never rolls the car over
          _d.addScaledVector(up, _c.subVectors(this.pos, _d).dot(up));
          const m = this.effectiveMass(_d, _a);
          const j = (-latSpeed * m * friction) / (iter === 0 ? 1 : 2);
          _n.copy(_a).multiplyScalar(j);
          this.applyImpulse(_n, _d);
        }
      }
    }

    // ── surface following (arcade assist) ───────────────────────────────
    // With two or more wheels down the chassis is steered onto the surface normal and
    // velocity into the surface is redirected along it, so ramps and walls keep momentum.
    if (this.wheelsInContact >= 2 && !this.isJumping && !this.isFlipping && this.autoFlipTime <= 0 && up.dot(_avgN) > 0.6) {
      // (small approach speeds are left to the suspension so the car still settles)
      const into = this.vel.dot(_avgN);
      if (into < -0.5) this.vel.addScaledVector(_avgN, -(into + 0.5));
      const cosA = Math.min(1, up.dot(_avgN));
      if (cosA < 0.99999) {
        _q.setFromUnitVectors(up, _avgN);
        _qi.identity().slerp(_q, this.wheelsInContact >= 3 ? 0.35 : 0.2);
        this.quat.premultiply(_qi).normalize();
      }
      // keep only the yaw part of the rotation (about the surface normal)
      const yawRate = this.angVel.dot(_avgN);
      this.angVel.copy(_avgN).multiplyScalar(yawRate);
      fwd.set(1, 0, 0).applyQuaternion(this.quat);
      up.set(0, 1, 0).applyQuaternion(this.quat);
      right.set(0, 0, 1).applyQuaternion(this.quat);
    }

    // ── jumping ─────────────────────────────────────────────────────────
    if (grounded && jumpPressed && !this.isJumping && !this.hasJumped) {
      this.vel.addScaledVector(up, JUMP_IMPULSE);
      this.isJumping = true;
      this.hasJumped = true;
      this.jumpTime = 0;
      this.airTime = 0;
    } else if (!grounded && jumpPressed && this.bodyContact && this.wheelsInContact === 0 && this.autoFlipTime <= 0) {
      // turtle / on-side recovery ("auto flip")
      this.autoFlipTime = 0.4;
      this.autoFlipDir = right.y > 0 ? -1 : 1;
      this.vel.y += 2.5;
    } else if (!anyContact && jumpPressed && !this.hasDoubleJumped && !this.hasFlipped && !this.isJumping) {
      const withinWindow = !this.hasJumped || this.airTime < DOUBLEJUMP_WINDOW;
      if (withinWindow) {
        const sx = input.pitch;
        const sy = input.yaw;
        const mag = Math.abs(sx) + Math.abs(sy);
        if (mag >= DODGE_DEADZONE) this.startFlip(sx, sy, forwardSpeed);
        else {
          this.vel.addScaledVector(up, JUMP_IMPULSE);
          this.hasDoubleJumped = true;
        }
      }
    }
    if (this.isJumping) {
      this.jumpTime += dt;
      const holding = input.jump || this.jumpTime < JUMP_MIN_TIME;
      if (holding && this.jumpTime < JUMP_MAX_TIME) {
        this.vel.addScaledVector(up, JUMP_HOLD_ACCEL * dt);
      } else {
        this.isJumping = false;
      }
    } else if (this.hasJumped && !anyContact) {
      this.airTime += dt;
    }

    // ── flip ────────────────────────────────────────────────────────────
    if (this.isFlipping) {
      this.flipTime += dt;
      if (this.flipTime < FLIP_TORQUE_TIME) {
        // local angular accel: roll about +x, pitch about +z
        // pulling the stick against a front/back flip cancels the pitch spin ("flip cancel")
        let pitchScale = 1;
        if (this.flipFwd !== 0 && input.pitch * this.flipFwd < 0) pitchScale = 1 - Math.min(1, Math.abs(input.pitch));
        _a.set(this.flipSide * 260, 0, -this.flipFwd * 224 * pitchScale).multiplyScalar(dt);
        _a.applyQuaternion(this.quat);
        this.angVel.add(_a);
        if (pitchScale < 1) {
          // actively damp existing pitch rotation while cancelling
          const wl = _b.copy(this.angVel).applyQuaternion(_qi.copy(this.quat).invert());
          wl.z *= 1 - (1 - pitchScale) * 0.2;
          this.angVel.copy(wl.applyQuaternion(this.quat));
        }
      } else {
        this.isFlipping = false;
      }
      // flips "hover": vertical velocity is damped at the start and whenever falling during the flip
      if (this.flipTime < FLIP_Z_DAMP_TIME || (this.vel.y < 0 && this.flipTime < FLIP_TORQUE_TIME)) {
        this.vel.y *= Math.pow(1 - FLIP_Z_DAMP, dt * 120);
      }
    }

    // ── air control ─────────────────────────────────────────────────────
    if (!anyContact) {
      let roll = input.roll;
      let yaw = input.yaw;
      if (input.handbrake && roll === 0) {
        roll = yaw;
        yaw = 0;
      }
      let pitch = input.pitch;
      if (this.isFlipping && this.flipTime < FLIP_TORQUE_TIME) {
        // the flip owns the rotation for a moment
        pitch = this.flipFwd !== 0 ? 0 : pitch;
        roll = this.flipSide !== 0 ? 0 : roll;
      }
      // local angular velocity
      _qi.copy(this.quat).invert();
      const wl = _b.copy(this.angVel).applyQuaternion(_qi);
      const flipping = this.isFlipping && this.flipTime < FLIP_TORQUE_TIME;
      const ax = roll * AIR_ROLL_TORQUE - (flipping && this.flipSide !== 0 ? 0 : wl.x * AIR_ROLL_DAMP);
      const ay = -yaw * AIR_YAW_TORQUE - wl.y * AIR_YAW_DAMP * (1 - Math.abs(yaw));
      const az =
        -pitch * AIR_PITCH_TORQUE - (flipping && this.flipFwd !== 0 ? 0 : wl.z * AIR_PITCH_DAMP * (1 - Math.abs(pitch)));
      _a.set(ax, ay, az).multiplyScalar(dt).applyQuaternion(this.quat);
      this.angVel.add(_a);
      // air throttle
      if (!this.isBoosting) this.vel.addScaledVector(fwd, input.throttle * THROTTLE_AIR_ACCEL * dt);
    }

    // turtle recovery spin
    if (this.autoFlipTime > 0) {
      this.autoFlipTime -= dt;
      _a.copy(fwd).multiplyScalar(this.autoFlipDir * 40 * dt);
      this.angVel.add(_a);
    }

    // ── limits ──────────────────────────────────────────────────────────
    const sp = this.vel.length();
    if (sp > MAX_CAR_SPEED) this.vel.multiplyScalar(MAX_CAR_SPEED / sp);
    const w = this.angVel.length();
    if (w > MAX_ANG_SPEED && !anyContact) this.angVel.multiplyScalar(MAX_ANG_SPEED / w);

    // supersonic
    const speed = Math.min(sp, MAX_CAR_SPEED);
    if (speed >= SUPERSONIC_START) {
      this.supersonic = true;
      this.supersonicTime = 0;
    } else if (this.supersonic) {
      this.supersonicTime += dt;
      if (speed < SUPERSONIC_MAINTAIN || this.supersonicTime > 1) this.supersonic = false;
    }

    if (this.bumpCooldown > 0) this.bumpCooldown -= dt;

    // ── integrate ───────────────────────────────────────────────────────
    this.pos.addScaledVector(this.vel, dt);
    if (w > 1e-6) {
      const ang = (anyContact ? w : Math.min(w, MAX_ANG_SPEED)) * dt;
      _q.setFromAxisAngle(_a.copy(this.angVel).normalize(), ang);
      this.quat.premultiply(_q).normalize();
    }

    this.resolveArena();
    this.prevJump = input.jump;
  }

  private startFlip(pitchIn: number, yawIn: number, forwardSpeed: number) {
    // normalised dodge direction: x = forward, y = right
    let dx = pitchIn;
    let dy = yawIn;
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
    if (Math.abs(dx) < 0.1) dx = 0;
    if (Math.abs(dy) < 0.1) dy = 0;
    this.isFlipping = true;
    this.hasFlipped = true;
    this.flipTime = 0;
    this.flipFwd = dx;
    this.flipSide = dy;

    const ratio = Math.min(1, Math.abs(forwardSpeed) / MAX_CAR_SPEED);
    const backwards = Math.abs(forwardSpeed) < 1 ? dx < 0 : dx >= 0 !== forwardSpeed >= 0;
    let vx = dx * FLIP_INITIAL_VEL;
    let vy = dy * FLIP_INITIAL_VEL;
    const maxScaleX = backwards ? FLIP_BACKWARD_SCALE : FLIP_FORWARD_SCALE;
    vx *= (maxScaleX - 1) * ratio + 1;
    vy *= (FLIP_SIDE_SCALE - 1) * ratio + 1;
    if (backwards) vx *= 16 / 15;
    // yaw-only basis
    const f = this.forward(_a);
    f.y = 0;
    if (f.lengthSq() < 1e-6) f.set(1, 0, 0);
    f.normalize();
    const r = _b.set(-f.z, 0, f.x); // right of flattened forward
    this.vel.addScaledVector(f, vx).addScaledVector(r, vy);
    // kick off the rotation immediately
    _c.set(dy * 5.5, 0, -dx * 5.5).applyQuaternion(this.quat);
    this.angVel.copy(_c);
  }

  /** Push the hitbox out of arena surfaces and remove inward velocity. */
  private resolveArena() {
    this.bodyContact = false;
    for (let pass = 0; pass < 2; pass++) {
      let deepest = 0;
      _n.set(0, 0, 0);
      for (const lp of HITBOX_POINTS) {
        _a.copy(lp).applyQuaternion(this.quat).add(this.pos);
        const d = arenaSDF(_a.x, _a.y, _a.z);
        if (d >= 0) continue;
        this.bodyContact = true;
        arenaNormal(_a.x, _a.y, _a.z, _c);
        // velocity response at this point
        this.pointVelocity(_a, _b);
        const vn = _b.dot(_c);
        if (vn < 0) {
          const m = this.effectiveMass(_a, _c);
          const restitution = vn < -3 ? 0.25 : 0;
          const jn = -(1 + restitution) * vn * m * 0.5;
          _d.copy(_c).multiplyScalar(jn);
          // friction
          _b.addScaledVector(_c, -vn);
          const vt = _b.length();
          if (vt > 1e-4) {
            _b.multiplyScalar(1 / vt);
            const mt = this.effectiveMass(_a, _b);
            const jt = Math.min(vt * mt * 0.5, jn * 0.6);
            _d.addScaledVector(_b, -jt);
          }
          this.applyImpulse(_d, _a);
        }
        if (-d > deepest) {
          deepest = -d;
          _n.copy(_c);
        }
      }
      if (deepest <= 0) break;
      this.pos.addScaledVector(_n, deepest);
    }
  }

  /** Numbers written to snapshots (order matters – see serialize). */
  static readonly STATE_SIZE = 30;
  writeState(a: Float32Array | number[], o: number) {
    a[o++] = this.pos.x; a[o++] = this.pos.y; a[o++] = this.pos.z;
    a[o++] = this.vel.x; a[o++] = this.vel.y; a[o++] = this.vel.z;
    a[o++] = this.quat.x; a[o++] = this.quat.y; a[o++] = this.quat.z; a[o++] = this.quat.w;
    a[o++] = this.angVel.x; a[o++] = this.angVel.y; a[o++] = this.angVel.z;
    a[o++] = this.boost;
    a[o++] =
      (this.isJumping ? 1 : 0) |
      (this.hasJumped ? 2 : 0) |
      (this.hasDoubleJumped ? 4 : 0) |
      (this.hasFlipped ? 8 : 0) |
      (this.isFlipping ? 16 : 0) |
      (this.prevJump ? 32 : 0) |
      (this.isBoosting ? 64 : 0) |
      (this.supersonic ? 128 : 0) |
      (this.demolished ? 256 : 0) |
      (this.bodyContact ? 512 : 0);
    a[o++] = this.jumpTime;
    a[o++] = this.airTime;
    a[o++] = this.flipTime;
    a[o++] = this.flipFwd;
    a[o++] = this.flipSide;
    a[o++] = this.autoFlipTime;
    a[o++] = this.autoFlipDir;
    a[o++] = this.boostTime;
    a[o++] = this.supersonicTime;
    a[o++] = this.respawnTimer;
    a[o++] = this.bumpCooldown;
    a[o++] = this.lastBumper;
    a[o++] = this.wheelsInContact;
    a[o++] = this.handbrake;
    a[o++] = this.steerAngle;
    return o;
  }

  readState(a: Float32Array | number[], o: number) {
    this.pos.set(a[o++], a[o++], a[o++]);
    this.vel.set(a[o++], a[o++], a[o++]);
    this.quat.set(a[o++], a[o++], a[o++], a[o++]).normalize();
    this.angVel.set(a[o++], a[o++], a[o++]);
    this.boost = a[o++];
    const f = a[o++];
    this.isJumping = (f & 1) !== 0;
    this.hasJumped = (f & 2) !== 0;
    this.hasDoubleJumped = (f & 4) !== 0;
    this.hasFlipped = (f & 8) !== 0;
    this.isFlipping = (f & 16) !== 0;
    this.prevJump = (f & 32) !== 0;
    this.isBoosting = (f & 64) !== 0;
    this.supersonic = (f & 128) !== 0;
    this.demolished = (f & 256) !== 0;
    this.bodyContact = (f & 512) !== 0;
    this.jumpTime = a[o++];
    this.airTime = a[o++];
    this.flipTime = a[o++];
    this.flipFwd = a[o++];
    this.flipSide = a[o++];
    this.autoFlipTime = a[o++];
    this.autoFlipDir = a[o++];
    this.boostTime = a[o++];
    this.supersonicTime = a[o++];
    this.respawnTimer = a[o++];
    this.bumpCooldown = a[o++];
    this.lastBumper = a[o++];
    this.wheelsInContact = a[o++];
    this.handbrake = a[o++];
    this.steerAngle = a[o++];
    return o;
  }
}
