// Bot-vs-bot evaluation: goals and touches per match. `npx tsx scripts/bot-eval.ts`
import { Match } from '../src/game/match';
import { Bot } from '../src/game/bot';
import { DEFAULT_LOADOUT, emptyStats } from '../src/game/types';
const tot = [0, 0];
let touchesAll = 0;
for (let g = 0; g < 6; g++) {
  const m = new Match({ duration: 120, replays: false });
  m.kickoffCount = g;
  const bots: Bot[] = [];
  const slots = g % 2 ? [0, 3] : [0, 1, 3, 4];
  for (const s of slots) {
    m.addPlayer({ slot: s, name: 'B' + s, team: s < 3 ? 0 : 1, isBot: true, loadout: DEFAULT_LOADOUT, stats: emptyStats() });
    bots[s] = new Bot(s, 0.8);
  }
  m.startKickoff();
  let ticks = 0;
  const touches = [0, 0];
  let demos = 0;
  while (m.phase !== 'ended' && ticks < 120 * 200) {
    const inputs = [];
    for (let s = 0; s < 6; s++) inputs[s] = bots[s] ? bots[s].update(m.world) : null;
    m.tick(inputs);
    for (const e of m.worldEvents) { if (e.type === 'touch') touches[e.car < 3 ? 0 : 1]++; if (e.type === 'demo') demos++; }
    m.worldEvents.length = 0; m.events.length = 0; ticks++;
  }
  tot[0] += m.scores[0]; tot[1] += m.scores[1];
  touchesAll += touches[0] + touches[1];
  console.log(slots.length / 2 + 'v' + slots.length / 2, 'score', m.scores, 'touches', touches, 'demos', demos, m.overtime ? 'OT' : '', (ticks / 120).toFixed(0) + 's');
}
console.log('total goals', tot, 'touches', touchesAll);
