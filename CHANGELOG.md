# Changelog

All notable changes to this project are documented in this file.

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