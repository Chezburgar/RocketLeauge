// Headless sanity checks for the physics – run with `npm test`.
import { World } from '../src/physics/world';
import { emptyInput } from '../src/physics/input';
import { DT } from '../src/physics/constants';
import { Vector3 } from 'three';

const f = (v: Vector3) => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
let failures = 0;
const check = (name: string, ok: boolean, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
  if (!ok) failures++;
};

function fresh() {
  const w = new World();
  const car = w.addCar(0, 0);
  car.reset(0, -20, 0);
  w.ball.reset(0, 0.9125, 30);
  return { w, car };
}

// 1. resting stability
{
  const { w, car } = fresh();
  const inp = emptyInput();
  for (let i = 0; i < 240; i++) w.step([inp]);
  check('car rests', Math.abs(car.pos.y - 0.17) < 0.03 && car.vel.length() < 0.05 && car.onGround, f(car.pos) + ' v=' + car.vel.length().toFixed(3) + ' wheels=' + car.wheelsInContact);
}
// 2. throttle to max drive speed
{
  const { w, car } = fresh();
  const inp = emptyInput();
  inp.throttle = 1;
  let t1 = -1;
  for (let i = 0; i < 600; i++) {
    w.step([inp]);
    if (t1 < 0 && car.vel.length() > 13.5) t1 = i * DT;
  }
  check('throttle top speed ≈14.1', Math.abs(car.vel.length() - 14.1) < 0.4, 'v=' + car.vel.length().toFixed(2) + ' t(13.5)=' + t1.toFixed(2) + ' pos=' + f(car.pos));
}
// 3. boost to supersonic
{
  const { w, car } = fresh();
  car.reset(0, -45, 0);
  car.boost = 100;
  const inp = emptyInput();
  inp.throttle = 1;
  inp.boost = true;
  let t = -1;
  for (let i = 0; i < 600; i++) {
    w.step([inp]);
    if (t < 0 && car.supersonic) t = i * DT;
  }
  check('boost reaches supersonic', t > 0, 't=' + t.toFixed(2) + ' boost=' + car.boost.toFixed(1));
}
// 4. turning circle
{
  const { w, car } = fresh();
  const inp = emptyInput();
  inp.throttle = 1;
  for (let i = 0; i < 240; i++) w.step([inp]);
  inp.steer = 1;
  const start = car.pos.clone();
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < 480; i++) {
    w.step([inp]);
    minX = Math.min(minX, car.pos.x);
    maxX = Math.max(maxX, car.pos.x);
  }
  const fwd = car.forward(new Vector3());
  check('turning circle', maxX - minX > 5 && maxX - minX < 40, 'diameter≈' + (maxX - minX).toFixed(1) + ' speed=' + car.vel.length().toFixed(1) + ' up.y=' + car.up(new Vector3()).y.toFixed(2) + ' lateral=' + (car.vel.dot(car.right(new Vector3()))).toFixed(2));
}
// 5. jump height
{
  const { w, car } = fresh();
  const inp = emptyInput();
  for (let i = 0; i < 60; i++) w.step([inp]);
  inp.jump = true;
  let maxY = 0;
  for (let i = 0; i < 240; i++) {
    w.step([inp]);
    maxY = Math.max(maxY, car.pos.y);
  }
  check('full jump height ≈2.3m', maxY > 1.8 && maxY < 2.8, 'maxY=' + maxY.toFixed(2));
}
// 6. double jump
{
  const { w, car } = fresh();
  const inp = emptyInput();
  for (let i = 0; i < 60; i++) w.step([inp]);
  let maxY = 0;
  for (let i = 0; i < 400; i++) {
    inp.jump = i < 24 || (i > 30 && i < 34);
    w.step([inp]);
    maxY = Math.max(maxY, car.pos.y);
  }
  check('double jump higher', maxY > 3.2, 'maxY=' + maxY.toFixed(2) + ' dj=' + car.hasDoubleJumped);
}
// 7. front flip
{
  const { w, car } = fresh();
  const inp = emptyInput();
  inp.throttle = 1;
  for (let i = 0; i < 120; i++) w.step([inp]);
  const v0 = car.vel.length();
  for (let i = 0; i < 360; i++) {
    inp.jump = i < 6 || (i > 12 && i < 16);
    inp.pitch = i > 10 && i < 20 ? 1 : 0;
    w.step([inp]);
    if (i === 16) check('flip adds speed', car.vel.length() > v0 + 3, `v0=${v0.toFixed(1)} v=${car.vel.length().toFixed(1)} flipping=${car.isFlipping}`);
  }
  check('lands on wheels after flip', car.onGround && car.up(new Vector3()).y > 0.9, 'up.y=' + car.up(new Vector3()).y.toFixed(2) + ' pos=' + f(car.pos) + ' wheels=' + car.wheelsInContact + ' v=' + f(car.vel));
}
// 8. wall drive: drive into side wall at speed
{
  const { w, car } = fresh();
  car.reset(20, 0, Math.PI / 2); // facing +x
  car.boost = 100;
  const inp = emptyInput();
  inp.throttle = 1;
  inp.boost = true;
  let maxY = 0;
  for (let i = 0; i < 300; i++) {
    w.step([inp]);
    maxY = Math.max(maxY, car.pos.y);
    if (process.env.DEBUG && i % 5 === 0) console.log(i, f(car.pos), 'v', car.vel.length().toFixed(1), 'up', f(car.up(new Vector3())), 'wheels', car.wheelsInContact, 'body', car.bodyContact, 'w', car.angVel.length().toFixed(2));
  }
  check('drives up the wall', maxY > 6, 'maxY=' + maxY.toFixed(2) + ' pos=' + f(car.pos) + ' wheels=' + car.wheelsInContact);
}
// 9. ball bounce
{
  const w = new World();
  w.ball.reset(0, 10, 0);
  let bounces = 0, prevVy = 0, peak2 = 0, landed = false;
  for (let i = 0; i < 600; i++) {
    w.step([]);
    if (prevVy < 0 && w.ball.vel.y > 0) { bounces++; landed = true; }
    if (landed && bounces === 1) peak2 = Math.max(peak2, w.ball.pos.y);
    prevVy = w.ball.vel.y;
  }
  check('ball bounces with ~0.6 restitution', bounces >= 2 && peak2 > 3 && peak2 < 5.5, 'bounces=' + bounces + ' 2nd peak=' + peak2.toFixed(2));
}
// 10. car hits ball
{
  const { w, car } = fresh();
  car.reset(0, 20, 0);
  w.ball.reset(0, 0.9125, 30);
  const inp = emptyInput();
  inp.throttle = 1;
  let hit = false;
  for (let i = 0; i < 400; i++) {
    w.step([inp]);
    for (const e of w.events) if (e.type === 'touch') hit = true;
    w.events.length = 0;
    if (hit) break;
  }
  for (let i = 0; i < 5; i++) w.step([inp]);
  check('ball gets hit forward', hit && w.ball.vel.z > car.vel.z + 3, 'ballV=' + f(w.ball.vel) + ' carV=' + f(car.vel));
}
// 11. goal detection
{
  const w = new World();
  w.ball.reset(0, 2, 45);
  w.ball.vel.set(0, 0, 30);
  let goal: any = null;
  for (let i = 0; i < 120; i++) {
    w.step([]);
    for (const e of w.events) if (e.type === 'goal') goal = e;
  }
  check('goal detected (blue scores on +z)', goal && goal.team === 0);
}
// 12. ball blocked by posts / back wall behaves
{
  const w = new World();
  w.ball.reset(12, 2, 45);
  w.ball.vel.set(0, 0, 25);
  let goal = false;
  for (let i = 0; i < 240; i++) { w.step([]); if (w.events.some(e => e.type === 'goal')) goal = true; }
  check('wide shot bounces off back wall', !goal && w.ball.pos.z < 51.2, f(w.ball.pos));
}
// 13. serialization roundtrip
{
  const { w, car } = fresh();
  const inp = emptyInput(); inp.throttle = 1; inp.steer = 0.4;
  for (let i = 0; i < 100; i++) w.step([inp]);
  const s = w.serialize();
  const w2 = new World(); w2.deserialize(s);
  for (let i = 0; i < 60; i++) { w.step([inp]); w2.step([inp]); }
  check('deterministic after deserialize', w.cars[0]!.pos.distanceTo(w2.cars[0]!.pos) < 0.01, f(w.cars[0]!.pos) + ' vs ' + f(w2.cars[0]!.pos));
}
// 14. perf
{
  const w = new World();
  for (let i = 0; i < 6; i++) { const c = w.addCar(i, (i < 3 ? 0 : 1) as 0|1); c.reset(-10 + i * 4, 0, 0); }
  const inp = emptyInput(); inp.throttle = 1; inp.steer = 0.3;
  const t0 = performance.now();
  for (let i = 0; i < 1200; i++) w.step([inp, inp, inp, inp, inp, inp]);
  const ms = (performance.now() - t0) / 1200;
  check('6-car tick < 0.3ms', ms < 0.3, ms.toFixed(3) + 'ms/tick');
}
console.log(failures ? `${failures} failing` : 'all good');
process.exit(failures ? 1 : 0);
