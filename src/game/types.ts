import type { Team } from '../physics/car';

export type BodyId = 'breaker' | 'wedge' | 'titan' | 'viper';
export type WheelId = 'classic' | 'spoke' | 'turbine' | 'neon' | 'star';
export type BoostId = 'flame' | 'neon' | 'plasma' | 'sparkle' | 'bubbles' | 'lightning' | 'rainbow';
export type ExplosionId = 'classic' | 'fireworks' | 'singularity' | 'electro' | 'confetti' | 'voxel' | 'shockwave' | 'inferno';
export type TopperId = 'none' | 'cone' | 'crown' | 'halo' | 'antenna' | 'horns';

export interface Loadout {
  body: BodyId;
  /** accent / secondary paint colour (hex) */
  accent: number;
  /** 0..3 – which shade of the team colour the body uses */
  shade: number;
  wheels: WheelId;
  boost: BoostId;
  explosion: ExplosionId;
  anthem: string;
  topper: TopperId;
}

export const DEFAULT_LOADOUT: Loadout = {
  body: 'breaker',
  accent: 0xdedede,
  shade: 0,
  wheels: 'classic',
  boost: 'flame',
  explosion: 'classic',
  anthem: 'echo-charge',
  topper: 'none',
};

export interface PlayerStats {
  score: number;
  goals: number;
  assists: number;
  saves: number;
  shots: number;
  demos: number;
  touches: number;
}

export const emptyStats = (): PlayerStats => ({ score: 0, goals: 0, assists: 0, saves: 0, shots: 0, demos: 0, touches: 0 });

export interface PlayerInfo {
  slot: number;
  name: string;
  team: Team;
  isBot: boolean;
  /** bot skill 0..1 */
  skill?: number;
  accountId?: string;
  loadout: Loadout;
  stats: PlayerStats;
}

export type Phase = 'countdown' | 'playing' | 'goal' | 'replay' | 'ended' | 'freeplay';

export type MatchEvent =
  | { type: 'goal'; team: Team; scorer: number; assister: number; speed: number; x: number; y: number; z: number; ownGoal: boolean }
  | { type: 'kickoff' }
  | { type: 'countdown'; n: number }
  | { type: 'go' }
  | { type: 'replay' }
  | { type: 'overtime' }
  | { type: 'end'; winner: Team; mvp: number }
  | { type: 'save'; slot: number }
  | { type: 'shot'; slot: number }
  | { type: 'demo'; attacker: number; victim: number; x: number; y: number; z: number }
  | { type: 'chat'; slot: number; text: string }
  | { type: 'lastSeconds'; n: number };

export const TEAM_NAMES = ['BLUE', 'ORANGE'] as const;
export const TEAM_COLORS = [0x2f7bff, 0xff7a1a] as const;
export const TEAM_SHADES: [number[], number[]] = [
  [0x1f5fe0, 0x2b3fb8, 0x1497d6, 0x5a3be0],
  [0xf26a10, 0xd9480f, 0xf0a020, 0xe0323a],
];
