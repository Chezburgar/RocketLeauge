// All physics runs in metres / seconds. Values are tuned to feel like classic
// car-soccer handling (1 m = 100 "unreal units" of the reference game).

export const TICK_RATE = 120;
export const DT = 1 / TICK_RATE;
export const GRAVITY = 6.5;

// ── Arena ──────────────────────────────────────────────────────────────────
export const ARENA_HALF_W = 40.96; // side walls at ±x
export const ARENA_HALF_L = 51.2; // back walls at ±z
export const ARENA_H = 20.44; // ceiling
export const ARENA_FILLET = 3.0; // floor→wall / wall→ceiling ramps
export const ARENA_CORNER_R = 11.5; // vertical corner rounding
export const GOAL_HALF_W = 8.93;
export const GOAL_H = 6.43;
export const GOAL_DEPTH = 8.8;

// ── Ball ───────────────────────────────────────────────────────────────────
export const BALL_RADIUS = 0.9125;
export const BALL_MASS = 30;
export const BALL_MAX_SPEED = 60;
export const BALL_MAX_ANG = 6;
export const BALL_RESTITUTION = 0.6;
export const BALL_FRICTION = 0.35;
export const BALL_DRAG = 0.0305;
export const BALL_REST_Y = BALL_RADIUS;

// ── Car ────────────────────────────────────────────────────────────────────
export const CAR_MASS = 180;
// hitbox (length, height, width) — local frame: +x forward, +y up, +z right
export const CAR_HALF = { x: 0.59, y: 0.181, z: 0.421 };
export const CAR_HITBOX_OFFSET = { x: 0.1388, y: 0.2075, z: 0 };
export const CAR_INERTIA = { x: 12.6, y: 31.5, z: 22.8 }; // about local axes
export const CAR_REST_HEIGHT = 0.17;

// Pace tuning: cars are ~10% slower than the reference game so the ball can out-pace them.
export const MAX_CAR_SPEED = 20.5;
export const SUPERSONIC_START = 19.5;
export const SUPERSONIC_MAINTAIN = 18.5;
export const MAX_ANG_SPEED = 5.5;

export const BOOST_MAX = 100;
export const BOOST_START = 33.3;
export const BOOST_USE = 33.3; // per second
export const BOOST_ACCEL_GROUND = 8.8;
export const BOOST_ACCEL_AIR = 9.4;
export const BOOST_MIN_TIME = 0.1;

export const BRAKE_ACCEL = 35.0;
export const COAST_DECEL = 5.25;
export const THROTTLE_AIR_ACCEL = 0.6667;
// forward speed (m/s) → acceleration (m/s²)
export const THROTTLE_CURVE: [number, number][] = [
  [0, 14.5],
  [12.4, 1.4],
  [12.5, 0],
];
// forward speed (m/s) → max steer angle (rad)
export const STEER_CURVE: [number, number][] = [
  [0, 0.53356],
  [5, 0.3193],
  [10, 0.18203],
  [15, 0.1057],
  [17.5, 0.08507],
  [30, 0.03454],
];
export const POWERSLIDE_STEER_CURVE: [number, number][] = [
  [0, 0.39235],
  [25, 0.1261],
];

export const JUMP_IMPULSE = 2.9167;
export const JUMP_HOLD_ACCEL = 14.5833;
export const JUMP_MIN_TIME = 0.025;
export const JUMP_MAX_TIME = 0.2;
export const DOUBLEJUMP_WINDOW = 1.25;
export const DODGE_DEADZONE = 0.5;
export const FLIP_TORQUE_TIME = 0.65;
export const FLIP_Z_DAMP_TIME = 0.15;
export const FLIP_Z_DAMP = 0.35; // fraction removed per 1/120 s while damping
export const FLIP_Z_DAMP_END = 0.21; // falling is damped until then
/** flips started closer than this to the floor hop so they finish the turn in the air */
export const FLIP_LOW_HEIGHT = 1.2;
export const FLIP_LOW_AIR_TIME = 0.72;
export const FLIP_LOW_AIR_TIME_BACK = 0.82;
/** the flip spin eases off over the last part of the turn (rad) */
export const FLIP_EASE_ANGLE = 0.6;
/** a flip that hasn't finished its turn by now (e.g. cancelled) ends anyway */
export const FLIP_MAX_TIME = 0.8;
export const FLIP_INITIAL_VEL = 5.0;
export const FLIP_FORWARD_SCALE = 1.0;
export const FLIP_SIDE_SCALE = 1.9;
export const FLIP_BACKWARD_SCALE = 2.5;
/** flips spin much faster than normal air control (a full front flip takes ~0.65 s) */
export const FLIP_ANG_SPEED = 9.8;

export const AIR_PITCH_TORQUE = 12.46;
export const AIR_YAW_TORQUE = 9.11;
export const AIR_ROLL_TORQUE = 38.34;
export const AIR_PITCH_DAMP = 2.798;
export const AIR_YAW_DAMP = 1.886;
export const AIR_ROLL_DAMP = 4.1;

export const STICKY_FORCE_SCALE = 0.5;
/** most sideways grip one tyre can apply per tick (N·s): about 6 g of cornering per wheel */
export const LAT_IMPULSE_MAX = 22;

// suspension
export const SUSP_STIFFNESS = 30000;
export const SUSP_DAMP = 1700;
export const SUSP_MAX_FORCE = 9000;

export const DEMO_RESPAWN_TIME = 3.0;
export const BUMP_COOLDOWN = 0.25;

// ball–car "extra impulse" (what makes hits feel punchy)
export const HIT_Z_SCALE = 0.35;
export const HIT_FORWARD_SCALE = 0.65;
export const HIT_MAX_DELTA = 46.0;
// (boosted ~25% over the reference so the ball flies off the car faster than the car can chase)
export const HIT_CURVE: [number, number][] = [
  [0, 0.82],
  [5, 0.82],
  [23, 0.7],
  [46, 0.4],
];

// ── Boost pads (RL soccar layout, converted to metres; x across, z along) ──
export const BIG_PAD_RADIUS = 2.08;
export const SMALL_PAD_RADIUS = 1.44;
export const BIG_PAD_RESPAWN = 10;
export const SMALL_PAD_RESPAWN = 4;
export const BIG_PADS: [number, number][] = [
  [-30.72, -40.96],
  [30.72, -40.96],
  [-35.84, 0],
  [35.84, 0],
  [-30.72, 40.96],
  [30.72, 40.96],
];
export const SMALL_PADS: [number, number][] = [
  [0, -42.4], [-17.92, -41.84], [17.92, -41.84], [-9.4, -33.08], [9.4, -33.08],
  [0, -28.16], [-35.84, -24.84], [35.84, -24.84], [-17.88, -23.0], [17.88, -23.0],
  [-20.48, -10.36], [0, -10.24], [20.48, -10.36], [-10.24, 0], [10.24, 0],
  [-20.48, 10.36], [0, 10.24], [20.48, 10.36], [-17.88, 23.0], [17.88, 23.0],
  [-35.84, 24.84], [35.84, 24.84], [0, 28.16], [-9.4, 33.1], [9.4, 33.08],
  [-17.92, 41.84], [17.92, 41.84], [0, 42.4],
];

// kickoff spawns for the blue team (orange is mirrored). [x, z, yaw]
// yaw = 0 faces +z (towards the orange goal); forward = (sin yaw, 0, cos yaw).
// Orange spawns are the blue ones rotated 180° about the centre spot.
export const KICKOFF_SPOTS: [number, number, number][] = [
  [-20.48, -25.6, Math.PI / 4],
  [20.48, -25.6, -Math.PI / 4],
  [-2.56, -38.4, 0],
  [2.56, -38.4, 0],
  [0, -46.08, 0],
];

export function curve(points: [number, number][], x: number): number {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}
