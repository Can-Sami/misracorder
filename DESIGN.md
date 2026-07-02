# Design System — Misracorder

A calm capture tool with a paper soul. Surfaces are warm quiet neutrals (soft
near-black at night, true warm paper in the light theme); a single cobalt/indigo
carries the brand; a native serif (New York) carries titles, day headers, and
transcript prose; one warm coral is reserved exclusively for the live recording
state. Color strategy: **Restrained** (warm-tinted neutrals + one accent).

## Color (OKLCH)

Surfaces carry a whisper of warmth (C ≈ 0.005–0.016 toward hue ~84–96, the
paper band) — the calm comes from the material, the energy from the brand
color and the waveform.

```
DARK (default)
--bg:          oklch(0.205 0.006 84)   /* soft warm near-black — a room, not a void */
--surface:     oklch(0.24 0.007 84)
--surface-2:   oklch(0.285 0.009 84)
--ink:         oklch(0.955 0.005 84)
--ink-2:       oklch(0.79 0.009 84)
--muted:       oklch(0.66 0.011 84)    /* ≥4.5:1 on --bg */

LIGHT (true warm paper)
--bg:          oklch(0.953 0.013 96)
--surface:     oklch(0.985 0.006 96)
--surface-2:   oklch(0.922 0.016 96)
--ink:         oklch(0.28 0.009 84)

BOTH
--primary:     oklch(0.62 0.17 264)  /* brand indigo — record control, selection, focus */
--live:        oklch(0.66 0.20 22)   /* RECORDING STATE ONLY — coral, never decoration */
--success / --danger as in styles.css
```

### Speaker hues (diarized transcripts)

Each speaker chip completes a fixed L/C pair (`--sp-text`, `--sp-fill`, re-tuned per
theme) with a per-speaker hue. "You" is always the brand hue **264**; other voices
draw, in roster order, from a curated wheel that stays clear of the reserved coral
band: **210 · 160 · 305 · 95 · 340 · 250**. Hue is identity, never decoration — the
same speaker keeps the same hue for the life of a recording.

Contrast: --ink and --ink-2 clear 4.5:1 on --bg and --surface; --muted is the floor at
~4.5:1, used only for small non-body labels (dates, durations).

## Typography

Two voices on a contrast axis:

- **UI voice** — the macOS system sans (SF Pro): labels, buttons, entries,
  settings, chips, all controls.
- **Reading voice** — the macOS system serif (`ui-serif` / New York): the
  wordmark (italic), "Press to record", day group headers (italic), recording
  titles, sheet titles, empty-state titles, and transcript prose. Serif never
  appears on buttons, labels, or data.

Durations/timestamps use the mono stack with tabular figures.

```
--font-sans:  -apple-system, "SF Pro Text", system-ui, "Segoe UI", sans-serif;
--font-serif: ui-serif, "New York", Georgia, "Times New Roman", serif;
--font-mono:  ui-monospace, "SF Mono", Menlo, monospace;

--text-xs: 0.75rem;    /* meta labels */
--text-sm: 0.8125rem;  /* secondary */
--text-base: 0.9375rem;
--text-lg: 1.0625rem;  /* transcript prose (serif) */
--text-xl: 1.375rem;   /* hero hint (serif) */
--text-2xl: 1.75rem;   /* timer while recording */
```

Numerals: `font-variant-numeric: tabular-nums` on all durations and the live timer.

## Spacing & Radius

8px base rhythm (4/8/12/16/20/24/32/40). Radii: `--r-sm: 9px`, `--r-md: 14px`,
`--r-lg: 20px`, `--r-pill: 999px` — generous and soft. Record control is a
perfect circle.

## Motion

150–250 ms, ease-out (cubic-bezier(0.22, 1, 0.36, 1)). Motion conveys state only.

- **Record control states:** idle (indigo filled circle, mic glyph) → recording (morphs to
  rounded-square stop, soft `--live` glow, gentle breathing pulse) → transcribing (indigo
  ring shimmer). Crossfade between states.
- **Live waveform:** real-time amplitude bars driven by mic RMS; smooth, organic, centered.
- **History rows:** subtle stagger on first paint; hover lifts to --surface-2 in 150 ms.
- **prefers-reduced-motion:** waveform becomes a static level bar; pulses become opacity
  steps; all transitions collapse to instant/crossfade.

## Layout

Single window (~880×620, resizable, min 640×480). Two zones:
- **Stage** (top, generous whitespace): the record control centered, live timer + waveform
  while recording, the active mic device selector as a quiet pill.
- **History** (lower / side): date-grouped list (Today / Yesterday / month-day headers).
  Selecting a recording opens its transcript in a calm reading panel with copy + reveal-in-
  Finder actions. Empty state teaches the one gesture: "Press record to start."
