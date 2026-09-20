"""Rebuild demo/index.html from the Tokdash package's static UI.

The demo page is the unmodified dashboard frontend (tokdash/src/tokdash/static/index.html)
plus three small injections:

  1. Google Analytics tag (head)
  2. mock-api.js loader (head, before the font tags)
  3. "Live demo" banner (top of body)

Build the public demo from a released tree, never from a feature branch:

    git -C ../tokdash worktree add ../tokdash-wt-demo origin/main --detach
    python3 build_demo.py --upstream ../tokdash-wt-demo/src/tokdash/static/index.html

Without --upstream this reads ../tokdash, which is usually someone's work in progress.
Fails loudly if an injection anchor no longer matches the upstream UI.
"""
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_UPSTREAM = ROOT.parent / "tokdash" / "src" / "tokdash" / "static" / "index.html"
DEFAULT_OUT = ROOT / "demo" / "index.html"

GA_BLOCK = """  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-SMJYP7ZVL7"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-SMJYP7ZVL7');
  </script>
"""

MOCK_LOADER = """  <!-- Demo: synthetic backend (overrides window.fetch for /api/*) -->
  <script>document.write(`<script src="${window.tokdashPath('/static/mock-api.js')}"><\\/script>`);</script>
"""

DEMO_BANNER = """
    <!-- Demo banner (links back to the marketing site) -->
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-2.5"
         style="background: linear-gradient(135deg, rgba(30,64,175,0.10), rgba(245,158,11,0.10)); border: 1px solid var(--color-border);">
      <p class="text-xs sm:text-sm" style="color: var(--color-muted);">
        <span style="color: var(--color-cta); font-weight: 700;">\u25cf</span>
        Live demo - every number here is <strong style="color: var(--color-text);">synthetic</strong>, and three demo
        servers are pre-loaded so the Servers tab and the server picker in Settings work. Nothing is uploaded or read
        from your machine.
      </p>
      <script>document.write(`<a href="${window.tokdashPath('/')}" class="btn btn-ghost" style="min-height: 32px; padding: 6px 12px; font-size: 12px;">\u2190 Tokdash home</a>`);</script>
    </div>
"""


def once(source: str, anchor: str) -> int:
    count = source.count(anchor)
    assert count == 1, f"anchor not found exactly once (found {count}): {anchor[:60]!r}"
    return source.index(anchor)


def render(upstream_html: str) -> str:
    """The three demo-only injections, applied to an upstream dashboard shell.

    Shared with check_demo_sync.py, which compares this output against the demo page
    on disk to tell whether the public demo still is the current UI.
    """
    html = upstream_html

    # 1. GA tag, between the theme-color meta and the title.
    anchor = '<meta name="theme-color" content="#1E40AF" />\n'
    i = once(html, anchor) + len(anchor)
    html = html[:i] + GA_BLOCK + html[i:]

    # 2. Mock API loader, right before the font tags.
    i = once(html, "  <!-- Fonts (Design System: Fira Code / Fira Sans) -->")
    html = html[:i] + MOCK_LOADER + "\n" + html[i:]

    # 3. Demo banner, at the top of the body content container.
    anchor = '  <div class="max-w-[1200px] mx-auto">\n'
    i = once(html, anchor) + len(anchor)
    html = html[:i] + DEMO_BANNER + html[i:]

    return html


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--upstream", default=str(DEFAULT_UPSTREAM),
                    help="path to a Tokdash checkout's src/tokdash/static/index.html")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="demo page to write")
    args = ap.parse_args()

    upstream, out = Path(args.upstream).resolve(), Path(args.out).resolve()
    html = render(upstream.read_text(encoding="utf-8"))

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out} ({len(html)} chars) from {upstream}")


if __name__ == "__main__":
    main()
