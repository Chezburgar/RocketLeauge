# Boost League

A browser car-soccer game in the spirit of Rocket League, with a semi-low-poly look, real car/ball physics, cosmetics (goal explosions, boost trails, anthems), bots, online multiplayer, and a Supabase-backed account system with an admin panel.

> The name, logo, cars and stadium are all original, so the project doesn't use anyone else's trademarks. You can rename the game in `src/config.ts` (`GAME_NAME`).

## Features

- **Physics (120 Hz, custom):** the arena is a smooth signed-distance field with ramps, walls, ceiling and goals, so you can drive up walls and across the ceiling. Cars have suspension, throttle and steering curves, powerslide, jump, double jump, dodges/flips (with flip cancel), air pitch/yaw/roll, free air roll, boost, supersonic, bumps and demolitions. Car touches add extra impulse to the ball, and all 34 boost pads work.
- **Cosmetics:** 4 original car bodies, team shades plus a custom accent colour, 5 wheel styles, 6 toppers, 7 boost trails, and 8 goal explosions (Classic, Fireworks, Singularity, Electroshock, Confetti, Voxel, Shockwave, Inferno). Your goal anthem plays for everyone when you score, and the MVP's anthem plays at the end of the match.
- **Anthems:** the 10 *Echo Fanfare* anthems you attached are bundled. The admin can upload more, and they show up in everyone's Garage.
- **Matches:** kickoff countdown with random kickoff spots, clock, overtime, goal replays (skippable), scoreboard, MVP, saves/shots/assists, quick chat and chat, crowd reactions, and synthesized sound effects.
- **Modes:** Online rooms (1v1/2v2/3v3, public or private, bots fill empty spots, join mid-match), Exhibition vs bots (Rookie/Pro/All-Star), and Free Play.
- **Accounts:** tied to the device, with no email and no password. New players choose a name and request access, and the admin approves them.
- **Admin panel:** approve/deny requests, manage players (revoke, ban, rename, promote to admin, delete), upload songs, build main-menu playlists (in order, shuffle, or radio-sync where everyone hears the same moment), choose the live playlist, and upload custom anthems.

## Controls

| Keyboard / mouse | Gamepad | Action |
| --- | --- | --- |
| W / S | RT / LT | Throttle / reverse (pitch in the air) |
| A / D | Left stick | Steer (yaw in the air) |
| Space / Right mouse | A | Jump (press again with a direction to dodge) |
| Shift / Left mouse | B | Boost |
| X (hold) | X | Powerslide / free air roll |
| Q / E | LB / RB | Air roll left / right |
| C | Y | Toggle ball cam |
| Tab | Back | Scoreboard |
| T, 1-4 | | Chat, quick chat |
| Esc | Start | Menu |

Camera (FOV, distance, height, angle, stiffness, swivel, shake), graphics quality, and volumes are under **Options**.

## How accounts work ("by device, not wifi")

Browsers can't read a device's hardware ID or MAC address, and an IP address changes whenever a device switches networks. So each device creates a random 256-bit **device key** the first time it runs. The key is stored in three places (localStorage, IndexedDB and a cookie), so a normal cache clear won't lose it. The database stores only a SHA-256 hash of the key.

- **Sign-up:** the player enters a name and presses **Request access**. The request shows up in **Admin → Access requests** with the device type (for example *Windows · Chrome · 1920×1080*).
- **The first account ever created becomes the admin and is approved automatically.** Open the game yourself first, before sharing the link.
- **Backup code:** **Profile → Backup code** shows the device key. Pasting it into *Restore with a backup code* on the sign-up screen moves the account to another browser or device.
- A player who has already been approved can still play offline modes if the server is unreachable.

## Supabase

Everything is already set up in your Supabase project (`bgoxonxxutkporbqbtbh`). All objects are prefixed `rl_` so they don't collide with the other apps in that project:

- `supabase/migrations/20260928000000_boost_league.sql` creates the tables (`rl_accounts`, `rl_songs`, `rl_playlists`, `rl_playlist_songs`, `rl_settings`), the RPC functions, and the public `rl-music` storage bucket. Every table has RLS on with no policies, so it can only be reached through SECURITY DEFINER functions that check the device key (admin functions also check admin status).
- `supabase/migrations/20260928000100_boost_league_realtime.sql` adds Realtime policies for the game's `bl-*` channels. These are only used if public Realtime channels are disabled.
- `supabase/functions/rl-music-storage` is an edge function that hands out signed upload URLs (and deletes files) for admins, used for music uploads.
- Accounts do **not** use Supabase Auth, so no rows are added to `auth.users` or to the other apps' `profiles` table.

Handy SQL (Supabase dashboard → SQL editor):

```sql
-- see everyone
select display_name, status, is_admin, device_label, created_at from rl_accounts order by created_at;
-- make someone admin
update rl_accounts set is_admin = true, status = 'approved' where display_name = 'TheirName';
```

The URL and anon key in `src/config.ts` are public by design. They can be overridden with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.

## Multiplayer

Rooms use **Supabase Realtime** for matchmaking (room codes, public room list, WebRTC signalling). The game itself runs over a **peer-to-peer WebRTC** connection to the host:

- The host's browser runs the authoritative simulation and sends snapshots at 30 Hz.
- Clients predict their own car, roll back to each snapshot, and re-simulate. This is the same approach Rocket League uses, so your own car responds instantly. In the headless test (`npm test`), prediction error is under 1 cm at typical pings.
- If a direct connection can't be made (strict NAT or firewall), traffic is relayed through Supabase automatically, at a lower update rate.
- If a player leaves, a bot takes over their car. If the host leaves, the match ends.

## Running locally

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # physics + netcode tests
npm run build      # production build in dist/
```

## Deploying (GitHub Pages)

1. Merge this branch into `main`.
2. In the repository, go to **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Every push to `main` then runs `.github/workflows/deploy.yml` (tests, build, deploy). You can also run it by hand from the **Actions** tab.

The build uses relative paths, so it also works on Netlify, Vercel, Cloudflare Pages, or any static host. Just serve `dist/`.

## Project layout

```
src/physics   arena SDF, car, ball, world (collisions, pads, demos), constants
src/game      match rules, bots, ball prediction, sessions (offline/host/client), controls, settings
src/render    Three.js view, stadium, car models, particles, goal explosions, replay frames
src/audio     synthesized SFX, crowd, engine, menu music player, anthems
src/net       Supabase API, device key, signalling, WebRTC peers, host logic, snapshot protocol
src/ui        menus, garage, HUD, admin panel, styles
supabase      migrations + edge function
scripts       headless physics & netcode tests
```

## Notes

- The bundled anthem MP3s in `public/audio/anthems` are the files you supplied (Rocket League "Echo Fanfare" variations, © Psyonix). This repository is public, so anyone can download them. If you'd rather not redistribute them, delete the MP3s, set `src/audio/anthemList.json` to `[]`, and upload anthems through **Admin → Custom anthems** instead.
- No menu-music file was in the attachment, so until you set a live playlist in the admin panel, the menu plays a built-in generative theme.
