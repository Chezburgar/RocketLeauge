/** One tick worth of player controls. Analog values are in [-1, 1]. */
export interface CarInput {
  throttle: number;
  steer: number;
  /** +1 = stick forward (nose down) */
  pitch: number;
  /** +1 = right */
  yaw: number;
  /** +1 = roll right */
  roll: number;
  jump: boolean;
  boost: boolean;
  /** powerslide on the ground / free air roll in the air */
  handbrake: boolean;
}

export function emptyInput(): CarInput {
  return { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
}

export function copyInput(src: CarInput, dst: CarInput = emptyInput()): CarInput {
  dst.throttle = src.throttle;
  dst.steer = src.steer;
  dst.pitch = src.pitch;
  dst.yaw = src.yaw;
  dst.roll = src.roll;
  dst.jump = src.jump;
  dst.boost = src.boost;
  dst.handbrake = src.handbrake;
  return dst;
}

// Compact encoding used by the netcode: 5 analog bytes + 1 bitfield byte.
export const INPUT_BYTES = 6;
const q = (v: number) => Math.max(0, Math.min(254, Math.round((v + 1) * 127)));
const dq = (b: number) => Math.max(-1, Math.min(1, b / 127 - 1));

export function encodeInput(inp: CarInput, view: DataView, off: number) {
  view.setUint8(off, q(inp.throttle));
  view.setUint8(off + 1, q(inp.steer));
  view.setUint8(off + 2, q(inp.pitch));
  view.setUint8(off + 3, q(inp.yaw));
  view.setUint8(off + 4, q(inp.roll));
  view.setUint8(off + 5, (inp.jump ? 1 : 0) | (inp.boost ? 2 : 0) | (inp.handbrake ? 4 : 0));
}

export function decodeInput(view: DataView, off: number, out: CarInput = emptyInput()): CarInput {
  out.throttle = dq(view.getUint8(off));
  out.steer = dq(view.getUint8(off + 1));
  out.pitch = dq(view.getUint8(off + 2));
  out.yaw = dq(view.getUint8(off + 3));
  out.roll = dq(view.getUint8(off + 4));
  const b = view.getUint8(off + 5);
  out.jump = (b & 1) !== 0;
  out.boost = (b & 2) !== 0;
  out.handbrake = (b & 4) !== 0;
  return out;
}

/** Quantise in place so the local simulation sees exactly what the host will decode. */
export function quantizeInput(inp: CarInput): CarInput {
  inp.throttle = dq(q(inp.throttle));
  inp.steer = dq(q(inp.steer));
  inp.pitch = dq(q(inp.pitch));
  inp.yaw = dq(q(inp.yaw));
  inp.roll = dq(q(inp.roll));
  return inp;
}
