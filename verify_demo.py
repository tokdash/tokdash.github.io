"""Browser smoke test for the /demo/ page: load it in headless Chromium, fail on
console errors or a missing agent-time figure, and save screenshots."""
import http.server
import json
from datetime import datetime
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
    # anthropic/claude-opus-4.7 overflow) and stay readable in full on hover. The
    # hover affordance is #topModelExact, an exact-value readout the shell fills with
    # setKpiExactReadout, which replaced the title attribute this check used to read.
    # The probe constrains the element to the real card inner width (1200px container,
    # 6-col grid at lg, 16px gaps, p-5 cards) and measures against a fixed long
    # name, so it does not depend on which model the dataset ranks first.
    top_model = page.locator("#topModel")
    assert top_model.count() == 1, "Top Model KPI missing"
    name = (top_model.inner_text() or "").strip()
    assert name not in ("", "-", "—"), "Top Model KPI empty"
    assert "break-all" in (top_model.get_attribute("class") or ""), "Top Model KPI missing break-all"
    readout = page.locator("#topModelExact")
    assert readout.count() == 1, "Top Model KPI has no exact-value readout"
    assert readout.get_attribute("hidden") is None, "exact-value readout stays hidden"
    assert (readout.text_content() or "").strip() == name, "exact-value readout lacks the full name"
    assert top_model.get_attribute("aria-label") == name, "Top Model KPI missing its accessible name"
    fit = page.evaluate(
        """() => {
          const el = document.getElementById('topModel');
          const vp = window.innerWidth;
          const innerW = (Math.min(1200, vp - 64) - 5 * 16) / 6 - 40;
          const probe = document.createElement('style');
          // Both arms need !important: the page ships a break-all utility of its own
          // now that Tailwind loads from static/vendor, and a rule that only ever
          // adds the property leaves the "without" arm measured with it on.
          probe.textContent = '.td-ovf-off{word-break:normal !important;}'
                            + '.td-ovf-on{word-break:break-all !important;}';
          document.head.appendChild(probe);
          const original = el.textContent;
          el.textContent = 'anthropic/claude-opus-4.7-experimental-20260903';
          const measure = (arm) => {
            el.classList.remove('td-ovf-off', 'td-ovf-on');
            el.classList.add(arm);
            el.style.width = innerW + 'px';
            const scroll = el.scrollWidth;
            el.style.width = '';
            return scroll;
          };
          const withoutFix = measure('td-ovf-off');
          const withFix = measure('td-ovf-on');
          el.textContent = original;
          el.classList.remove('td-ovf-off', 'td-ovf-on');
          probe.remove();
          return { innerW: Math.round(innerW), withoutFix, withFix };
        }"""
    )
    print(f"top-model fit: {name!r} innerW={fit['innerW']}px "
          f"scrollWithoutFix={fit['withoutFix']} scrollWithFix={fit['withFix']}")
    assert fit["withoutFix"] > fit["innerW"], "overflow probe is vacuous (the long name fits unwrapped)"
    assert fit["withFix"] <= fit["innerW"] + 1, "Top Model KPI overflows its card with break-all"

    # And the readout must actually arrive: CSS reveals it on hover of the wrap
    # (.overview-token-value-wrap:hover), which is the only way to read an unbroken
    # name now that the card wraps it across lines.
    page.locator("#topModelWrap").hover()
    page.wait_for_timeout(300)  # let the opacity transition settle
    assert page.evaluate(
        """() => {
          const s = getComputedStyle(document.getElementById('topModelExact'));
          return s.visibility === 'visible' && parseFloat(s.opacity) > 0.9;
        }"""
    ), "exact-value readout does not reveal on hover"

    # Two things to prove about the Overview tools table, and both read the client
    # list from the demo itself rather than a list frozen in this file: the page
    # renders a labelled row for every client in the window it is showing (the
    # labels come from the dashboard's own formatter), and across the whole fleet
    # the demo generates traffic for every client the app can parse. A low-volume
    # client can legitimately miss one machine's day, so coverage is a fleet claim
    # and row rendering is a per-window claim.
    table = page.evaluate(
        """async () => {
          const fleet = ['', ...JSON.parse(localStorage.getItem('tokdash-servers') || '[]')
            .map((s) => s.baseUrl)];
          const seen = {};
          for (const base of fleet) {
            const usage = await (await fetch(`${base}/api/usage?period=today`)).json();
            for (const [tool, row] of Object.entries(usage.by_tool)) {
              if (Number(row.tokens || 0) > 0) seen[tool] = (seen[tool] || 0) | (base ? 2 : 1);
            }
          }
          return { local: Object.keys(seen).filter((t) => seen[t] & 1).map((t) => formatToolName(t)),
                   all: Object.keys(seen).map((t) => formatToolName(t)) };
        }"""
    )
    body_labels = page.inner_text("body")
    missing_rows = [label for label in table["local"] if label not in body_labels]
    assert not missing_rows, f"missing from Overview tools table: {missing_rows}"
    assert len(table["local"]) >= 12, f"the Overview table only rendered {len(table['local'])} clients"
    expected_clients = {
        page.evaluate("(tool) => formatToolName(tool)", tool)
        for tool in page.evaluate("() => window.__TOKDASH_DEMO__.toolKeys")
    }
    unshown = sorted(expected_clients - set(table["all"]))
    assert not unshown, f"no machine reported traffic for: {unshown}"
    print(f"overview table: {len(table['local'])} clients on local, "
          f"{len(table['all'])} across the fleet (e.g. {', '.join(sorted(table['all'])[-4:])})")

    page.screenshot(path="verify-overview.png")

    # Sessions tab: every session tool the mock answers for must own a panel, and
    # that panel must carry loaded rows -- not a spinner, a "no data" row or an
    # error row. /api/sessions refuses a tool the mock does not know, so a session
    # harness added upstream and never mirrored here shows up as a dead panel.
    session_tools = page.evaluate("() => window.__TOKDASH_DEMO__.sessionTools")
    assert len(session_tools) >= 20, f"the demo only serves {len(session_tools)} session tools"
    page.locator("button, a").filter(has_text="Sessions").first.click()
    unloaded = session_tools
    for _ in range(20):
        unloaded = [tool for tool in session_tools if not page.evaluate(
            """(tool) => {
              const chip = document.getElementById(`${tool}PanelCount`);
              return !!chip && /^[1-9]/.test(chip.textContent.trim());
            }""", tool)]
        if not unloaded:
            break
        page.wait_for_timeout(1000)
    assert not unloaded, f"session panels without loaded rows: {unloaded}"
    print("session panels:", len(session_tools), "tools, all with rows")

    # Session speed (v2.6.9+) fails loudly on screen and silently at the API, which is how
    # two regressions reached the public demo: a batch that leaves a requested session out
    # is read as not-indexed, parking that cell on "Pending" beside a build hint that can
    # never resolve, and a session detail whose timeline cannot load prints "Timing history
    # could not be read." The demo's turns are synthetic and carry no response durations,
    # so both routes answer with the shell's own settled unmeasured state instead.
    # Speed cells sit three levels deep (tool details > project details > rows) and the
    # batch is IntersectionObserver-gated, so nothing is requested until a reader opens a
    # panel and a row is on screen. Both steps happen the way a reader would do them.
    speed_cells = """() => {
      const cells = [...document.querySelectorAll('[data-session-speed-cell]')]
        .filter((cell) => cell.querySelector('button')?.checkVisibility({ visibilityProperty: true }))
        .map((cell) => cell.innerText.trim()).filter(Boolean);
      return { count: cells.length,
               stuck: cells.filter((label) => /pending|not indexed|building|error/i.test(label)),
               sample: [...new Set(cells)].slice(0, 3) };
    }"""
    # Sessions nests three deep: tool panel > project > rows. Opening the tool panel
    # alone leaves the rows folded, so keep opening the next closed panel a reader
    # would open until a few speed cells are actually on screen -- a batch of one
    # session would not prove the batch answers all of them.
    for _ in range(8):
        heads = page.locator("details:has([data-session-speed-cell]) > summary")
        opened = False
        for head in range(heads.count()):
            panel = heads.nth(head)
            if not panel.is_visible() or panel.evaluate("el => el.parentElement.open"):
                continue  # open only what a reader would still have to open
            panel.click()
            opened = True
            page.wait_for_timeout(1000)
            if page.evaluate(speed_cells)["count"] >= 3:
                break
        if not opened or page.evaluate(speed_cells)["count"] >= 3:
            break

    marked = page.evaluate(
        """() => {
          const cell = [...document.querySelectorAll('[data-session-speed-cell]')]
            .find((c) => c.querySelector('button')?.checkVisibility({ visibilityProperty: true }));
          if (!cell) return null;
          cell.dataset.speedProbe = '1';
          cell.scrollIntoView({ block: 'center' });
          return { tool: cell._speedSession?.tool, session: cell._speedSession?.session_id };
        }"""
    )
    assert marked, "no session speed cell reached the viewport after opening a session panel"

    settled = {"count": 0, "stuck": ["<the batch never answered>"], "sample": []}
    for _ in range(20):
        settled = page.evaluate(speed_cells)
        if settled["count"] and not settled["stuck"]:
            break
        page.wait_for_timeout(1000)
    assert settled["count"], "no session speed cell painted a rate after opening a session panel"
    assert not settled["stuck"], (
        "session speed cells never settled; POST /api/session-speeds has to answer every "
        "requested session, the unmeasured ones too: " + str(settled["stuck"][:3])
    )
    assert page.evaluate(
        "() => document.querySelector('[data-speed-probe] button')?.innerText.trim()") == "—", \
        "the settled speed cell does not read as an unmeasured em dash"
    print("session speed cells:", settled["count"], "settled, as", settled["sample"])

    # The cell button opens the same session detail a row click opens, and the timing
    # panel inside it has to explain the missing chart instead of blaming the read.
    page.locator("[data-speed-probe] button").click()
    page.wait_for_selector("#sessionSpeedPanel:not([hidden])", timeout=30_000)
    speed_note = (page.locator("#sessionSpeedEmpty").inner_text() + " "
                  + page.locator("#sessionSpeedNote").inner_text()).lower()
    assert "could not be read" not in speed_note, f"speed timeline failed to load: {speed_note[:120]!r}"
    assert "not indexed" not in speed_note and "could not be loaded" not in speed_note, \
        f"speed timeline is stuck waiting for a build: {speed_note[:120]!r}"
    assert page.evaluate("() => document.getElementById('sessionSpeedEmpty').hidden") is False, \
        "speed panel shows neither a chart nor a reason"
    assert page.evaluate("() => document.getElementById('sessionSpeedRetry').hidden") is True, \
        "speed panel offers a retry, so it thinks the read failed"
    print("session speed modal:", page.locator("#sessionSpeedEmpty").inner_text()[:90])
    page.evaluate("() => closeSessionModal()")
    page.wait_for_timeout(400)

    page.screenshot(path="verify-sessions.png")

    # The mock fleet: three machines, every generated session owned by exactly one.
    fleet = page.evaluate("() => window.__TOKDASH_DEMO__.servers")
    print("fleet:", [(f["id"], f["sessions"]) for f in fleet])
    assert len(fleet) == 3, f"expected 3 demo servers, got {len(fleet)}"
    assert sum(f["sessions"] for f in fleet) == page.evaluate("() => window.__TOKDASH_DEMO__.sessionsCount"), \
        "server partitions do not cover the dataset exactly once"
    assert len({f["sessions"] for f in fleet}) == len(fleet), "server partitions are indistinguishable"

    # Servers tab (sidebar-era shell): the nav lives in the sidebar, the legacy
    # top tab strip is display:none at desktop widths. One card per server plus
    # the comparison table with its Combined column.
    tab = page.locator('.sidebar-nav-item[data-tab-target="servers"]')
    assert tab.count() == 1 and tab.is_visible(), "Servers nav item missing from the sidebar"
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
    # Every provider the demo reports must exist in the mock's catalog and reach the
    # screen under the name the dashboard gives it. A provider added upstream and
    # never mirrored here would leave the demo silently without it.
    catalog = page.evaluate("() => window.__TOKDASH_DEMO__.quotaProviders")
    extra = sorted(set(providers["local"]) - set(catalog))
    assert not extra, f"reported but not in the mock catalog: {extra}"
    quota_text = page.locator("#quotaServerBlocks").inner_text()
    unrendered = [
        page.evaluate("(provider) => quotaProviderLabel(provider)", provider)
        for provider in providers["local"]
        if page.evaluate("(provider) => quotaProviderLabel(provider)", provider) not in quota_text
    ]
    assert not unrendered, f"quota cards missing for: {unrendered}"
    print("quota cards:", ", ".join(
        page.evaluate("(provider) => quotaProviderLabel(provider)", p) for p in providers["local"]))
    page.screenshot(path="verify-quota.png", full_page=True)

    # Stats tab: the year heatmap and its Monthly Totals table. This is where a gap in
    # the demo dataset becomes something a visitor sees, because the table prints every
    # month of the year on display. January to June used to be rows of nothing. The tab
    # opens on the month view, so the year view has to be asked for.
    page.locator('.sidebar-nav-item[data-tab-target="stats"]').click()
    page.wait_for_timeout(1500)
    page.locator("#viewYear").click()
    page.wait_for_timeout(1500)

    def monthly_rows():
        return page.eval_on_selector_all(
            "#yearMonthlyTotalsTable tr[title]",
            """rows => rows.map((r) => ({
              month: r.getAttribute('title'),
              tokens: (r.children[1] || {}).textContent || '',
              cost: (r.children[2] || {}).textContent || '',
            }))""",
        )

    page.wait_for_function(
        "() => document.querySelectorAll('#yearMonthlyTotalsTable tr[title]').length >= 6",
        timeout=30_000,
    )
    EMPTY = ("0", "0.0", "0 B", "0 tokens", "-", "\u2014", "")

    def check_year(label):
        rows = monthly_rows()
        now = datetime.now()
        shown = page.inner_text("#yearTitle").strip()
        year = int("".join(ch for ch in shown if ch.isdigit()) or now.year)
        expected = (now.month if year == now.year else 12)
        months = [r["month"] for r in rows]
        assert len(rows) == expected, f"{label} {year}: {len(rows)} monthly rows, expected {expected}"
        assert months[0].startswith("Jan"), f"{label} {year}: monthly table does not start in January: {months[:2]}"
        dry = [r["month"] for r in rows if r["tokens"].strip() in EMPTY or r["cost"].strip() in EMPTY]
        assert not dry, f"{label} {year} has months with no tokens or cost: {dry}"
        cells = page.locator("#yearGrid .heatmap-year-cell").count()
        assert cells >= 300, f"{label} {year}: the heatmap painted {cells} cells"
        print(f"stats {label} {shown}: {len(rows)} monthly rows, Jan-{months[-1][:3]}, {cells} heatmap cells")
        return year

    stats_year = check_year("year")
    page.screenshot(path="verify-stats.png", full_page=True)

    # The year pager is the control that takes a visitor to last year, and the quick
    # ranges do the same in one click. Both used to land on an empty page.
    page.locator("#prevYear").click()
    page.wait_for_function(
        f"""() => {{
          const t = (document.getElementById('yearTitle') || {{}}).textContent || '';
          return t.includes('{stats_year - 1}');
        }}""",
        timeout=30_000,
    )
    page.wait_for_timeout(1200)
    check_year("previous year")
    page.screenshot(path="verify-stats-prev-year.png", full_page=True)
    page.locator("#nextYear").click()
    page.wait_for_timeout(1000)

    # Report tab: one facet feed paints the hero, the day map, the podium, the hour
    # and weekday rhythm, the agent table and both share cards. A facet or endpoint
    # the demo did not answer would surface as a banner or an em dash, so the check
    # is that nothing is missing rather than that some number is big.
    page.locator('.sidebar-nav-item[data-tab-target="report"]').click()
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
        "usageReportKTokens", "usageReportKCost", "usageReportKActive", "usageReportKDays",
        "usageReportKSessions", "usageReportKMessages")}
    print("report KPIs:", kpis)
    assert all(v not in ("<missing>", "", "-", "\u2014") for v in kpis.values()), \
        f"report hero KPI empty: {kpis}"
    assert page.locator("#usageReportBanner").is_hidden(), "report shows a missing-source banner"
    assert page.locator("#usageReportStatePanel").is_hidden(), "report shows its error/state panel"

    for label in ("usageReportRange", "usageReportStreak",
                  "usageReportFooter", "usageReportTz"):
        value = text("#" + label)
        assert value not in ("<missing>", "", "-", "\u2014"), f"{label} printed nothing"
    print("report streak:", text("#usageReportStreak"))

    # The podium note is apology-only: it appears to flag missing project rows or
    # partial facet coverage, neither of which the demo's synthetic fleet has, so a
    # silent note is the healthy answer here and a printed one is the regression.
    group_note = page.locator("#usageReportGroupNote")
    assert group_note.is_hidden(), "report flags facet gaps on complete demo data"
    print("report groups note:", (group_note.text_content() or "").strip()[:120] or "<none>")

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
    # The column rules mirror the UI's own row builder: sessions and runtime come from
    # /api/active-time, which answers only for tools with a session harness, and the
    # output column comes from /api/usage's per-app rows, which OpenClaw is not in.
    # An em dash anywhere else means the tool keys used by /api/usage, /api/insights
    # and /api/active-time no longer agree.
    allowance = page.evaluate(
        """async () => {
          const usage = await (await fetch('/api/usage?period=60')).json();
          const harness = new Set(window.__TOKDASH_DEMO__.sessionTools);
          const out = {};
          for (const tool of Object.keys(usage.by_tool)) {
            const app = (usage.apps || {})[tool];
            out[formatToolName(tool)] = (harness.has(tool) ? 0 : 2)
              + (app && app.tokens_out !== undefined ? 0 : 1);
          }
          return out;
        }"""
    )
    dashed = page.evaluate(
        """() => Object.fromEntries([...document.querySelectorAll('#usageReportAgentsBody tr')]
             .map((tr) => [tr.querySelector('.tool-identity')?.getAttribute('aria-label') || '?',
               [...tr.querySelectorAll('td')].filter(
                 (td) => ['-', '\\u2014'].includes(td.textContent.trim())).length])
             .filter(([, cells]) => cells > 0))"""
    )
    print("report agent rows with an em dash:", dashed)
    over = {label: cells for label, cells in dashed.items() if cells > allowance.get(label, 0)}
    assert not over, f"report agent cells fell back to an em dash: {over}"

    # The report reads one server at a time, and the demo fleet has three.
    options = page.eval_on_selector_all("#usageReportServer option", "els => els.length")
    print("report server options:", options)
    assert options == 3, f"report server picker offers {options} of 3 servers"

    # Two cards per tier, a light one and a dark one, whatever theme is on screen.
    assert page.locator("#usageReportGreenCards canvas").count() == 2, "green share cards incomplete"
    assert page.locator("#usageReportAmberCards canvas").count() == 2, "amber share cards incomplete"
    audit = page.evaluate("() => document.getElementById('usageReportStack')?.dataset?.cardAudit || ''")
    assert "OVERFLOW" not in audit, f"a share card overflows its canvas: {audit}"
    # The share-card code itself is pinned by check_demo_sync.py, which byte-compares
    # this page against the released UI, so what is left to prove here is that the
    # ranking prints rows at all. Only the amber card ranks projects, and it
    # surrenders rows just when the canvas cannot hold them: an amber card with none
    # means the ranking or the fit ladder broke, not that the dataset is thin.
    amber = [part for part in audit.split(" | ") if part.startswith("amber/")]
    assert amber, f"the audit names no amber card: {audit}"
    thin = [part for part in amber if " 0 project rows" in part]
    assert not thin, f"the amber share card printed no project rows: {thin}"
    print("share card fit:", " | ".join(part.split(",")[-3].strip() for part in amber))
    print("card fit:", audit[:150])
    page.screenshot(path="verify-report.png", full_page=True)

    # Model output speed (v2.6.9+) is a page the demo cannot fill: the synthetic
    # turns carry no response durations, so the mock answers with the API's own cold
    # snapshot. That is only a good demo while it renders the state upstream designed
    # for it, so pin that here -- a route the mock dropped would print the shell's
    # "Output speed could not be loaded." line and look like a broken product.
    page.locator('.sidebar-nav-item[data-tab-target="speed"]').click()
    page.wait_for_timeout(2500)
    assert page.locator("#speed-content").is_visible(), "Model output speed does not open"
    speed_state = text("#usageReportSpeedState")
    body = text("#usageReportSpeedBody")
    assert "could not be loaded" not in speed_state.lower(), f"speed page failed to load: {speed_state!r}"
    assert "no measured output speed" in body.lower(), f"speed table is not on its empty state: {body[:120]!r}"
    sources = text("#usageReportSpeedSources")
    assert "Freebuff" in sources, f"speed availability omits the newest client: {sources[:120]!r}"
    print("speed page:", speed_state, "|", sources[:70])
    page.screenshot(path="verify-speed.png", full_page=True)

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

# This run aborts every off-origin request on purpose, so the shell's own health
# probes for the CDN and for Google Fonts fail by design; both resolve on the live
# site, which is why the shell logs them at all.
OFFLINE_EXPECTED = ("cdn.tailwindcss.com", "googletagmanager", "Failed to load Google Fonts")
real_errors = [e for e in errors if not any(needle in e for needle in OFFLINE_EXPECTED)]
print("console errors:", real_errors if real_errors else "none")
assert not real_errors, "console errors on the demo page"
print("BROWSER-CHECK-OK")
