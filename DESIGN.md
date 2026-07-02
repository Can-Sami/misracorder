# Design System — Misracorder

A refined dark capture tool. The surface stays neutral and quiet; a single cobalt/indigo
carries the brand, and one warm color is reserved exclusively for the live recording state.
Color strategy: **Restrained** (tinted-neutral surfaces + one accent).

## Color (OKLCH)

Surfaces are intentionally chroma-0 neutral — the mood lives in the brand color and the
waveform, never in the background (avoids the "warmth in both" AI tell).

```
--bg:          oklch(0.145 0 0)      /* app background, near-black neutral */
--surface:     oklch(0.185 0 0)      /* panels, history list */
--surface-2:   oklch(0.225 0 0)      /* elevated: hover rows, menus */
--border:      oklch(1 0 0 / 0.09)   /* hairline dividers */
--border-strong: oklch(1 0 0 / 0.16)

--ink:         oklch(0.98 0 0)       /* primary text */
--ink-2:       oklch(0.76 0 0)       /* secondary text */
--muted:       oklch(0.64 0 0)       /* tertiary labels (≥4.5:1 on --bg) */

--primary:     oklch(0.62 0.18 262)  /* brand indigo — record control, selection, focus */
--primary-hi:  oklch(0.70 0.17 264)  /* hover / lift */
--primary-soft: oklch(0.62 0.18 262 / 0.14) /* tints, focus rings */
--accent:      oklch(0.74 0.15 264)  /* brighter periwinkle for small highlights */

--live:        oklch(0.66 0.20 22)   /* RECORDING STATE ONLY — coral/red, never decoration */
--live-soft:   oklch(0.66 0.20 22 / 0.16)
--success:     oklch(0.74 0.15 155)
--danger:      oklch(0.64 0.21 25)
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

One family — the macOS system stack (SF Pro). Durations/timestamps use the mono stack with
tabular figures. Fixed rem scale, ratio ≈ 1.2.

```
--font-sans: -apple-system, "SF Pro Text", system-ui, "Segoe UI", sans-serif;
--font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;

--text-xs: 0.75rem;   /* meta labels */
--text-sm: 0.8125rem; /* secondary */
--text-base: 0.9375rem;
--text-lg: 1.0625rem;
--text-xl: 1.375rem;  /* section title */
--text-2xl: 1.75rem;  /* timer while recording */
```

Numerals: `font-variant-numeric: tabular-nums` on all durations and the live timer.

## Spacing & Radius

8px base rhythm (4/8/12/16/20/24/32/40). Radii: `--r-sm: 8px`, `--r-md: 12px`,
`--r-lg: 16px`, `--r-pill: 999px`. Record control is a perfect circle.

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
