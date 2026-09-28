import { Quaternion, Vector3 } from 'three';
import type { Car } from '../physics/car';
import { ARENA_HALF_L, BALL_RADIUS, DT } from '../physics/constants';
import { emptyInput, type CarInput } from '../physics/input';
import type { World } from '../physics/world';
import { BallPredictor } from './prediction';

const _v = new Vector3();
const _l = new Vector3();
const _t = new Vector3();
const _qi = new Quaternion();
const UP = new Vector3(0, 1, 0);

/** A simple but reasonably competent car-soccer bot. */
export class Bot {
  readonly slot: number;
  skill: number;
  private input = emptyInput();
  private pred = new BallPredictor(3);
  private predTimer = 0;
  private seq: { t: number; kind: 'jump' | 'flip' | 'double' } | null = null;
  private seqDir = { x: 1, y: 0 };
  private stuckTime = 0;
  private reverseTime = 0;
  private thinkTimer = 0;
  private target = new Vector3();
  private wantBoost = false;
  private cooldown = 0;
  private turtleTime = 0;
  private demoChase = 0;
  private demoCooldown = 0;

  constructor(slot: number, skill = 0.6) {
    this.slot = slot;
    this.skill = skill;
  }

  update(world: World): CarInput {
    const car = world.cars[this.slot];
    const inp = this.input;
    Object.assign(inp, emptyInput());
    if (!car || car.demolished) return inp;
    const ball = world.ball;
    const dir = car.team === 0 ? 1 : -1; // attacking direction along z

    if (--this.predTimer <= 0) {
      this.predTimer = 10;
      this.pred.update(ball.pos, ball.vel, ball.angVel);
    }
    if (this.cooldown > 0) this.cooldown -= DT;
    if (this.demoCooldown > 0) this.demoCooldown -= DT;

    // ── running jump / flip sequence ─────────────────────────────────
    if (this.seq) {
      this.seq.t += DT;
      const t = this.seq.t;
      if (this.seq.kind === 'jump') {
        inp.jump = t < 0.2;
        if (t > 0.9) this.seq = null;
      } else if (this.seq.kind === 'double') {
        inp.jump = t < 0.15 || (t > 0.22 && t < 0.28);
        if (t > 1.2) this.seq = null;
      } else {
        // jump, short wait, then flip in seqDir
        inp.jump = t < 0.08 || (t > 0.13 && t < 0.18);
        if (t > 0.12) {
          inp.pitch = this.seqDir.x;
          inp.yaw = this.seqDir.y;
        }
        inp.throttle = 1;
        if (t > 0.9) this.seq = null;
      }
      if (this.seq) {
        if (!car.onGround && t > 0.3) this.airRecovery(car, inp);
        return inp;
      }
    }

    // ── lying on the side / roof: tap jump to self-right ────────────
    if (car.wheelsInContact === 0 && car.bodyContact && car.vel.length() < 3) {
      this.turtleTime += DT;
      inp.jump = this.turtleTime % 0.5 < 0.1;
      this.airRecovery(car, inp);
      return inp;
    }
    this.turtleTime = 0;

    // ── in the air: land on the wheels ──────────────────────────────
    if (car.wheelsInContact === 0) {
      this.airRecovery(car, inp);
      inp.throttle = 1;
      return inp;
    }

    // ── decide where to go (re-evaluated a few times per second) ─────
    if (--this.thinkTimer <= 0) {
      this.thinkTimer = Math.round((0.05 + (1 - this.skill) * 0.25) / DT);
      this.chooseTarget(world, car, dir);
    }

    // ── drive to target ─────────────────────────────────────────────
    _qi.copy(car.quat).invert();
    _l.subVectors(this.target, car.pos).applyQuaternion(_qi);
    const angle = Math.atan2(_l.z, _l.x);
    const dist = Math.hypot(_l.x, _l.z);
    const speed = car.vel.length();
    const fwdSpeed = car.vel.dot(_v.set(1, 0, 0).applyQuaternion(car.quat));

    // stuck detection
    if (speed < 1.5 && this.reverseTime <= 0) this.stuckTime += DT;
    else this.stuckTime = 0;
    if (this.stuckTime > 0.8) {
      this.reverseTime = 0.7;
      this.stuckTime = 0;
    }
    if (this.reverseTime > 0) {
      this.reverseTime -= DT;
      inp.throttle = -1;
      inp.steer = -Math.sign(angle);
      return inp;
    }

    inp.steer = Math.max(-1, Math.min(1, angle * 3));
    inp.throttle = 1;
    if (Math.abs(angle) > 1.9 && dist < 8 && fwdSpeed < 6) {
      // target right behind us – reverse towards it
      inp.throttle = -1;
      inp.steer = -Math.sign(angle);
    }
    inp.handbrake = Math.abs(angle) > 1.6 && speed > 8 && car.up(_v).y > 0.8;
    const ballDist = car.pos.distanceTo(ball.pos);
    const aligned = Math.abs(angle) < 0.25;
    inp.boost =
      this.wantBoost && aligned && car.boost > 0 && speed < 22.8 && (this.skill > 0.45 || dist > 30) && car.up(_v).y > 0.5;

    // slow down a bit if we'd overshoot a waiting position
    if (!this.wantBoost && dist < 4 && ballDist > 12) inp.throttle = Math.min(inp.throttle, dist / 4);

    // ── hitting the ball ────────────────────────────────────────────
    if (this.cooldown <= 0 && this.skill > 0.3) {
      const rel = _t.subVectors(ball.pos, car.pos);
      const horiz = Math.hypot(rel.x, rel.z);
      const closing = -_v.subVectors(ball.vel, car.vel).dot(rel) / Math.max(0.1, rel.length());
      const lb = _l.copy(rel).applyQuaternion(_qi);
      const ballAngle = Math.atan2(lb.z, lb.x);
      const isKickoff = ball.vel.lengthSq() < 0.01 && Math.abs(ball.pos.x) < 0.1 && Math.abs(ball.pos.z) < 0.1;
      if (isKickoff && horiz < 3.2 + speed * 0.12 && Math.abs(ballAngle) < 0.3 && car.onGround) {
        this.startFlip(1, 0);
      } else if (horiz < 3.2 && rel.y > 1.4 && rel.y < 3.6 && closing > 2 && Math.abs(ballAngle) < 0.5 && car.onGround) {
        this.seq = { t: 0, kind: rel.y > 2.6 && this.skill > 0.55 ? 'double' : 'jump' };
        this.cooldown = 1.2;
      } else if (horiz < 3.4 && rel.y < 1.6 && closing > 3 && Math.abs(ballAngle) < 0.35 && car.onGround && this.skill > 0.5 && speed > 7) {
        // dodge into the ball for power
        const a = ballAngle;
        this.startFlip(Math.cos(a), Math.sin(a) * 1.3);
      }
    }
    return inp;
  }

  private startFlip(fx: number, fy: number) {
    const l = Math.hypot(fx, fy) || 1;
    this.seqDir = { x: fx / l, y: fy / l };
    this.seq = { t: 0, kind: 'flip' };
    this.cooldown = 1.5;
  }

  private airRecovery(car: Car, inp: CarInput) {
    // rotate so that car up → world up while keeping heading
    _qi.copy(car.quat).invert();
    const upL = _l.copy(UP).applyQuaternion(_qi);
    // upL expressed in car frame: x = forward, y = up, z = right
    inp.pitch = Math.max(-1, Math.min(1, upL.x * 3)); // world-up tilted forward → nose down
    inp.roll = Math.max(-1, Math.min(1, -upL.z * 3));
    // damp spin
    const w = _v.copy(car.angVel).applyQuaternion(_qi);
    inp.pitch += w.z * 0.25;
    inp.roll -= w.x * 0.15;
    inp.pitch = Math.max(-1, Math.min(1, inp.pitch));
    inp.roll = Math.max(-1, Math.min(1, inp.roll));
  }

  private chooseTarget(world: World, car: Car, dir: number) {
    const ball = world.ball;
    const pred = this.pred;
    const ownGoalZ = -dir * ARENA_HALF_L;
    const maxSpeed = car.boost > 15 ? 19 : 13;

    // find the first point on the ball's path we can reach
    let tHit = pred.positions.length - 1;
    for (let k = 0; k < pred.positions.length; k++) {
      const p = pred.positions[k];
      if (p.y > 3.2) continue;
      const d = Math.hypot(p.x - car.pos.x, p.z - car.pos.z) - 2;
      const t = k * pred.sampleDt;
      if (d / maxSpeed <= t + 0.1) {
        tHit = k;
        break;
      }
    }
    const hit = pred.positions[tHit];

    // teammates: am I the closest to the ball on my team?
    let myEta = Math.hypot(hit.x - car.pos.x, hit.z - car.pos.z);
    let closer = 0;
    for (const other of world.cars) {
      if (!other || other === car || other.team !== car.team || other.demolished) continue;
      const eta = Math.hypot(hit.x - other.pos.x, hit.z - other.pos.z);
      if (eta < myEta - 2) closer++;
    }
    const danger = pred.goalFor === car.team;
    const ballInOwnHalf = ball.pos.z * dir < 0;

    if (closer > 0 && !danger) {
      // support role: sit between ball and own goal
      const back = closer === 1 ? 0.45 : 0.75;
      this.target.set(hit.x * 0.4, 0, hit.z + (ownGoalZ - hit.z) * back);
      this.wantBoost = car.pos.distanceTo(this.target) > 25;
      return;
    }

    // aim point: behind the ball, on the line from the opponent goal through the ball
    const goal = _t.set(Math.max(-6, Math.min(6, hit.x * 0.3)), 0, dir * ARENA_HALF_L);
    const toGoal = _v.subVectors(goal, hit).setY(0).normalize();
    const carAhead = (car.pos.z - hit.z) * dir > 1.5;
    if (danger || (carAhead && ballInOwnHalf && Math.abs(hit.x) < 20)) {
      if (carAhead) {
        // get goal-side first: head for a point beside the ball toward our goal
        const side = car.pos.x > hit.x ? 1 : -1;
        this.target.set(hit.x + side * 6, 0, hit.z - dir * 10);
        if ((car.pos.z - ownGoalZ) * dir < (hit.z - ownGoalZ) * dir) this.target.set(hit.x, 0, hit.z);
      } else {
        // clear it: hit away from our goal
        const away = _t.set(hit.x - car.pos.x, 0, hit.z - car.pos.z).normalize();
        this.target.copy(hit).addScaledVector(away, 0.6);
      }
      this.wantBoost = true;
    } else if (carAhead) {
      // rotate back behind the ball
      this.target.set(hit.x * 0.6 + (car.pos.x > hit.x ? 8 : -8), 0, hit.z - dir * 14);
      this.wantBoost = false;
    } else {
      const d = Math.hypot(hit.x - car.pos.x, hit.z - car.pos.z);
      const toBall = _t.set(hit.x - car.pos.x, 0, hit.z - car.pos.z).normalize();
      const align = toBall.dot(toGoal);
      if (align > 0.55 || d < 2.5) {
        // lined up: drive straight through the ball towards the goal
        this.target.copy(hit).addScaledVector(toGoal, 1.0);
      } else {
        // swing around to get behind the ball
        const offset = Math.min(7, 2 + (1 - align) * 3);
        this.target.copy(hit).addScaledVector(toGoal, -offset);
      }
      this.wantBoost = d > 8 || (car.boost > 50 && d > 4);
    }
    if (ball.vel.lengthSq() < 0.01 && Math.abs(ball.pos.x) < 0.1 && Math.abs(ball.pos.z) < 0.1) {
      // kickoff: straight at the ball
      this.target.set(0, 0, 0);
      this.wantBoost = true;
    }
    this.target.y = 0;
    // stay on the pitch
    this.target.x = Math.max(-38, Math.min(38, this.target.x));
    this.target.z = Math.max(-49, Math.min(49, this.target.z));
    this.lookForDemo(world, car, danger);
  }

  /** Skilled bots go for a demolition when an opponent is lined up and the ball isn't urgent. */
  private lookForDemo(world: World, car: Car, danger: boolean) {
    if (this.demoCooldown > 0) return;
    if (this.demoChase > 2.5) {
      // give up and play the ball for a while
      this.demoChase = 0;
      this.demoCooldown = 6;
      return;
    }
    const fast = car.supersonic || (car.vel.length() > 15 && car.boost > 30);
    if (this.skill < 0.55 || danger || !fast || !car.onGround) {
      this.demoChase = 0;
      return;
    }
    const ballDist = car.pos.distanceTo(world.ball.pos);
    if (ballDist < 18) return;
    // never leave the net empty: someone on our team must be closer to our goal
    const ownZ = car.team === 0 ? -51.2 : 51.2;
    const myBack = Math.abs(car.pos.z - ownZ);
    let covered = false;
    for (const t of world.cars) if (t && t !== car && t.team === car.team && !t.demolished && Math.abs(t.pos.z - ownZ) < myBack) covered = true;
    if (!covered && Math.abs(world.ball.pos.z - ownZ) < 60) return;
    const fwd = _v.set(1, 0, 0).applyQuaternion(car.quat);
    let best: Car | null = null;
    let bestD = 28;
    for (const o of world.cars) {
      if (!o || o.team === car.team || o.demolished) continue;
      const to = _t.copy(o.pos).addScaledVector(o.vel, 0.35).sub(car.pos);
      const d = to.length();
      if (d > bestD || d < 3) continue;
      if (to.normalize().dot(fwd) < 0.8) continue;
      best = o;
      bestD = d;
    }
    if (!best) {
      this.demoChase = 0;
      return;
    }
    this.demoChase += 0.05 + (1 - this.skill) * 0.25; // ≈ time between decisions
    this.target.copy(best.pos).addScaledVector(best.vel, 0.35);
    this.target.y = 0;
    this.wantBoost = true;
  }
}
