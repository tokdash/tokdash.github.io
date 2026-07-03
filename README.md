# tokdash.github.io

Official site for [Tokdash](https://github.com/JingbiaoMei/Tokdash) — a local token & cost
dashboard for AI coding tools (Codex, Claude Code, OpenCode, Gemini CLI, OpenClaw,
Kimi CLI, Pi, GitHub Copilot CLI, Hermes).

- **`/`** — the marketing landing page (`index.html`).
- **`/demo/`** — the live, interactive dashboard demo (`demo/index.html`).

> **The data on the demo page is fully synthetic.** A small in-browser shim
> (`static/mock-api.js`) intercepts every `/api/*` request and returns deterministic
> sample data, so the unmodified Tokdash frontend can run as a static site. Nothing is
> uploaded; nothing is read from your machine.

## What you can try

- Switch tabs (Overview / Sessions / Heatmap / Quota / Pricing).
- Change the period or pick a custom date range.
- Toggle light/dark and the 10 style themes.
- Click into a synthetic Codex / Claude / OpenCode session.
- On the **Stats** tab, switch the Daily Activity metric chip to **Energy** to recolor the heatmap by estimated energy per day, and read the new Total Energy (kWh) row in the Month Stats sidebar (estimated entirely in the browser from token counts × model-family `J/token` coefficients; order-of-magnitude only).
- On the **Quota** tab, inspect the mock remaining limits for Codex, Claude, and Antigravity, toggle active providers, adjust the polling interval settings, or trigger a manual refresh.
- Browse the read-only demo pricing snapshot.

## Local preview

```bash
python3 -m http.server 8000
# open http://localhost:8000        (landing page)
# open http://localhost:8000/demo/  (dashboard demo)
```

## How it works

| File                       | Purpose                                                                |
| -------------------------- | ---------------------------------------------------------------------- |
| `index.html`               | Official marketing landing page (self-contained, reuses the design tokens). |
| `static/landing.css`       | Prebuilt Tailwind utilities for the landing page (so it renders without JS). |
| `demo/index.html`          | Tokdash dashboard shell — upstream frontend + the demo-only edits listed below. |
| `static/themes.css`        | Verbatim copy of the production stylesheet.                            |
| `static/theme-config.js`   | Verbatim copy of the production theme palettes.                        |
| `static/mock-api.js`       | Demo-only fetch shim that builds and serves synthetic data.            |
| `static/icons/agents/`     | Per-agent logos used by the landing page "supported tools" row.        |
| `sw.js`                    | Service worker (PWA install + offline app shell), served at `/sw.js`.   |
| `pricing_db.json`          | Sanitized pricing snapshot for the read-only Pricing tab.              |

### Refreshing the demo from upstream

`demo/index.html` is a verbatim copy of `src/tokdash/static/index.html` from the
[Tokdash repo](https://github.com/JingbiaoMei/Tokdash) plus four demo-only edits. To
re-sync, copy the upstream file over `demo/index.html` and re-apply:

1. The `<script src="/static/mock-api.js">` include in `<head>` (the synthetic backend).
2. The "Live demo" banner block immediately after `<body>` (links back to `/`).
3. `pi_agent: 'Pi'` in the `formatToolName` map (display name; the rest matches upstream).
4. The Google Analytics `gtag.js` snippet in `<head>`.

Keep `static/themes.css` / `static/theme-config.js` in sync the same way (currently
byte-identical to upstream), and sanitize `pricing_db.json` so the public demo does not
advertise unreleased or placeholder model ids. When upstream adds API fields (e.g.
`cache_hit_rate`), mirror them in `static/mock-api.js` so the new UI shows real synthetic
values instead of `n/a`.

### Rebuilding the landing CSS

The landing page ships a prebuilt, purged Tailwind v3 stylesheet (`static/landing.css`)
instead of the runtime JS CDN, so it renders fully with JavaScript disabled. Regenerate it
after changing classes in `index.html`:

```bash
printf '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' > /tmp/in.css
npx tailwindcss@3 -i /tmp/in.css -o static/landing.css --minify \
  --content ./index.html
```

(Equivalently, point a `tailwind.config.js` at `index.html` with `darkMode: 'class'`.)
No Node tooling is committed — this is a one-off build step that only touches `static/landing.css`.

## License

MIT — see [`LICENSE`](LICENSE).
