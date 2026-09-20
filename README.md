# tokdash.github.io

Official site for [Tokdash](https://github.com/JingbiaoMei/Tokdash) — a local token & cost
dashboard for AI coding tools. It reads the session logs your agents already write to disk:
Codex, Claude Code, OpenCode, Gemini CLI, Kimi CLI, ZCode, and
[18 more](https://github.com/JingbiaoMei/Tokdash/blob/main/docs/reference/SUPPORTED_CLIENTS.md).

- **`/`** — the marketing landing page (`index.html`).
- **`/demo/`** — the live, interactive dashboard demo (`demo/index.html`).

> **The data on the demo page is fully synthetic.** A small in-browser shim
> (`static/mock-api.js`) intercepts every `/api/*` request and returns deterministic
> sample data, so the unmodified Tokdash frontend can run as a static site. Nothing is
> uploaded; nothing is read from your machine.

## What you can try

- Switch tabs (Overview / Sessions / Stats / Report / Quota / Servers / Pricing).
- Change the period or pick a custom date range.
- Toggle light/dark and the 17 style themes.
- Click into synthetic sessions, including turns and per-turn token accounting.
- Open the **Servers** tab. The demo pre-loads three machines — Local, WSL workstation, and
  Mac Studio — split by session id, so each one reports its own tokens, cost, share bars,
  top tools and top models, and the compare table puts them side by side. Reachable counts,
  combined totals, and the stalest timestamp sit in the strip above the cards.
- Narrow the fleet with the header server picker or Settings → Servers. Every tab re-scopes
  to the selection, including the Quota tab.
- On the **Quota** tab, read the mock subscription windows grouped per machine (each demo
  server advertises a different provider set), toggle active providers, change the polling
  interval, or trigger a manual refresh.
- On the **Report** tab, step the period chips (this week / last week, a named month, a
  year) and read the day map, the harness / model / project podiums, the hour-and-weekday rhythm,
  and the per-agent runtime table. The tab covers one server at a time and says which one; the
  picker above it switches machines. Both share cards download as light + dark PNGs.
- On the **Stats** tab, switch the Daily Activity metric chip to **Energy** to recolor the
  heatmap by estimated energy per day, and read the Total Energy (kWh) row in the Month Stats
  sidebar (estimated in the browser from token counts × model-family `J/token` coefficients;
  order-of-magnitude only).
- Browse the read-only demo pricing snapshot.

The demo registry is seeded once, into `localStorage`, and never overwrites servers you add
yourself — clear site data to get the three-machine fleet back.

## Local preview

```bash
python3 -m http.server 8000
# open http://localhost:8000        (landing page)
# open http://localhost:8000/demo/  (dashboard demo)
```

## How it works

|  File                       | Purpose                                                                |
|  -------------------------- | ---------------------------------------------------------------------- |
|  `index.html`               | Official marketing landing page (self-contained, reuses the design tokens). |
|  `static/landing.css`       | Prebuilt Tailwind utilities for the landing page (so it renders without JS). |
|  `demo/index.html`          | Tokdash dashboard shell — upstream frontend + the demo-only edits listed below. |
|  `static/themes.css`        | Verbatim copy of the production stylesheet.                            |
|  `static/theme-config.js`   | Verbatim copy of the production theme palettes.                        |
|  `static/mock-api.js`       | Demo-only fetch shim that builds and serves synthetic data.            |
| `static/release-notes.json` | Verbatim copy of the shipped release notes the header reads.           |
|  `static/icons/agents/`     | Per-agent logos used by the landing page "supported tools" row.        |
|  `sw.js`                    | Service worker (PWA install + offline app shell), served at `/sw.js`.   |
|  `pricing_db.json`          | Sanitized pricing snapshot for the read-only Pricing tab.              |
|  `build_demo.py`            | Rebuilds `demo/index.html` from an upstream checkout.                  |
|  `check_demo_sync.py`       | Fails when the demo has fallen behind the upstream UI.                 |
|  `verify_demo.py`           | Headless-Chromium check of `/demo/` (fleet split, Servers tab, quota).  |
|  `verify_landing.py`        | Headless-Chromium check of `/` (render, copy, six-language parity, mobile). |

### Refreshing the demo from upstream

`demo/index.html` is the upstream `src/tokdash/static/index.html` plus three injections: the
Google Analytics tag, the `mock-api.js` loader, and the "Live demo" banner. Rebuild it with
the script rather than editing by hand:

```bash
git -C ../tokdash fetch origin main
git -C ../tokdash worktree add /tmp/tokdash-demo-build origin/main --detach
python3 check_demo_sync.py --upstream /tmp/tokdash-demo-build   # what has fallen behind
python3 build_demo.py --upstream /tmp/tokdash-demo-build/src/tokdash/static/index.html
python3 check_demo_sync.py --upstream /tmp/tokdash-demo-build   # DEMO-IN-SYNC
```

Build from a released tree. Without `--upstream` the script reads `../tokdash`, which is
usually a work in progress, and the public demo must not ship unreleased UI. The build fails
loudly if an injection anchor no longer matches the upstream file.

Keep `static/themes.css`, `static/theme-config.js` and `static/release-notes.json` in sync the same way — all three
byte-identical to upstream — and sanitize `pricing_db.json` so the public demo does not
advertise unreleased or placeholder model ids. When upstream adds API routes or fields
(e.g. `/api/insights`, `top_models_by_cost`, `cache_hit_rate`), mirror them in
`static/mock-api.js` so the new UI shows real synthetic values instead of `n/a`. `/api/insights`
folds its nine facets from the same synthetic turns that feed `/api/usage`, so the Report tab's
totals agree with Overview's, and one tool-key space serves `/api/usage`, `/api/insights`, and
`/api/active-time` alike because the Report tab joins them on it.

Lists drift the same way fields do. A new client, session harness or quota provider upstream
needs its line in `static/mock-api.js` as well, or the demo shows an empty panel where the app
shows data. `check_demo_sync.py` compares the mock's own lists (`window.__TOKDASH_DEMO__`)
against the panels and the Show menu in the current UI, so it names what to add; the client
list compares against upstream's parsers, minus anything left out of `NO_DEMO_DATA`.

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

## Checking the site

```bash
python3 check_demo_sync.py # demo vs. the upstream UI: page, notes, pricing, mock tool lists
node test-mock-api.mjs     # mock API routes, no browser
python3 verify_landing.py  # landing page: renders offline, all six languages, 390px mobile
python3 verify_demo.py     # demo: every client, every session panel, per-machine quota, cards
```

Both `verify_*.py` scripts need Playwright and Chromium, serve the repo over 127.0.0.1, and
print `LANDING-CHECK-OK` / `BROWSER-CHECK-OK` on success. They write `verify-*.png` previews
to the repo root; those are gitignored. `check_demo_sync.py` needs an upstream checkout at `../tokdash` (or `--upstream`) and node
only to ask the mock which tools it serves.

The landing page's copy lives in a six-language
dictionary inside `index.html`, and every `data-i18n` key must have an entry in all six —
`verify_landing.py` fails on drift in either direction.

## License

MIT — see [`LICENSE`](LICENSE).
