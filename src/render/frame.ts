import { Quaternion, Vector3 } from 'three';
import type { World } from '../physics/world';
import { MAX_CARS } from '../physics/world';

export interface CarFrame {
  present: boolean;
  team: number;
  pos: Vector3;
  quat: Quaternion;
  vel: Vector3;
  boosting: boolean;
  supersonic: boolean;
  demolished: boolean;
  onGround: boolean;
  wheelsInContact: number;
  steer: number;
  wheelLen: number[];
  boost: number;
}

export interface Frame {
  tick: number;
  ballPos: Vector3;
  ballVel: Vector3;
  ballAng: Vector3;
  ballVisible: boolean;
  cars: CarFrame[];
}

export function newFrame(): Frame {
  const cars: CarFrame[] = [];
  for (let i = 0; i < MAX_CARS; i++)
    cars.push({
      present: false,
      team: 0,
      pos: new Vector3(),
      quat: new Quaternion(),
      vel: new Vector3(),
      boosting: false,
      supersonic: false,
      demolished: false,
      onGround: true,
      wheelsInContact: 4,
      steer: 0,
      wheelLen: [0, 0, 0, 0],
      boost: 0,
    });
  return { tick: 0, ballPos: new Vector3(), ballVel: new Vector3(), ballAng: new Vector3(), ballVisible: true, cars };
}

export function captureFrame(w: World, f: Frame) {
  f.tick = w.tick;
  f.ballPos.copy(w.ball.pos);
  f.ballVel.copy(w.ball.vel);
  f.ballAng.copy(w.ball.angVel);
  f.ballVisible = !w.goalScored;
  for (let i = 0; i < MAX_CARS; i++) {
    const c = w.cars[i];
    const cf = f.cars[i];
    cf.present = !!c;
    if (!c) continue;
    cf.team = c.team;
    cf.pos.copy(c.pos);
    cf.quat.copy(c.quat);
    cf.vel.copy(c.vel);
    cf.boosting = c.isBoosting;
    cf.supersonic = c.supersonic;
    cf.demolished = c.demolished;
    cf.onGround = c.onGround;
    cf.wheelsInContact = c.wheelsInContact;
    cf.steer = c.steerAngle;
    cf.boost = c.boost;
    for (let k = 0; k < 4; k++) cf.wheelLen[k] = c.wheels[k].length;
  }
}

export function copyFrame(src: Frame, dst: Frame) {
  dst.tick = src.tick;
  dst.ballPos.copy(src.ballPos);
  dst.ballVel.copy(src.ballVel);
  dst.ballAng.copy(src.ballAng);
  dst.ballVisible = src.ballVisible;
  for (let i = 0; i < MAX_CARS; i++) {
    const a = src.cars[i];
    const b = dst.cars[i];
    b.present = a.present;
    b.team = a.team;
    b.pos.copy(a.pos);
    b.quat.copy(a.quat);
    b.vel.copy(a.vel);
    b.boosting = a.boosting;
    b.supersonic = a.supersonic;
    b.demolished = a.demolished;
    b.onGround = a.onGround;
    b.wheelsInContact = a.wheelsInContact;
    b.steer = a.steer;
    b.boost = a.boost;
    for (let k = 0; k < 4; k++) b.wheelLen[k] = a.wheelLen[k];
  }
}

/** out = lerp(a, b, t) for transforms; discrete fields from b. */
export function lerpFrame(a: Frame, b: Frame, t: number, out: Frame) {
  copyFrame(b, out);
  if (a.ballVisible === b.ballVisible && a.ballPos.distanceToSquared(b.ballPos) < 25) out.ballPos.lerpVectors(a.ballPos, b.ballPos, t);
  for (let i = 0; i < MAX_CARS; i++) {
    const ca = a.cars[i];
    const cb = b.cars[i];
    const co = out.cars[i];
    if (!ca.present || !cb.present || ca.demolished !== cb.demolished) continue;
    if (ca.pos.distanceToSquared(cb.pos) > 25) continue; // teleport (respawn)
    co.pos.lerpVectors(ca.pos, cb.pos, t);
    co.quat.slerpQuaternions(ca.quat, cb.quat, t);
  }
}

/** Ring buffer of frames for goal replays. */
export class ReplayBuffer {
  private frames: Frame[] = [];
  private head = 0;
  private count = 0;
  constructor(private capacity: number) {
    for (let i = 0; i < capacity; i++) this.frames.push(newFrame());
  }
  push(w: World) {
    captureFrame(w, this.frames[this.head]);
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }
  pushFrame(f: Frame) {
    copyFrame(f, this.frames[this.head]);
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }
  /** Copy of the most recent `n` frames, oldest first. */
  snapshot(n: number): Frame[] {
    const out: Frame[] = [];
    const k = Math.min(n, this.count);
    for (let i = k; i > 0; i--) {
      const idx = (this.head - i + this.capacity) % this.capacity;
      const f = newFrame();
      copyFrame(this.frames[idx], f);
      out.push(f);
    }
    return out;
  }
  clear() {
    this.count = 0;
  }
}
