// Boost League – admin music storage helper.
// Hands out signed upload URLs (and deletes files) for the `rl-music` bucket,
// but only for callers holding an approved admin device key.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: { secret?: string; action?: string; filename?: string; kind?: string; path?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const { data: isAdmin, error: authErr } = await admin.rpc('rl_check_admin', { p_secret: body.secret ?? '' });
  if (authErr || isAdmin !== true) return json({ error: 'admin only' }, 403);

  const bucket = admin.storage.from('rl-music');
  if (body.action === 'sign') {
    const folder = body.kind === 'anthem' ? 'anthems' : 'songs';
    const clean = (body.filename ?? 'track')
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .slice(-80) || 'track';
    const path = `${folder}/${crypto.randomUUID().slice(0, 8)}-${clean}`;
    const { data, error } = await bucket.createSignedUploadUrl(path);
    if (error || !data) return json({ error: error?.message ?? 'could not sign' }, 500);
    return json({ path, token: data.token, signedUrl: data.signedUrl });
  }
  if (body.action === 'delete') {
    const path = body.path ?? '';
    if (!/^(songs|anthems)\/[A-Za-z0-9._-]+$/.test(path)) return json({ error: 'bad path' }, 400);
    const { error } = await bucket.remove([path]);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  return json({ error: 'unknown action' }, 400);
});
