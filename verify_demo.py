"""Browser smoke test for the /demo/ page: load it in headless Chromium, fail on
console errors or a missing agent-time figure, and save screenshots."""
import http.server
import json
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
PORT = 8971
BROWSER_ARGS = [
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-features=Vulkan,VizDisplayCompositor",
]


def serve():
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=ROOT, **k)
    with socketserver.TCPServer(("127.0.0.1", PORT), handler) as httpd:
        httpd.serve_forever()


threading.Thread(target=serve, daemon=True).start()

errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=BROWSER_ARGS)
    page = browser.new_page(
        viewport={"width": 1440, "height": 960},
        device_scale_factor=2,
        reduced_motion="reduce",
    )
    # The demo only needs local assets. Abort external CDN requests up front so
    # goto() never waits on a slow or blocked network: the head has blocking
    # <script> tags (tailwind/chart.js) that would otherwise stall parsing
    # until TCP timeout.
    page.route(
        "**/*",
        lambda route: route.abort()
        if route.request.url.startswith("http") and "127.0.0.1" not in route.request.url
        else route.continue_(),
    )
    # The verify environment may have no internet. Provide permissive stand-ins
    # for the CDN libraries the dashboard expects (tailwind config hook,
    # flatpickr init, Chart instances), so the inline scripts and the Overview
    # render path run to completion without network access.
    page.add_init_script(
        """
        (function () {
          const handler = {
            get(t, k) { return k in t ? t[k] : stub(); },
            set() { return true; },
            apply() { return stub(); },
          };
          const stub = () => new Proxy(function () {}, handler);
          window.tailwind = { config: {} };
          window.flatpickr = function () {
            const inst = stub();
            inst.input = {};
            return inst;
          };
          window.Chart = function () {
            const inst = stub();
            inst.data = { labels: [], datasets: [{ data: [] }] };
            return inst;
          };
        })();
        """
    )
    def on_console(message):
        if message.type != "error":
            return
        location = (message.location or {}).get("url") or ""
        if location.startswith("http") and "127.0.0.1" not in location:
            return  # aborted external CDN resource
        errors.append(message.text)
    page.on("console", on_console)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"http://127.0.0.1:{PORT}/demo/", wait_until="domcontentloaded")
    page.wait_for_timeout(2500)

    def text(sel):
        return page.locator(sel).inner_text().strip() if page.locator(sel).count() else "<missing>"

    print("agent-time card:", text("#overviewActiveTime"))
    print("agent-time delta:", text("#overviewActiveDelta"))
    print("agent-time meta:", text("#overviewActiveMeta")[:60])
    assert text("#overviewActiveTime") not in ("<missing>", "-", ""), "agent-time card empty"

    # Top Model KPI: the full name must fit the card (regression for the
    # anthropic/claude-opus-4.7 overflow) and carry a hover title. The probe
    # constrains the element to the real card inner width (1200px container,
    # 6-col grid at lg, 16px gaps, p-5 cards) and measures against a fixed long
    # name, so it does not depend on which model the dataset ranks first.
    top_model = page.locator("#topModel")
    assert top_model.count() == 1, "Top Model KPI missing"
    name = (top_model.inner_text() or "").strip()
    assert name not in ("", "-", "—"), "Top Model KPI empty"
    assert "break-all" in (top_model.get_attribute("class") or ""), "Top Model KPI missing break-all"
    assert top_model.get_attribute("title") == name, "Top Model KPI missing hover title"
    fit = page.evaluate(
        """() => {
          const el = document.getElementById('topModel');
          const vp = window.innerWidth;
          const innerW = (Math.min(1200, vp - 64) - 5 * 16) / 6 - 40;
          const probe = document.createElement('style');
          probe.textContent = '.td-ovf-test{word-break:break-all;}';
          document.head.appendChild(probe);
          const original = el.textContent;
          el.textContent = 'anthropic/claude-opus-4.7-experimental-20260903';
          const measure = (fixed) => {
            el.classList.toggle('td-ovf-test', fixed);
            el.style.width = innerW + 'px';
            const scroll = el.scrollWidth;
            el.style.width = '';
            return scroll;
          };
          const withoutFix = measure(false);
          const withFix = measure(true);
          el.textContent = original;
          el.classList.remove('td-ovf-test');
          probe.remove();
          return { innerW: Math.round(innerW), withoutFix, withFix };
        }"""
    )
    print(f"top-model fit: {name!r} innerW={fit['innerW']}px "
          f"scrollWithoutFix={fit['withoutFix']} scrollWithFix={fit['withFix']}")
    assert fit["withoutFix"] > fit["innerW"], "overflow probe is vacuous (the long name fits unwrapped)"
    assert fit["withFix"] <= fit["innerW"] + 1, "Top Model KPI overflows its card with break-all"

    # Every recently added source must show up in the Overview tools table.
    overview_body = page.inner_text("body")
    for label in ["WorkBuddy", "Qoder IDE", "Qoder CLI", "omp", "Kilo Code", "Cline"]:
        assert label in overview_body, f"{label} missing from Overview tools table"

    page.screenshot(path="verify-overview.png")

    # Sessions tab: every recently added session source must be present.
    page.locator("button, a").filter(has_text="Sessions").first.click()
    page.wait_for_timeout(1500)
    body = page.inner_text("body")
    for label in ["DeepSeek Harness", "Kimi", "Mimo", "Reasonix", "ZCode"]:
        assert label in body, f"{label} missing from Sessions tab"
    page.screenshot(path="verify-sessions.png")

    # The mock fleet: three machines, every generated session owned by exactly one.
    fleet = page.evaluate("() => window.__TOKDASH_DEMO__.servers")
    print("fleet:", [(f["id"], f["sessions"]) for f in fleet])
    assert len(fleet) == 3, f"expected 3 demo servers, got {len(fleet)}"
    assert sum(f["sessions"] for f in fleet) == page.evaluate("() => window.__TOKDASH_DEMO__.sessionsCount"), \
        "server partitions do not cover the dataset exactly once"
    assert len({f["sessions"] for f in fleet}) == len(fleet), "server partitions are indistinguishable"

    # Servers tab: hidden until a second server exists, then one card per server
    # plus the comparison table with its Combined column.
    tab = page.locator("#serversTabBtn")
    assert tab.count() == 1 and tab.is_visible(), "Servers tab hidden despite a seeded fleet"
    assert page.evaluate("() => JSON.parse(localStorage.getItem('tokdash-servers') || '[]').length") == 2, \
        "demo fleet did not seed the two remote servers"
    tab.click()
    page.wait_for_selector(".servers-card", timeout=30_000)
    page.wait_for_timeout(1200)
    cards = page.locator(".servers-card")
    assert cards.count() == 3, f"Servers tab rendered {cards.count()} of 3 cards"
    strip = page.locator(".servers-strip").inner_text()
    print("servers strip:", " ".join(strip.split())[:120])
    # Header text is uppercased by CSS, so compare case-folded.
    headers = [h.strip().casefold() for h in page.locator(".servers-compare th").all_inner_texts()]
    print("compare headers:", headers)
    assert len(headers) == 5, f"comparison table needs corner + Combined + 3 servers, got {headers}"
    assert "combined" in headers[1], f"second column should be the combined one: {headers}"
    for label in ("local", "wsl workstation", "mac studio"):
        assert label in headers, f"{label} missing from the comparison table"
    # Per-card figures must be filled, and the two remotes must differ from Local.
    values = page.eval_on_selector_all(
        ".servers-kpi .v",
        "els => els.map(e => e.textContent.trim().replace(/\\s+/g, ' '))",
    )
    print("server KPIs:", values[:9])
    assert all(v and v not in ("-", "—") for v in values), f"empty server KPI in {values}"
    page.screenshot(path="verify-servers.png", full_page=True)

    # Quota tab: grouped per server, and each machine reports its own providers.
    page.locator("button, a").filter(has_text="Quota").first.click()
    page.wait_for_selector("#quotaServerBlocks [data-server-id]", timeout=30_000)
    page.wait_for_timeout(1500)
    blocks = page.locator("#quotaServerBlocks [data-server-id]")
    assert blocks.count() == 3, f"quota tab shows {blocks.count()} of 3 server blocks"
    providers = page.evaluate(
        """async () => {
          const out = {};
          for (const [id, base] of [['local', ''], ['wsl', 'https://wsl-desktop.ts.net'],
                                    ['studio', 'https://mac-studio.ts.net']]) {
            const res = await fetch(base + '/api/quota');
            out[id] = Object.keys((await res.json()).providers).sort();
          }
          return out;
        }"""
    )
    print("quota providers per server:", providers)
    assert providers["local"] and providers["wsl"] and providers["studio"], "a server reports no quota providers"
    assert providers["wsl"] != providers["studio"] != providers["local"], "servers report the same quota set"
    page.screenshot(path="verify-quota.png", full_page=True)

    # Report tab: one facet feed paints the hero, the day map, the podium, the hour
    # and weekday rhythm, the agent table and both share cards. A facet or endpoint
    # the demo did not answer would surface as a banner or an em dash, so the check
    # is that nothing is missing rather than that some number is big.
    page.locator('button[data-tab="report"]').click()
    page.wait_for_function(
        """() => {
          const el = document.getElementById('usageReportKTokens');
          return !!el && !['', '-', '\\u2014'].includes(el.textContent.trim());
        }""",
        timeout=30_000,
    )
    # The share cards are painted last, in the same render pass as the figures.
    page.wait_for_function(
        """() => document.querySelectorAll('#usageReportGreenCards canvas').length === 2
            && document.querySelectorAll('#usageReportAmberCards canvas').length === 2""",
        timeout=30_000,
    )

    kpis = {i: text("#" + i) for i in (
        "usageReportKTokens", "usageReportKCost", "usageReportKActive", "usageReportKDays")}
    print("report KPIs:", kpis)
    assert all(v not in ("<missing>", "", "-", "\u2014") for v in kpis.values()), \
        f"report hero KPI empty: {kpis}"
    assert page.locator("#usageReportBanner").is_hidden(), "report shows a missing-source banner"
    assert page.locator("#usageReportStatePanel").is_hidden(), "report shows its error/state panel"

    for label in ("usageReportRange", "usageReportSentence", "usageReportStreak",
                  "usageReportGroupNote", "usageReportFooter", "usageReportTz"):
        value = text("#" + label)
        assert value not in ("<missing>", "", "-", "\u2014"), f"{label} printed nothing"
    print("report sentence:", text("#usageReportSentence")[:150])
    print("report streak:", text("#usageReportStreak"))
    print("report groups:", text("#usageReportGroupNote")[:120])

    assert page.locator("#usageReportHeat > *").count() >= 1, "report day map painted nothing"
    podium = page.locator("#usageReportPodium > *")
    print("report podium entries:", podium.count())
    assert podium.count() >= 3, f"report podium has {podium.count()} entries"
    assert page.locator("#usageReportWhen > *").count() >= 2, "hour/weekday rhythm did not render"

    rows = page.locator("#usageReportAgentsBody tr")
    print("report agent rows:", rows.count())
    assert rows.count() >= 5, f"report agent table rendered {rows.count()} rows"
    # Sessions and runtime per row come from /api/active-time, keyed the same way as
    # the insights tool facet and the usage rows. A key mismatch prints an em dash.
    dashes = page.eval_on_selector_all(
        "#usageReportAgentsBody td",
        "els => els.filter(e => ['-', '\\u2014'].includes(e.textContent.trim())).length",
    )
    print("report agent cells that are em dashes:", dashes)
    assert dashes == 0, f"{dashes} agent cells fell back to an em dash (tool keys disagree?)"

    # The report reads one server at a time, and the demo fleet has three.
    options = page.eval_on_selector_all("#usageReportServer option", "els => els.length")
    print("report server options:", options)
    assert options == 3, f"report server picker offers {options} of 3 servers"

    # Two cards per tier, a light one and a dark one, whatever theme is on screen.
    assert page.locator("#usageReportGreenCards canvas").count() == 2, "green share cards incomplete"
    assert page.locator("#usageReportAmberCards canvas").count() == 2, "amber share cards incomplete"
    audit = page.evaluate("() => document.getElementById('usageReportStack')?.dataset?.cardAudit || ''")
    assert "OVERFLOW" not in audit, f"a share card overflows its canvas: {audit}"
    print("card fit:", audit[:150])
    page.screenshot(path="verify-report.png", full_page=True)

    # The What's new view reads static/release-notes.json, which the site copies from
    # a release. A copy left behind upstream is a sync bug, not a UI bug.
    notes = json.loads((ROOT / "static" / "release-notes.json").read_text(encoding="utf-8"))
    page.evaluate("() => document.getElementById('releaseNotesToggle')?.click()")
    page.wait_for_timeout(700)
    head = " ".join(page.locator("#releaseNotesList").inner_text().split())[:120]
    print("what's new leads with:", head[:60])
    assert notes["current"] in head, f"What's new does not lead with v{notes['current']}: {head!r}"
    page.evaluate("() => document.getElementById('releaseNotesClose')?.click()")
    page.wait_for_timeout(300)

    # Settings: the picker lists the whole fleet.
    page.evaluate("() => document.getElementById('settingsBtn')?.click()")
    page.wait_for_timeout(600)
    rows = page.locator("#serverSettingsList .server-setting-row")
    assert rows.count() == 3, f"settings lists {rows.count()} of 3 servers"

    browser.close()

real_errors = [e for e in errors if "cdn.tailwindcss.com" not in e and "googletagmanager" not in e]
print("console errors:", real_errors if real_errors else "none")
assert not real_errors, "console errors on the demo page"
print("BROWSER-CHECK-OK")
