// ─────────────────────────────────────────────────────────────────────────────
//  Project configuration. The Supabase URL + publishable (anon) key are meant to
//  be public – security is enforced by row-level security and SECURITY DEFINER
//  functions in the database (see supabase/migrations).
//  They can be overridden at build time with VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.
// ─────────────────────────────────────────────────────────────────────────────

export const GAME_NAME = 'BOOST LEAGUE';
export const GAME_TAGLINE = 'CAR SOCCER • EST. 2026';

export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? 'https://bgoxonxxutkporbqbtbh.supabase.co';
export const SUPABASE_ANON_KEY: string =
  import.meta.env.VITE_SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJnb3hvbnh4dXRrcG9yYnFidGJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4NjQzNDYsImV4cCI6MjA5OTQ0MDM0Nn0.o0obh7NwBn50TOxhdUl7mdccWOzuqJs_TpiG609wlbM';

/** Storage bucket that holds admin-uploaded music. */
export const MUSIC_BUCKET = 'rl-music';

/** Public STUN servers used for peer-to-peer multiplayer. */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
