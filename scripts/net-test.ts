// Headless netcode test: host + client connected by a fake lossy, laggy link.
// Run with `npx tsx scripts/net-test.ts`.
export {};
let now = 0;
Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true });

const { Match } = await import('../src/game/match');
const { LocalSession, ClientSession } = await import('../src/game/session');
const { emptyStats, DEFAULT_LOADOUT } = await import('../src/game/types');
const { decodeInputs } = await import('../src/net/protocol');
const { emptyInput, copyInput } = await import('../src/physics/input');

const LATENCY = Number(process.env.LAT ?? 60); // ms one-way
const JITTER = 15;
const LOSS = 0.03;

type Pkt = { at: number; fn: () => void };
const queue: Pkt[] = [];
const send = (fn: () => void, reliable: boolean) => {
  if (!reliable && Math.random() < LOSS) return;
  queue.push({ at: now + LATENCY + Math.random() * JITTER, fn });
};

// ── host side ──
const match = new Match({ duration: 300, replays: true });
const mk = (slot: number, team: 0 | 1, isBot: boolean) => ({ slot, name: 'P' + slot, team, isBot, skill: 0.6, loadout: DEFAULT_LOADOUT, stats: emptyStats() });
match.addPlayer(mk(0, 0, false));
match.addPlayer(mk(3, 1, false));
match.addPlayer(mk(1, 0, true));
match.startKickoff();
const remoteInputs = new Map<number, ReturnType<typeof emptyInput>>();
const remoteLast = emptyInput();
const hostToClientU: ((b: ArrayBuffer) => void)[] = [];
const hostToClientR: ((m: unknown) => void)[] = [];
const fakeNet: any = {
  getTick: () => 0,
  inputFor(slot: number, tick: number) {
    const i = remoteInputs.get(tick);
    if (i) copyInput(i, remoteLast);
    return remoteLast;
  },
  broadcastU(buf: ArrayBuffer) { const copy = buf.slice(0); send(() => hostToClientU.forEach((f) => f(copy)), false); },
  sendEvent(e: unknown) { send(() => hostToClientR.forEach((f) => f({ t: 'ev', e })), true); },
  sendStats() {},
  close() {},
};
const host = new LocalSession(match, 0, fakeNet);

// ── client side ──
const clientLink: any = {
  onUnreliable: null, onReliable: null, onClose: null,
  sendU(buf: ArrayBuffer) {
    const copy = buf.slice(0);
    send(() => {
      const d = decodeInputs(copy);
      if (!d) return;
      const first = d.lastTick - d.inputs.length + 1;
      d.inputs.forEach((inp, i) => remoteInputs.set(first + i, inp));
    }, false);
  },
  sendR(msg: any) {
    if (msg.t === 'ping') send(() => send(() => clientLink.onReliable?.({ t: 'pong', ts: msg.ts, tick: match.world.tick }), true), true);
  },
  close() {},
};
hostToClientU.push((b) => clientLink.onUnreliable?.(b));
hostToClientR.push((m) => clientLink.onReliable?.(m));
const client = new ClientSession(clientLink, { slot: 3, ...(host.startPayload() as any) });

// ── run ──
const hostPos = new Map<number, { x: number; y: number; z: number }>();
const clientPos = new Map<number, { x: number; y: number; z: number; t: number }>();
const errs: number[] = [];
const frameDt = 1 / 60;
const cInput = emptyInput();
let maxOffset = 0;
for (let f = 0; f < 60 * 25; f++) {
  now += frameDt * 1000;
  // deliver packets
  queue.sort((a, b) => a.at - b.at);
  while (queue.length && queue[0].at <= now) queue.shift()!.fn();
  const t = f / 60;
  cInput.throttle = 1;
  cInput.steer = Math.sin(t * 0.7) * 0.6;
  cInput.boost = t % 4 < 1.2;
  cInput.jump = t % 3 < 0.15 || (t % 3 > 0.3 && t % 3 < 0.36);
  cInput.pitch = t % 6 < 3 ? 0 : 1;
  for (let half = 0; half < 2; half++) {
    host.update(frameDt / 2, emptyInput());
    const hc = match.world.cars[3]!;
    hostPos.set(match.world.tick, { x: hc.pos.x, y: hc.pos.y, z: hc.pos.z });
    client.update(frameDt / 2, cInput);
    const cw = client.world;
    const cc = cw.cars[3]!;
    if (!clientPos.has(cw.tick) && match.phase === 'playing' && client.phase === 'playing') clientPos.set(cw.tick, { x: cc.pos.x, y: cc.pos.y, z: cc.pos.z, t });
  }
  const cw = client.world;
  const off = (client as any).offsets[3].pos.length();
  maxOffset = Math.max(maxOffset, off);
  if (f % 300 === 0) console.log(`t=${t.toFixed(0)}s host tick ${match.world.tick} client tick ${cw.tick} lead ${cw.tick - match.world.tick} phase ${match.phase}/${client.phase} clock ${match.clock.toFixed(1)}/${client.clock.toFixed(1)} rtt≈${client.pingMs()}ms`);
}
for (const [tick, cp] of clientPos) {
  const hp = hostPos.get(tick);
  if (hp && cp.t > 4) errs.push(Math.hypot(cp.x - hp.x, cp.y - hp.y, cp.z - hp.z));
}
errs.sort((a, b) => a - b);
const pct = (p: number) => errs[Math.floor(errs.length * p)]?.toFixed(3);
console.log(`prediction error vs host (same tick): median ${pct(0.5)} m, p90 ${pct(0.9)} m, p99 ${pct(0.99)} m, samples ${errs.length}`);
console.log(`max visual correction offset: ${maxOffset.toFixed(3)} m`);
const ok = errs.length > 100 && Number(pct(0.9)) < 0.5;
console.log(ok ? 'NET OK' : 'NET FAIL');
process.exit(ok ? 0 : 1);
