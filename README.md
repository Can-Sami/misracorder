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
- **Search** by keyword, or flip on **Semantic** search to find recordings by meaning.
- Filter by date, rename recordings, copy/export transcripts.
- Auto-uses your **headphone mic** when connected, falls back to the built-in mic.
- Optionally records your Mac's **system audio** alongside the mic — great for calls.
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

## Updating to a new version
Just open the new `.dmg`, drag **Misracorder** into **Applications**, and replace the
old one. Your recordings, transcripts, and API key are kept (they live in
`~/Documents/Misracorder` and your user data, not inside the app). Re-run the
`xattr -cr` step below after replacing.

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

For local sharing development: `npx supabase start` boots a full local stack
(Docker), then run the app with the `MISRA_*` env vars pointing at it.

## Build the distributable

```bash
npm run icon       # regenerate the app icon (build/icon.png) from build/icon.html
npm run dist       # build dist/Misracorder-<version>-universal.dmg
```

### Fully frictionless distribution (optional)
To ship with **zero** Gatekeeper warnings, sign + notarize with an Apple Developer ID
($99/yr Apple Developer account). Set `mac.identity` to your "Developer ID Application"
cert in `package.json` and add an electron-builder `afterSign` notarize step. Without
that, the one-time `xattr -cr` above is the simplest path.

## Privacy
Your Gemini API key is encrypted at rest on your Mac (Electron `safeStorage`), and so
is your sharing identity. Audio is sent to Google's Gemini API only to produce the
transcript. Recordings never leave your Mac unless you explicitly share one — a share
uploads that recording (as AAC) and its transcript to the owner's Supabase project,
and "Remove from cloud" deletes the copy again. Public links are unguessable and
revocable; revoked links stop serving audio immediately.
