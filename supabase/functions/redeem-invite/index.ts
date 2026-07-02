// redeem-invite — exchange an invite code + display name for a session.
//
// Deploy with JWT verification OFF (the caller is unauthenticated by design):
//   supabase functions deploy redeem-invite --no-verify-jwt
//
// POST { code: string, displayName: string }
//   → 200 { ok, access_token, refresh_token, expires_at, user_id, display_name }
//   → 4xx { error: 'invalid-code' | 'code-already-used' | 'name-taken' | ... }
//
// Identity model: each redeemed code becomes a real auth user with a synthetic
// email + random password (public signups stay disabled). Codes are single-use;
// flipping invite_codes.allow_rebind lets the same code re-bind its existing
// user after a reinstall (password is rotated, identity and shares survive).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_');
}

async function signIn(email: string, password: string) {
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`sign-in failed: ${error?.message}`);
  return data.session;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method-not-allowed' });

  let code = '';
  let displayName = '';
  try {
    const body = await req.json();
    code = String(body.code || '').trim().toUpperCase();
    displayName = String(body.displayName || '').trim().slice(0, 40);
  } catch {
    return json(400, { error: 'bad-json' });
  }
  if (!code) return json(400, { error: 'missing-code' });
  if (!displayName) return json(400, { error: 'missing-display-name' });

  const { data: invite, error: inviteErr } = await admin
    .from('invite_codes')
    .select('id, code, allow_rebind, redeemed_by')
    .eq('code', code)
    .maybeSingle();
  if (inviteErr) return json(500, { error: 'lookup-failed' });
  if (!invite) return json(404, { error: 'invalid-code' });

  // --- reinstall recovery: same code, existing identity, fresh password ----
  if (invite.redeemed_by) {
    if (!invite.allow_rebind) return json(409, { error: 'code-already-used' });
    const { data: userData, error: userErr } = await admin.auth.admin.getUserById(invite.redeemed_by);
    if (userErr || !userData.user?.email) return json(500, { error: 'user-missing' });
    const password = randomPassword();
    const { error: pwErr } = await admin.auth.admin.updateUserById(invite.redeemed_by, { password });
    if (pwErr) return json(500, { error: 'rebind-failed' });
    await admin.from('invite_codes').update({ allow_rebind: false }).eq('id', invite.id);
    const { data: profile } = await admin
      .from('profiles')
      .select('display_name')
      .eq('id', invite.redeemed_by)
      .single();
    try {
      const session = await signIn(userData.user.email, password);
      return json(200, {
        ok: true,
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        user_id: invite.redeemed_by,
        display_name: profile?.display_name ?? displayName,
      });
    } catch {
      return json(500, { error: 'sign-in-failed' });
    }
  }

  // --- fresh redemption ----------------------------------------------------
  const { data: taken } = await admin
    .from('profiles')
    .select('id')
    .ilike('display_name', displayName)
    .maybeSingle();
  if (taken) return json(409, { error: 'name-taken' });

  const email = `u-${crypto.randomUUID()}@users.misracorder.invalid`;
  const password = randomPassword();
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { invite_code: code },
  });
  if (createErr || !created.user) return json(500, { error: 'create-failed' });
  const userId = created.user.id;

  const { error: profileErr } = await admin
    .from('profiles')
    .insert({ id: userId, display_name: displayName });
  if (profileErr) {
    // Roll back the auth user so the code stays cleanly unredeemed.
    await admin.auth.admin.deleteUser(userId);
    const conflict = profileErr.code === '23505';
    return json(conflict ? 409 : 500, { error: conflict ? 'name-taken' : 'profile-failed' });
  }

  // Mark redeemed LAST so any earlier failure leaves the code usable. The
  // `is null` predicate + returned-row check makes the claim atomic: if a
  // concurrent redemption of the same code won the race, this matches zero
  // rows and we roll our identity back instead of minting a second account.
  const { data: claimed, error: redeemErr } = await admin
    .from('invite_codes')
    .update({ redeemed_by: userId, redeemed_at: new Date().toISOString() })
    .eq('id', invite.id)
    .is('redeemed_by', null)
    .select('id');
  if (redeemErr || !claimed?.length) {
    await admin.from('profiles').delete().eq('id', userId);
    await admin.auth.admin.deleteUser(userId);
    return json(redeemErr ? 500 : 409, { error: redeemErr ? 'redeem-failed' : 'code-already-used' });
  }

  try {
    const session = await signIn(email, password);
    return json(200, {
      ok: true,
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
      user_id: userId,
      display_name: displayName,
    });
  } catch {
    return json(500, { error: 'sign-in-failed' });
  }
});
