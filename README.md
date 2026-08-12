# VAAS — Visibility as a Service (drop-in widget)

A self-contained, dependency-free web widget that implements the [VAAS selection logic](VAAS_SELECTION_LOGIC.md) shared by `steemometer-web` and `phoenix-prime`. Drop it into **any** JavaScript project and it will:

- Poll the Steem blockchain in real time for two kinds of `@null` content:
  1. **Null-beneficiary posts** — posts whose `comment_options` give a cut to the `null` account (authors "burning" a portion of rewards), subject to quality gates.
  2. **Promotional transfers / vanity broadcasts** — `transfer`s to `null` with a non-blank memo.
- Rotate between those two pools with **age-decayed, weighted-random** selection (weight halves every ~1 hour, items expire after ~1 day).
- Refresh every 30 blocks (~90 s) with a heat-scale border and animated scrolling title.
- **Adopt the look & feel of the host project** via CSS custom-property fallback chains.

## Quick start

```html
<!-- 1. Style -->
<link rel="stylesheet" href="vaas.css">

<!-- 2. Script -->
<script src="vaas.js"></script>

<!-- 3. A container (position anywhere — header, footer, sidebar) -->
<div id="vaas"></div>

<!-- 4. Mount -->
<script>
  VAAS.init().mount('#vaas');
</script>
```

That's it. `mount()` builds the entire widget DOM itself — it never requires or touches any element IDs from your app.

Try the included harness: `demo.html` (open it directly in a browser).

## API

### `VAAS.init(config)`
Store default configuration for the widget. Returns `this`, so it chains with `mount()`.
All options are optional; the second argument to `mount()` can also override per-mount.

| Option                 | Default                  | Meaning |
|------------------------|--------------------------|---------|
| `nodeUrl`              | `https://api.steemit.com` | Steem JSON-RPC node |
| `urlLeft`              | `https://steemit.com`     | Frontend used for click-through links |
| `interval`             | `30`                      | Blocks between content refreshes |
| `halflifeBlocks`       | `1200`                    | Weight halves this often (~1 h) |
| `maxlifeBlocks`        | `28800`                   | Item expiry (~1 day) |
| `minRep`               | `45.0`                    | Minimum author reputation (Pool A gate) |
| `minFollowers`         | `20`                      | Minimum follower count (Pool A gate) |
| `minMedFollowerRep`    | `35.0`                    | Minimum median follower rep (Pool A gate) |
| `pollMsBehind`         | `1000`                    | Poll delay while catching up |
| `pollMsCaughtUp`       | `3000`                    | Nominal poll delay |
| `position`             | `'inline'`                | `'inline'` fills its container; `'fixed'` sticks to the bottom |
| `storageKey`           | `null`                    | Override the auto-namespaced `localStorage` key |
| `theme`                | `null`                    | Object of explicit theme values (see Theming) |
| `onDisplay`            | `null`                    | Callback invoked with each rendered display payload |

### `VAAS.mount(target, overrides)`
Build and start the widget inside `target` (a CSS selector string or a DOM element). Starts polling and the refresh cycle. Calling while already mounted logs a warning and returns.

### `VAAS.unmount()`
Stop polling, remove generated DOM and any injected theme `<style>`.

### `VAAS.refresh()`
Force an immediate display cycle (e.g. from a "refresh" button).

## Theming — take on the host's look & feel

`vaas.css` declares every color and size as a **fallback chain**:

```css
.vaas-section {
  background: var(--vaas-bg, var(--bg-secondary, rgba(30,41,59,.85)));
  color:      var(--vaas-text, var(--text-primary, #f8fafc));
  border: 1px solid var(--vaas-border, var(--glass-border, rgba(255,255,255,.1)));
  border-radius: var(--vaas-radius, .75rem);
}
```

The widget **never sets a `font-family` or base size**, so it inherits the host's
typography and `rem` scale. If your project already defines tokens such as
`--bg-secondary`, `--text-primary`, `--text-muted`, `--accent-primary`,
`--glass-border`, `--card-bg`, they are picked up **automatically** — no config.

### Explicit theme object

For full control, pass a `theme` object. Values are injected as a small `<style>`
block that overrides everything:

```js
VAAS.init({
  theme: {
    bg: '#0f172a',
    text: '#f8fafc',
    muted: '#94a3b8',
    accent: '#3b82f6',
    cardBg: 'rgba(30,41,59,.7)',
    border: 'rgba(255,255,255,.1)',
    radius: '12px',
    heat: ['#ff6400', '#ff6400', '#ff8040', '#ff8040', '#ff8040',
           '#fd9800', '#fd9800', '#fd9800', '#00fde4', '#00fde4', '#3284ff']
  }
}).mount('#vaas');
```

You can also override individual tokens on the page itself by setting `--vaas-*`
CSS variables, e.g. `#vaas { --vaas-bg: #1a1a2e; }`.

## How it works

1. Reads the current chain head (`get_dynamic_global_properties`), then walks
   one block at a time with `condenser_api.get_ops_in_block`.
2. Maintains two pools per walk:
   - **Pool A** — `comment_options` ops whose `null` beneficiary weight is
     nonzero, filtered by `rep > 45 && followers > 20 && medianFollowerRep > 35`.
   - **Pool B** — `transfer`s to `null` with a non-blank memo; SBD amounts are
     normalized to STEEM using the median feed-history ratio.
3. Every `interval` blocks it trims expired items and picks a content type
   (3-way random; types 1 & 2 both mean "promo", giving memos a 2:1 draw bias).
4. A weighted-random item is chosen (posts use integer weights, memos float).
5. Metadata is fetched (title/payout/votes, author rep, followers, median
   follower rep) and rendered with a heat-scale border + scrolling title.
6. State is persisted to `localStorage` (under a page-namespaced key) so the
   current display survives reloads.

## Files

| File | Purpose |
|------|---------|
| `vaas.js` | The widget library (IIFE → `window.VAAS`). |
| `vaas.css` | Default stylesheet; all tokens are `var(--vaas-*, …)` fallback chains. |
| `demo.html` | A self-contained harness showing auto-picked host theming. |
| `VAAS_SELECTION_LOGIC.md` | The selection-algorithm spec this widget implements. |
| `smoke.test.js` | Headless Node harness (with a DOM/fetch shim) that exercises mount → poll → display. |
| `CHANGELOG.md` | Version history. |
| `LICENSE` | MIT. |

## Development / testing

`node smoke.test.js` runs the widget logic headlessly (with a minimal DOM/fetch
shim) and asserts that mount, polling, pool building, and at least one display
render succeed. `node --check vaas.js` is a quick syntax sanity check.

## License

MIT. See [LICENSE](LICENSE).