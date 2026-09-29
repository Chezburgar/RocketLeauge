-- All playlists (with songs) so players can pick what plays in their own main menu.
create or replace function public.rl_public_playlists()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'name', p.name, 'mode', p.mode,
    'songs', coalesce((
      select jsonb_agg(jsonb_build_object('id', so.id, 'title', so.title, 'artist', so.artist, 'path', so.storage_path, 'duration', so.duration) order by ps.position)
      from public.rl_playlist_songs ps join public.rl_songs so on so.id = ps.song_id
      where ps.playlist_id = p.id), '[]'::jsonb)) order by p.created_at), '[]'::jsonb)
  from public.rl_playlists p
$$;
revoke all on function public.rl_public_playlists() from public;
grant execute on function public.rl_public_playlists() to anon, authenticated;
