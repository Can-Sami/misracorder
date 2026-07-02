# Misracorder

Record audio on your Mac, transcribe it with the Gemini API, and keep everything
organized by date. Native-feeling, calm, and fast.

- Press the orb (or **⌥⌘R** from anywhere) to record; press again to stop.
- A transcript appears next to the saved recording within a couple of seconds, with
  a short **AI-generated title** so it's easy to find.
- **Who-said-what transcripts.** Every voice gets its own label ("Man 1", "Woman 1"),
  shown as colored chips — click a chip to rename the speaker everywhere.
- **Share recordings with friends** who use Misracorder (they get a ping), or with
  anyone via a web link with a player + transcript. Everything stays local until you
  hit Share.
- **Search that just finds things.** Exact matches appear instantly; recordings
  that only *mean* what you typed follow under "More by meaning" — no modes, no
  toggles.
- Filter by date, rename recordings, copy/export transcripts.
- Auto-uses your **headphone mic** when connected, falls back to the built-in mic.
- Optionally records your Mac's **system audio** alongside the mic — great for calls.
- **Updates itself** — new versions download in the background; a *Restart to update*
  pill appears in the title bar when one's ready.
- Recordings + transcripts live in `~/Documents/Misracorder/YYYY/MM/DD/`.

## What's new in 2.0

- **Real speaker diarization.** Transcripts are structured by voice, not just by
  channel: several people on a call (or in the room, on one mic) each get their own
  label — "Man 1", "Woman 1", "Speaker 2" — with a stable identity across long
  recordings. Your own voice keeps your name (Settings → Your name). Click any
  speaker chip in a transcript to rename that voice everywhere; search, copy, and
  export follow the rename. Old recordings upgrade the moment you hit
  **Re-transcribe**.
- **Sharing.** Connect once in **Settings → Sharing** with an invite code, then share
  any recording from its ••• menu: pick friends (it lands in their **Shared with me**
  tab with a dock-badge ping and a notification) and/or flip on a **public link** —
  a clean web page with the player and the speaker-labeled transcript. Revoke a
  share or the link any time; **Remove from cloud** deletes the cloud copy entirely.
  Nothing is uploaded until you share, and your local files remain the source of
  truth. Audio uploads as compact AAC (converted on the fly with macOS's built-in
  encoder).

## What's new in 1.2
- **Automatic system-audio recording.** Install BlackHole once and Misracorder does the
  rest — it routes your audio through it only while recording and restores your output
  the moment you stop (even if the app crashes mid-recording). No Audio MIDI Setup.
- On Bluetooth headphones it records with the built-in mic so your headphones stay hi-fi.

## What's new in 1.1
- AI summary titles (shown in the list); rename anything, your titles stick.
- Speaker labels for calls — set **Settings → Your name**; the other side is labeled
  with the app's name (or "System Sound").
- **Semantic search** toggle (embeddings + cosine similarity).

## Updating
**Misracorder updates itself.** When a new version is published, it downloads
quietly in the background and a small **Restart to update** pill appears in the
title bar — click it whenever you like and the app relaunches on the new version
(or it just applies the next time you quit). No re-downloading DMGs, no
`xattr` dance after the first install. Your recordings, transcripts, and API key
are always kept — they live in `~/Documents/Misracorder` and your user data, not
inside the app.

> The very first install (below) still needs the one-time `xattr -cr` step,
> because the initial `.dmg` isn't notarized by Apple. Every automatic update
> after that is seamless — the app is signed with a stable identity, so macOS
> lets it replace itself in place without prompting.

---

## Install (for sending to a friend)

Send them the file **`dist/Misracorder-1.0.0-universal.dmg`** (works on both Apple
Silicon and Intel Macs, macOS 12+).

On their Mac:

1. **Open the `.dmg`** and drag **Misracorder** into the **Applications** folder.
2. The app isn't notarized by Apple (no paid Developer account), so macOS will
   block it on first open. Open **Terminal** and run this once:
   ```bash
   xattr -cr /Applications/Misracorder.app
   ```
   Then open Misracorder normally (double-click). It opens cleanly every time after.
   *(Alternative: right-click the app → Open → Open. If macOS still says "damaged,"
   use the Terminal command above — it removes the download quarantine flag.)*
3. When prompted, **allow microphone access**.
4. Get a **free Gemini API key** at <https://aistudio.google.com/apikey>, click the
   gear (Settings) in Misracorder, paste the key, and hit **Save**. That's it.

### Optional: record system audio (for calls) — one-time BlackHole install
macOS doesn't let apps capture the computer's audio directly, so Misracorder routes
it through a free virtual audio device called **BlackHole**. You only install it once —
Misracorder handles all the audio routing automatically while you record (and puts your
output back exactly as it was the moment you stop).

1. **Install BlackHole** (2ch) — paste into Terminal:
   ```bash
   brew install blackhole-2ch
   ```
   (or download the installer from <https://existential.audio/blackhole/>). Enter your
   password / approve it in **System Settings → Privacy & Security** if asked.
2. **Restart your Mac** (or run `sudo killall coreaudiod`) so macOS loads BlackHole.
3. Open Misracorder → **Settings**, make sure **Record system audio** is ON, and set
   **Your name**. It should say **"✓ System audio ready."**

That's it. Now when you record, Misracorder captures your mic **and** the computer's
audio and labels who said what (your name vs. the app, e.g. "Microsoft Teams"). You keep
hearing everything normally while recording. No Audio MIDI Setup, no manual switching.

> **Volume keys while recording:** because the app routes audio through a Multi-Output
> Device (which macOS gives no volume control), the hardware volume keys only work during
> a recording if you grant Misracorder **Accessibility** (System Settings → Privacy &
> Security → Accessibility). The first time you record it'll offer to open that page —
> enabling it is optional; without it, just use the app's own volume (Teams/YouTube
> slider). On Bluetooth headphones the mic switches to your Mac's built-in mic for that
> recording so your headphones keep playing in full quality. Everything returns to normal
> the instant you stop.

Don't need it? Turn **Settings → Record system audio** off — the app records your mic.

---

## Sharing setup (owner, one time)

Sharing runs on a free Supabase project plus a tiny Cloudflare Worker for the public
share pages. Friends never see any of this — they just enter an invite code.

1. Create a Supabase project at <https://supabase.com/dashboard>. In
   **Authentication → Sign In / Up**, disable email signups and anonymous sign-ins.
2. Apply the schema: paste `supabase/migrations/001_init.sql` into the SQL editor
   (or `npx supabase link && npx supabase db push`).
3. Deploy the invite function:
   ```bash
   npx supabase functions deploy redeem-invite --no-verify-jwt
   ```
4. Deploy the share page Worker:
   ```bash
   cd worker
   npx wrangler secret put SUPABASE_URL          # https://<project>.supabase.co
   npx wrangler secret put SUPABASE_SERVICE_KEY  # service_role key
   npx wrangler deploy
   ```
5. Bake the deployment into the app: set `SUPABASE_URL`, `ANON_KEY`, and
   `WORKER_BASE` at the top of `src/main/supabase.js` (or export
   `MISRA_SUPABASE_URL` / `MISRA_SUPABASE_ANON_KEY` / `MISRA_SHARE_WORKER` in dev),
   then `npm run dist` and ship the DMG.
6. Generate invite codes in the SQL editor (snippet at the bottom of
   `001_init.sql`) and DM one to each friend. If someone reinstalls, flip their
   code's `allow_rebind` to `true` and they can reconnect with the same code.

## Develop / run from source

```bash
npm install
npm start          # run the app
npm run dev        # run with DevTools
```

## Sharing backend (already deployed)

Sharing runs on a dedicated Supabase project (`nclwfgyxlocxtylozdte`) plus a
Cloudflare Worker, and is **already live** — the URLs and the public anon key
are baked into `src/main/supabase.js` (env `MISRA_SUPABASE_URL` /
`MISRA_SUPABASE_ANON_KEY` / `MISRA_SHARE_WORKER` override them for local dev
against `npx supabase start`).

Architecture: the app talks straight to PostgREST/Storage under RLS with the
user's JWT. Two Edge Functions hold the only privileged access:
`redeem-invite` (exchanges an invite code for an identity) and `share-data`
(resolves a public link slug → metadata + a 1-hour signed audio URL). The
Worker at <https://misracorder-share.can-c5b.workers.dev> just renders the
share page from `share-data` — it holds **no secrets** at all.

Day-2 operations (SQL editor, or `mcp__misracorder__execute_sql`):

```sql
-- more invite codes
insert into invite_codes (code, note)
select 'MISRA-' || upper(substr(md5(random()::text), 1, 4)) || '-' ||
       upper(substr(md5(random()::text), 1, 4)), 'for <name>'
from generate_series(1, 5) returning code;

-- see who redeemed what
select code, note, redeemed_at from invite_codes order by created_at;

-- let a friend who reinstalled reconnect with their same code
update invite_codes set allow_rebind = true where note = 'for <name>';

-- evict a user entirely (cascades their recordings/shares; audio objects
-- need a sweep in Storage afterwards)
delete from auth.users where id = (select id from profiles where display_name = '<name>');
```

Schema changes go through `supabase/migrations/`; the Worker redeploys with
`cd worker && npx wrangler deploy`; Edge Functions via the Supabase MCP or
`npx supabase functions deploy <name> --no-verify-jwt`.

For local sharing development: `npx supabase start` boots a full local stack
(Docker), then run the app with the `MISRA_*` env vars pointing at it.

## Build the distributable

```bash
npm run icon       # regenerate the app icon (build/icon.png) from build/icon.html
npm run dist       # build a signed dist/Misracorder-<version>-universal.dmg (+ .zip)
```

Builds are **code-signed** with a local self-signed identity ("Misracorder
Signing"). This is what makes auto-update work and stops macOS re-asking for the
microphone on every new build. One-time setup on this Mac:

```bash
# Trust the bundled signing cert for code signing (approve the keychain prompt):
security add-trusted-cert -r trustRoot -p codeSign \
  -k ~/Library/Keychains/login.keychain-db build/misra-signing.crt
# Verify it's usable — should list "Misracorder Signing":
security find-identity -v -p codesigning
```

## Publishing a new version (auto-update)

Auto-update is wired to **GitHub Releases** on the public
[`Can-Sami/misracorder`](https://github.com/Can-Sami/misracorder) repo. To ship an
update everyone gets automatically:

```bash
# 1. bump the version
npm version patch          # or: minor / major  (edits package.json, tags the commit)
# 2. build, sign, and publish the release in one step
npm run release            # electron-builder --mac -p always, GH_TOKEN from `gh auth token`
```

`npm run release` builds the universal `.dmg` + `.zip`, generates `latest-mac.yml`,
and uploads them to a new GitHub release. Running copies of Misracorder poll that
repo, download the update in the background, and show the **Restart to update**
pill. That's the whole loop — you never hand out a DMG again after the first one.

> **First install only:** friends still need the initial `.dmg` (see *Install*
> above) with the one-time `xattr -cr`. Every release after that updates itself.

### Fully frictionless distribution (optional)
To drop the first-install `xattr -cr` too, sign + notarize with an Apple Developer
ID ($99/yr). Swap `mac.identity` for your "Developer ID Application" cert and add an
electron-builder `afterSign` notarize step. Auto-update keeps working either way.

## Privacy
Your Gemini API key is encrypted at rest on your Mac (Electron `safeStorage`), and so
is your sharing identity. Audio is sent to Google's Gemini API only to produce the
transcript. Recordings never leave your Mac unless you explicitly share one — a share
uploads that recording (as AAC) and its transcript to the owner's Supabase project,
and "Remove from cloud" deletes the copy again. Public links are unguessable and
revocable; revoked links stop serving audio immediately.
