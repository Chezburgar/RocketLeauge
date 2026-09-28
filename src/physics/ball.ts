import { Quaternion, Vector3 } from 'three';
import { arenaNormal, arenaSDF } from './arena';
import {
  BALL_DRAG,
  BALL_FRICTION,
  BALL_MASS,
  BALL_MAX_ANG,
  BALL_MAX_SPEED,
  BALL_RADIUS,
  BALL_RESTITUTION,
  GRAVITY,
} from './constants';

const _n = new Vector3();
const _r = new Vector3();
const _vt = new Vector3();
const _a = new Vector3();
const _q = new Quaternion();

export const BALL_INERTIA = 0.4 * BALL_MASS * BALL_RADIUS * BALL_RADIUS;

export class Ball {
  pos = new Vector3(0, BALL_RADIUS, 0);
  vel = new Vector3();
  angVel = new Vector3();
  /** visual only – not part of the replicated state */
  quat = new Quaternion();
  /** strongest surface impact this tick (for sounds) */
  lastImpact = 0;
  onGround = false;

  reset(x = 0, y = BALL_RADIUS, z = 0) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
  }

  step(dt: number) {
    this.lastImpact = 0;
    this.vel.y -= GRAVITY * dt;
    this.vel.multiplyScalar(1 - BALL_DRAG * dt);
    const sp = this.vel.length();
    if (sp > BALL_MAX_SPEED) this.vel.multiplyScalar(BALL_MAX_SPEED / sp);
    this.pos.addScaledVector(this.vel, dt);
    this.collideArena();
    const w = this.angVel.length();
    if (w > BALL_MAX_ANG) this.angVel.multiplyScalar(BALL_MAX_ANG / w);
    if (w > 1e-5) {
      _q.setFromAxisAngle(_a.copy(this.angVel).multiplyScalar(1 / w), w * dt);
      this.quat.premultiply(_q).normalize();
    }
  }

  private collideArena() {
    this.onGround = false;
    for (let iter = 0; iter < 3; iter++) {
      const d = arenaSDF(this.pos.x, this.pos.y, this.pos.z);
      if (d >= BALL_RADIUS) return;
      const n = arenaNormal(this.pos.x, this.pos.y, this.pos.z, _n);
      this.pos.addScaledVector(n, BALL_RADIUS - d);
      if (n.y > 0.7) this.onGround = true;
      const vn = this.vel.dot(n);
      if (vn >= 0) continue;
      this.lastImpact = Math.max(this.lastImpact, -vn);
      const e = vn < -1.5 ? BALL_RESTITUTION : 0;
      const jn = -(1 + e) * vn * BALL_MASS;
      this.vel.addScaledVector(n, -(1 + e) * vn);
      // friction at the contact point couples linear and angular velocity
      _r.copy(n).multiplyScalar(-BALL_RADIUS); // centre → contact
      _vt.copy(this.angVel).cross(_r).add(this.vel);
      _vt.addScaledVector(n, -_vt.dot(n)); // slip velocity at contact
      const slip = _vt.length();
      if (slip > 1e-5) {
        _vt.multiplyScalar(1 / slip);
        // impulse needed to stop slipping for a solid sphere: m * slip / 3.5
        const jt = Math.min((BALL_MASS * slip) / 3.5, BALL_FRICTION * jn + BALL_MASS * 0.02);
        this.vel.addScaledVector(_vt, -jt / BALL_MASS);
        // Δω = r × (−jt·t̂) / I
        _a.copy(_r).cross(_vt).multiplyScalar(-jt / BALL_INERTIA);
        this.angVel.add(_a);
      }
    }
  }
}
