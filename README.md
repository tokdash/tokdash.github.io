# tokdash.github.io

Live demo of [Tokdash](https://github.com/JingbiaoMei/Tokdash) — a local token & cost
dashboard for AI coding tools (Codex, Claude Code, OpenCode, Gemini CLI, OpenClaw,
Kimi CLI).

> **The data on this page is fully synthetic.** A small in-browser shim
> (`static/mock-api.js`) intercepts every `/api/*` request and returns deterministic
> sample data, so the unmodified Tokdash frontend can run as a static site. Nothing is
> uploaded; nothing is read from your machine.

## What you can try

- Switch tabs (Overview / Sessions / Heatmap / Pricing).
- Change the period or pick a custom date range.
- Toggle light/dark and the 10 style themes.
- Click into a synthetic Codex / Claude / OpenCode session.
- On the **Stats** tab, switch the Daily Activity metric chip to **Energy** to recolor the heatmap by estimated energy per day, and read the new Total Energy (kWh) row in the Month Stats sidebar (estimated entirely in the browser from token counts × model-family `J/token` coefficients; order-of-magnitude only).
- Browse the read-only demo pricing snapshot.

## Local preview

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## How it works

| File                       | Purpose                                                                |
| -------------------------- | ---------------------------------------------------------------------- |
| `index.html`               | Tokdash dashboard shell with demo banner and synthetic backend wiring.  |
| `static/themes.css`        | Verbatim copy of the production stylesheet.                            |
| `static/theme-config.js`   | Verbatim copy of the production theme palettes.                        |
| `static/mock-api.js`       | Demo-only fetch shim that builds and serves synthetic data.            |
| `pricing_db.json`          | Sanitized pricing snapshot for the read-only Pricing tab.              |

To refresh the demo when Tokdash itself changes, re-copy the upstream static assets,
keep the demo-only edits in `index.html`, and sanitize `pricing_db.json` so the public
demo does not advertise unreleased or placeholder model ids.

## License

MIT — see [`LICENSE`](LICENSE).
