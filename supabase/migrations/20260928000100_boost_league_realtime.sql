-- Allow Boost League's private realtime channels (topics prefixed "bl-") for signalling & room presence.
-- The game uses public broadcast channels first and falls back to private ones if the
-- project has "public access" for Realtime switched off.
create policy "bl rooms: read" on realtime.messages for select to anon, authenticated
  using (realtime.topic() like 'bl-%');
create policy "bl rooms: write" on realtime.messages for insert to anon, authenticated
  with check (realtime.topic() like 'bl-%');
