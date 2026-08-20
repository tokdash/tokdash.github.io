"""Browser smoke test for the /demo/ page: load it in headless Firefox, fail on
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
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"http://127.0.0.1:{PORT}/demo/", wait_until="networkidle")
    page.wait_for_timeout(2500)

    def text(sel):
        return page.locator(sel).inner_text().strip() if page.locator(sel).count() else "<missing>"

    print("agent-time card:", text("#overviewActiveTime"))
    print("agent-time delta:", text("#overviewActiveDelta"))
    print("agent-time meta:", text("#overviewActiveMeta")[:60])
    assert text("#overviewActiveTime") not in ("<missing>", "-", ""), "agent-time card empty"

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
