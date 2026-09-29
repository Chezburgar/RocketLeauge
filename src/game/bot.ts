import { Quaternion, Vector3 } from 'three';
import type { Car } from '../physics/car';
import {
  ARENA_HALF_L,
  ARENA_HALF_W,
  BALL_RADIUS,
  BOOST_ACCEL_GROUND,
  BOOST_USE,
  CAR_HALF,
  CAR_HITBOX_OFFSET,
  CAR_REST_HEIGHT,
  curve,
  DT,
  GOAL_HALF_W,
  GRAVITY,
  MAX_CAR_SPEED,
  STEER_CURVE,
  THROTTLE_CURVE,
} from '../physics/constants';
import { emptyInput, type CarInput } from '../physics/input';
import { World } from '../physics/world';
import { BallPredictor } from './prediction';

/*
 * Car-soccer bot.
 *
 *  - One ball prediction per world is shared by all bots. Each bot searches it for the first
 *    moment it can reach the ball (real throttle/boost curves plus a turning cost), then
 *    commits to that intercept until the ball's path changes.
 *  - Each bot takes a role inside its team by time-to-ball: first man plays the ball, second
 *    man supports / collects boost, last man keeps the net. Only the first man challenges.
 *  - Shots are aimed at the opponent goal; in the own third or when the ball is heading into
 *    the net it clears towards the side walls instead. Touches that would send the ball
 *    towards the bot's own goal are avoided, and when it isn't playing the ball it steers
 *    around it rather than bumping it back towards its net.
 *  - Balls in the air are met with timed jumps, double jumps or aerials; the jump timing is
 *    played out against the prediction using a height table measured with the real physics.
 *
 * `skill` (0..1) picks a profile: reaction time, aim, which mechanics it uses, boost habits.
 *   0.35 Rookie · 0.6 Pro · 0.9 All-Star
 */

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** What a bot of a given skill is able to do. */
export interface BotProfile {
  /** seconds before it reacts to the ball changing direction */
  react: number;
  /** how far off (m) its shots are aimed, at most */
  aimError: number;
  jumpShots: boolean;
  doubleJumps: boolean;
  aerials: boolean;
  /** dodges into the ball, jump + dodge shots */
  dodges: boolean;
  demos: boolean;
  /** detours for boost pads */
  boostPickup: boolean;
  /** boost it won't spend on driving */
  boostReserve: number;
  /** only boosts towards targets at least this far away (m) */
  boostMinDist: number;
  /** flips into the ball at kickoff */
  fastKickoff: boolean;
  /** throttle it drives with (1 = full) */
  maxThrottle: number;
  /** air control gain */
  airGain: number;
}

export function botProfile(skill: number): BotProfile {
  return {
    react: clamp(0.06 + (0.9 - skill) * 0.46, 0.04, 0.4),
    aimError: clamp((0.95 - skill) * 6.5, 0.2, 5),
    jumpShots: skill >= 0.3,
    doubleJumps: skill >= 0.5,
    aerials: skill >= 0.72,
    dodges: skill >= 0.5,
    demos: skill >= 0.55,
    boostPickup: skill > 0.45,
    boostReserve: skill < 0.45 ? 40 : 0,
    boostMinDist: skill < 0.45 ? 25 : 20,
    fastKickoff: skill >= 0.45,
    maxThrottle: skill < 0.45 ? 0.85 : 1,
    airGain: 2.2 + skill * 1.8,
  };
}

type Role = 'first' | 'second' | 'third';
type ShotKind = 'ground' | 'jump' | 'double' | 'aerial';
type Mode = 'attack' | 'clear';

interface Intercept {
  hitTick: number;
  /** ball position at the hit, as planned */
  planned: Vector3;
  /** ball position at the hit, latest prediction */
  ball: Vector3;
  kind: ShotKind;
  shotDir: Vector3;
  mode: Mode;
}

type Maneuver =
  | { kind: 'flip'; t: number; fx: number; fz: number }
  | { kind: 'jumpShot'; t: number; double: boolean; hitTick: number; dodged: boolean }
  | { kind: 'aerial'; t: number; hitTick: number; double: boolean; shotDir: Vector3 };

const WORLD_UP = new Vector3(0, 1, 0);
/** re-plan at least this often even when nothing changed (s) */
const REPLAN = 0.3;

// ── shared ball prediction (one per world) ──
const PRED_SECONDS = 4;
interface Shared {
  pred: BallPredictor;
  tick: number;
  /** bumped whenever the ball leaves its predicted path (touches, kickoff reset…) */
  version: number;
}
const predCache = new WeakMap<World, Shared>();
function sharedPrediction(world: World) {
  let c = predCache.get(world);
  if (!c) {
    c = { pred: new BallPredictor(PRED_SECONDS), tick: -1e9, version: 0 };
    predCache.set(world, c);
  }
  const ageTicks = world.tick - c.tick;
  let stale = ageTicks < 0 || ageTicks * DT > 0.5;
  let changed = ageTicks < 0;
  if (!stale && ageTicks % c.pred.stride === 0) {
    const k = ageTicks / c.pred.stride;
    if (k >= c.pred.positions.length || c.pred.velocities[k].distanceToSquared(world.ball.vel) > 0.25 || c.pred.positions[k].distanceToSquared(world.ball.pos) > 0.04) {
      stale = true;
      changed = true;
    }
  }
  if (stale) {
    c.pred.update(world.ball.pos, world.ball.vel, world.ball.angVel);
    c.tick = world.tick;
    if (changed) c.version++;
  }
  return { pred: c.pred, age: (world.tick - c.tick) * DT, version: c.version };
}

/** Ball position `t` seconds after the prediction was made (linear between samples). */
function predictBall(pred: BallPredictor, t: number, out: Vector3) {
  const f = t / pred.sampleDt;
  const n = pred.positions.length - 1;
  const k = Math.min(n - 1, Math.max(0, Math.floor(f)));
  const a = clamp(f - k, 0, 1);
  return out.copy(pred.positions[k]).lerp(pred.positions[k + 1], a);
}

// ── jump height tables, measured once with the real car physics ──
let jumpTables: { single: number[]; double: number[] } | null = null;
function tables() {
  if (jumpTables) return jumpTables;
  const sim = (dbl: boolean) => {
    const w = new World();
    w.muteEvents = true;
    const c = w.addCar(0, 0);
    c.reset(20, -20, 0); // well away from the ball
    const inp = emptyInput();
    for (let i = 0; i < 30; i++) w.step([inp]);
    const base = c.pos.y;
    const h: number[] = [];
    for (let i = 0; i < 300; i++) {
      const t = i * DT;
      inp.jump = t < 0.2 || (dbl && t >= 0.25 && t < 0.3);
      w.step([inp]);
      h.push(c.pos.y - base);
      if (t > 0.35 && c.vel.y <= 0) break;
    }
    return h;
  };
  jumpTables = { single: sim(false), double: sim(true) };
  return jumpTables;
}
/** Seconds of jumping to rise `dh`; just above the apex still counts (the roof reaches it). */
function timeToRise(table: number[], dh: number) {
  for (let i = 0; i < table.length; i++) if (table[i] >= dh) return (i + 1) * DT;
  return dh <= table[table.length - 1] + 0.2 ? table.length * DT : Infinity;
}
/** Ball centre height minus this = car centre height that meets it squarely. */
const CONTACT_DROP = 0.55;

/** Fastest speed (m/s) at which the car can still drive a circle of radius `r` (m). */
const WHEELBASE = 0.85;
const TURN_SPEEDS: number[] = [];
const TURN_RADII: number[] = [];
for (let v = 0; v <= MAX_CAR_SPEED + 0.01; v += 0.5) {
  TURN_SPEEDS.push(v);
  TURN_RADII.push(WHEELBASE / Math.tan(curve(STEER_CURVE, v)));
}
function speedForRadius(r: number) {
  let best = 0;
  for (let i = 0; i < TURN_SPEEDS.length; i++) if (TURN_RADII[i] <= r) best = TURN_SPEEDS[i];
  return best;
}

/** Would a hit from (bx, bz) in direction (hx, hz) send the ball at `team`'s own goal? */
function towardsOwnGoal(team: number, bx: number, bz: number, hx: number, hz: number) {
  const dir = team === 0 ? 1 : -1;
  const l = Math.hypot(hx, hz);
  if (l < 1e-6) return false;
  hx /= l;
  hz /= l;
  if (hz * dir > -0.2) return false;
  const ownZ = -dir * ARENA_HALF_L;
  const x = bx + hx * ((ownZ - bz) / hz);
  return Math.abs(x) < GOAL_HALF_W + 5;
}

/**
 * Rough time for a car to reach the ball (used to decide who goes). Includes the time to turn
 * and a penalty for being on the wrong side of the ball.
 */
function quickEta(c: Car, pred: BallPredictor, age: number, dir: number, tmp: Vector3) {
  const fwd = tmp.set(1, 0, 0).applyQuaternion(c.quat);
  const fl = Math.hypot(fwd.x, fwd.z) || 1;
  const v0 = Math.max(0, (c.vel.x * fwd.x + c.vel.z * fwd.z) / fl);
  const boosting = c.boost > 8;
  const vmax = boosting ? MAX_CAR_SPEED : 13;
  const a = boosting ? 13 : 8;
  const tAcc = Math.max(0, (vmax - v0) / a);
  const n = pred.positions.length;
  for (let k = Math.ceil(age / pred.sampleDt); k < n; k += 2) {
    const t = k * pred.sampleDt - age;
    if (t < 0) continue;
    const b = pred.positions[k];
    if (b.y > 4) continue;
    const dx = b.x - c.pos.x;
    const dz = b.z - c.pos.z;
    const dl = Math.hypot(dx, dz) || 1;
    const ang = Math.acos(clamp((fwd.x * dx + fwd.z * dz) / (fl * dl), -1, 1));
    const wrongSide = (c.pos.z - b.z) * dir > 1 ? 0.7 : 0;
    const air = c.wheelsInContact === 0 ? 0.4 : 0;
    const tt = t - ang * 0.4 - wrongSide - air;
    if (tt <= 0) continue;
    const reach = tt <= tAcc ? v0 * tt + 0.5 * a * tt * tt : v0 * tAcc + 0.5 * a * tAcc * tAcc + vmax * (tt - tAcc);
    if (reach >= dl - 1.6) return t;
  }
  return 9;
}

/**
 * If the straight line from P to T runs through the circle (C, r), write a waypoint that goes
 * around the circle into `out` and return true.
 */
function around(px: number, pz: number, tx: number, tz: number, cx: number, cz: number, r: number, out: Vector3) {
  const dx = tx - px;
  const dz = tz - pz;
  const L = Math.hypot(dx, dz);
  if (L < 0.5) return false;
  const ux = dx / L;
  const uz = dz / L;
  const wx = cx - px;
  const wz = cz - pz;
  const along = wx * ux + wz * uz;
  const cross = ux * wz - uz * wx; // > 0: circle centre right of the path
  if (along < 0 || along > L + r * 0.5 || Math.abs(cross) >= r) return false;
  if (Math.hypot(tx - cx, tz - cz) < r) return false; // the target itself is by the circle
  const dc = Math.hypot(wx, wz);
  const s = cross > 0 ? -1 : 1; // pass on the other side
  if (dc <= r * 1.05) {
    // already next to it: move sideways away from it
    const nx = -wx / dc;
    const nz = -wz / dc;
    out.set(px + (nx - s * nz) * 3, 0, pz + (nz + s * nx) * 3);
    return true;
  }
  // tangent point, pushed a little past
  const alpha = Math.asin(r / dc) * s;
  const cs = Math.cos(alpha);
  const sn = Math.sin(alpha);
  const ex = wx / dc;
  const ez = wz / dc;
  // rotating (x, z) by +θ turns towards +z (the right)
  const rx = ex * cs - ez * sn;
  const rz = ex * sn + ez * cs;
  const len = Math.sqrt(dc * dc - r * r) + 1.5;
  out.set(px + rx * len, 0, pz + rz * len);
  return true;
}

export class Bot {
  readonly slot: number;
  readonly skill: number;
  profile: BotProfile;
  private input = emptyInput();
  private man: Maneuver | null = null;
  private role: Role = 'first';
  private roleTimer = 0;
  private thinkTimer = 0;
  private seenVersion = -1;
  private plan: 'kickoff' | 'ball' | 'position' | 'boost' | 'demo' | 'shadow' = 'position';
  private intercept: Intercept | null = null;
  private danger = false;
  private target = new Vector3();
  private face = new Vector3();
  private wantBoost = false;
  private dodgeCooldown = 0;
  private stuckTime = 0;
  private reverseTime = 0;
  private turtleTime = 0;
  private demoChase = 0;
  private demoCooldown = 0;
  private reach = new Float32Array(Math.ceil(PRED_SECONDS / (DT * 4)) + 2);
  private seed: number;
  /** current shot aim offset (m), re-rolled for each new attack */
  private aimNoise = 0;
  // private temporaries (never shared between helpers that call each other)
  private qi = new Quaternion();
  private tA = new Vector3();
  private tB = new Vector3();
  private tC = new Vector3();
  private tD = new Vector3();
  private tE = new Vector3();
  private shotT = new Vector3();
  private way = new Vector3();

  constructor(slot: number, skill = 0.6) {
    this.slot = slot;
    this.skill = skill;
    this.profile = botProfile(skill);
    this.seed = (slot * 9973 + 12345) >>> 0;
    tables();
  }

  // ════════════════════════════════════════════════════════════════════════
  update(world: World): CarInput {
    const inp = this.input;
    Object.assign(inp, emptyInput());
    const car = world.cars[this.slot];
    if (!car || car.demolished) {
      this.man = null;
      this.intercept = null;
      return inp;
    }
    if (this.dodgeCooldown > 0) this.dodgeCooldown -= DT;
    if (this.demoCooldown > 0) this.demoCooldown -= DT;
    if (this.roleTimer > 0) this.roleTimer -= DT;

    // re-plan periodically, and a reaction time after the ball changes course
    const { version } = sharedPrediction(world);
    if (version !== this.seenVersion) {
      this.seenVersion = version;
      this.thinkTimer = Math.min(this.thinkTimer, Math.max(1, Math.round(this.profile.react / DT)));
    }
    if (--this.thinkTimer <= 0) {
      this.thinkTimer = Math.round(REPLAN / DT);
      this.think(world, car);
    }

    // an ongoing jump / flip / aerial owns the controls
    if (this.man) {
      if (this.runManeuver(world, car, inp)) return inp;
      this.man = null;
    }

    // lying on the side or roof: tap jump to self-right
    if (car.wheelsInContact === 0 && car.bodyContact && car.vel.length() < 3) {
      this.turtleTime += DT;
      inp.jump = this.turtleTime % 0.5 < 0.1;
      this.aim(car, this.flatDirTo(car, world.ball.pos, this.tA), WORLD_UP, inp);
      return inp;
    }
    this.turtleTime = 0;

    // airborne without a maneuver: land on the wheels facing where we want to go
    if (car.wheelsInContact === 0) {
      this.aim(car, this.flatDirTo(car, this.target, this.tA), WORLD_UP, inp);
      inp.throttle = 1;
      return inp;
    }

    this.act(world, car, inp);
    return inp;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Decision making
  // ════════════════════════════════════════════════════════════════════════
  private think(world: World, car: Car) {
    const ball = world.ball;
    const dir = car.team === 0 ? 1 : -1;
    const ownZ = -dir * ARENA_HALF_L;
    const { pred, age } = sharedPrediction(world);

    // ── kickoff ──
    if (ball.vel.lengthSq() < 0.01 && Math.abs(ball.pos.x) < 0.05 && Math.abs(ball.pos.z) < 0.05) {
      this.plan = 'kickoff';
      this.intercept = null;
      if (this.isKickoffTaker(world, car)) {
        // aim a touch towards our own side of the ball so the hit is centred
        this.target.set(0, 0, -dir * 0.35);
        this.wantBoost = true;
      } else {
        const back = this.teamRank(world, car) >= 2 || this.teammates(world, car) === 0;
        if (back) this.target.set(0, 0, ownZ + dir * 3);
        else this.nearestBigPad(world, car, ownZ, this.target);
        this.wantBoost = !back;
      }
      this.thinkTimer = 2; // stay sharp until the ball moves
      return;
    }

    this.updateRole(world, car, dir, pred, age);

    const danger = pred.goalFor === car.team && pred.goalTime - age < 3.2;
    this.danger = danger;
    const mode: Mode = danger ? 'clear' : this.defaultMode(ball.pos, dir);
    const oppT = this.bestOpponentEta(world, car, pred, age);

    let ic = this.findIntercept(world, car, pred, age, mode, 'aerial', danger, oppT);
    // no pressure: rather wait for a ball we can hit on the ground than fly for it
    if (ic && (ic.kind === 'double' || ic.kind === 'aerial') && !danger) {
      const t = (ic.hitTick - world.tick) * DT;
      if (oppT > t + 0.9) {
        const calm = this.findIntercept(world, car, pred, age, mode, 'jump', danger, oppT);
        if (calm && (calm.hitTick - world.tick) * DT < oppT - 0.3) ic = calm;
      }
    }
    // stick with the current plan unless it broke or something clearly better came up
    const cur = this.plan === 'ball' ? this.intercept : null;
    if (cur && this.stillValid(world, car, cur, pred, age) && (!ic || ic.hitTick > cur.hitTick - 0.3 / DT)) {
      cur.mode = mode;
      ic = cur;
    }
    const myT = ic ? (ic.hitTick - world.tick) * DT : 99;

    let goForBall = this.role === 'first';
    // in a save situation whoever gets there first goes, whatever the roles say
    if (danger && ic && this.amFastestToSave(world, car, pred, age, dir)) goForBall = true;

    if (goForBall && ic) {
      const solo = this.teammates(world, car) === 0;
      const inOurHalf = ic.ball.z * dir < 5;
      const ballFromGoal = Math.abs(ic.ball.z - ownZ);
      const onWrongSide = (car.pos.z - ic.ball.z) * dir > 2;
      // 1v1: if the opponent will clearly win the ball in our half, shadow instead of diving in
      if (!danger && solo && oppT < myT - 0.55 && inOurHalf) {
        this.shadow(world, car, dir);
        return;
      }
      // ahead of the ball in our half: rotate back via the far post first
      if (!danger && onWrongSide && ballFromGoal < 45 && ballFromGoal > 18 && oppT < myT) {
        this.rotateBack(world, car, dir);
        return;
      }
      if (this.plan !== 'ball') this.aimNoise = (this.rand() * 2 - 1) * this.profile.aimError;
      this.plan = 'ball';
      this.intercept = ic;
      this.wantBoost = true;
      this.lookForDemo(world, car, danger);
      return;
    }

    // ── support / keeper positioning ──
    this.intercept = null;
    this.face.copy(ball.pos);
    if (goForBall) {
      // our ball but no clean intercept (e.g. it's high or out of reach): stay goal-side of it
      this.shadow(world, car, dir);
      return;
    }
    if (this.role === 'second') {
      if (car.boost < 45 && this.profile.boostPickup && this.pickBoost(world, car, ball.pos, dir)) return;
      const bz = clamp(ball.pos.z - dir * 18, -ARENA_HALF_L + 8, ARENA_HALF_L - 8);
      this.target.set(clamp(ball.pos.x * 0.5, -25, 25), 0, bz);
      if ((this.target.z - ownZ) * dir < 6) this.target.z = ownZ + dir * 6;
      this.plan = 'position';
      this.wantBoost = car.pos.distanceTo(this.target) > 25;
      this.lookForDemo(world, car, danger);
      return;
    }
    // last man
    if (car.boost < 30 && this.profile.boostPickup && Math.abs(ball.pos.z - ownZ) > 55 && this.pickBoost(world, car, ball.pos, dir)) return;
    const depth = clamp(Math.abs(ball.pos.z - ownZ) - 40, 2.5, 30);
    this.target.set(clamp(ball.pos.x * 0.25, -GOAL_HALF_W * 0.5, GOAL_HALF_W * 0.5), 0, ownZ + dir * depth);
    this.plan = 'position';
    this.wantBoost = car.pos.distanceTo(this.target) > 30;
  }

  private defaultMode(ballPos: Vector3, dir: number): Mode {
    // deep in our own third, just get it out
    const ownZ = -dir * ARENA_HALF_L;
    return Math.abs(ballPos.z - ownZ) < 22 && Math.abs(ballPos.x) < 25 ? 'clear' : 'attack';
  }

  /** Is a committed intercept still worth pursuing? */
  private stillValid(world: World, car: Car, ic: Intercept, pred: BallPredictor, age: number) {
    const tRem = (ic.hitTick - world.tick) * DT;
    if (tRem < 0.05) return false;
    const now = predictBall(pred, tRem + age, this.tD);
    if (now.distanceToSquared(ic.planned) > 1.5 * 1.5) return false;
    const d = Math.hypot(now.x - car.pos.x, now.z - car.pos.z) - 1.5;
    return d / tRem < MAX_CAR_SPEED * 1.1;
  }

  private updateRole(world: World, car: Car, dir: number, pred: BallPredictor, age: number) {
    const mates: Car[] = [];
    for (const c of world.cars) if (c && c.team === car.team && !c.demolished) mates.push(c);
    if (mates.length <= 1) {
      this.role = 'first';
      return;
    }
    const ownZ = -dir * ARENA_HALF_L;
    // first man = quickest to the ball
    const eta = mates.map((c) => ({ c, t: quickEta(c, pred, age, dir, this.tE) }));
    eta.sort((a, b) => a.t - b.t);
    let first = eta[0].c;
    // hysteresis: keep attacking unless a teammate is clearly better placed
    if (this.role === 'first' && first !== car && this.roleTimer > 0) {
      const me = eta.find((e) => e.c === car)!;
      if (me.t - eta[0].t < 0.3) first = car;
    }
    let r: Role;
    if (first === car) r = 'first';
    else {
      // of the others, whoever is closer to our goal keeps it; the other supports
      const rest = eta.filter((e) => e.c !== first).map((e) => e.c);
      rest.sort((a, b) => Math.abs(a.pos.z - ownZ) - Math.abs(b.pos.z - ownZ));
      if (rest.length === 1) r = Math.abs(world.ball.pos.z - ownZ) < 50 ? 'third' : 'second';
      else r = rest[0] === car ? 'third' : 'second';
    }
    if (r !== this.role) {
      this.role = r;
      this.roleTimer = 0.6;
    }
  }

  private teammates(world: World, car: Car) {
    let n = 0;
    for (const c of world.cars) if (c && c !== car && c.team === car.team && !c.demolished) n++;
    return n;
  }

  private teamRank(world: World, car: Car) {
    const d0 = car.pos.lengthSq();
    let rank = 0;
    for (const c of world.cars) if (c && c !== car && c.team === car.team && c.pos.lengthSq() < d0) rank++;
    return rank;
  }

  private isKickoffTaker(world: World, car: Car) {
    const d0 = Math.round(Math.hypot(car.pos.x, car.pos.z) * 10);
    const side = car.team === 0 ? 1 : -1;
    for (const c of world.cars) {
      if (!c || c === car || c.team !== car.team || c.demolished) continue;
      const d = Math.round(Math.hypot(c.pos.x, c.pos.z) * 10);
      // closest takes it; on a tie the car on the left (from its own view) goes
      if (d < d0 || (d === d0 && c.pos.x * side < car.pos.x * side)) return false;
    }
    return true;
  }

  private bestOpponentEta(world: World, car: Car, pred: BallPredictor, age: number) {
    let best = 99;
    for (const c of world.cars) {
      if (!c || c.team === car.team || c.demolished) continue;
      best = Math.min(best, quickEta(c, pred, age, c.team === 0 ? 1 : -1, this.tE));
    }
    return best;
  }

  private amFastestToSave(world: World, car: Car, pred: BallPredictor, age: number, dir: number) {
    const mine = quickEta(car, pred, age, dir, this.tE);
    for (const c of world.cars) {
      if (!c || c === car || c.team !== car.team || c.demolished) continue;
      if (quickEta(c, pred, age, dir, this.tE) < mine - 0.25) return false;
    }
    return true;
  }

  /** First reachable moment on the predicted ball path, using shots up to `maxKind`. */
  private findIntercept(
    world: World,
    car: Car,
    pred: BallPredictor,
    age: number,
    mode: Mode,
    maxKind: 'jump' | 'aerial',
    danger: boolean,
    oppT: number,
  ): Intercept | null {
    const sdt = pred.sampleDt;
    const n = pred.positions.length;
    const pf = this.profile;
    const tb = tables();
    const dir = car.team === 0 ? 1 : -1;
    const singleMax = tb.single[tb.single.length - 1] + CONTACT_DROP + 0.2;
    const doubleMax = tb.double[tb.double.length - 1] + CONTACT_DROP + 0.2;
    const canJump = pf.jumpShots;
    const canDouble = pf.doubleJumps && maxKind === 'aerial';
    const canAerial = pf.aerials && maxKind === 'aerial' && car.boost >= 25;
    const speed = car.vel.length();
    const fwd = this.tA.set(1, 0, 0).applyQuaternion(car.quat);
    const fx = fwd.x;
    const fz = fwd.z;
    const fl = Math.hypot(fx, fz) || 1;
    // how far can we drive in k samples?
    const reach = this.reach;
    let v = Math.max(0, car.vel.dot(fwd));
    let d = 0;
    let b = car.boost > 5 + pf.boostReserve ? car.boost - pf.boostReserve : 0;
    reach[0] = 0;
    for (let k = 1; k < reach.length; k++) {
      for (let s = 0; s < 4; s++) {
        const dt = sdt / 4;
        let a = v < 12.5 ? curve(THROTTLE_CURVE, v) : 0;
        if (b > 0 && v < MAX_CAR_SPEED) {
          a += BOOST_ACCEL_GROUND;
          b -= BOOST_USE * dt;
        }
        v = Math.min(MAX_CAR_SPEED, v + a * dt);
        d += v * dt;
      }
      reach[k] = d;
    }
    const onWall = car.wheelsInContact > 0 && this.tB.set(0, 1, 0).applyQuaternion(car.quat).y < 0.6;
    const busy = car.wheelsInContact === 0 ? 0.35 : onWall ? 0.3 : 0;
    const lastK = pred.goalFor >= 0 ? Math.min(n - 1, Math.floor((pred.goalTime - 0.05) / sdt)) : n - 1;
    const k0 = Math.ceil(age / sdt);
    for (let k = Math.max(1, k0 + 1); k <= lastK; k++) {
      const t = k * sdt - age;
      if (t < 0.05 || t < busy) continue;
      const bp = pred.positions[k];
      let kind: ShotKind;
      if (bp.y <= 1.55) kind = 'ground';
      else if (canJump && bp.y <= singleMax) kind = 'jump';
      else if (canDouble && bp.y <= doubleMax) kind = 'double';
      else if (canAerial && bp.y <= 12 && t >= 0.75 && car.boost >= 20 + (bp.y - 5) * 4) kind = 'aerial';
      else continue;
      if (kind === 'jump' && t < timeToRise(tb.single, bp.y - CONTACT_DROP)) continue;
      if (kind === 'double' && t < timeToRise(tb.double, bp.y - CONTACT_DROP)) continue;
      // where the car needs to be: just behind the ball along the shot line
      this.shotTarget(car, bp, mode, this.shotT);
      const sdx = this.shotT.x - bp.x;
      const sdz = this.shotT.z - bp.z;
      const sl = Math.hypot(sdx, sdz) || 1;
      const ax = bp.x - (sdx / sl) * (BALL_RADIUS + 0.6);
      const az = bp.z - (sdz / sl) * (BALL_RADIUS + 0.6);
      const dx = ax - car.pos.x;
      const dz = az - car.pos.z;
      const dist = Math.hypot(dx, dz);
      const ang = Math.acos(clamp((fx * dx + fz * dz) / (fl * (dist || 1)), -1, 1));
      // being on the wrong side of the shot means driving around the ball
      const behind = ((bp.x - car.pos.x) * sdx + (bp.z - car.pos.z) * sdz) / sl;
      const detour = behind < 0 ? Math.min(8, -behind * 0.8) + 3 : 0;
      const path = dist + ang * (1 + speed * 0.3) + detour;
      const kk = Math.min(reach.length - 1, k - k0);
      if (reach[Math.max(0, kk)] * (kind === 'aerial' ? 1.25 : 1) < path) continue;
      if (kind !== 'ground' && dist > 3 && ang > 1.3) continue; // airborne hits need a straight run-up
      if (kind === 'aerial' || kind === 'double') {
        // flying at the ball from its wrong side just knocks it towards our net
        const hx = bp.x - car.pos.x;
        const hz = bp.z - car.pos.z;
        if (!danger && towardsOwnGoal(car.team, bp.x, bp.z, hx, hz)) continue;
        // only fly when it's a save, a shot from behind the ball, or a race for it
        const useful = danger || (mode === 'attack' && (bp.z - car.pos.z) * dir > 2) || (oppT < t + 0.3 && bp.z * dir < 0);
        if (kind === 'aerial' && !useful) continue;
      }
      return {
        hitTick: world.tick + Math.round(t / DT),
        planned: bp.clone(),
        ball: bp.clone(),
        kind,
        shotDir: new Vector3(sdx / sl, 0, sdz / sl),
        mode,
      };
    }
    return null;
  }

  /** Where to send the ball. */
  private shotTarget(car: Car, b: Vector3, mode: Mode, out: Vector3) {
    const dir = car.team === 0 ? 1 : -1;
    const oppZ = dir * ARENA_HALF_L;
    if (mode === 'attack') {
      // the point inside the posts closest to the natural car→ball line (cheapest shot)
      const dx = b.x - car.pos.x;
      const dz = b.z - car.pos.z;
      let x = 0;
      if (dz * dir > 0.5) x = b.x + (oppZ - b.z) * (dx / dz);
      const lim = GOAL_HALF_W - 3;
      return out.set(clamp(x, -lim, lim) + this.aimNoise, 0, oppZ + dir * 3);
    }
    // clear: up-field towards the near side wall, never across our own goal
    let side = Math.sign(b.x);
    if (side === 0) side = Math.sign(b.x - car.pos.x) || 1;
    return out.set(side * ARENA_HALF_W, 0, b.z + dir * 28 + this.aimNoise * 3);
  }

  private shadow(world: World, car: Car, dir: number) {
    const ball = world.ball.pos;
    const ownZ = -dir * ARENA_HALF_L;
    const gx = clamp(ball.x * 0.3, -GOAL_HALF_W, GOAL_HALF_W);
    const toGoal = this.tA.set(gx - ball.x, 0, ownZ - ball.z);
    const len = toGoal.length();
    const keep = Math.min(14, len * 0.5);
    this.target.set(ball.x, 0, ball.z).addScaledVector(toGoal, keep / (len || 1));
    this.face.copy(ball);
    this.plan = 'shadow';
    this.intercept = null;
    this.wantBoost = car.pos.distanceTo(this.target) > 20;
  }

  private rotateBack(world: World, car: Car, dir: number) {
    const ball = world.ball.pos;
    const ownZ = -dir * ARENA_HALF_L;
    // far post relative to the ball
    const side = ball.x > 0 ? -1 : 1;
    this.target.set(side * GOAL_HALF_W * 0.8, 0, ownZ + dir * 7);
    this.face.copy(ball);
    this.plan = 'position';
    this.intercept = null;
    this.wantBoost = car.pos.distanceTo(this.target) > 18;
  }

  private nearestBigPad(world: World, car: Car, ownZ: number, out: Vector3) {
    let best = Infinity;
    for (const p of world.pads) {
      if (!p.big || p.timer > 0) continue;
      if (Math.abs(p.z - ownZ) > ARENA_HALF_L) continue; // our half only
      const d = Math.hypot(p.x - car.pos.x, p.z - car.pos.z);
      if (d < best) {
        best = d;
        out.set(p.x, 0, p.z);
      }
    }
    if (best === Infinity) out.set(0, 0, ownZ * 0.8);
  }

  /** Pick up boost on the way to the support position. Returns true if a pad was chosen. */
  private pickBoost(world: World, car: Car, ballPos: Vector3, dir: number) {
    let best = Infinity;
    let found = false;
    for (const p of world.pads) {
      if (p.timer > 0) continue;
      const d = Math.hypot(p.x - car.pos.x, p.z - car.pos.z);
      if (d > (p.big ? 35 : 18)) continue;
      // prefer pads that are behind the ball (on our side of it)
      const behind = (ballPos.z - p.z) * dir > -4 ? 0 : 12;
      const s = d - (p.big ? 12 : 0) + behind;
      if (s < best) {
        best = s;
        this.target.set(p.x, 0, p.z);
        found = true;
      }
    }
    if (found) {
      this.plan = 'boost';
      this.face.copy(ballPos);
      this.wantBoost = false;
    }
    return found;
  }

  /** Skilled bots go for a demolition when an opponent is lined up and the ball isn't urgent. */
  private lookForDemo(world: World, car: Car, danger: boolean) {
    if (this.demoCooldown > 0 || !this.profile.demos || danger || !car.onGround) {
      this.demoChase = 0;
      return;
    }
    if (this.demoChase > 2.5) {
      this.demoChase = 0;
      this.demoCooldown = 6;
      return;
    }
    const fast = car.supersonic || (car.vel.length() > 15 && car.boost > 30);
    if (!fast) {
      this.demoChase = 0;
      return;
    }
    if (car.pos.distanceTo(world.ball.pos) < 18) return;
    const dir = car.team === 0 ? 1 : -1;
    const ownZ = -dir * ARENA_HALF_L;
    const myBack = Math.abs(car.pos.z - ownZ);
    let covered = false;
    for (const t of world.cars) if (t && t !== car && t.team === car.team && !t.demolished && Math.abs(t.pos.z - ownZ) < myBack) covered = true;
    if (!covered && Math.abs(world.ball.pos.z - ownZ) < 60) return;
    const fwd = this.tA.set(1, 0, 0).applyQuaternion(car.quat);
    let best: Car | null = null;
    let bestD = 28;
    for (const o of world.cars) {
      if (!o || o.team === car.team || o.demolished) continue;
      const to = this.tB.copy(o.pos).addScaledVector(o.vel, 0.35).sub(car.pos);
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
    this.demoChase += REPLAN;
    this.target.copy(best.pos).addScaledVector(best.vel, 0.35);
    this.target.y = 0;
    this.plan = 'demo';
    this.intercept = null;
    this.wantBoost = true;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Acting on the plan (every tick)
  // ════════════════════════════════════════════════════════════════════════
  private act(world: World, car: Car, inp: CarInput) {
    const ball = world.ball;
    const speed = car.vel.length();

    if (this.plan === 'kickoff') {
      this.drive(car, this.target, inp, { boost: this.wantBoost, kickoff: true });
      const d = Math.hypot(ball.pos.x - car.pos.x, ball.pos.z - car.pos.z);
      const taking = Math.abs(this.target.x) < 0.01 && Math.abs(this.target.z) < 1;
      if (taking && this.profile.fastKickoff && car.onGround && d < 2.7 + speed * 0.11 && this.localAngle(car, ball.pos) < 0.3) this.startFlip(1, 0);
      return;
    }

    if (this.plan === 'ball' && this.intercept) {
      const ic = this.intercept;
      const tRem = (ic.hitTick - world.tick) * DT;
      if (tRem < -0.1) this.thinkTimer = 0; // missed it – re-plan now
      // follow the latest prediction of where the ball will be at the planned moment
      const { pred, age } = sharedPrediction(world);
      const bp = predictBall(pred, Math.max(0, tRem) + age, ic.ball);
      this.shotTarget(car, bp, ic.mode, this.shotT);
      ic.shotDir.set(this.shotT.x - bp.x, 0, this.shotT.z - bp.z).normalize();
      const goal = this.approach(world, car, bp, ic.shotDir, this.target);
      const flatD = Math.hypot(bp.x - car.pos.x, bp.z - car.pos.z);
      const aligned = this.localAngle(car, bp);
      const fwd = car.forward(this.tC);
      const safe = this.danger || !towardsOwnGoal(car.team, bp.x, bp.z, fwd.x, fwd.z);

      // airborne hits: arrive on time rather than early
      this.drive(car, goal, inp, { boost: this.wantBoost, arriveIn: ic.kind === 'ground' ? -1 : tRem });

      const tb = tables();
      if (ic.kind === 'jump' || ic.kind === 'double') {
        const table = ic.kind === 'jump' ? tb.single : tb.double;
        const rise = timeToRise(table, bp.y - CONTACT_DROP);
        if (!Number.isFinite(rise) || bp.y < 1.2 || tRem < rise - 0.1) {
          this.thinkTimer = 0; // the ball isn't where we planned any more (or we're late)
        } else if (safe && car.onGround && car.up(this.tB).y > 0.9 && tRem <= rise + 0.25 && this.jumpConnects(car, table, pred, age)) {
          this.man = { kind: 'jumpShot', t: 0, double: ic.kind === 'double', hitTick: ic.hitTick, dodged: false };
        }
      } else if (ic.kind === 'aerial') {
        if (car.onGround && aligned < 0.35 && tRem > 0.6 && this.aerialFeasible(car, bp, tRem)) {
          this.man = { kind: 'aerial', t: 0, hitTick: ic.hitTick, double: true, shotDir: ic.shotDir.clone() };
        }
      } else if (this.profile.dodges && this.dodgeCooldown <= 0 && car.onGround && speed > 6 && bp.y < 1.7 && safe) {
        // power dodge into a ground ball when lined up with the shot
        const reachT = flatD / Math.max(speed, 1);
        const lineUp = this.tA.set(bp.x - car.pos.x, 0, bp.z - car.pos.z).normalize().dot(ic.shotDir);
        if (flatD < 2.4 + speed * 0.14 && reachT < 0.35 && lineUp > 0.8 && aligned < 0.3) {
          const l = this.local(car, this.tB.copy(bp).addScaledVector(ic.shotDir, 1.2), this.tC);
          const a = Math.atan2(l.z, l.x);
          this.startFlip(Math.cos(a), Math.sin(a) * 1.4);
        }
      }
      return;
    }

    // positioning, boost pickup, shadowing, demo chase
    const d = Math.hypot(this.target.x - car.pos.x, this.target.z - car.pos.z);
    if ((this.plan === 'position' || this.plan === 'shadow') && d < 3) {
      // in position: turn to face the ball and hold
      this.drive(car, this.face, inp, { boost: false, crawl: true });
      if (this.localAngle(car, this.face) < 0.35) inp.throttle = Math.abs(car.vel.dot(car.forward(this.tA))) > 1 ? -0.3 : 0;
      return;
    }
    let goal = this.target;
    if (this.plan !== 'demo' && ball.pos.y < 3.2) {
      // keep clear of the ball on the way (where it will be as we pass it)
      const bx = ball.pos.x + ball.vel.x * 0.3;
      const bz = ball.pos.z + ball.vel.z * 0.3;
      if (around(car.pos.x, car.pos.z, this.target.x, this.target.z, bx, bz, 3.2, this.way)) goal = this.way;
    }
    this.drive(car, goal, inp, { boost: this.wantBoost, arriveSlow: goal === this.target && (this.plan === 'position' || this.plan === 'shadow') });
  }

  /** Where to drive now to meet the ball `b` travelling along the shot line. */
  private approach(world: World, car: Car, b: Vector3, shotDir: Vector3, out: Vector3) {
    const dx = b.x - car.pos.x;
    const dz = b.z - car.pos.z;
    const dist = Math.hypot(dx, dz) || 1;
    const align = (dx * shotDir.x + dz * shotDir.z) / dist; // 1 = lined up behind the ball
    const contact = BALL_RADIUS + 0.6;
    const safe = this.danger || !towardsOwnGoal(car.team, b.x, b.z, dx, dz);
    if (dist < 3.4 && align > 0.4 && safe) {
      // committed: drive through the ball
      return out.set(b.x + shotDir.x * 1.5, 0, b.z + shotDir.z * 1.5);
    }
    const offset = clamp(dist * 0.38, 0, 7) * clamp(1.15 - align, 0, 1.6);
    out.set(b.x - shotDir.x * (contact + offset), 0, b.z - shotDir.z * (contact + offset));
    out.x = clamp(out.x, -ARENA_HALF_W + 1.5, ARENA_HALF_W - 1.5);
    out.z = clamp(out.z, -ARENA_HALF_L - 2, ARENA_HALF_L + 2);
    // don't run through the ball on the way to the far side of it
    const ball = world.ball;
    if (ball.pos.y < 3.2 && (align < 0.4 || !safe)) {
      const bx = ball.pos.x + ball.vel.x * 0.2;
      const bz = ball.pos.z + ball.vel.z * 0.2;
      if (around(car.pos.x, car.pos.z, out.x, out.z, bx, bz, 2.6, this.way)) out.copy(this.way);
    }
    return out;
  }

  /**
   * Would jumping right now meet the ball with the front of the car? Plays the measured
   * jump forward against the ball prediction (the car keeps its ground velocity and stays level).
   */
  private jumpConnects(car: Car, table: number[], pred: BallPredictor, age: number) {
    const f = this.tA.set(1, 0, 0).applyQuaternion(car.quat).setY(0);
    if (f.lengthSq() < 0.25) return false;
    f.normalize();
    const hx = CAR_HALF.x + 0.02;
    const hy = CAR_HALF.y + 0.02;
    const hz = CAR_HALF.z + 0.02;
    const b = this.tE;
    const y0 = car.pos.y - CAR_REST_HEIGHT;
    for (let i = 1; i < table.length; i += 2) {
      const t = (i + 1) * DT;
      predictBall(pred, t + age, b);
      // hitbox centre at time t
      const cx = car.pos.x + car.vel.x * t + f.x * CAR_HITBOX_OFFSET.x;
      const cy = CAR_REST_HEIGHT + y0 + table[i] + CAR_HITBOX_OFFSET.y;
      const cz = car.pos.z + car.vel.z * t + f.z * CAR_HITBOX_OFFSET.x;
      const dx = b.x - cx;
      const dy = b.y - cy;
      const dz = b.z - cz;
      const lx = dx * f.x + dz * f.z; // along the car
      const lz = dz * f.x - dx * f.z; // sideways
      const ex = Math.max(0, Math.abs(lx) - hx);
      const ey = Math.max(0, Math.abs(dy) - hy);
      const ez = Math.max(0, Math.abs(lz) - hz);
      if (ex * ex + ey * ey + ez * ez < BALL_RADIUS * BALL_RADIUS) {
        // first contact: good if the ball is in front of the car and not below it
        return lx > hx * 0.6 && dy > -0.25 && Math.abs(lz) < hz + 0.45;
      }
    }
    return false;
  }

  private aerialFeasible(car: Car, target: Vector3, T: number) {
    // after the take-off jumps we have ~6 m/s upwards; boost gives ~9.4 m/s² along the nose
    const up = 6;
    const dx = target.x - (car.pos.x + car.vel.x * T);
    const dy = target.y - (car.pos.y + (car.vel.y + up) * T - 0.5 * GRAVITY * T * T);
    const dz = target.z - (car.pos.z + car.vel.z * T);
    const need = (2 * Math.hypot(dx, dy, dz)) / (T * T);
    const boostTime = car.boost / BOOST_USE;
    return need < 7.5 && boostTime > T * 0.6;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Low level control
  // ════════════════════════════════════════════════════════════════════════
  private local(car: Car, p: Vector3, out: Vector3) {
    this.qi.copy(car.quat).invert();
    return out.subVectors(p, car.pos).applyQuaternion(this.qi);
  }

  private localAngle(car: Car, p: Vector3) {
    const l = this.local(car, p, this.tD);
    return Math.abs(Math.atan2(l.z, l.x));
  }

  private flatDirTo(car: Car, p: Vector3, out: Vector3) {
    out.set(p.x - car.pos.x, 0, p.z - car.pos.z);
    if (out.lengthSq() < 1e-4) car.forward(out).setY(0);
    return out.normalize();
  }

  private drive(
    car: Car,
    target: Vector3,
    inp: CarInput,
    o: { boost: boolean; arriveIn?: number; crawl?: boolean; arriveSlow?: boolean; kickoff?: boolean },
  ) {
    const l = this.local(car, target, this.tC);
    const angle = Math.atan2(l.z, l.x);
    const dist = Math.hypot(l.x, l.z);
    const fwdSpeed = car.vel.dot(car.forward(this.tA));
    const speed = car.vel.length();
    const wl = this.tB.copy(car.angVel).applyQuaternion(this.qi);

    // stuck against something?
    if (speed < 1.2 && !o.crawl && car.onGround && this.reverseTime <= 0) this.stuckTime += DT;
    else this.stuckTime = 0;
    if (this.stuckTime > 0.9) {
      this.reverseTime = 0.6;
      this.stuckTime = 0;
    }
    if (this.reverseTime > 0) {
      this.reverseTime -= DT;
      inp.throttle = -1;
      inp.steer = -Math.sign(angle) || 1;
      return;
    }

    // target right behind us and close: back up instead of a big loop
    if (Math.abs(angle) > 2.3 && dist < 9 && fwdSpeed < 5 && !o.crawl) {
      const back = Math.atan2(l.z, -l.x);
      inp.throttle = -1;
      inp.steer = clamp(-back * 3, -1, 1);
      return;
    }

    // (+yaw rate = turning left, so it damps a right turn)
    inp.steer = clamp(angle * 3.2 + wl.y * 0.3, -1, 1);
    inp.throttle = 1;
    inp.handbrake = Math.abs(angle) > 1.25 && fwdSpeed > 8 && car.onGround;

    if (o.crawl) {
      inp.throttle = Math.abs(angle) > 0.3 ? 0.35 : 0;
      if (Math.abs(angle) > 1.9) {
        // turn on the spot: back up while steering the other way
        inp.throttle = -0.5;
        inp.steer = -Math.sign(angle);
      }
      return;
    }

    let desired = MAX_CAR_SPEED;
    // don't carry more speed into a corner than the car can turn with
    if (Math.abs(l.z) > 0.05 && l.x > -1) desired = Math.max(4, speedForRadius(((l.x * l.x + l.z * l.z) / (2 * Math.abs(l.z))) * 1.15));
    if (o.arriveIn !== undefined && o.arriveIn > 0.05) desired = Math.min(desired, clamp(dist / o.arriveIn, 0, MAX_CAR_SPEED));
    if (o.arriveSlow) desired = Math.min(desired, 2 + dist * 1.1);
    if (fwdSpeed > desired + 1.5) inp.throttle = fwdSpeed > desired + 5 ? -1 : 0;
    else if (fwdSpeed < desired - 0.5) inp.throttle = 1;
    else inp.throttle = 0.3;

    // boost only when lined up, on the wheels and actually needed
    const pf = this.profile;
    if (inp.throttle > pf.maxThrottle) inp.throttle = pf.maxThrottle;
    const needSpeed = desired > fwdSpeed + 1 && desired > 12;
    inp.boost =
      o.boost &&
      needSpeed &&
      Math.abs(angle) < 0.3 &&
      car.onGround &&
      speed < MAX_CAR_SPEED - 0.3 &&
      (o.kickoff || (car.boost > pf.boostReserve && dist > pf.boostMinDist));
  }

  /** Air orientation: point the nose along `fwd` with the roof towards `up`. */
  private aim(car: Car, fwd: Vector3, up: Vector3, inp: CarInput) {
    this.qi.copy(car.quat).invert();
    const f = this.tD.copy(fwd).applyQuaternion(this.qi);
    const u = this.tE.copy(up).applyQuaternion(this.qi);
    const w = this.tB.copy(car.angVel).applyQuaternion(this.qi);
    const pitchErr = Math.atan2(f.y, Math.hypot(f.x, f.z) * Math.sign(f.x || 1));
    const yawErr = Math.atan2(f.z, f.x);
    const rollErr = Math.atan2(u.z, u.y);
    const kp = this.profile.airGain;
    // +pitch input = nose down, so negate; +yaw = turn right; +roll = roll right
    inp.pitch = clamp(-(kp * pitchErr - 0.75 * w.z), -1, 1);
    inp.yaw = clamp(kp * yawErr + 0.6 * w.y, -1, 1);
    inp.roll = clamp(2.2 * rollErr - 0.35 * w.x, -1, 1);
  }

  private startFlip(fx: number, fz: number) {
    const l = Math.hypot(fx, fz) || 1;
    this.man = { kind: 'flip', t: 0, fx: fx / l, fz: fz / l };
    this.dodgeCooldown = 1.6;
  }

  /** Run the current maneuver. Returns false when it's finished. */
  private runManeuver(world: World, car: Car, inp: CarInput): boolean {
    const m = this.man!;
    m.t += DT;
    const t = m.t;
    switch (m.kind) {
      case 'flip': {
        inp.throttle = 1;
        inp.jump = t < 0.07 || (t >= 0.12 && t < 0.16);
        if (t >= 0.11 && t < 0.5) {
          inp.pitch = m.fx;
          inp.yaw = m.fz;
        }
        if (t > 0.5) {
          if (!car.isFlipping) this.aim(car, this.flatDirTo(car, this.target, this.tA), WORLD_UP, inp);
          inp.throttle = 1;
        }
        return !(t > 0.35 && car.onGround) && t < 1.6;
      }
      case 'jumpShot': {
        const ball = world.ball.pos;
        inp.throttle = 1;
        inp.jump = t < 0.2 || (m.double && t >= 0.25 && t < 0.29);
        const toBall = this.tA.subVectors(ball, car.pos);
        // neutral stick around the second press (otherwise it would dodge)
        if (!(m.double && t >= 0.23 && t < 0.3)) {
          // stay level while the jump pushes us up, then tip the nose towards the ball
          const aimDir = this.tC.set(toBall.x, t < 0.3 ? 0 : toBall.y * 0.5, toBall.z);
          if (aimDir.lengthSq() < 1e-4) car.forward(aimDir);
          this.aim(car, aimDir.normalize(), WORLD_UP, inp);
        }
        // jump + dodge into the ball for extra power
        if (!m.double && !m.dodged && this.profile.dodges && t > 0.22 && !car.hasFlipped && !car.hasDoubleJumped) {
          const flat = Math.hypot(toBall.x, toBall.z);
          if (toBall.length() < 2.2 && flat > 0.4) {
            const l = this.local(car, ball, this.tC);
            const a = Math.atan2(l.z, l.x);
            inp.pitch = Math.cos(a);
            inp.yaw = Math.sin(a);
            inp.roll = 0;
            inp.jump = true;
            m.dodged = true;
          }
        }
        return !(t > 0.4 && car.wheelsInContact > 0) && t < 2.2;
      }
      case 'aerial': {
        const { pred, age } = sharedPrediction(world);
        const tRem = (m.hitTick - world.tick) * DT;
        const T = Math.max(0.05, tRem);
        // aim a little behind the ball so the touch sends it along the shot line
        const target = predictBall(pred, T + age, this.tE).addScaledVector(m.shotDir, -0.7);
        inp.jump = t < 0.2 || (m.double && t >= 0.24 && t < 0.28);
        // correction needed on top of the ballistic path
        const delta = this.tA.set(
          target.x - (car.pos.x + car.vel.x * T),
          target.y - (car.pos.y + car.vel.y * T - 0.5 * GRAVITY * T * T),
          target.z - (car.pos.z + car.vel.z * T),
        );
        const need = (2 * delta.length()) / (T * T);
        const aimDir = delta.lengthSq() > 0.04 ? this.tC.copy(delta).normalize() : this.tC.subVectors(target, car.pos).normalize();
        // neutral stick for the double jump (otherwise it would dodge)
        if (!(m.double && t >= 0.22 && t < 0.3)) this.aim(car, aimDir, WORLD_UP, inp);
        const fwd = car.forward(this.tB);
        inp.boost = fwd.dot(aimDir) > 0.8 && need > 0.6 && car.boost > 0;
        if (t < 0.2 && fwd.y > 0.25) inp.boost = true;
        return !(tRem < -0.25 || (t > 0.5 && car.wheelsInContact > 0) || t > 4);
      }
    }
    return false;
  }

  private rand() {
    // mulberry32
    let t = (this.seed = (this.seed + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
