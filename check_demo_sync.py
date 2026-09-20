#!/usr/bin/env python3
"""Fail when the public demo stops matching the Tokdash UI it demos.

The demo is a few copies of upstream -- the dashboard shell, the shipped release
notes, the pricing snapshot, themes and icons -- and one hand-written synthetic
backend. Each drifts on its own schedule, and a stale one shows visitors a
different product: an older share card, a client that never shows up, a session
panel that can only ever load nothing. Nothing else in this repo notices.

Run it against a released upstream checkout, from the repo root:

    git -C ../tokdash fetch origin main
    git -C ../tokdash worktree add /tmp/tokdash-demo-build origin/main --detach
    python3 check_demo_sync.py --upstream /tmp/tokdash-demo-build
    python3 build_demo.py --upstream /tmp/tokdash-demo-build/src/tokdash/static/index.html

Exits 1 with one line per mismatch. `--verbose` lists the checks that passed too.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import build_demo

ROOT = Path(__file__).resolve().parent
DEFAULT_UPSTREAM = ROOT.parent / "tokdash"

# Clients the demo deliberately generates no traffic for, each with its reason.
NO_DEMO_DATA = {
    "amp": "a parser upstream, but not a client the landing page advertises",
}

# What the mock publishes about itself; see window.__TOKDASH_DEMO__ in mock-api.js.
MOCK_MANIFEST_JS = """
const { readFileSync } = require("node:fs");
const window = globalThis;
window.location = { origin: "https://tokdash.app", pathname: "/demo/" };
window.TOKDASH_BASE_PATH = "";
window.localStorage = { getItem: () => null, setItem: () => {} };
window.fetch = () => new Response("{}");
new Function("window", readFileSync(process.env.TOKDASH_MOCK, "utf8"))(window);
const demo = window.__TOKDASH_DEMO__;
process.stdout.write(JSON.stringify({
  sessionTools: demo.sessionTools,
  quotaProviders: demo.quotaProviders,
  toolKeys: demo.toolKeys,
}));
"""


class Report:
    def __init__(self, verbose: bool) -> None:
        self.problems: list[str] = []
        self.verbose = verbose

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        if ok:
            if self.verbose:
                print(f"ok    {name}")
            return True
        self.problems.append(f"{name}: {detail}" if detail else name)
        print(f"STALE {name}" + (f"\n      {detail}" if detail else ""))
        return False


def first_difference(left: str, right: str) -> str:
    left_lines, right_lines = left.splitlines(), right.splitlines()
    for index, (a, b) in enumerate(zip(left_lines, right_lines), start=1):
        if a != b:
            return f"line {index}: site has {a.strip()[:70]!r}, upstream has {b.strip()[:70]!r}"
    return f"length differs: site {len(left_lines)} lines, upstream {len(right_lines)}"


def js_array(text: str, name: str, path: str) -> list[str]:
    match = re.search(rf"const {name} = \[([^\]]*)\];", text, re.S)
    if not match:
        raise SystemExit(f"{path}: no `const {name} = [...]` to compare against")
    return re.findall(r"'([^']+)'", match.group(1))


def upstream_manifest(upstream: Path) -> dict:
    shell = (upstream / "src/tokdash/static/index.html").read_text(encoding="utf-8")
    parsers = (upstream / "src/tokdash/sources/coding_tools.py").read_text(encoding="utf-8")
    # "combined" is the Sessions tab's all-tools panel, not a tool of its own.
    panels = [p for p in re.findall(r'data-panel-details="([a-z_]+)"', shell) if p != "combined"]
    return {
        "session_tools": js_array(shell, "SESSION_TOOL_KEYS", "index.html"),
        "session_panels": panels,
        "quota_providers": js_array(shell, "QUOTA_PROVIDERS", "index.html"),
        "sources": sorted(set(re.findall(r'source_name = "([a-z_]+)"', parsers)) | {"openclaw"}),
        "icons": sorted(set(re.findall(r"icon: '(/static/icons/[^']+)'", shell))),
        "package_version": re.search(r'^version = "([^"]+)"',
                                     (upstream / "pyproject.toml").read_text(encoding="utf-8"),
                                     re.M).group(1),
        "pricing_db": json.loads((upstream / "src/tokdash/pricing_db.json").read_text(encoding="utf-8")),
        "release_notes": (upstream / "src/tokdash/static/release-notes.json").read_text(encoding="utf-8"),
        "themes_css": (upstream / "src/tokdash/static/themes.css").read_text(encoding="utf-8"),
        "theme_config": (upstream / "src/tokdash/static/theme-config.js").read_text(encoding="utf-8"),
    }


def mock_manifest() -> dict:
    try:
        result = subprocess.run(
            ["node", "-"], input=MOCK_MANIFEST_JS, capture_output=True, text=True,
            cwd=ROOT, env={"TOKDASH_MOCK": str(ROOT / "static/mock-api.js"),
                           "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin")},
            check=False,
        )
    except FileNotFoundError:
        raise SystemExit("node is required to read the demo mock's own tool lists")
    if result.returncode != 0:
        raise SystemExit(f"could not load static/mock-api.js with node:\n{result.stderr.strip()}")
    manifest = json.loads(result.stdout)
    # A mock predating the info API, or one whose lists were never filled in, would
    # otherwise come back as a KeyError mid-comparison. Report it and move on: the
    # rest of the demo can still be judged, and one problem reads better than a crash.
    absent = [key for key in ("sessionTools", "quotaProviders", "toolKeys") if not manifest.get(key)]
    if absent:
        return {
            key: [] for key in ("sessionTools", "quotaProviders", "toolKeys")
        }, ("static/mock-api.js publishes no " + ", ".join(absent)
            + " on window.__TOKDASH_DEMO__ -- add them there, or this check cannot tell"
            " what the synthetic backend serves")
    return manifest, ""


def same_sets(report: Report, name: str, site: list[str], upstream: list[str]) -> None:
    missing = sorted(set(upstream) - set(site))
    extra = sorted(set(site) - set(upstream))
    report.check(name, not missing and not extra, "; ".join(filter(None, [
        f"the demo lacks {', '.join(missing)}" if missing else "",
        f"the demo has {', '.join(extra)}, which upstream no longer has" if extra else "",
    ])))


def compare(report: Report, upstream: Path, mock: dict, mock_error: str) -> None:
    here = lambda *parts: ROOT.joinpath(*parts).read_text(encoding="utf-8")  # noqa: E731
    up = upstream_manifest(upstream)

    # 1. The dashboard shell: the demo page must be exactly what build_demo.py
    #    produces from the released UI today.
    shell_html = (upstream / "src/tokdash/static/index.html").read_text(encoding="utf-8")
    built, served = build_demo.render(shell_html), here("demo/index.html")
    report.check("demo/index.html is the current UI", served == built,
                 f"{first_difference(served, built)} -- rerun build_demo.py --upstream "
                 f"{upstream}/src/tokdash/static/index.html")

    # 2. Verbatim copies the header and the theme read at runtime.
    reported = here("static/themes.css")
    report.check("static/themes.css is upstream's", reported == up["themes_css"],
                 first_difference(reported, up["themes_css"]))
    reported = here("static/theme-config.js")
    report.check("static/theme-config.js is upstream's", reported == up["theme_config"],
                 first_difference(reported, up["theme_config"]))

    # 3. Release notes: the same file, and its own `current` agrees with the package.
    notes_text = here("static/release-notes.json")
    report.check("static/release-notes.json is upstream's", notes_text == up["release_notes"],
                 first_difference(notes_text, up["release_notes"]))
    current = json.loads(notes_text).get("current")
    report.check("What's new leads with the released version",
                 current == up["package_version"],
                 f"the copy says {current!r}, the package is {up['package_version']}")

    # 4. Pricing snapshot: the demo costs tokens with this file, so an old copy
    #    prices a new model at nothing.
    pricing = json.loads(here("pricing_db.json"))
    up_models, site_models = set(up["pricing_db"]["models"]), set(pricing["models"])
    report.check("pricing_db.json covers every upstream model", not up_models - site_models,
                 f"{len(up_models - site_models)} missing, e.g. "
                 f"{', '.join(sorted(up_models - site_models)[:6])} "
                 f"(upstream {up['pricing_db']['version']}, copy {pricing['version']})")
    report.check("pricing_db.json advertises no model upstream dropped",
                 not site_models - up_models,
                 f"site-only: {', '.join(sorted(site_models - up_models)[:6])}")

    # 5. Icons the UI asks for by name; a 404 here loses a logo in the demo.
    missing_icons = [icon for icon in up["icons"] if not (ROOT / icon.lstrip("/")).exists()]
    report.check("every tool logo the UI references exists", not missing_icons,
                 f"missing: {', '.join(missing_icons)}")

    # 6. Synthetic backend vs the UI it answers, both in the tool-key space the API
    #    answers with -- the mock names two sources after their products
    #    (claude_code, gemini) and maps them to the upstream keys on the way out.
    if mock_error:
        report.check("mock publishes what it serves", False, mock_error)
        return
    same_sets(report, "mock serves every session tool the Sessions tab asks for",
              mock["sessionTools"], up["session_tools"])
    same_sets(report, "every session tool has a panel in the shell",
              up["session_panels"], up["session_tools"])
    same_sets(report, "mock's quota catalog covers the Quota tab's providers",
              mock["quotaProviders"], up["quota_providers"])
    same_sets(report, "mock generates traffic for every client with a parser",
              mock["toolKeys"], sorted(set(up["sources"]) - set(NO_DEMO_DATA)))
    for source, reason in NO_DEMO_DATA.items():
        report.check(f"demo skips {source} on purpose", source in set(up["sources"]),
                     f"upstream has no {source} parser any more -- drop the exception ({reason})")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--upstream", default=str(DEFAULT_UPSTREAM),
                    help="released Tokdash checkout to compare against (default: ../tokdash)")
    ap.add_argument("--verbose", action="store_true", help="list the checks that passed")
    args = ap.parse_args()

    upstream = Path(args.upstream).resolve()
    shell = upstream / "src/tokdash/static/index.html"
    if not shell.exists():
        raise SystemExit(f"{shell} not found: point --upstream at a Tokdash checkout")
    version = re.search(r'^version = "([^"]+)"',
                        (upstream / "pyproject.toml").read_text(encoding="utf-8"), re.M).group(1)

    report = Report(args.verbose)
    mock, mock_error = mock_manifest()
    compare(report, upstream, mock, mock_error)

    if report.problems:
        print(f"\n{len(report.problems)} way(s) the demo is behind the UI:")
        for problem in report.problems:
            print(f"  - {problem}")
        print("\nRefresh the demo (build_demo.py, the verbatim copies, then mock-api.js) "
              "and run this again.")
        return 1
    print(f"DEMO-IN-SYNC with {upstream.name} v{version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
