# Changelog

All notable changes to this project are documented in this file.

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