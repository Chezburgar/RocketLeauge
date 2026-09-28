import type { Team } from '../physics/car';
import { BALL_RADIUS, DT, KICKOFF_SPOTS } from '../physics/constants';
import type { CarInput } from '../physics/input';
import { MAX_CARS, World, type WorldEvent } from '../physics/world';
import { BallPredictor } from './prediction';
import { emptyStats, type MatchEvent, type Phase, type PlayerInfo } from './types';

export interface MatchSettings {
  duration: number; // seconds, 0 = unlimited
  freeplay: boolean;
  replays: boolean;
  /** end early if a team leads by this many goals (0 = off) */
  mercy: number;
}

export const PHASE_IDS: Phase[] = ['countdown', 'playing', 'goal', 'replay', 'ended', 'freeplay'];
const GOAL_PHASE_TIME = 3.0;
const REPLAY_TIME = 6.0;
const COUNTDOWN_TIME = 3.0;

/** Authoritative game rules layered on top of the physics world (run by offline games and hosts). */
export class Match {
  world = new World();
  players: (PlayerInfo | null)[] = new Array(MAX_CARS).fill(null);
  settings: MatchSettings;
  phase: Phase = 'countdown';
  phaseTime = COUNTDOWN_TIME;
  clock: number;
  overtime = false;
  scores: [number, number] = [0, 0];
  events: MatchEvent[] = [];
  /** raw physics events from the last tick(s) – consumed by renderer / audio */
  worldEvents: WorldEvent[] = [];
  lastGoal: Extract<MatchEvent, { type: 'goal' }> | null = null;
  winner: Team | -1 = -1;
  mvp = -1;
  kickoffCount = 0;
  private touches: { slot: number; team: Team; time: number }[] = [];
  private elapsed = 0;
  private predictor = new BallPredictor(2.5);
  private threat = -1;
  private pendingTouch: { slot: number; threatBefore: number } | null = null;
  private predictTimer = 0;
  private lastCountdown = 4;
  private lastSecondsCalled = 99;
  private waitingForGround = false;

  constructor(settings: Partial<MatchSettings> = {}) {
    this.settings = { duration: 300, freeplay: false, replays: true, mercy: 0, ...settings };
    this.clock = this.settings.duration;
    if (this.settings.freeplay) {
      this.phase = 'freeplay';
      this.phaseTime = 0;
    }
  }

  addPlayer(p: PlayerInfo) {
    this.players[p.slot] = p;
    const car = this.world.addCar(p.slot, p.team);
    this.placeForKickoff();
    if (this.phase === 'playing' || this.phase === 'freeplay') this.world.respawn(car);
    return car;
  }

  removePlayer(slot: number) {
    this.players[slot] = null;
    this.world.removeCar(slot);
  }

  teamSize(team: Team) {
    return this.players.filter((p) => p && p.team === team).length;
  }

  freeSlot(team: Team): number {
    const range = team === 0 ? [0, 1, 2] : [3, 4, 5];
    for (const s of range) if (!this.players[s]) return s;
    return -1;
  }

  private emit(e: MatchEvent) {
    this.events.push(e);
  }

  startKickoff() {
    this.kickoffCount++;
    this.world.goalScored = false;
    this.placeForKickoff();
    this.phase = this.settings.freeplay ? 'freeplay' : 'countdown';
    this.phaseTime = COUNTDOWN_TIME;
    this.lastCountdown = 4;
    this.world.frozen = !this.settings.freeplay;
    this.touches = [];
    this.threat = -1;
    this.emit({ type: 'kickoff' });
  }

  private placeForKickoff() {
    const w = this.world;
    w.ball.reset(0, BALL_RADIUS, 0);
    // deterministic shuffle of the five kickoff spots
    const order = [0, 1, 2, 3, 4];
    let seed = this.kickoffCount * 7919 + 17;
    for (let i = order.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const team of [0, 1] as Team[]) {
      let k = 0;
      for (let s = 0; s < MAX_CARS; s++) {
        const car = w.cars[s];
        if (!car || car.team !== team) continue;
        const [x, z, yaw] = KICKOFF_SPOTS[order[k++ % order.length]];
        if (team === 0) car.reset(x, z, yaw);
        else car.reset(-x, -z, yaw + Math.PI);
      }
    }
    for (const p of w.pads) p.timer = 0;
  }

  /** Advance one physics tick. */
  tick(inputs: (CarInput | null | undefined)[]) {
    const w = this.world;
    w.step(inputs);
    this.elapsed += DT;
    for (const e of w.events) this.onWorldEvent(e);
    this.worldEvents.push(...w.events);
    w.events.length = 0;

    switch (this.phase) {
      case 'countdown': {
        this.phaseTime -= DT;
        const n = Math.ceil(this.phaseTime);
        if (n < this.lastCountdown && n > 0) {
          this.lastCountdown = n;
          this.emit({ type: 'countdown', n });
        }
        if (this.phaseTime <= 0) {
          this.phase = 'playing';
          w.frozen = false;
          this.emit({ type: 'go' });
        }
        break;
      }
      case 'playing': {
        if (this.settings.duration > 0) {
          if (this.overtime) this.clock += DT;
          else if (this.clock > 0) {
            this.clock = Math.max(0, this.clock - DT);
            const secs = Math.ceil(this.clock);
            if (secs <= 10 && secs < this.lastSecondsCalled && this.clock > 0) {
              this.lastSecondsCalled = secs;
              this.emit({ type: 'lastSeconds', n: secs });
            }
          }
          if (!this.overtime && this.clock <= 0) {
            if (this.scores[0] === this.scores[1]) {
              // tied → wait for ball to hit the floor, then overtime
              if (w.ball.onGround || w.ball.pos.y < BALL_RADIUS + 0.3) {
                this.overtime = true;
                this.clock = 0;
                this.emit({ type: 'overtime' });
                this.startKickoff();
              }
            } else {
              this.waitingForGround = true;
              if (w.ball.onGround || w.ball.pos.y < BALL_RADIUS + 0.3) this.endMatch();
            }
          }
        }
        this.updatePrediction();
        break;
      }
      case 'freeplay':
        this.updatePrediction();
        if (w.goalScored) {
          this.phaseTime += DT;
          if (this.phaseTime > GOAL_PHASE_TIME) {
            this.phaseTime = 0;
            w.goalScored = false;
            w.ball.reset(0, BALL_RADIUS + 2, 0);
          }
        }
        break;
      case 'goal':
        this.phaseTime -= DT;
        if (this.phaseTime <= 0) {
          const over =
            (this.settings.duration > 0 && (this.overtime || this.clock <= 0)) ||
            (this.settings.mercy > 0 && Math.abs(this.scores[0] - this.scores[1]) >= this.settings.mercy);
          if (over) this.endMatch();
          else if (this.settings.replays) {
            this.phase = 'replay';
            this.phaseTime = REPLAY_TIME;
            this.emit({ type: 'replay' });
          } else this.startKickoff();
        }
        break;
      case 'replay':
        this.phaseTime -= DT;
        if (this.phaseTime <= 0) this.startKickoff();
        break;
      case 'ended':
        break;
    }
  }

  skipReplay() {
    if (this.phase === 'replay') this.phaseTime = Math.min(this.phaseTime, 0.05);
  }

  private endMatch() {
    this.phase = 'ended';
    this.world.frozen = true;
    this.winner = this.scores[0] > this.scores[1] ? 0 : 1;
    let best = -1;
    let mvp = -1;
    for (const p of this.players) {
      if (!p || p.team !== this.winner) continue;
      if (p.stats.score > best) {
        best = p.stats.score;
        mvp = p.slot;
      }
    }
    this.mvp = mvp;
    this.emit({ type: 'end', winner: this.winner, mvp });
  }

  private updatePrediction() {
    if (--this.predictTimer > 0) return;
    this.predictTimer = 6;
    const b = this.world.ball;
    this.predictor.update(b.pos, b.vel, b.angVel);
    const newThreat = this.predictor.goalFor;
    if (this.pendingTouch) {
      const { slot, threatBefore } = this.pendingTouch;
      const p = this.players[slot];
      if (p && !this.settings.freeplay) {
        // their own goal was about to be scored on and now isn't → save
        if (threatBefore === p.team && newThreat !== p.team) {
          p.stats.saves++;
          p.stats.score += 50;
          this.emit({ type: 'save', slot });
        } else if (newThreat === 1 - p.team && threatBefore !== 1 - p.team) {
          p.stats.shots++;
          p.stats.score += 20;
          this.emit({ type: 'shot', slot });
        }
      }
      this.pendingTouch = null;
    }
    this.threat = newThreat;
  }

  private onWorldEvent(e: WorldEvent) {
    switch (e.type) {
      case 'touch': {
        const car = this.world.cars[e.car];
        if (!car) break;
        this.touches.push({ slot: e.car, team: car.team, time: this.elapsed });
        if (this.touches.length > 12) this.touches.shift();
        const p = this.players[e.car];
        if (p) p.stats.touches++;
        this.pendingTouch = { slot: e.car, threatBefore: this.threat };
        this.predictTimer = 0;
        break;
      }
      case 'demo': {
        const p = this.players[e.attacker];
        if (p) {
          p.stats.demos++;
          p.stats.score += 15;
        }
        this.emit({ type: 'demo', attacker: e.attacker, victim: e.victim, x: e.x, y: e.y, z: e.z });
        break;
      }
      case 'goal': {
        if (this.phase === 'freeplay') {
          this.phaseTime = 0;
          this.lastGoal = { type: 'goal', team: e.team, scorer: this.touches.at(-1)?.slot ?? -1, assister: -1, speed: e.speed, x: e.x, y: e.y, z: e.z, ownGoal: false };
          this.emit(this.lastGoal);
          this.world.explode(e.x, e.y, e.z, 14, 16);
          break;
        }
        if (this.phase !== 'playing') break;
        this.scores[e.team]++;
        // scorer = last toucher from the scoring team; assist = previous distinct teammate within 5 s
        let scorer = -1;
        let assister = -1;
        let ownGoal = false;
        for (let i = this.touches.length - 1; i >= 0; i--) {
          const t = this.touches[i];
          if (t.team !== e.team) continue;
          if (scorer < 0) scorer = t.slot;
          else if (t.slot !== scorer && this.elapsed - t.time < 5) {
            assister = t.slot;
            break;
          }
        }
        if (scorer < 0) {
          ownGoal = true;
          scorer = this.touches.at(-1)?.slot ?? -1;
        }
        const sp = scorer >= 0 ? this.players[scorer] : null;
        if (sp && !ownGoal) {
          sp.stats.goals++;
          sp.stats.score += 100;
          if (this.pendingTouch?.slot === scorer || this.threat !== 1 - sp.team) {
            sp.stats.shots++;
            sp.stats.score += 20;
          }
        }
        const ap = assister >= 0 ? this.players[assister] : null;
        if (ap) {
          ap.stats.assists++;
          ap.stats.score += 50;
        }
        this.pendingTouch = null;
        this.lastGoal = { type: 'goal', team: e.team, scorer, assister, speed: e.speed, x: e.x, y: e.y, z: e.z, ownGoal };
        this.emit(this.lastGoal);
        this.phase = 'goal';
        this.phaseTime = GOAL_PHASE_TIME;
        this.world.explode(e.x, e.y, e.z, 14, 16);
        break;
      }
    }
  }

  resetStats() {
    for (const p of this.players) if (p) p.stats = emptyStats();
  }

  /** Restart everything (rematch). */
  restart() {
    this.scores = [0, 0];
    this.clock = this.settings.duration;
    this.overtime = false;
    this.winner = -1;
    this.mvp = -1;
    this.lastSecondsCalled = 99;
    this.waitingForGround = false;
    this.resetStats();
    for (const c of this.world.cars) if (c) c.demolished = false;
    this.startKickoff();
  }
}
