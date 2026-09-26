# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Changed

- **Time-based display rotation.** The displayed item used to rotate every
  `interval` blocks (default 30, ~90 s). Because `pollBlock()` drains the whole
  missed-block backlog in one fast burst on each tick, that rule rotated the
  display many times in quick succession whenever the widget caught up (e.g.
  after a hidden tab). Rotations are now gated on wall-clock time via the new
  `displayIntervalMs` option (default `90000`), so the cadence is a true ~90 s
  no matter how many blocks are processed at once. The two-phase `changePost`
  flag was removed in favour of the time gate.
- **Per-origin shared state.** Added a new `scope` option (`'page'` default |
  `'origin'`). When set to `'origin'`, the persisted `localStorage` state is
  keyed by host only (not host+path), so all pages on the same host share one
  pool/display and the widget stays consistent when navigating between pages
  (e.g. portfolio search → leaderboard → home).
- **Bounded catch-up and a slower poll cadence (RPC-load reduction).**
  `pollBlock()` now drains at most `maxBlocksPerPass` (default `100`) blocks per
  tick instead of the entire backlog in one burst. Firing one
  `get_ops_in_block` per block in a single pass was tripping node rate limiting
  ("upstream temporarily unavailable"); catch-up now simply resumes on the next
  tick. The default `pollMsBehind` is raised from `1000` to `3000` ms to match
  Steem's ~3 s block time, cutting steady-state `get_dynamic_global_properties`
  traffic by roughly two thirds.

### Fixed

- Fixed the widget **falling behind the chain when the browser tab loses
  focus**. The previous approach relied on the assumption that background
  `setInterval` is only throttled to ~1s, but modern browsers throttle
  hidden-tab timers far harder (Chrome "intensive throttling" drops them to
  ~1/minute, and some engines pause them entirely). Because `pollBlock()`
  advanced the block cursor by only **one** block per poll, `currentBlock` and
  the candidate pools permanently lagged the chain while unfocused.
  `pollBlock()` now drains the entire missed-block gap in a single pass on each
  tick, so any poll that fires — even a heavily throttled background tick —
  fully catches back up to the last irreversible block.
- Added a `visibilitychange` / `pageshow` listener so the widget immediately
  catches up the moment the tab regains focus (including bfcache restores),
  instead of waiting for the next interval tick.
- Fixed the **display failing to rotate (~90 s) while catching up during
  upstream errors**. A single transient `get_ops_in_block` failure used to abort
  the whole catch-up pass *and* skip the display rotation, because the catch-up
  rotation gate was a per-tick local and the final `displayCycle()` sat inside
  the aborted `try`. Rotation is now gated on the persistent
  `state.lastDisplayTime`; `displayCycle()` is always attempted in a `finally`
  block; and each block fetch is retried (`BLOCK_RETRIES`, `BLOCK_RETRY_MS`)
  with backoff, so a persistent failure pauses catch-up (leaving
  `lastBlockChecked` untouched) instead of crashing the pass.

## [0.2.0] - 2026-08-12

### Changed

- Reworked blockchain polling from a recursive `setTimeout` to a fixed
  `setInterval` loop. Because browsers throttle **chained** timers aggressively
  in background tabs (down to ~1/min in Chrome after ~5 min), the widget now
  uses a top-level interval that is only throttled to ~1s while unfocused.
  This keeps the candidate pools filling and old entries aging out even when
  the tab is not in focus.
- `trimExpired()` now runs on every poll tick (not just on the 30-block display
  cycle) so expired items are aged out continuously.
- Removed the now-unused `pollMsCaughtUp` config option; `pollMsBehind` is the
  single fixed poll interval.

## [0.1.0] - 2026-08-12

### Added

- Initial drop-in VAAS (Visibility as a Service) widget.
- Nominally a dependency-free port of the `VAAS_SELECTION_LOGIC.md` selection
  algorithm shared by `steemometer-web` and `phoenix-prime`.
- Self-contained IIFE exposing `window.VAAS` with `init`, `mount`, `unmount`,
  and `refresh` methods.
- Generates its own scoped DOM inside any host container — no host IDs required.
- Themeable stylesheet (`vaas.css`) driven by `var(--vaas-*, …)` fallback
  chains that auto-adopt a host project's design tokens.
- Namespaced `localStorage` shared-state persistence so the widget survives
  reloads and stays isolated per host page.
- `demo.html` harness, `README.md`, and MIT `LICENSE`.
