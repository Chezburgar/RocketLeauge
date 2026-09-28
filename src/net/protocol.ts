import { decodeInput, emptyInput, encodeInput, INPUT_BYTES, type CarInput } from '../physics/input';
import { MAX_CARS, World } from '../physics/world';

export const MSG_SNAPSHOT = 1;
export const MSG_INPUT = 2;

export interface SnapshotHeader {
  tick: number;
  phase: number;
  phaseTime: number;
  clock: number;
  overtime: boolean;
  scores: [number, number];
}

const HEADER_FLOATS = 7;

export function encodeSnapshot(h: SnapshotHeader, world: World, lastInputs: (CarInput | null)[]): ArrayBuffer {
  const stateLen = World.stateSize();
  const floats = HEADER_FLOATS + stateLen;
  const bytes = 4 + floats * 4 + MAX_CARS * INPUT_BYTES;
  const buf = new ArrayBuffer(bytes);
  const view = new DataView(buf);
  view.setUint8(0, MSG_SNAPSHOT);
  const f = new Float32Array(buf, 4, floats);
  f[0] = h.tick;
  f[1] = h.phase;
  f[2] = h.phaseTime;
  f[3] = h.clock;
  f[4] = h.overtime ? 1 : 0;
  f[5] = h.scores[0];
  f[6] = h.scores[1];
  world.serialize(f.subarray(HEADER_FLOATS));
  let off = 4 + floats * 4;
  const none = emptyInput();
  for (let i = 0; i < MAX_CARS; i++) {
    encodeInput(lastInputs[i] ?? none, view, off);
    off += INPUT_BYTES;
  }
  return buf;
}

export interface DecodedSnapshot {
  header: SnapshotHeader;
  state: Float32Array;
  inputs: CarInput[];
}

export function decodeSnapshot(buf: ArrayBuffer): DecodedSnapshot | null {
  const view = new DataView(buf);
  if (view.getUint8(0) !== MSG_SNAPSHOT) return null;
  const stateLen = World.stateSize();
  const floats = HEADER_FLOATS + stateLen;
  if (buf.byteLength < 4 + floats * 4 + MAX_CARS * INPUT_BYTES) return null;
  const f = new Float32Array(buf, 4, floats);
  const header: SnapshotHeader = {
    tick: f[0],
    phase: f[1],
    phaseTime: f[2],
    clock: f[3],
    overtime: f[4] === 1,
    scores: [f[5], f[6]],
  };
  const state = new Float32Array(f.subarray(HEADER_FLOATS));
  const inputs: CarInput[] = [];
  let off = 4 + floats * 4;
  for (let i = 0; i < MAX_CARS; i++) {
    inputs.push(decodeInput(view, off));
    off += INPUT_BYTES;
  }
  return { header, state, inputs };
}

/** Client → host: the last `count` inputs ending at `lastTick`. */
export function encodeInputs(lastTick: number, inputs: CarInput[]): ArrayBuffer {
  const buf = new ArrayBuffer(6 + inputs.length * INPUT_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, MSG_INPUT);
  view.setUint8(1, inputs.length);
  view.setUint32(2, lastTick);
  inputs.forEach((inp, i) => encodeInput(inp, view, 6 + i * INPUT_BYTES));
  return buf;
}

export function decodeInputs(buf: ArrayBuffer): { lastTick: number; inputs: CarInput[] } | null {
  const view = new DataView(buf);
  if (view.getUint8(0) !== MSG_INPUT) return null;
  const n = view.getUint8(1);
  const lastTick = view.getUint32(2);
  const inputs: CarInput[] = [];
  for (let i = 0; i < n; i++) inputs.push(decodeInput(view, 6 + i * INPUT_BYTES));
  return { lastTick, inputs };
}

export function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  for (const x of b) s += alphabet[x % alphabet.length];
  return s;
}
