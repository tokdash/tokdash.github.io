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
- Browse the (read-only) pricing database.

## Local preview

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## How it works

| File                       | Purpose                                                                |
| -------------------------- | ---------------------------------------------------------------------- |
| `index.html`               | Verbatim copy of `src/tokdash/static/index.html` from the main repo.   |
| `static/themes.css`        | Verbatim copy of the production stylesheet.                            |
| `static/theme-config.js`   | Verbatim copy of the production theme palettes.                        |
| `static/mock-api.js`       | Demo-only fetch shim that builds and serves synthetic data.            |
| `pricing_db.json`          | Snapshot of the pricing database for the read-only Pricing tab.        |

To refresh the snapshot when Tokdash itself changes, re-copy the four upstream files
(everything except `static/mock-api.js`) and commit.

## License

MIT — see [`LICENSE`](LICENSE).
