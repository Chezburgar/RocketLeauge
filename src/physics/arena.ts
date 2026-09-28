import { Vector3 } from 'three';
import {
  ARENA_CORNER_R,
  ARENA_FILLET,
  ARENA_H,
  ARENA_HALF_L,
  ARENA_HALF_W,
  GOAL_DEPTH,
  GOAL_H,
  GOAL_HALF_W,
} from './constants';

/**
 * The arena is described analytically as a signed distance field: `arenaSDF(p)`
 * is the distance from p to the nearest solid surface (positive in free space,
 * negative inside walls). This gives perfectly smooth floor→wall→ceiling
 * transitions, which is what makes wall driving feel right.
 */

const HALF_H = ARENA_H / 2;

/** Rounded-box interior: side/back walls with rounded vertical corners, filleted top & bottom edges. */
function interior(x: number, y: number, z: number, halfL: number): number {
  const rc = ARENA_CORNER_R;
  const rf = ARENA_FILLET;
  const qx = Math.abs(x) - (ARENA_HALF_W - rc);
  const qz = Math.abs(z) - (halfL - rc);
  const mx = Math.max(qx, 0);
  const mz = Math.max(qz, 0);
  const d2 = Math.sqrt(mx * mx + mz * mz) + Math.min(Math.max(qx, qz), 0) - rc;
  const wx = d2 + rf;
  const wy = Math.abs(y - HALF_H) - (HALF_H - rf);
  const ax = Math.max(wx, 0);
  const ay = Math.max(wy, 0);
  const sd = Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(wx, wy), 0) - rf;
  return -sd;
}

export function arenaSDF(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  if (ax < GOAL_HALF_W && y < GOAL_H && az > ARENA_HALF_L - 12) {
    // Inside the goal-mouth column: the back wall is open here.
    // Solid pieces: floor, wall around the mouth (incl. goal side walls + crossbar),
    // goal back wall, and far-away arena pieces (ceiling etc).
    const dm = Math.min(GOAL_HALF_W - ax, GOAL_H - y);
    const dz = Math.max(ARENA_HALF_L - az, 0);
    const dWall = Math.sqrt(dz * dz + dm * dm);
    const dBack = ARENA_HALF_L + GOAL_DEPTH - az;
    return Math.min(y, dWall, dBack);
  }
  return interior(x, y, z, ARENA_HALF_L);
}

const EPS = 0.005;
/** Outward (into free space) surface normal at p via central differences. */
export function arenaNormal(x: number, y: number, z: number, out: Vector3): Vector3 {
  const nx = arenaSDF(x + EPS, y, z) - arenaSDF(x - EPS, y, z);
  const ny = arenaSDF(x, y + EPS, z) - arenaSDF(x, y - EPS, z);
  const nz = arenaSDF(x, y, z + EPS) - arenaSDF(x, y, z - EPS);
  out.set(nx, ny, nz);
  const l = out.length();
  if (l < 1e-9) out.set(0, 1, 0);
  else out.multiplyScalar(1 / l);
  return out;
}

/** Is the point inside one of the goals (past the goal line)? Returns +1 (orange goal, z>0), -1 (blue goal) or 0. */
export function goalSide(z: number, margin: number): number {
  if (z > ARENA_HALF_L + margin) return 1;
  if (z < -ARENA_HALF_L - margin) return -1;
  return 0;
}
