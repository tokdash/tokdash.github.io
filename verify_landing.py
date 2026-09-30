"""Browser check for the landing page: renders offline, speaks every shipped
language, and carries the current copy (no stale version chips, no claims the
product cannot keep)."""
import html as html_module
import http.server
import re
import threading
from html.parser import HTMLParser
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright

ROOT = Path(__file__).resolve().parent
PORT = 8972
BROWSER_ARGS = [
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-features=Vulkan,VizDisplayCompositor",
]
# Languages the landing page ships, and one string that must appear in each
# language's copy of the multi-server section heading.
def flatten(markup: str) -> str:
    """Dictionary values and markup text compared as plain, collapsed text."""
    return " ".join(html_module.unescape(re.sub(r"<[^>]+>", "", markup)).replace("\xa0", " ").split())


def english_dictionary(page_html: str) -> dict[str, str]:
    start = page_html.index("var I18N = {")
    block = page_html[start:page_html.index("\n      };", start)]
    en = block[block.index("en: {"):block.index("\n        },")]
    return {
        m.group(1): flatten(m.group(2))
        for m in re.finditer(r"^          '([A-Za-z0-9_.]+)': `(.*?)`,$", en, re.M)
    }


class _Fallbacks(HTMLParser):
    """Inline text of every data-i18n element: what a no-JS visitor reads."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.found: dict[str, str] = {}
        self.open: list[tuple[str, str, int]] = []
        self.depth = 0

    def handle_starttag(self, tag, attrs):
        self.depth += 1
        attrs = dict(attrs)
        if "data-i18n" in attrs:
            self.open.append((attrs["data-i18n"], tag, self.depth))
            self.found.setdefault(attrs["data-i18n"], "")

    def handle_endtag(self, tag):
        if self.open and self.open[-1][1] == tag and self.open[-1][2] == self.depth:
            self.open.pop()
        self.depth -= 1

    def handle_data(self, data):
        if self.open:
            key = self.open[-1][0]
            self.found[key] += data


def markup_fallbacks(page_html: str) -> dict[str, str]:
    parser = _Fallbacks()
    parser.feed(page_html)
    return {k: flatten(v) for k, v in parser.found.items()}


LANG_HEADING = {
    "en": "one total",
    "zh": "一个总量",
    "ja": "ひとつの合計",
    "ko": "하나의 합계",
    "es": "un solo total",
    "pt": "um total só",
}
# Feature card 2 is the Report tab and card 6 carries the style-theme count, so
# both are checked per language rather than only in the English fallback.
LANG_REPORT = {
    "en": "Report tab",
    "zh": "报告标签页",
    "ja": "Report タブ",
    "ko": "Report 탭",
    "es": "Pestaña Report",
    "pt": "Aba Report",
}
THEME_COUNT = "17"


class ThreadedServer(http.server.ThreadingHTTPServer):
    """Threaded, with a deep backlog: the page fetches ~30 assets at once, and
    unlike socketserver.TCPServer it can rebind a port left in TIME_WAIT."""
    request_queue_size = 128


def serve():
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=ROOT, **k)
    with ThreadedServer(("127.0.0.1", PORT), handler) as httpd:
        httpd.serve_forever()


threading.Thread(target=serve, daemon=True).start()

errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=BROWSER_ARGS)
    no_js = browser.new_context(java_script_enabled=False).new_page()
    no_js.goto(f"http://127.0.0.1:{PORT}/", wait_until="domcontentloaded")
    assert no_js.locator("#landerOverlay").evaluate(
        "el => getComputedStyle(el).display"
    ) == "none", "intro must not block visitors with JavaScript disabled"
    no_js.close()

    no_anime = browser.new_page()
    no_anime.route("**/static/anime.min.js", lambda route: route.abort())
    no_anime.goto(f"http://127.0.0.1:{PORT}/", wait_until="domcontentloaded")
    assert no_anime.locator("#landerOverlay").evaluate(
        "el => getComputedStyle(el).display"
    ) == "none", "intro must not block visitors when Anime.js is unavailable"
    no_anime.close()

    page = browser.new_page(viewport={"width": 1440, "height": 960, }, reduced_motion="reduce")
    # Landing CSS is prebuilt, so the page must render with no network at all.
    page.route(
        "**/*",
        lambda route: route.abort()
        if route.request.url.startswith("http") and "127.0.0.1" not in route.request.url
        else route.continue_(),
    )
    def on_console(message):
        if message.type != "error":
            return
        # Blocked third-party loads (fonts, analytics, Store badges) are expected
        # offline; anything pointing at our own origin is a real failure.
        location = (message.location or {}).get("url") or ""
        if location.startswith("http") and "127.0.0.1" not in location:
            return
        errors.append(message.text)

    page.on("console", on_console)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"http://127.0.0.1:{PORT}/", wait_until="domcontentloaded")
    page.wait_for_timeout(800)
    assert page.locator("#landerOverlay").evaluate(
        "el => getComputedStyle(el).display"
    ) == "none", "reduced motion should skip the intro"
    assert page.locator(".reveal").evaluate_all(
        "els => els.every(el => getComputedStyle(el).opacity === '1')"
    ), "reduced motion should show all sections without scroll fades"

    text = lambda sel: " ".join(page.locator(sel).first.inner_text().split())

    # Stale marketing copy stays out of the page: the version chip and the two
    # claims the product does not implement.
    body = page.inner_text("body")
    for stale in ("v0.6.0", "ccusage", "recoverable", "Compare models for cheaper swaps", "10 themes"):
        assert stale not in body, f"stale copy on the landing page: {stale!r}"

    # Multi-server: feature card plus its own section, with the fleet mockup.
    assert page.locator("#features .surface").count() == 9, "features grid is not nine cards"
    assert page.locator("#servers").count() == 1, "multi-server section missing"
    assert text("#servers h2"), "multi-server heading is empty"
    assert page.locator("#servers .srv-row").count() == 3, "fleet mockup should show three servers"
    assert page.locator("#servers .srv-chip").count() == 5, "fleet mockup quota chips changed"
    print("servers section:", text("#servers h2"), "|", text("#servers .chip"))
    print("feature 2:", text("#features .surface >> nth=1"))
    print("feature 9:", text("#features .surface >> nth=8"))
    assert "Report" in text("#features .surface >> nth=1"), "feature card 2 is not the Report tab"
    assert THEME_COUNT in text("#features .surface >> nth=5"), "theme count card is stale"

    # Cost section reads the data instead of inventing a savings figure.
    assert "Cache hit" in text("#optimize .readout-box"), "cost readout did not land"

    # English fallback markup must match the English dictionary, so the page reads
    # the same before JavaScript runs and with it switched off.
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    dictionary = english_dictionary(html)
    drift = [
        f"{key}: markup {text!r} vs dictionary {dictionary[key]!r}"
        for key, text in markup_fallbacks(html).items()
        if dictionary.get(key) != text
    ]
    assert not drift, "markup fallbacks drifted from the dictionary: " + "; ".join(drift[:6])
    print(f"fallback copy matches the dictionary ({len(drift)} drifts): {len(dictionary)} keys checked")

    page.screenshot(path="verify-landing-desktop.png", full_page=True)

    seen = {}
    for lang, needle in LANG_HEADING.items():
        page.evaluate("([l]) => localStorage.setItem('tokdash-site-lang', l)", [lang])
        page.reload(wait_until="domcontentloaded")
        page.wait_for_timeout(300)
        heading, card = text("#servers h2"), text("#features .surface >> nth=8")
        report, themes = text("#features .surface >> nth=1"), text("#features .surface >> nth=5")
        assert needle in heading, f"{lang}: heading {heading!r} lacks {needle!r}"
        assert card, f"{lang}: the multi-server feature card is empty"
        assert LANG_REPORT[lang] in report, f"{lang}: Report-tab card reads {report!r}"
        assert THEME_COUNT in themes, f"{lang}: theme-count card reads {themes!r}"
        seen[lang] = card
    untranslated = [k for k, v in seen.items() if k != "en" and v == seen["en"]]
    assert not untranslated, f"feature card 9 untranslated in {untranslated}"
    print("languages render:", ", ".join(LANG_HEADING))

    mobile = browser.new_page(viewport={"width": 390, "height": 844}, reduced_motion="reduce")
    mobile.route(
        "**/*",
        lambda route: route.abort()
        if route.request.url.startswith("http") and "127.0.0.1" not in route.request.url
        else route.continue_(),
    )
    mobile.goto(f"http://127.0.0.1:{PORT}/", wait_until="domcontentloaded")
    mobile.wait_for_timeout(800)
    mobile.screenshot(path="verify-landing-mobile.png", full_page=True)
    # Nothing may spill past the viewport on a phone.
    overflow = mobile.evaluate(
        """() => {
          const w = document.documentElement.clientWidth;
          return [...document.querySelectorAll('#servers *, #features *')]
            .filter((el) => el.getBoundingClientRect().right > w + 1)
            .map((el) => el.className + ' ' + Math.round(el.getBoundingClientRect().right));
        }"""
    )
    assert not overflow, f"mobile overflow in the new sections: {overflow[:6]}"

    intro = browser.new_page(viewport={"width": 1440, "height": 960})
    intro.goto(f"http://127.0.0.1:{PORT}/", wait_until="domcontentloaded")
    intro.wait_for_function(
        "getComputedStyle(document.querySelector('#landerExploreWrap')).opacity === '1'",
        timeout=15000,
    )
    intro.locator("#landerExploreBtn").click()
    assert intro.locator("#landerOverlay").evaluate(
        "el => getComputedStyle(el).display"
    ) != "none", "Explore must keep the overlay visible during its exit animation"
    intro.wait_for_function(
        "document.documentElement.classList.contains('lander-skipped')",
        timeout=5000,
    )
    assert not intro.locator("body").evaluate(
        "el => el.classList.contains('lander-locked')"
    ), "Explore must unlock scrolling after the exit animation"
    intro.close()

    # The intro on a phone and on a short landscape screen. Every line must fit the
    # stage, the heading must not start above the scroll origin, and the stage must
    # scroll to Explore under a wheel while Lenis is stopped for the intro.
    for viewport in ({"width": 390, "height": 844}, {"width": 844, "height": 390}):
        size = f"{viewport['width']}x{viewport['height']}"
        small = browser.new_page(viewport=viewport)
        small.on("pageerror", lambda e: errors.append(str(e)))
        small.goto(f"http://127.0.0.1:{PORT}/", wait_until="domcontentloaded")
        small.wait_for_function(
            "getComputedStyle(document.querySelector('#landerExploreWrap')).opacity === '1'",
            timeout=15000,
        )
        fit = small.evaluate(
            """() => {
              const stage = document.getElementById('landerStage');
              const box = stage.getBoundingClientRect();
              const pad = parseFloat(getComputedStyle(stage).paddingLeft);
              const spill = [...stage.querySelectorAll('.m-word')].filter((w) => {
                const r = w.getBoundingClientRect();
                return r.left < box.left + pad - 1 || r.right > box.right - pad + 1;
              });
              return {
                spill: spill.map((w) => w.textContent),
                cutAbove: document.getElementById('landerQuery').getBoundingClientRect().top < box.top - 1,
              };
            }"""
        )
        assert not fit["spill"], f"{size} intro: words run past the stage: {fit['spill'][:6]}"
        assert not fit["cutAbove"], f"{size} intro: the heading starts above the scroll origin"
        stage_box = small.locator("#landerStage").bounding_box()
        small.mouse.move(stage_box["x"] + stage_box["width"] / 2, stage_box["y"] + stage_box["height"] / 2)
        small.mouse.wheel(0, 800)
        small.wait_for_timeout(500)
        assert small.evaluate(
            """() => {
              const b = document.getElementById('landerExploreBtn').getBoundingClientRect();
              const s = document.getElementById('landerStage').getBoundingClientRect();
              return b.top >= s.top - 1 && b.bottom <= Math.min(innerHeight, s.bottom) + 1;
            }"""
        ), f"{size} intro: scrolling the stage does not bring Explore into view"
        small.locator("#landerExploreBtn").click()
        small.wait_for_function(
            "document.documentElement.classList.contains('lander-skipped')",
            timeout=5000,
        )
        small.close()
    print("intro fits and scrolls to Explore: 390x844, 844x390")

    # Scroll-triggered animations with motion on. Every page above runs reduced
    # motion or stays on the intro, so an Anime.js error here (such as a v4-only
    # easing name) would leave scrolled-to text and row icons hidden unnoticed.
    # The phone pass also catches split headings that can no longer wrap.
    settled = """() => !document.querySelector('.scramble-char.pending')
      && [...document.querySelectorAll('.opt-li .opt-ic')].every((ic) => ic.classList.contains('morphed'))
      && [...document.querySelectorAll('.heading-char')].every((c) => c.classList.contains('in'))"""
    for viewport in ({"width": 1440, "height": 960}, {"width": 390, "height": 844}):
        motion = browser.new_context(viewport=viewport)
        motion.add_init_script("sessionStorage.setItem('tokdash_lander_seen', 'true')")
        moving = motion.new_page()
        moving.route(
            "**/*",
            lambda route: route.abort()
            if route.request.url.startswith("http") and "127.0.0.1" not in route.request.url
            else route.continue_(),
        )
        moving.on("console", on_console)
        moving.on("pageerror", lambda e: errors.append(str(e)))
        moving.goto(f"http://127.0.0.1:{PORT}/", wait_until="domcontentloaded")
        animated = moving.locator(
            "[data-i18n='feat.h'], [data-i18n='feat.sub'], .opt-li, [data-i18n='cta.h']"
        )
        for i in range(animated.count()):
            animated.nth(i).scroll_into_view_if_needed()
            moving.wait_for_timeout(250)
        try:
            moving.wait_for_function(settled, timeout=10000)
        except PlaywrightTimeoutError:
            pass
        width = viewport["width"]
        assert moving.evaluate(settled), f"{width}px: with motion on, scrolled-to text or row icons never finished animating"

        # Every block has to arrive. A reveal whose tween never runs leaves the
        # whole section at zero opacity, which reads as a blank page with the
        # boxes and the text missing, and the settled check above passes anyway
        # because it only looks at headings and row icons.
        #
        # Each reveal is brought to the middle of the viewport in turn rather
        # than jumped past in a sweep. A block shorter than the scroll step can
        # pass through the observer's window between two sampled positions and
        # never be seen, which is a flaw in the sweep and not in the page.
        blocks = moving.locator(".reveal")
        for i in range(blocks.count()):
            blocks.nth(i).scroll_into_view_if_needed()
            moving.wait_for_timeout(70)
        try:
            moving.wait_for_function(
                """() => [...document.querySelectorAll('.reveal')].every(
                    (el) => el.classList.contains('in') && getComputedStyle(el).opacity === '1')""",
                timeout=15000,
            )
        except PlaywrightTimeoutError:
            pass
        hidden = moving.evaluate(
            """() => [...document.querySelectorAll('.reveal')]
              .filter((el) => getComputedStyle(el).opacity !== '1' || !el.classList.contains('in'))
              .map((el) => el.className.slice(0, 40))"""
        )
        assert not hidden, f"{width}px: {len(hidden)} blocks never revealed, page reads blank: {hidden[:4]}"
        clipped = moving.evaluate(
            """() => [...document.querySelectorAll(
                "[data-i18n='feat.h'], [data-i18n='feat.sub'], .opt-li [data-i18n], [data-i18n='cta.h']")]
              .filter((el) => el.scrollWidth > el.clientWidth + 1)
              .map((el) => el.getAttribute('data-i18n'))"""
        )
        assert not clipped, f"{width}px: animated text overflows its box: {clipped[:6]}"
        print(
            f"motion-on animations settled at {width}px:",
            animated.count(), "targets and", blocks.count(), "blocks, all revealed",
        )
        motion.close()

    browser.close()

print("console errors:", errors if errors else "none")
assert not errors, "console errors on the landing page"
print("LANDING-CHECK-OK")
