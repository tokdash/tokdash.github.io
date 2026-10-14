// ---- Theme toggle with SVG morphing ----
(function () {
  var root = document.documentElement;
  var themeToggle = document.getElementById('themeToggle');
  var themeSvg = document.getElementById('themeSvg');
  var themeBody = themeSvg ? themeSvg.querySelector('.theme-body') : null;
  var themeRays = themeSvg ? themeSvg.querySelector('.theme-rays') : null;

  var MOON_D = 'M 21 12.8 A 9 9 0 1 1 11.2 3 A 7 7 0 0 0 21 12.8 Z';
  var SUN_D  = 'M 17 12.0 A 5 5 0 1 1 7.0 12 A 5 5 0 0 1 17 12.0 Z';

  function sync(animate) {
    var isDark = root.classList.contains('dark');
    if (!themeBody || !themeRays) return;

    if (animate && typeof anime !== 'undefined' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (isDark) {
        // Morph to Sun
        anime({
          targets: themeBody,
          d: [{ value: SUN_D }],
          rotate: [0, 180],
          duration: 550,
          easing: 'easeInOutExpo'
        });
        // The rays are visible while they open rather than appearing at
        // the same moment they finish opening. Fading in on its own
        // shorter timing, the way the reveals do, is the difference
        // between watching a sun come up and watching a shape materialise.
        anime({
          targets: themeRays,
          opacity: { value: [0, 1], duration: 240, easing: 'linear' },
          scale: [0.2, 1],
          rotate: [-45, 0],
          duration: 500,
          easing: 'easeInOutExpo'
        });
      } else {
        // Morph to Moon
        anime({
          targets: themeBody,
          d: [{ value: MOON_D }],
          rotate: [180, 0],
          duration: 550,
          easing: 'easeInOutExpo'
        });
        // Going the other way the fade is late rather than early, so the
        // rays are still there while they fold away instead of vanishing
        // and then shrinking into nothing.
        anime({
          targets: themeRays,
          opacity: { value: [1, 0], duration: 320, easing: 'linear' },
          scale: [1, 0.2],
          rotate: [0, -45],
          duration: 450,
          easing: 'easeInOutExpo'
        });
      }
    } else {
      themeBody.setAttribute('d', isDark ? SUN_D : MOON_D);
      themeBody.style.transform = isDark ? 'rotate(180deg)' : 'rotate(0deg)';
      themeRays.style.opacity = isDark ? '1' : '0';
      themeRays.style.transform = isDark ? 'scale(1) rotate(0deg)' : 'scale(0.2) rotate(-45deg)';
    }
  }

  sync(false);
  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      root.classList.toggle('dark');
      try { localStorage.setItem('tokdash-site-theme', root.classList.contains('dark') ? 'dark' : 'light'); } catch (e) {}
      sync(true);
    });
  }
})();

// ---- Copy-to-clipboard with SVG Morphing Engine ----
function copyCmd(el) {
  if (!el || el.dataset.copying === 'true') return;
  el.dataset.copying = 'true';
  var cmd = el.getAttribute('data-cmd') || '';

  var front = el.querySelector('.copy-front');
  var back = el.querySelector('.copy-back');

  var BOX_D  = 'M 9 9 L 20 9 L 20 20 L 9 20 L 9 9';
  var TICK_D = 'M 5 13 L 9 17 L 19 7 L 19 7 L 19 7';
  var BACK_EXPAND   = 'M 5 15 L 5 5 L 16 5';
  var BACK_COLLAPSE = 'M 5 13 L 5 13 L 5 13';

  var isReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var reset = function () {
    el.classList.remove('copied');
    if (typeof anime !== 'undefined' && !isReduced && front) {
      anime({
        targets: front,
        d: [{ value: BOX_D }],
        strokeWidth: [{ value: 2 }],
        easing: 'easeInOutExpo',
        duration: 450,
        complete: function () {
          delete el.dataset.copying;
        }
      });
      if (back) {
        anime({
          targets: back,
          d: [{ value: BACK_EXPAND }],
          opacity: [{ value: 1 }],
          easing: 'easeInOutExpo',
          duration: 400
        });
      }
    } else {
      if (front) {
        front.setAttribute('d', BOX_D);
        front.setAttribute('stroke-width', '2');
      }
      if (back) {
        back.setAttribute('d', BACK_EXPAND);
        back.style.opacity = '1';
      }
      delete el.dataset.copying;
    }
  };

  var success = function () {
    el.classList.add('copied');
    if (typeof anime !== 'undefined' && !isReduced && front) {
      anime({
        targets: front,
        d: [{ value: TICK_D }],
        strokeWidth: [{ value: 2.5 }],
        easing: 'easeInOutExpo',
        duration: 480
      });
      if (back) {
        anime({
          targets: back,
          d: [{ value: BACK_COLLAPSE }],
          opacity: [{ value: 0 }],
          easing: 'easeInOutExpo',
          duration: 360
        });
      }
    } else {
      if (front) {
        front.setAttribute('d', TICK_D);
        front.setAttribute('stroke-width', '2.5');
      }
      if (back) {
        back.style.opacity = '0';
      }
    }
    clearTimeout(el._copyTimer);
    el._copyTimer = setTimeout(reset, 1600);
  };

  var failure = function () {
    reset();
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(cmd).then(success).catch(function () {
      try {
        var t = document.createElement('textarea'); t.value = cmd; document.body.appendChild(t);
        t.select(); var ok = document.execCommand('copy'); document.body.removeChild(t);
        if (ok) success(); else failure();
      } catch (e) { failure(); }
    });
  } else {
    try {
      var t = document.createElement('textarea'); t.value = cmd; document.body.appendChild(t);
      t.select(); var ok = document.execCommand('copy'); document.body.removeChild(t);
      if (ok) success(); else failure();
    } catch (e) { failure(); }
  }
};
// One delegated listener covers every install-command pill on the page
// (hero and closing CTA alike), so a new .cmd needs no wiring of its own.
document.addEventListener('click', function (e) {
  var el = e.target.closest ? e.target.closest('[data-cmd]') : null;
  if (el) copyCmd(el);
});

// ---- onScroll: one rAF-coalesced driver for every scroll-linked effect ----
// Lenis fires scroll at frame rate and a momentum trackpad fires faster, so
// the layout reads are coalesced into one frame. Every subscriber gets the
// same normalised progress: 0 at the top, 1 at the last scrollable pixel.
// ---- Capability gate ----
// Everything decorative on this page asks this first. The question is not
// "does the user want motion" but "can this device afford it and has the
// user not already said no": a coarse pointer means a finger rather than a
// cursor, and a device that has told the browser it is on a metered or
// memory-constrained connection has told us twice.
var canAnimate = (function () {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  } catch (e) {}
  var nav = window.navigator || {};
  if (nav.connection && (nav.connection.saveData || nav.connection.effectiveType === 'slow-2g' || nav.connection.effectiveType === '2g')) return false;
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 2) return false;
  if (typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency <= 2) return false;
  return true;
})();
// The verdict is also published on <html>, so CSS can gate on it. Anything
// that runs for as long as the tab is open, rather than for the length of
// one entrance, has to be reachable from a stylesheet, and re-asking the
// same questions here would be a second answer that can disagree with
// the first. The class is written in one go, at load, never toggled.
document.documentElement.classList.toggle('can-animate', canAnimate);

var onScroll = (function () {
  var subs = [], resizers = [], queued = false;
  // scrollHeight is a layout read. Taking it inside the scroll frame forces
  // a synchronous reflow every frame, which is the single most reliable way
  // to make smooth scrolling feel like it is hitting something. Cache it and
  // invalidate only when the document can actually have changed size.
  var vh = window.innerHeight, range = 1;
  function measure() {
    vh = window.innerHeight;
    range = Math.max(1, document.documentElement.scrollHeight - vh);
    for (var i = 0; i < resizers.length; i++) resizers[i]();
  }
  function frame() {
    queued = false;
    var y = window.pageYOffset || document.documentElement.scrollTop || 0;
    var p = Math.min(1, Math.max(0, y / range));
    for (var i = 0; i < subs.length; i++) subs[i](p, y, vh, range);
  }
  function request() { if (queued) return; queued = true; requestAnimationFrame(frame); }
  window.addEventListener('scroll', request, { passive: true });
  window.addEventListener('resize', function () { measure(); request(); }, { passive: true });
  window.addEventListener('orientationchange', function () { measure(); request(); }, { passive: true });
  // A late webfont, a language switch, or the heatmap building itself all
  // change the page height without firing resize.
  if ('ResizeObserver' in window) {
    var ro = new ResizeObserver(function () { measure(); request(); });
    ro.observe(document.body);
  }
  measure();
  return {
    add: function (fn) { subs.push(fn); frame(); return fn; },
    // Subscribers that also need to know their own geometry. Anything
    // reading a rect belongs here rather than in the scroll frame -- a
    // subscriber that re-measures per frame reintroduces exactly the
    // forced reflow this driver exists to avoid, no matter how careful
    // the driver itself is.
    onResize: function (fn) { resizers.push(fn); fn(); return fn; },
    request: request,
    remeasure: measure
  };
})();

// Sticky nav state + reading progress
(function () {
  var nav = document.querySelector('.site-nav');
  var bar = document.querySelector('.nav-progress > i');
  if (!nav && !bar) return;
  onScroll.add(function (p, y) {
    if (nav) nav.classList.toggle('scrolled', y > 8);
    if (bar) bar.style.transform = 'scaleX(' + p + ')';
  });
})();

// Hero scroll hint: it steps aside as soon as the reader commits.
(function () {
  var hint = document.querySelector('.scroll-hint');
  if (!hint) return;
  onScroll.add(function (p, y) { hint.classList.toggle('gone', y > 260); });
})();

// ---- Live GitHub star count (graceful: button still works if this fails) ----
(function () {
  var el = document.getElementById('ghStarCount');
  if (!el || !window.fetch) return;
  fetch('https://api.github.com/repos/JingbiaoMei/Tokdash', { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || typeof d.stargazers_count !== 'number') return;
      var n = d.stargazers_count;
      el.textContent = n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
      el.hidden = false;
    })
    .catch(function () {});
})();
