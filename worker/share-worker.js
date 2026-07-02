// Misracorder share page — a single-file Cloudflare Worker.
//
//   GET /s/:slug  → player + transcript page (404 unknown, 410 revoked)
//   GET /a/:slug  → re-check revocation, then 302 to a 1h signed audio URL
//
// Secrets (wrangler secret put …): SUPABASE_URL, SUPABASE_SERVICE_KEY.
// The service key never leaves the Worker; it only resolves link slugs and
// signs storage URLs. Revocation bites on every audio fetch: the <audio> src
// always points at /a/:slug, so a revoked link stops playing as soon as the
// browser's buffer runs out.

const HUES = [210, 160, 305, 95, 340, 250];
const USER_HUE = 264;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [, route, slug] = url.pathname.split('/');
    if (request.method !== 'GET' || !slug || !/^[A-Za-z0-9_-]{10,64}$/.test(slug)) {
      return page(404, 'Not found', 'Nothing lives at this address.');
    }
    if (route === 's') return sharePage(slug, env);
    if (route === 'a') return audioRedirect(slug, env);
    return page(404, 'Not found', 'Nothing lives at this address.');
  },
};

async function lookupSlug(slug, env, columns) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/link_shares?slug=eq.${encodeURIComponent(slug)}&select=${encodeURIComponent(columns)}&limit=1`,
    { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
  );
  if (!res.ok) throw new Error(`postgrest ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function sharePage(slug, env) {
  let row;
  try {
    row = await lookupSlug(
      slug,
      env,
      'revoked_at,recording:recordings(title,duration_sec,created_at_local,transcript,owner:profiles(display_name))'
    );
  } catch {
    return page(502, 'Temporarily unavailable', 'Try again in a moment.');
  }
  if (!row || !row.recording) return page(404, 'Not found', 'This link doesn’t point to a recording.');
  if (row.revoked_at) return page(410, 'No longer available', 'This shared recording has been taken back by its owner.');

  const rec = row.recording;
  const title = esc(rec.title || 'Untitled recording');
  const owner = esc(rec.owner?.display_name || 'Someone');
  const when = rec.created_at_local
    ? new Date(rec.created_at_local).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';
  const dur = fmtDuration(rec.duration_sec);
  const meta = [owner, when, dur].filter(Boolean).join(' · ');

  const body = `
  <header>
    <div class="mark">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 12c1.6 0 1.6-4 3.2-4s1.6 8 3.2 8 1.6-7 3.2-7 1.6 5 3.2 5 1.6-3 1.9-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Misracorder
    </div>
    <h1>${title}</h1>
    <p class="meta">${esc(meta)}</p>
  </header>
  <audio controls preload="metadata" src="/a/${esc(slug)}"></audio>
  <main>${transcriptHtml(rec.transcript)}</main>
  <footer>Shared with Misracorder</footer>`;

  return page(200, title, body, true);
}

async function audioRedirect(slug, env) {
  let row;
  try {
    row = await lookupSlug(slug, env, 'revoked_at,recording:recordings(audio_path)');
  } catch {
    return new Response('temporarily unavailable', { status: 502 });
  }
  if (!row || !row.recording) return new Response('not found', { status: 404 });
  if (row.revoked_at) return new Response('gone', { status: 410 });

  const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/sign/audio/${row.recording.audio_path}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!res.ok) return new Response('audio unavailable', { status: 502 });
  const { signedURL } = await res.json();
  return new Response(null, {
    status: 302,
    headers: { Location: `${env.SUPABASE_URL}/storage/v1${signedURL}`, 'Cache-Control': 'no-store' },
  });
}

// --- transcript rendering ----------------------------------------------------

function transcriptHtml(payload) {
  if (!payload || (!payload.text && !Array.isArray(payload.segments))) {
    return '<p class="empty">No transcript came with this recording.</p>';
  }
  if (payload.format === 'segments' && Array.isArray(payload.segments)) {
    const hues = new Map();
    let i = 0;
    for (const s of payload.speakers || []) hues.set(s.label, s.isUser ? USER_HUE : HUES[i++ % HUES.length]);
    const turns = [];
    for (const seg of payload.segments) {
      if (!seg || !seg.text) continue;
      const last = turns[turns.length - 1];
      if (last && last.speaker === seg.speaker) last.texts.push(seg.text);
      else turns.push({ speaker: seg.speaker || 'Speaker', texts: [seg.text] });
    }
    if (turns.length) {
      return turns
        .map((t) => {
          if (!hues.has(t.speaker)) hues.set(t.speaker, HUES[i++ % HUES.length]);
          return `<div class="turn" style="--h:${hues.get(t.speaker)}"><span class="chip">${esc(t.speaker)}</span><p>${esc(t.texts.join(' '))}</p></div>`;
        })
        .join('');
    }
  }
  // Plain transcript: bold a leading "Name:" label per line when present.
  return (payload.text || '')
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const m = /^(.{1,40}?):\s+(.*)$/.exec(line);
      return m
        ? `<p class="line"><b>${esc(m[1])}</b> ${esc(m[2])}</p>`
        : `<p class="line">${esc(line)}</p>`;
    })
    .join('');
}

// --- chrome -------------------------------------------------------------------

function page(status, title, body, isFull = false) {
  const content = isFull
    ? body
    : `<header><div class="mark"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 12c1.6 0 1.6-4 3.2-4s1.6 8 3.2 8 1.6-7 3.2-7 1.6 5 3.2 5 1.6-3 1.9-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>Misracorder</div><h1>${esc(title)}</h1><p class="meta">${esc(body)}</p></header>`;
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${esc(title)} — Misracorder</title>
<style>
  :root {
    --bg: oklch(0.14 0.006 264);
    --surface: oklch(0.185 0.007 264);
    --border: oklch(1 0 0 / 0.09);
    --ink: oklch(0.97 0 0);
    --ink-2: oklch(0.76 0.01 264);
    --muted: oklch(0.63 0.012 264);
    --primary: oklch(0.62 0.17 264);
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    font: 0.9375rem/1.65 -apple-system, "SF Pro Text", system-ui, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--ink);
    -webkit-font-smoothing: antialiased;
    max-width: 40rem;
    margin: 0 auto;
    padding: 48px 24px 64px;
  }
  header { margin-bottom: 28px; }
  .mark {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 0.8125rem; font-weight: 600; color: var(--muted);
    margin-bottom: 22px;
  }
  .mark svg { color: var(--primary); }
  h1 { font-size: 1.375rem; font-weight: 650; letter-spacing: -0.01em; }
  .meta { margin-top: 6px; font-size: 0.8125rem; color: var(--muted); }
  audio { width: 100%; margin: 4px 0 30px; }
  .turn { margin-bottom: 18px; }
  .chip {
    display: inline-block; padding: 1px 9px; border-radius: 999px;
    font-size: 0.71875rem; font-weight: 600; letter-spacing: 0.01em;
    color: oklch(0.8 0.1 var(--h, 210));
    background: oklch(0.65 0.13 var(--h, 210) / 0.14);
    margin-bottom: 4px;
  }
  .turn p, .line { color: var(--ink-2); }
  .line { margin-bottom: 10px; }
  .line b { color: var(--ink); font-weight: 600; }
  .empty { color: var(--muted); }
  footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 0.75rem; color: var(--muted); }
</style>
</head>
<body>${content}</body>
</html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
      },
    }
  );
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
