import { Vector3 } from 'three';
import { Ball } from '../physics/ball';
import { ARENA_HALF_L, BALL_RADIUS, DT, GOAL_H, GOAL_HALF_W } from '../physics/constants';

/** Ball-only trajectory prediction (ignores cars). Used by bots and for shot/save detection. */
export class BallPredictor {
  private sim = new Ball();
  readonly steps: number;
  /** sampled positions every `stride` ticks */
  readonly positions: Vector3[] = [];
  readonly velocities: Vector3[] = [];
  readonly stride = 4;
  /** team whose goal the ball enters (0 = blue goal at -z, 1 = orange goal at +z), or -1 */
  goalFor = -1;
  goalTime = Infinity;

  constructor(seconds = 3) {
    this.steps = Math.round(seconds / DT);
    const n = Math.ceil(this.steps / this.stride) + 1;
    for (let i = 0; i < n; i++) {
      this.positions.push(new Vector3());
      this.velocities.push(new Vector3());
    }
  }

  update(pos: Vector3, vel: Vector3, angVel: Vector3) {
    const b = this.sim;
    b.pos.copy(pos);
    b.vel.copy(vel);
    b.angVel.copy(angVel);
    this.goalFor = -1;
    this.goalTime = Infinity;
    let k = 0;
    this.positions[0].copy(pos);
    this.velocities[0].copy(vel);
    for (let i = 1; i <= this.steps; i++) {
      b.step(DT);
      if (this.goalFor < 0 && Math.abs(b.pos.z) > ARENA_HALF_L + BALL_RADIUS && Math.abs(b.pos.x) < GOAL_HALF_W && b.pos.y < GOAL_H) {
        this.goalFor = b.pos.z > 0 ? 1 : 0;
        this.goalTime = i * DT;
      }
      if (i % this.stride === 0) {
        k++;
        this.positions[k].copy(b.pos);
        this.velocities[k].copy(b.vel);
      }
    }
  }

  /** Position at time t seconds (nearest sample). */
  at(t: number): Vector3 {
    const k = Math.max(0, Math.min(this.positions.length - 1, Math.round(t / (DT * this.stride))));
    return this.positions[k];
  }
  get sampleDt() {
    return DT * this.stride;
  }
}
