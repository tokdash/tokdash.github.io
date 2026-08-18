# companion-api — static demo backend for Tokdash Companion

This folder exists so a **Microsoft Store certification reviewer** (or anyone else
testing the native Tokdash Companion app without running a real Tokdash server) has a
working endpoint to point the app at. Without it, the app shows a "not connected" /
empty-state screen, which makes it hard to review the actual UI.

It is **not** the same thing as `/demo/`. `/demo/` is the browser-based dashboard demo:
it works by patching `window.fetch` from inside a loaded web page
(`static/mock-api.js`), which only works for JavaScript running in that page. A native
desktop app makes its own HTTP requests and cannot use a JS fetch shim, so it needs
actual static files at the actual paths it requests. That's what this folder provides.

## How a reviewer uses it

1. Launch Tokdash Companion.
2. Open **Settings** from the tray icon's (Windows) or menu-bar icon's (macOS) context
   menu.
3. Set the server address to:
   ```
   https://tokdash.github.io/companion-api
   ```
4. The app should report a healthy connection and show populated Today/Month usage and
   quota figures.

## What's here

| Request the app makes | File served |
| --- | --- |
| `GET /companion-api/health` | [`health`](health) |
| `GET /companion-api/api/usage?period=today` | [`api/usage`](api/usage) |
| `GET /companion-api/api/usage?period=month` | [`api/usage`](api/usage) (see limitation below) |
| `GET /companion-api/api/quota` | [`api/quota`](api/quota) |
| `GET /companion-api/api/version` | [`api/version`](api/version) |

Files are served with **no extension** (`health`, `api/usage`, `api/quota`,
`api/version`) because that's the exact path the companion requests — it does not
append `.json`, and it does not validate the response's `Content-Type`; it deserializes
the response body directly, so whatever MIME type GitHub Pages happens to assign the
extensionless file is fine. Do not rename these to `*.json`.

## Data is synthetic

Every figure in every file here is made up for demo purposes: no real usage numbers, no
real machine names or account identifiers, nothing that identifies anyone. Treat it the
same as `/demo/`'s mock data.

## Known limitation: query strings are ignored

GitHub Pages serves static files and does not look at the query string, so
`/companion-api/api/usage?period=today` and `/companion-api/api/usage?period=month`
both resolve to the same [`api/usage`](api/usage) file. In the real app, "today" and
"month" are two different aggregation windows with different totals; here, the Month
figure in the companion UI will equal the Today figure, because both requests get the
same static response. This is an accepted limitation of a static-file demo backend —
not a bug — and is fine for showing certification reviewers a populated, working UI.

## Updating

These files are handwritten JSON, not generated. If the companion's response contract
changes (see `companion/contract/COMPANION_API.md` and `companion/contract/fixtures/`
in the main [Tokdash](https://github.com/JingbiaoMei/Tokdash) repo), update the fields
here by hand to keep this demo endpoint from confusing the app.
