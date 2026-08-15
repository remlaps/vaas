# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Changed

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