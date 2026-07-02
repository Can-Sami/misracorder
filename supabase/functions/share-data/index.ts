// share-data — resolve a public share slug for the web share page.
//
// Deployed with JWT verification OFF: the unguessable slug (22 chars of
// randomness, checked against link_shares with revocation) IS the credential,
// exactly like the share URL itself. This keeps the service role inside
// Supabase — the Cloudflare Worker that renders the page holds no secrets.
//
// GET ?slug=<slug>
//   → 200 { status:'ok', owner, recording:{...}, signedUrl }   (signedUrl: 1h)
//   → 404 { status:'missing' } | 410 { status:'revoked' } | 500 { status:'error' }

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'GET') return json(405, { status: 'error' });
  const slug = new URL(req.url).searchParams.get('slug') || '';
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(slug)) return json(404, { status: 'missing' });

  const { data: link, error } = await admin
    .from('link_shares')
    .select(
      'revoked_at, recording:recordings(title, duration_sec, created_at_local, transcript, audio_format, audio_path, owner:profiles(display_name))'
    )
    .eq('slug', slug)
    .maybeSingle();
  if (error) return json(500, { status: 'error' });
  if (!link || !link.recording) return json(404, { status: 'missing' });
  if (link.revoked_at) return json(410, { status: 'revoked' });

  const rec = link.recording as Record<string, unknown>;
  const { data: signed, error: signErr } = await admin.storage
    .from('audio')
    .createSignedUrl(rec.audio_path as string, 3600);
  if (signErr || !signed?.signedUrl) return json(500, { status: 'error' });

  return json(200, {
    status: 'ok',
    owner: (rec.owner as Record<string, string> | null)?.display_name || '',
    recording: {
      title: rec.title,
      durationSec: Number(rec.duration_sec) || 0,
      recordedAt: rec.created_at_local,
      audioFormat: rec.audio_format,
      transcript: rec.transcript,
    },
    signedUrl: signed.signedUrl,
  });
});
