"""Browser regression checks for the approved supported-agent ticker."""
import argparse
import functools
import http.server
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = ["OpenCode","Codex","Claude Code","Gemini CLI","Antigravity","OpenClaw","Kimi CLI","MiMo Code","Grok Build","Pi","omp","Kilo Code","Cline","GitHub Copilot CLI","Hermes","DeepSeek Harness","Reasonix","ZCode","WorkBuddy","Qoder IDE","Qoder CLI","Zed","Qwen Code","Crush","Muse Code","Freebuff","MiniMax Code","Devin CLI"]
COUNTS = {"en": "twenty-eight", "zh": "二十八", "ja": "28", "ko": "28", "es": "veintiocho", "pt": "vinte e oito"}
ARGS = ["--disable-gpu", "--disable-features=Vulkan,VizDisplayCompositor"]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--group", choices=["all", "motion", "fallbacks", "locales"], default="all")
parser.add_argument("--output", type=Path, default=ROOT / "output/ticker-checks")
options = parser.parse_args()
options.output.mkdir(parents=True, exist_ok=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_port}/"
results = []


def check_links(page):
    links = page.locator(".tick-item:not([aria-hidden])")
    assert links.count() == len(EXPECTED), "supported-agent list lost or duplicated an entry"
    names = links.evaluate_all("els => els.map(el=>el.getAttribute('aria-label') || el.textContent.trim())")
    assert names == EXPECTED, names
    assert page.get_by_role("link", name="MiMo Code", exact=True).count() == 1, "MiMo link is unnamed"
    assert page.locator(".tick-item[aria-hidden='true']:not([tabindex='-1'])").count() == 0
    assert page.evaluate("document.querySelector('#tools').nextElementSibling.id === 'start'"), "ticker must sit directly between hero and quickstart"
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "ticker causes horizontal overflow"


def image_check(page):
    page.locator("#tools").evaluate("el=>el.scrollIntoView({block:'center'})")
    page.locator(".tick-logo").evaluate_all("els=>els.forEach(el=>el.loading='eager')")
    page.wait_for_function("Array.from(document.querySelectorAll('.tick-logo')).every(el=>el.complete && el.naturalWidth>0)", timeout=10000)


def static_check(page):
    check_links(page)
    assert page.locator(".tick-track").evaluate("el=>getComputedStyle(el).animationName") == "none"
    assert page.locator(".tick-item[aria-hidden='true']").evaluate_all("els=>els.every(el=>getComputedStyle(el).display==='none')")
    assert not page.locator(".ticker-control").is_visible()
    assert page.locator(".tick-item:not([aria-hidden])").evaluate_all("els=>els.every(el=>{const r=el.getBoundingClientRect(); return r.left>=-1 && r.right<=innerWidth+1;})")


try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=ARGS)

        def open_page(width=1440, mode="motion", theme="light"):
            context = browser.new_context(
                viewport={"width": width, "height": 900 if width > 400 else 844},
                java_script_enabled=mode != "no_js",
                reduced_motion="reduce" if mode == "reduced" else "no-preference",
                service_workers="block",
                color_scheme=theme,
            )
            context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(url) else route.abort())
            context.add_init_script("""localStorage.setItem('tokdash_lander_seen','1');
              Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>8});
              Object.defineProperty(navigator,'deviceMemory',{get:()=>MEMORY});""".replace("MEMORY", "2" if mode == "low_memory" else "8"))
            page = context.new_page()
            page.set_default_timeout(5000)
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url, wait_until="load")
            page.locator("#tools").evaluate("el=>el.scrollIntoView({block:'center'})")
            page.wait_for_timeout(100)
            return context, page, errors

        if options.group in ("all", "motion"):
            for width, theme in [(1440, "light"), (1440, "dark"), (390, "light"), (390, "dark")]:
                context, page, errors = open_page(width=width, theme=theme)
                check_links(page)
                image_check(page)
                page.wait_for_function("document.querySelector('.ticker').classList.contains('in')", timeout=5000)
                # Both copies must have identical width, including trailing separators.
                error = page.evaluate("""() => {
                  const links=[...document.querySelectorAll('.tick-item')];
                  return Math.abs((links[28].offsetLeft-links[0].offsetLeft)-document.querySelector('.tick-track').getBoundingClientRect().width/2);
                }""")
                assert error <= 1, f"ticker loop has a {error}px seam"
                page.screenshot(path=str(options.output / f"ticker-{width}-{theme}.png"))

                # Enter with Tab after half a cycle: the first original was offscreen.
                page.evaluate("""() => {
                  document.querySelector('.tick-track').getAnimations()[0].currentTime=26000;
                  document.querySelector('.ticker-control').focus();
                }""")
                page.keyboard.press("Tab")
                assert page.locator(".ticker").evaluate("el=>el.classList.contains('is-keyboard')")
                for name in EXPECTED:
                    state = page.evaluate("""() => {
                      const el=document.activeElement,r=el.getBoundingClientRect();
                      return {name:el.getAttribute('aria-label')||el.textContent.trim(),left:r.left,right:r.right,top:r.top,bottom:r.bottom};
                    }""")
                    assert state["name"] == name, state
                    assert state["left"] >= -1 and state["right"] <= width + 1, state
                    assert state["bottom"] > 0 and state["top"] < page.viewport_size["height"], state
                    page.keyboard.press("Tab")
                assert not page.locator(".ticker").evaluate("el=>el.classList.contains('is-keyboard')")

                # Pause works as a toggle; pointer activation must not reflow a link.
                button = page.locator(".ticker-control")
                button.click()
                assert button.get_attribute("aria-pressed") == "true"
                assert page.locator(".tick-track").evaluate("el=>getComputedStyle(el).animationPlayState") == "paused"
                page.locator("#tools").evaluate("el=>el.scrollIntoView({block:'center'})")
                first = page.locator(".tick-item").first
                first.evaluate("el=>el.closest('.tick-track').getAnimations()[0].currentTime=0")
                with page.expect_popup() as popup:
                    first.click()
                popup.value.close()
                assert not page.locator(".ticker").evaluate("el=>el.classList.contains('is-keyboard')"), "pointer click reflows the moving row"
                button.click()
                assert button.get_attribute("aria-pressed") == "false"
                # Hover still eases to the chosen one-fifth speed after a focus cycle.
                row = page.locator(".tick-row")
                row.hover()
                page.wait_for_timeout(400)
                rate = page.locator(".tick-track").evaluate("el=>el.getAnimations()[0].playbackRate")
                assert abs(rate - 0.2) < 0.01, rate
                page.mouse.move(0, 0)
                page.wait_for_timeout(400)
                assert abs(page.locator(".tick-track").evaluate("el=>el.getAnimations()[0].playbackRate") - 1) < 0.01
                assert not errors, errors
                results.append({"group": "motion", "width": width, "theme": theme, "agents": len(EXPECTED), "seamError": error})
                context.close()

        if options.group in ("all", "fallbacks"):
            for mode in ["reduced", "no_js", "low_memory"]:
                for width in [1440, 390]:
                    context, page, errors = open_page(width=width, mode=mode)
                    static_check(page)
                    image_check(page)
                    # A failed wordmark still has a visible and accessible name.
                    if mode != "no_js":
                        mimo = page.get_by_role("link", name="MiMo Code", exact=True)
                        mimo.locator("img").evaluate("el=>el.dispatchEvent(new Event('error'))")
                        assert mimo.locator("span").is_visible()
                    assert not errors, errors
                    results.append({"group": "fallbacks", "mode": mode, "width": width, "agents": len(EXPECTED)})
                    context.close()

        if options.group in ("all", "locales"):
            context, page, errors = open_page(mode="reduced")
            for language, count in COUNTS.items():
                page.evaluate("lang=>window.__applyLang(lang)", language)
                title = page.locator("#toolsHeading").inner_text()
                subtitle = page.locator("[data-i18n='tools.sub']").inner_text()
                pause = page.locator("[data-i18n='tools.pause']").text_content()
                assert title and pause and count in subtitle, (language, title, subtitle, pause)
                assert "28" in page.locator("[data-i18n='hero.proof1']").inner_text()
                check_links(page)
                results.append({"group": "locales", "language": language, "heading": title})
            assert not errors, errors
            context.close()

        browser.close()
finally:
    server.shutdown()
    server.server_close()

(options.output / f"{options.group}-results.json").write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n")
print(json.dumps(results, ensure_ascii=False))
print("TICKER-CHECK-OK")
