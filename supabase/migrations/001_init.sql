-- Misracorder cloud sharing — full schema.
-- Apply in the Supabase SQL editor (or `supabase db push`).
--
-- Model: invite-code auth (no email). The redeem-invite Edge Function (service
-- role) creates auth users with synthetic credentials; the app talks to
-- PostgREST/Storage with the user's JWT under these RLS policies; the public
-- share Worker reads with the service key (bypasses RLS) and only ever
-- resolves link slugs + signs audio URLs.

create extension if not exists pgcrypto;

-- ============ profiles =====================================================
-- One row per friend. The roster is small (~15 people) and every signed-in
-- user may read it — the share sheet's recipient picker needs it.
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at   timestamptz not null default now()
);
create unique index profiles_display_name_key on public.profiles (lower(display_name));

alter table public.profiles enable row level security;

create policy "profiles: authenticated read all"
  on public.profiles for select to authenticated using (true);

create policy "profiles: update own"
  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
-- (Rows are inserted only by the service-role Edge Function; column grants at
-- the bottom of this file limit users to their own display name.)

-- ============ invite_codes =================================================
-- Deny-all RLS: only the Edge Function (service role) touches this table.
-- allow_rebind: flip to true (SQL) to let a friend who reinstalled log back
-- into their existing identity with the same code.
create table public.invite_codes (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  note         text,
  allow_rebind boolean not null default false,
  redeemed_by  uuid references auth.users(id) on delete set null,
  redeemed_at  timestamptz,
  created_at   timestamptz not null default now()
);
alter table public.invite_codes enable row level security;

-- ============ recordings ===================================================
-- A cloud copy exists only after the owner shares. transcript carries both
-- formats: { format: 'segments'|'plain', text, segments?, speakers? } with
-- per-recording speaker renames already resolved by the app at upload time.
create table public.recordings (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references public.profiles(id) on delete cascade,
  client_id        text not null,          -- the recording's local id in the app
  title            text not null default '',
  duration_sec     numeric not null default 0,
  created_at_local timestamptz,
  uploaded_at      timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  audio_path       text not null,          -- storage key: '{owner_id}/{id}.m4a'
  audio_format     text not null default 'm4a' check (audio_format in ('m4a', 'wav')),
  audio_bytes      bigint,
  channels         int not null default 1,
  transcript       jsonb not null default '{}'::jsonb,
  unique (owner_id, client_id)             -- re-shares upsert, never duplicate
);
create index recordings_owner_idx on public.recordings (owner_id);

alter table public.recordings enable row level security;

create policy "recordings: owner all"
  on public.recordings for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- (The recipient-read policy references shares, so it is created after that
-- table, below.)

-- ============ shares (user-to-user) ========================================
-- owner_id is denormalized from recordings to keep the recordings policy
-- above recursion-free. seen_at is the recipient's server-side unread state.
create table public.shares (
  id           uuid primary key default gen_random_uuid(),
  recording_id uuid not null references public.recordings(id) on delete cascade,
  owner_id     uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  seen_at      timestamptz,
  unique (recording_id, recipient_id)
);
create index shares_recipient_idx on public.shares (recipient_id, revoked_at, created_at desc);
create index shares_recording_idx on public.shares (recording_id);

alter table public.shares enable row level security;

create policy "shares: owner all"
  on public.shares for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "shares: recipient read"
  on public.shares for select to authenticated
  using (recipient_id = auth.uid() and revoked_at is null);

create policy "shares: recipient update own rows"
  on public.shares for update to authenticated
  using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

-- (Column grants at the bottom limit BOTH update policies to the two mutable
-- columns: owners revoke via revoked_at, recipients mark read via seen_at. A
-- recipient flipping revoked_at on their own row only hides it from
-- themselves — harmless.)

-- Recipients read recordings actively shared to them. No RLS recursion: the
-- shares policies above only test auth.uid() columns.
create policy "recordings: recipient read"
  on public.recordings for select to authenticated
  using (exists (
    select 1 from public.shares s
    where s.recording_id = recordings.id
      and s.recipient_id = auth.uid()
      and s.revoked_at is null
  ));

-- ============ link_shares (public web links) ===============================
-- slug is 22 chars of base64url randomness (16 bytes) — unguessable. The
-- anon web viewer never touches PostgREST; the Worker resolves slugs with
-- the service key and re-checks revoked_at on every audio request.
create table public.link_shares (
  id           uuid primary key default gen_random_uuid(),
  recording_id uuid not null references public.recordings(id) on delete cascade,
  owner_id     uuid not null references public.profiles(id) on delete cascade,
  slug         text not null unique,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);
create index link_shares_recording_idx on public.link_shares (recording_id);

alter table public.link_shares enable row level security;

create policy "link_shares: owner all"
  on public.link_shares for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ============ storage ======================================================
-- Private bucket; owners write under their own folder, recipients may read
-- audio of recordings shared to them (authenticated download endpoint). Link
-- viewers get 1-hour signed URLs minted by the Worker.
insert into storage.buckets (id, name, public) values ('audio', 'audio', false);

create policy "audio: owner rw"
  on storage.objects for all to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "audio: recipient read"
  on storage.objects for select to authenticated
  using (bucket_id = 'audio' and exists (
    select 1
    from public.recordings r
    join public.shares s on s.recording_id = r.id
    where r.audio_path = storage.objects.name
      and s.recipient_id = auth.uid()
      and s.revoked_at is null
  ));

-- ============ privileges ===================================================
-- Deterministic grants regardless of environment defaults: hosted projects
-- grant broadly to authenticated by default (which would defeat the column
-- restrictions), while local stacks may grant nothing at all (which would
-- break even the service role). Revoke everything, then grant the minimum.
revoke all on public.profiles, public.invite_codes, public.recordings,
              public.shares, public.link_shares
  from anon, authenticated;

grant all on public.profiles, public.invite_codes, public.recordings,
             public.shares, public.link_shares
  to service_role;

grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select, insert, update, delete on public.recordings to authenticated;
grant select, insert on public.shares to authenticated;
grant update (seen_at, revoked_at) on public.shares to authenticated;
grant select, insert, update on public.link_shares to authenticated;
-- invite_codes: service role only.

-- ============ invite-code generation (run as needed) =======================
-- insert into public.invite_codes (code, note)
-- select 'MISRA-' || upper(substr(md5(random()::text), 1, 4)) || '-' ||
--        upper(substr(md5(random()::text), 1, 4)),
--        'friend ' || i
-- from generate_series(1, 10) i
-- returning code, note;
--
-- Reinstall recovery for a friend:
-- update public.invite_codes set allow_rebind = true where note = 'for Deniz';
