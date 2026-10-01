// ---- Scroll-linked depth ----
// Flat sections read as a stack of cards. Giving each framed mockup a small
// counter-move against the scroll is what makes the page feel like it has
// a plane the reader is travelling across. Amplitudes are tiny on purpose:
// anything larger stops reading as depth and starts reading as a bug.
(function () {
  if (!canAnimate) return;
  var hero = document.querySelector('.preview-wrap');
  var bands = Array.prototype.slice.call(document.querySelectorAll('.band .surface, #companion .surface'));
  if (!hero && !bands.length) return;

  function depth(el, strength) {
    // Geometry is read once, on resize, and never again. The scroll frame
    // gets viewport position by subtracting the scroll offset from a
    // stored document position, which is arithmetic. Asking for a rect per
    // frame instead would force a synchronous layout on every one of them,
    // which is the single easiest way to make a scroll feel like it is
    // dragging something behind it.
    var docTop = 0, height = 0;
    onScroll.onResize(function () {
      var r = el.getBoundingClientRect();
      docTop = r.top + (window.pageYOffset || document.documentElement.scrollTop || 0);
      height = r.height;
    });
    onScroll.add(function (p, y, vh) {
      var top = docTop - y;
      if (top + height < -200 || top > vh + 200) return;   // off-screen: leave it
      // -1 .. 1 as the element crosses the viewport, 0 when centred.
      var through = (top + height / 2 - vh / 2) / (vh / 2 + height / 2);
      through = Math.max(-1, Math.min(1, through));
      // The standalone translate property, not transform: the reveal
      // engine animates transform and a card's :hover lift sets it, and
      // translate composes with both instead of overriding them.
      el.style.translate = '0 ' + (through * strength).toFixed(2) + 'px';
    });
  }
  if (hero) depth(hero, 46);
  bands.forEach(function (el) { depth(el, 18); });
})();

// ---- Scroll mini-map ----
(function () {
  var map = document.querySelector('.minimap');
  if (!map) return;
  var nodes = Array.prototype.slice.call(map.querySelectorAll('.minimap-node'));
  if (!nodes.length) return;
  var ids = ['top', 'install', 'features', 'tui', 'servers', 'companion'];

  var sections = ids.map(function (id) { return document.getElementById(id); });
  if (sections.some(function (s) { return !s; })) return;

  var marks = [];
  var tips = nodes.map(function (n) { return n.querySelector('.minimap-tip'); });
  var bars = nodes.map(function (n) { return n.querySelector('.minimap-bar'); });

  // Tip labels are borrowed from copy the page already carries rather than
  // spelled out in English here. A rail that reads "Companion app" on a
  // Japanese page is worse than no rail at all. Each section's eyebrow
  // chip is the shortest label it already has; the nav link covers the
  // sections with no chip; the heading is the last resort. The two ends
  // are named rather than derived, so they carry their own keys and are
  // left alone here.
  function eyebrowText(sec) {
    var chip = sec.querySelector('[data-i18n$="eyebrow"]');
    return chip ? chip.textContent.trim() : '';
  }
  function navText(id) {
    var a = document.querySelector('.site-nav a[href="#' + id + '"]');
    return a ? a.textContent.trim() : '';
  }
  function headingText(sec) {
    var h = sec.querySelector('h1, h2');
    return h ? h.textContent.trim() : '';
  }
  function labelFor(sec, id) {
    return eyebrowText(sec) || navText(id) || headingText(sec);
  }
  function refreshTips() {
    sections.forEach(function (sec, i) {
      var tip = tips[i];
      // data-i18n owns its own text; do not overwrite what the applier
      // just put there.
      if (tip && !tip.hasAttribute('data-i18n')) tip.textContent = labelFor(sec, ids[i]);
    });
  }
  refreshTips();
  document.addEventListener('tokdash:lang', refreshTips);

  function measure() {
    var vh = window.innerHeight;
    var range = Math.max(1, document.documentElement.scrollHeight - vh);
    marks = sections.map(function (sec, i) {
      // The first section is where you already are when the page opens,
      // so it counts as reached from the very top. Running it through the
      // rule below would put its mark a third of the way down the page and
      // leave the rail with nothing highlighted at scroll zero.
      if (i === 0) return 0;
      var r = sec.getBoundingClientRect();
      var top = r.top + window.pageYOffset;
      // Where the section is "reached" is a third of the way down it: by
      // then its heading is on screen and its content is what you read.
      return Math.min(1, Math.max(0, ((top + r.height * 0.34) - vh * 0.5) / range));
    });
  }
  // The driver's own ResizeObserver covers everything this used to poll
  // for: a late webfont, a language switch, the heatmap filling in, a
  // rotate. Re-reading scrollHeight every frame instead was a forced
  // layout on every frame of every scroll.
  onScroll.onResize(measure);

  // Bar lengths come from two things. A fixed shape gives the rail its
  // silhouette: short at both ends, fullest in the middle, so the eye
  // follows one curve rather than a column of equal dashes. Proximity
  // then pulls the bar you are near, or about to reach, out towards full
  // length. The section you are reading overrides to full outright, so
  // the peak travels down the rail as you read and the shape moves with
  // it rather than jumping.
  var SHAPE = [0.40, 0.62, 0.80, 0.70, 0.52, 0.32];
  var FLOOR = 0.26;   // shortest any bar ever gets
  var REST = 0.80;    // the fullest the silhouette goes on its own

  // The resting length of bar i, before proximity is taken into account.
  var base = SHAPE.map(function (s) { return FLOOR + (REST - FLOOR) * s; });

  var active = -1, lastActive = -1;

  // How long bar i should be right now, as a fraction of its full width.
  function lengthFor(i, p) {
    if (i === active) return 1;
    // Distance from where this section sits in the page to where you
    // actually are, softened near the two ends of the scroll so the first
    // and last sections are not pinned to a bare minimum.
    var d = Math.abs(p - marks[i]) / Math.max(0.08, Math.min(p, 1 - p) + 0.08);
    var near = 1 - Math.min(1, d);
    return base[i] + (1 - base[i]) * near;
  }

  // Bars move to a target rather than jumping to it. Following the scroll
  // directly is smooth enough, but the section you are reading changing
  // hands is a step change: the bar you are leaving snapped from full
  // straight back to two thirds in a single frame, which read as a glitch
  // rather than as the wave moving. Easing the value fixes that and takes
  // the last of the chatter off the scroll tracking as well.
  //
  // The loop only exists while something is still moving. Once every bar
  // has arrived it stops, so a page sitting still costs nothing.
  var shown = new Array(nodes.length);
  var want = new Array(nodes.length);
  var easingId = 0;
  var SETTLED = 0.0015;   // close enough to stop, in fractions of a bar

  function ease() {
    easingId = 0;
    var moving = false;
    for (var i = 0; i < bars.length; i++) {
      var d = want[i] - shown[i];
      if (Math.abs(d) < SETTLED) shown[i] = want[i];
      else { shown[i] += d * 0.22; moving = true; }
      bars[i].style.transform = 'scaleX(' + shown[i].toFixed(3) + ')';
    }
    if (moving) easingId = requestAnimationFrame(ease);
  }
  function nudge() { if (!easingId) easingId = requestAnimationFrame(ease); }

  // First pass has to land the bars where they belong rather than easing
  // them in from nothing, or the rail grows out of the floor on every load.
  var primed = false;

  onScroll.add(function (p) {
    // The active section is the one whose mark you have just passed, so
    // it can only be known after the pass that finds it.
    for (var i = 0; i < nodes.length; i++) {
      var reached = p >= marks[i] - 0.02;
      nodes[i].classList.toggle('on', reached);
      if (reached) active = i;
    }
    for (var j = 0; j < nodes.length; j++) want[j] = lengthFor(j, p);
    if (active !== lastActive) {
      if (lastActive >= 0) nodes[lastActive].classList.remove('active');
      if (active >= 0) nodes[active].classList.add('active');
      lastActive = active;
    }
    if (!primed) {
      primed = true;
      for (var k = 0; k < bars.length; k++) {
        shown[k] = want[k];
        bars[k].style.transform = 'scaleX(' + shown[k].toFixed(3) + ')';
      }
      return;
    }
    nudge();
  });

  // Each bar is a real link, so it has to land where it says it does.
  // Lenis owns the scroll, and a bare hash jump would fight it and land
  // under the fixed header, so the offset is applied here.
  map.addEventListener('click', function (e) {
    var a = e.target.closest('a[href^="#"]');
    if (!a) return;
    var target = document.getElementById(a.getAttribute('href').slice(1));
    if (!target) return;
    e.preventDefault();
    if (window.__lenis) window.__lenis.scrollTo(target, { offset: -72, duration: 1.1 });
    else target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  map.classList.add('ready');
  // Late-arriving content (fonts, the heatmap) changes where the sections
  // start, so take one more reading once the page has settled. Everything
  // after this is the driver's ResizeObserver.
  window.addEventListener('load', function () { onScroll.remeasure(); });
})();
