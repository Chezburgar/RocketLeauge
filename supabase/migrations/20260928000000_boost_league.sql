-- ════════════════════════════════════════════════════════════════════════════
--  Boost League – accounts, access requests, admin music & multiplayer tickets
--
--  Accounts are bound to a DEVICE, not an email: each device generates a random
--  256-bit key that never leaves the device except (over TLS) to these
--  functions. Only its SHA-256 hash is stored. Every table below has RLS enabled
--  with no policies, so the only way in is through the SECURITY DEFINER
--  functions, which check the device key themselves.
--  (All objects are prefixed rl_ so they don't collide with other apps.)
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.rl_accounts (
  id uuid primary key default gen_random_uuid(),
  device_hash text not null unique,
  display_name text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'banned')),
  is_admin boolean not null default false,
  device_label text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  last_seen timestamptz,
  loadout jsonb not null default '{}'::jsonb,
  stats jsonb not null default '{}'::jsonb
);
create unique index if not exists rl_accounts_name_uq on public.rl_accounts (lower(display_name));
alter table public.rl_accounts enable row level security;

create table if not exists public.rl_songs (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  artist text not null default '',
  kind text not null default 'menu' check (kind in ('menu', 'anthem')),
  storage_path text not null,
  duration real,
  created_at timestamptz not null default now(),
  created_by uuid references public.rl_accounts (id) on delete set null
);
create index if not exists rl_songs_created_by_idx on public.rl_songs (created_by);
alter table public.rl_songs enable row level security;

create table if not exists public.rl_playlists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mode text not null default 'order' check (mode in ('order', 'shuffle', 'radio')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.rl_playlists enable row level security;

create table if not exists public.rl_playlist_songs (
  playlist_id uuid not null references public.rl_playlists (id) on delete cascade,
  song_id uuid not null references public.rl_songs (id) on delete cascade,
  position int not null,
  primary key (playlist_id, song_id)
);
create index if not exists rl_playlist_songs_song_idx on public.rl_playlist_songs (song_id);
alter table public.rl_playlist_songs enable row level security;

create table if not exists public.rl_settings (
  id int primary key default 1 check (id = 1),
  active_playlist uuid references public.rl_playlists (id) on delete set null,
  radio_epoch timestamptz not null default now(),
  ticket_secret text not null default encode(extensions.gen_random_bytes(32), 'hex')
);
create index if not exists rl_settings_active_idx on public.rl_settings (active_playlist);
alter table public.rl_settings enable row level security;
insert into public.rl_settings (id) values (1) on conflict do nothing;

-- ── helpers (not callable by clients) ──────────────────────────────────────
create or replace function public.rl__hash(p_secret text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(coalesce(p_secret, ''), 'sha256'), 'hex')
$$;

create or replace function public.rl__me(p_secret text) returns public.rl_accounts
language plpgsql stable security definer set search_path = '' as $$
declare acc public.rl_accounts;
begin
  if p_secret is null or p_secret !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid device key';
  end if;
  select * into acc from public.rl_accounts where device_hash = public.rl__hash(p_secret);
  return acc;
end $$;

create or replace function public.rl__admin(p_secret text) returns public.rl_accounts
language plpgsql stable security definer set search_path = '' as $$
declare acc public.rl_accounts;
begin
  acc := public.rl__me(p_secret);
  if acc.id is null or not acc.is_admin or acc.status <> 'approved' then
    raise exception 'admin only';
  end if;
  return acc;
end $$;

create or replace function public.rl__json(acc public.rl_accounts) returns jsonb
language sql stable set search_path = '' as $$
  select case when acc.id is null then null else jsonb_build_object(
    'id', acc.id, 'name', acc.display_name, 'status', acc.status, 'is_admin', acc.is_admin,
    'device', acc.device_label, 'created_at', acc.created_at, 'approved_at', acc.approved_at,
    'last_seen', acc.last_seen, 'loadout', acc.loadout, 'stats', acc.stats) end
$$;

create or replace function public.rl__valid_name(p_name text) returns text
language plpgsql immutable set search_path = '' as $$
declare n text := btrim(coalesce(p_name, ''));
begin
  if n !~ '^[A-Za-z0-9 _.\-]{2,16}$' then
    raise exception 'Name must be 2-16 characters: letters, numbers, spaces, _ . -';
  end if;
  return n;
end $$;

-- ── player functions ───────────────────────────────────────────────────────
create or replace function public.rl_register(p_secret text, p_name text, p_device text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  acc public.rl_accounts;
  n text;
  first_account boolean;
begin
  perform pg_advisory_xact_lock(hashtext('rl_register'));
  acc := public.rl__me(p_secret);
  if acc.id is not null then
    return public.rl__json(acc);
  end if;
  n := public.rl__valid_name(p_name);
  if exists (select 1 from public.rl_accounts where lower(display_name) = lower(n)) then
    raise exception 'That name is already taken';
  end if;
  if (select count(*) from public.rl_accounts where status = 'pending') >= 200 then
    raise exception 'Too many pending requests right now – try again later';
  end if;
  -- the very first account becomes the admin (and is approved automatically)
  first_account := not exists (select 1 from public.rl_accounts where is_admin);
  insert into public.rl_accounts (device_hash, display_name, device_label, status, is_admin, approved_at, last_seen)
  values (public.rl__hash(p_secret), n, left(coalesce(p_device, ''), 120),
          case when first_account then 'approved' else 'pending' end,
          first_account, case when first_account then now() end, now())
  returning * into acc;
  return public.rl__json(acc);
end $$;

create or replace function public.rl_login(p_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare acc public.rl_accounts;
begin
  acc := public.rl__me(p_secret);
  if acc.id is null then return null; end if;
  update public.rl_accounts set last_seen = now() where id = acc.id returning * into acc;
  return public.rl__json(acc);
end $$;

-- a denied player may ask again (optionally with a new name)
create or replace function public.rl_rerequest(p_secret text, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare acc public.rl_accounts; n text;
begin
  acc := public.rl__me(p_secret);
  if acc.id is null then raise exception 'not registered'; end if;
  if acc.status <> 'denied' then return public.rl__json(acc); end if;
  n := public.rl__valid_name(p_name);
  if exists (select 1 from public.rl_accounts where lower(display_name) = lower(n) and id <> acc.id) then
    raise exception 'That name is already taken';
  end if;
  update public.rl_accounts set status = 'pending', display_name = n where id = acc.id returning * into acc;
  return public.rl__json(acc);
end $$;

create or replace function public.rl_save_loadout(p_secret text, p_loadout jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare acc public.rl_accounts;
begin
  acc := public.rl__me(p_secret);
  if acc.id is null or acc.status <> 'approved' then raise exception 'not approved'; end if;
  if pg_column_size(p_loadout) > 4000 then raise exception 'loadout too large'; end if;
  update public.rl_accounts set loadout = coalesce(p_loadout, '{}'::jsonb) where id = acc.id;
end $$;

create or replace function public.rl_add_stats(p_secret text, p_stats jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  acc public.rl_accounts;
  k text;
  s jsonb;
  v int;
begin
  acc := public.rl__me(p_secret);
  if acc.id is null or acc.status <> 'approved' then raise exception 'not approved'; end if;
  s := acc.stats;
  foreach k in array array['games', 'wins', 'goals', 'assists', 'saves', 'shots', 'mvps', 'demos'] loop
    v := least(greatest(coalesce((p_stats ->> k)::int, 0), 0), 60);
    if v > 0 then
      s := jsonb_set(s, array[k], to_jsonb(coalesce((s ->> k)::int, 0) + v));
    end if;
  end loop;
  update public.rl_accounts set stats = s where id = acc.id;
  return s;
end $$;

-- short-lived signed ticket proving "I'm an approved player" to a match host
create or replace function public.rl_ticket(p_secret text)
returns text language plpgsql security definer set search_path = '' as $$
declare acc public.rl_accounts; exp bigint; key text; payload text;
begin
  acc := public.rl__me(p_secret);
  if acc.id is null or acc.status <> 'approved' then raise exception 'not approved'; end if;
  select ticket_secret into key from public.rl_settings where id = 1;
  exp := extract(epoch from now())::bigint + 3600;
  payload := acc.id::text || '.' || exp::text;
  return payload || '.' || encode(extensions.hmac(payload, key, 'sha256'), 'hex');
end $$;

create or replace function public.rl_verify_ticket(p_ticket text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  parts text[];
  key text;
  acc public.rl_accounts;
begin
  parts := string_to_array(coalesce(p_ticket, ''), '.');
  if array_length(parts, 1) <> 3 then return null; end if;
  select ticket_secret into key from public.rl_settings where id = 1;
  if encode(extensions.hmac(parts[1] || '.' || parts[2], key, 'sha256'), 'hex') <> parts[3] then return null; end if;
  if parts[2]::bigint < extract(epoch from now())::bigint then return null; end if;
  select * into acc from public.rl_accounts where id = parts[1]::uuid;
  if acc.id is null or acc.status <> 'approved' then return null; end if;
  return jsonb_build_object('id', acc.id, 'name', acc.display_name, 'is_admin', acc.is_admin, 'loadout', acc.loadout);
end $$;

-- public menu music + custom anthems (no key needed – the files are public)
create or replace function public.rl_public_content()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'menu', (
      select jsonb_build_object(
        'playlist', jsonb_build_object('id', p.id, 'name', p.name, 'mode', p.mode),
        'epoch', s.radio_epoch,
        'songs', coalesce((
          select jsonb_agg(jsonb_build_object('id', so.id, 'title', so.title, 'artist', so.artist, 'path', so.storage_path, 'duration', so.duration) order by ps.position)
          from public.rl_playlist_songs ps join public.rl_songs so on so.id = ps.song_id
          where ps.playlist_id = p.id), '[]'::jsonb))
      from public.rl_settings s join public.rl_playlists p on p.id = s.active_playlist
      where s.id = 1),
    'anthems', coalesce((
      select jsonb_agg(jsonb_build_object('id', so.id, 'title', so.title, 'artist', so.artist, 'path', so.storage_path) order by so.created_at)
      from public.rl_songs so where so.kind = 'anthem'), '[]'::jsonb))
$$;

-- ── admin: players ─────────────────────────────────────────────────────────
create or replace function public.rl_admin_list(p_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.rl__admin(p_secret);
  return coalesce((
    select jsonb_agg(public.rl__json(a) order by (a.status = 'pending') desc, a.created_at desc)
    from public.rl_accounts a), '[]'::jsonb);
end $$;

create or replace function public.rl_admin_set_status(p_secret text, p_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.rl_accounts; acc public.rl_accounts;
begin
  me := public.rl__admin(p_secret);
  if p_status not in ('pending', 'approved', 'denied', 'banned') then raise exception 'bad status'; end if;
  if p_id = me.id and p_status <> 'approved' then raise exception 'You cannot revoke your own access'; end if;
  update public.rl_accounts
     set status = p_status,
         approved_at = case when p_status = 'approved' then coalesce(approved_at, now()) else approved_at end,
         is_admin = case when p_status = 'approved' then is_admin else false end
   where id = p_id returning * into acc;
  return public.rl__json(acc);
end $$;

create or replace function public.rl_admin_set_admin(p_secret text, p_id uuid, p_is_admin boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.rl_accounts; acc public.rl_accounts;
begin
  me := public.rl__admin(p_secret);
  if p_id = me.id and not p_is_admin then raise exception 'You cannot remove your own admin rights'; end if;
  update public.rl_accounts set is_admin = p_is_admin and status = 'approved' where id = p_id returning * into acc;
  return public.rl__json(acc);
end $$;

create or replace function public.rl_admin_rename(p_secret text, p_id uuid, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n text; acc public.rl_accounts;
begin
  perform public.rl__admin(p_secret);
  n := public.rl__valid_name(p_name);
  if exists (select 1 from public.rl_accounts where lower(display_name) = lower(n) and id <> p_id) then
    raise exception 'That name is already taken';
  end if;
  update public.rl_accounts set display_name = n where id = p_id returning * into acc;
  return public.rl__json(acc);
end $$;

create or replace function public.rl_admin_delete(p_secret text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare me public.rl_accounts;
begin
  me := public.rl__admin(p_secret);
  if p_id = me.id then raise exception 'You cannot delete your own account'; end if;
  delete from public.rl_accounts where id = p_id;
end $$;

-- ── admin: music ───────────────────────────────────────────────────────────
create or replace function public.rl_admin_music(p_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.rl__admin(p_secret);
  return jsonb_build_object(
    'songs', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'artist', artist, 'kind', kind, 'path', storage_path, 'duration', duration, 'created_at', created_at) order by created_at desc) from public.rl_songs), '[]'::jsonb),
    'playlists', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'mode', p.mode,
        'songs', coalesce((select jsonb_agg(ps.song_id order by ps.position) from public.rl_playlist_songs ps where ps.playlist_id = p.id), '[]'::jsonb)) order by p.created_at)
      from public.rl_playlists p), '[]'::jsonb),
    'active', (select active_playlist from public.rl_settings where id = 1));
end $$;

create or replace function public.rl_admin_add_song(p_secret text, p_title text, p_artist text, p_path text, p_duration real, p_kind text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare me public.rl_accounts; new_id uuid;
begin
  me := public.rl__admin(p_secret);
  if p_kind not in ('menu', 'anthem') then raise exception 'bad kind'; end if;
  if p_path !~ '^(songs|anthems)/[A-Za-z0-9._\-]+$' then raise exception 'bad path'; end if;
  insert into public.rl_songs (title, artist, kind, storage_path, duration, created_by)
  values (left(btrim(coalesce(p_title, 'Untitled')), 120), left(btrim(coalesce(p_artist, '')), 120), p_kind, p_path, p_duration, me.id)
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.rl_admin_update_song(p_secret text, p_id uuid, p_title text, p_artist text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.rl__admin(p_secret);
  update public.rl_songs set title = left(btrim(coalesce(p_title, 'Untitled')), 120), artist = left(btrim(coalesce(p_artist, '')), 120) where id = p_id;
end $$;

create or replace function public.rl_admin_delete_song(p_secret text, p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare path text;
begin
  perform public.rl__admin(p_secret);
  delete from public.rl_songs where id = p_id returning storage_path into path;
  return path;
end $$;

create or replace function public.rl_admin_save_playlist(p_secret text, p_id uuid, p_name text, p_mode text, p_song_ids uuid[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare pid uuid := p_id; i int;
begin
  perform public.rl__admin(p_secret);
  if p_mode not in ('order', 'shuffle', 'radio') then raise exception 'bad mode'; end if;
  if pid is null then
    insert into public.rl_playlists (name, mode) values (left(btrim(coalesce(p_name, 'Playlist')), 60), p_mode) returning id into pid;
  else
    update public.rl_playlists set name = left(btrim(coalesce(p_name, 'Playlist')), 60), mode = p_mode, updated_at = now() where id = pid;
  end if;
  delete from public.rl_playlist_songs where playlist_id = pid;
  if p_song_ids is not null then
    for i in 1 .. coalesce(array_length(p_song_ids, 1), 0) loop
      insert into public.rl_playlist_songs (playlist_id, song_id, position)
      select pid, p_song_ids[i], i from public.rl_songs where id = p_song_ids[i]
      on conflict do nothing;
    end loop;
  end if;
  -- restart the shared "radio" clock when the live playlist changes
  update public.rl_settings set radio_epoch = now() where id = 1 and active_playlist = pid;
  return pid;
end $$;

create or replace function public.rl_admin_delete_playlist(p_secret text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.rl__admin(p_secret);
  delete from public.rl_playlists where id = p_id;
end $$;

create or replace function public.rl_admin_set_active(p_secret text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.rl__admin(p_secret);
  update public.rl_settings set active_playlist = p_id, radio_epoch = now() where id = 1;
end $$;

-- used by the storage edge function (service role only)
create or replace function public.rl_check_admin(p_secret text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare acc public.rl_accounts;
begin
  acc := public.rl__me(p_secret);
  return acc.id is not null and acc.is_admin and acc.status = 'approved';
exception when others then
  return false;
end $$;

-- ── permissions ────────────────────────────────────────────────────────────
revoke all on function public.rl__hash(text) from public, anon, authenticated;
revoke all on function public.rl__me(text) from public, anon, authenticated;
revoke all on function public.rl__admin(text) from public, anon, authenticated;
revoke all on function public.rl__json(public.rl_accounts) from public, anon, authenticated;
revoke all on function public.rl__valid_name(text) from public, anon, authenticated;
revoke all on function public.rl_check_admin(text) from public, anon, authenticated;
grant execute on function public.rl_check_admin(text) to service_role;

do $$
declare f text;
begin
  foreach f in array array[
    'rl_register(text,text,text)', 'rl_login(text)', 'rl_rerequest(text,text)', 'rl_save_loadout(text,jsonb)',
    'rl_add_stats(text,jsonb)', 'rl_ticket(text)', 'rl_verify_ticket(text)', 'rl_public_content()',
    'rl_admin_list(text)', 'rl_admin_set_status(text,uuid,text)', 'rl_admin_set_admin(text,uuid,boolean)',
    'rl_admin_rename(text,uuid,text)', 'rl_admin_delete(text,uuid)', 'rl_admin_music(text)',
    'rl_admin_add_song(text,text,text,text,real,text)', 'rl_admin_update_song(text,uuid,text,text)',
    'rl_admin_delete_song(text,uuid)', 'rl_admin_save_playlist(text,uuid,text,text,uuid[])',
    'rl_admin_delete_playlist(text,uuid)', 'rl_admin_set_active(text,uuid)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;

-- ── storage bucket for uploaded music (public read; writes via signed URLs) ─
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('rl-music', 'rl-music', true, 52428800,
        array['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/aac',
              'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/webm', 'audio/flac', 'audio/x-flac'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
