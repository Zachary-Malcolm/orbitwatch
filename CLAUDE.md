# OrbitWatch: handoff notes for Claude

Live 3D tracker of every active satellite (~16,000) plus ~2,700 debris fragments, styled as a 1980s
amber-phosphor surveillance terminal. Vite + TypeScript + Three.js + satellite.js, no framework, no backend.

- Live: https://zachary-malcolm.github.io/orbitwatch/ · Repo: https://github.com/Zachary-Malcolm/orbitwatch
- **README.md is the full reference**: features, file-by-file map, and how each algorithm works. Read it first.
- Owner: Zach (GitHub `Zachary-Malcolm`). This is a **CV/portfolio project**, so code quality, honesty and
  presentation matter as much as features.

## Commands

```bash
npm run dev       # dev server (the app fetches CelesTrak directly in dev)
npm run build     # tsc + vite build (production base path is /orbitwatch/)
npm test          # Vitest unit tests for the maths (test/), ~1 s
npm run typecheck # tsc --noEmit (includes the tests)
npm run capture   # regenerate README media in docs/media from the live site (drives local Chrome)
```

GitHub Actions runs typecheck + tests on every push (`.github/workflows/ci.yml`), and the deploy workflow
won't publish if tests fail. Tests compare against independent answers (published reference values or a
brute-force search), not against the code's own output; keep it that way. Maths is kept in plain exported
functions so it can be tested without a browser (e.g. `screen()` in `src/screening.ts`, which
`conjunctionWorker.ts` just wraps; `coverageAngle()`, `tileBounds()`, `parseTle()`).

## Deploy

Pushing to `main` deploys to GitHub Pages (`.github/workflows/deploy.yml`). The workflow also runs every
3 hours to refresh `public/data/` (git-ignored): a mirror of CelesTrak's active catalogue and debris
groups. The production app reads that mirror, because CelesTrak returns 403 to any IP that re-downloads
a group within 2 hours. **Don't fetch CelesTrak groups repeatedly while testing**; the dev app caches them
in the browser's Cache API for 2 hours.
`scripts/mirror-celestrak.sh` does the mirroring: it reuses the site's published copy if it is under 2 hours
old (so several pushes in a row don't re-download) and every request has a time limit. It can be tested
without touching CelesTrak by pointing `PAGES_URL` / `CELESTRAK_URL` at a local server.

## Rules the owner cares about

- **Colour has meaning; keep it that way.** Amber `#ffb000` (P3 phosphor) = the terminal's own UI.
  Green `--p1` = gauges/progress bars. Warm white `--p4` = control buttons (chrono, quick targets,
  observer). Blue `--feed` = news from outside sources. Red `--warn` = warnings and the locked target
  (Release target). Orange `#ff7a2e` = Copy link. Satellite categories have their own palette in
  `CATEGORIES` (`src/satellites.ts`) with glyph shapes as a second cue. New colours must fit the
  phosphor theme, never random.
- **Phosphor mode** is a post-process in `src/scene.ts` that turns the frame amber. Anything that must keep
  its own colour renders with alpha `PASSTHROUGH_ALPHA` and `NoBlending` (satellite glyphs, ground track,
  observer marker); near-pure red also passes through.
- **Gauges show real measured data only**, never randomised values. The boot screen (`src/ui/boot.ts`) follows
  the same rule: its pacing is theatre, but each log line reports a real result (fed by `bootReport()`), and
  the bar holds short of 100% until the catalogue has actually loaded.
- **Sound** (`src/ui/sound.ts`) is synthesised, on by default at medium volume (silent until the first click; `[♪]` cycles low/med/high/off), and must stay retro: square/triangle waves and
  filtered noise through the warm low-pass. New interactive controls get a click automatically (document-level
  listener); add switches to the toggle selector there.
- **Announced state changes** (eclipse entry/exit, AOS/LOS) must ignore clock jumps: compare `clockJumps()` from
  `src/ui/clock.ts` so a jump to another moment isn't logged or sounded as if it happened.
- **Privacy:** the observer location stays in localStorage only. Never send it anywhere or put it in URLs.
  (The only other things stored are whether the guide has been seen and the sound on/off setting.)
- **Honesty in the UI:** representative images and models are labelled as such; miss distances are
  flagged as indicative (TLE accuracy is ~1 km).
- **Desktop layout is final: don't change it.** Phone work goes inside the `max-width: 900px` rules only.
- **Phones (≤900px, `src/ui/mobile.ts`):** the globe fills the screen above a tab bar (TARGET · LAYERS · FIND ·
  TIME · MORE); panels are moved into a bottom sheet (half / nearly full, drag the grip) and back to their
  columns on wider screens, so find panels by class (`.mod.layers`), not by column. A chip on the globe shows
  the locked target with release; locking closes the sheet; dossier sections fold (Briefing/News/Approaches
  start folded). The timeline sits on the globe.
- Explain things in plain terms; Zach is learning. Confirm before anything public-facing (repo settings,
  publishing). Commit and push completed work (the repo auto-deploys).

## Code notes

- `tsconfig` has `erasableSyntaxOnly`: **no constructor parameter properties** (declare fields and assign).
- UI code lives in `src/ui/`, one module per panel, each with an `init…()` that `src/main.ts` calls in order
  (main.ts also runs the frame loop and boot). Shared scene objects and state (`app.layer` etc.) are in
  `src/ui/context.ts`. Modules import each other's functions freely; keep top-level code to declarations
  and do wiring inside `init…()` so import order never matters.
- Verify in the browser preview with **text/DOM checks first** and few screenshots (they are costly).
  A dev-only `window.debug` exposes `globe`, `models`, `getLayer()` and `getConj()`.
- Commit messages end with a `Co-Authored-By: Claude …` line (shows Claude as a GitHub contributor).
  Zach may want this dropped; ask if unsure.

## Next steps (agreed priority)

1. ~~Tests + CI~~ (done 2026-09-21: 39 tests, CI workflow, README badge and Testing section).
2. ~~Split `main.ts`~~ (done 2026-09-22: `src/ui/`, main.ts 1,236 → 126 lines).
3. **Lighter on phones:** run close-approach screening only when the APPROACHES tab is opened (or on idle),
   use fewer workers on mobile, and consider fewer imagery tiles.
4. ~~Onboarding~~ (done 2026-09-22: `src/ui/tour.ts`; welcome card with START / NOT NOW / DON'T SHOW AGAIN,
   8 steps, ends by offering to lock the ISS; skipped for `#norad=` links; `[?]` replays; remembered via
   localStorage `orbitwatch.tour`). If panels are added or renamed, update the steps in `STEPS`.
5. **Validate passes** against Heavens-Above or N2YO for the ISS; note it in the README.
6. **Launch tracker** (next headline feature): Launch Library 2 (`ll.thespacedevs.com/2.3.0`, 15 req/hour
   free, so mirror or cache it), countdown, launch-pad markers, launch alert pop-up with the YouTube stream
   in a CRT window, then highlight new objects from CelesTrak's `last-30-days` group.
7. Later: spacewalk/docking events on the ISS dossier; NOAA space-weather (Kp) gauge.
