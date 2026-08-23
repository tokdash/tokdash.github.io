"""Browser smoke test for the /demo/ page: load it in headless Chromium, fail on
console errors or a missing agent-time figure, and save screenshots."""
import http.server
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
    # 6-col grid at lg, 16px gaps, p-5 cards) and applies word-break the same
    # way Tailwind's break-all does, so it works without the CDN.
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
          const measure = (fixed) => {
            el.classList.toggle('td-ovf-test', fixed);
            el.style.width = innerW + 'px';
            const scroll = el.scrollWidth;
            el.style.width = '';
            return scroll;
          };
          const withoutFix = measure(false);
          const withFix = measure(true);
          el.classList.remove('td-ovf-test');
          probe.remove();
          return { innerW: Math.round(innerW), withoutFix, withFix };
        }"""
    )
    print(f"top-model fit: {name!r} innerW={fit['innerW']}px "
          f"scrollWithoutFix={fit['withoutFix']} scrollWithFix={fit['withFix']}")
    assert fit["withoutFix"] > fit["innerW"], "overflow probe is vacuous (name fits without the fix)"
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

    browser.close()

real_errors = [e for e in errors if "cdn.tailwindcss.com" not in e and "googletagmanager" not in e]
print("console errors:", real_errors if real_errors else "none")
assert not real_errors, "console errors on the demo page"
print("BROWSER-CHECK-OK")
