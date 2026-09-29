// Bot-vs-bot evaluation. `npx tsx scripts/bot-eval.ts [games] [skillA] [skillB]`
// Plays 1v1/2v2/3v3 in turn (sides alternate) and prints goals, wins and own goals.
import { Match } from '../src/game/match';
import { Bot } from '../src/game/bot';
import { DEFAULT_LOADOUT, emptyStats } from '../src/game/types';
const games = Number(process.argv[2] ?? 12);
const skillA = Number(process.argv[3] ?? 0.9);
const skillB = Number(process.argv[4] ?? 0.6);
const tot = { goalsA: 0, goalsB: 0, winsA: 0, winsB: 0, draws: 0, ownGoalsA: 0, ownGoalsB: 0 };
for (let g = 0; g < games; g++) {
  const m = new Match({ duration: 120, replays: false });
  m.kickoffCount = g;
  const size = [1, 2, 3][g % 3];
  const aTeam = Math.floor(g / 3) % 2;
  const bots: Bot[] = [];
  for (let i = 0; i < size; i++) {
    for (const s of [i, 3 + i]) {
      const team = s < 3 ? 0 : 1;
      m.addPlayer({ slot: s, name: 'B' + s, team, isBot: true, loadout: DEFAULT_LOADOUT, stats: emptyStats() });
      bots[s] = new Bot(s, team === aTeam ? skillA : skillB);
    }
  }
  m.startKickoff();
  let ticks = 0;
  let lastTouch = -1;
  const touches = [0, 0];
  while (m.phase !== 'ended' && ticks < 120 * 200) {
    m.tick(bots.map((b) => (b ? b.update(m.world) : null)));
    for (const e of m.worldEvents) {
      if (e.type === 'touch') {
        lastTouch = e.car < 3 ? 0 : 1;
        touches[lastTouch]++;
      }
      if (e.type === 'goal' && lastTouch >= 0 && lastTouch !== e.team) {
        if (lastTouch === aTeam) tot.ownGoalsA++;
        else tot.ownGoalsB++;
      }
    }
    m.worldEvents.length = 0;
    m.events.length = 0;
    ticks++;
  }
  const a = m.scores[aTeam];
  const b = m.scores[1 - aTeam];
  tot.goalsA += a;
  tot.goalsB += b;
  if (a > b) tot.winsA++;
  else if (b > a) tot.winsB++;
  else tot.draws++;
  console.log(`${size}v${size}  A ${a} - ${b} B  touches ${touches[aTeam]}/${touches[1 - aTeam]}${m.overtime ? '  OT' : ''}`);
}
console.log(`A (skill ${skillA}) vs B (skill ${skillB}):`, tot);
