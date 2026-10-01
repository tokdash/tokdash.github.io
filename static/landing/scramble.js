(function () {
  var isReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var HEADING_KEYS = [
    'feat.h',
    'srv.1.h',
    'srv.2.h',
    'srv.3.h'
  ];

  var TARGET_KEYS = [
    'feat.sub',
    'srv.1.p',
    'srv.2.p',
    'srv.3.p'
  ];

  // Scramble settings: includes '.' full stop
  var GLYPHS = '0123456789ABCDEF_~<>{}/*+=!@#$%^&abcdef.';
  var PERTURBATION = 0.685;
  var REVEAL_RATE = 100; // chars/sec
  var REVEAL_DELAY = 50; // ms
  var SETTLE_RATE = 50;  // ms settle window

  // The scramble needs one named curve, and this used to ask the library
  // for it on every frame of every character, which meant building and
  // parsing the easing again each time. Ask once, keep the function.
  //
  // The hand-written copy below is the same curve, checked against the
  // library's own values at a dozen points, so a page where the library
  // did not load reads the same rather than differently. The old fallback
  // was easeOutExpo while the primary was easeInOutExpo, which meant the
  // failure path quietly changed the feel of the text.
  function easeInOutExpo(x) {
    if (x === 0 || x === 1) return x;
    return x < 0.5
      ? 0.5 * Math.pow(2, 20 * x - 10)
      : 1 - 0.5 * Math.pow(2, -20 * x + 10);
  }
  var SCRAMBLE_EASE = (function () {
    if (typeof anime === 'undefined' || !anime.easing) return null;
    try {
      // anime.js v3 names: 'easeInOutExpo', not v4's 'inOutExpo'.
      var fn = anime.easing('easeInOutExpo');
      return typeof fn === 'function' ? fn : null;
    } catch (e) { return null; }
  })();

  function getEase(p) {
    return SCRAMBLE_EASE ? SCRAMBLE_EASE(p) : easeInOutExpo(p);
  }

  // --- Headings: Fast Char-by-Char Fade-in (No cursor, no scramble) ---
  function prepareHeading(el) {
    if (!el) return;
    var text = el.getAttribute('data-raw-text') || el.textContent.trim();
    if (!text) return;
    el.setAttribute('data-raw-text', text);
    el.setAttribute('aria-label', text);

    if (isReduced) {
      el.textContent = text;
      el.classList.add('anim-ready');
      return;
    }

    var chars = text.split('');
    var len = chars.length;
    if (!len) return;

    el.innerHTML = '';
    var frag = document.createDocumentFragment();
    for (var i = 0; i < len; i++) {
      // Keep spaces as plain text: an &nbsp; span removes the line-break
      // opportunity, so a heading could never wrap on a phone.
      if (chars[i] === ' ') {
        frag.appendChild(document.createTextNode(' '));
        continue;
      }
      var span = document.createElement('span');
      span.className = 'heading-char';
      span.textContent = chars[i];
      frag.appendChild(span);
    }
    el.appendChild(frag);
    el.classList.add('anim-ready');
  }

  function animateHeading(el) {
    if (!el) return;
    var text = el.getAttribute('data-raw-text') || el.textContent.trim();
    if (!text) return;

    if (isReduced) {
      el.textContent = text;
      el.classList.add('anim-ready');
      return;
    }

    if (el._headingTimeouts) {
      el._headingTimeouts.forEach(clearTimeout);
    }
    el._headingTimeouts = [];

    var charSpans = Array.prototype.slice.call(el.querySelectorAll('.heading-char'));
    if (!charSpans.length) {
      prepareHeading(el);
      charSpans = Array.prototype.slice.call(el.querySelectorAll('.heading-char'));
    }

    // Heading char interval: 14ms per char (faster than the scrambler below)
    var CHAR_INTERVAL = 14;
    var START_DELAY = 30;

    for (var i = 0; i < charSpans.length; i++) {
      (function (idx) {
        var timer = setTimeout(function () {
          if (charSpans[idx]) {
            charSpans[idx].classList.add('in');
          }
        }, START_DELAY + (idx * CHAR_INTERVAL));
        el._headingTimeouts.push(timer);
      })(i);
    }
  }

  // --- Paragraphs: Cyber Scramble Decoder with Block Cursor ---
  function prepareScramble(el) {
    if (!el) return;
    var fullText = el.getAttribute('data-raw-text') || el.textContent.trim();
    if (!fullText) return;
    el.setAttribute('data-raw-text', fullText);
    el.setAttribute('aria-label', fullText);

    if (isReduced) {
      el.textContent = fullText;
      el.classList.add('anim-ready');
      return;
    }

    var chars = fullText.split('');
    var len = chars.length;
    if (!len) return;

    el.classList.add('scramble-box');
    el.innerHTML = '';

    var frag = document.createDocumentFragment();
    for (var i = 0; i < len; i++) {
      var span = document.createElement('span');
      span.className = 'scramble-char pending';
      span.textContent = chars[i];
      frag.appendChild(span);
    }
    el.appendChild(frag);
    el.classList.add('anim-ready');
  }

  function scrambleElement(el, immediate) {
    if (!el) return;
    var fullText = el.getAttribute('data-raw-text') || el.textContent.trim();
    if (!fullText) return;

    el.setAttribute('aria-label', fullText);

    if (isReduced || immediate) {
      el.textContent = fullText;
      el.classList.add('anim-ready');
      return;
    }

    if (el._scrambleTimer) {
      cancelAnimationFrame(el._scrambleTimer);
      el._scrambleTimer = null;
    }

    var chars = fullText.split('');
    var len = chars.length;
    if (!len) return;

    el.classList.add('scramble-box');
    el.innerHTML = '';

    var frag = document.createDocumentFragment();
    var charSpans = [];

    for (var i = 0; i < len; i++) {
      var span = document.createElement('span');
      span.className = 'scramble-char pending';
      span.textContent = chars[i];
      frag.appendChild(span);
      charSpans.push(span);
    }

    var cursor = document.createElement('span');
    cursor.className = 'scramble-cursor';
    cursor.textContent = '▍';
    frag.appendChild(cursor);

    el.appendChild(frag);
    el.classList.add('anim-ready');

    var revealDuration = (len / REVEAL_RATE) * 1000;
    var settleWindow = SETTLE_RATE * 5;
    var totalDuration = revealDuration + settleWindow + REVEAL_DELAY;
    var startTime = null;

    function tick(timestamp) {
      if (!startTime) startTime = timestamp;
      var elapsed = timestamp - startTime;

      if (elapsed < REVEAL_DELAY) {
        el._scrambleTimer = requestAnimationFrame(tick);
        return;
      }

      var activeElapsed = elapsed - REVEAL_DELAY;
      var revealProgress = Math.min(1, activeElapsed / revealDuration);
      var easedLead = getEase(revealProgress);
      var leadIndex = Math.min(len, Math.floor(easedLead * len));

      var settleProgress = Math.min(1, Math.max(0, activeElapsed - 50) / (revealDuration + settleWindow - 50));
      var settledIndex = Math.min(len, Math.floor(getEase(settleProgress) * len));

      if (leadIndex < len && charSpans[leadIndex] && charSpans[leadIndex].parentNode) {
        charSpans[leadIndex].parentNode.insertBefore(cursor, charSpans[leadIndex]);
      } else if (cursor.parentNode !== el) {
        el.appendChild(cursor);
      }

      for (var i = 0; i < len; i++) {
        var s = charSpans[i];
        var originalChar = chars[i];

        if (i < settledIndex) {
          if (s.textContent !== originalChar) s.textContent = originalChar;
          if (s.className !== 'scramble-char settled') s.className = 'scramble-char settled';
        } else if (i < leadIndex) {
          if (s.className !== 'scramble-char active') s.className = 'scramble-char active';
          if (originalChar === ' ') {
            s.textContent = ' ';
          } else if (Math.random() < PERTURBATION) {
            s.textContent = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
          }
        } else {
          if (s.className !== 'scramble-char pending') s.className = 'scramble-char pending';
          s.textContent = originalChar;
        }
      }

      if (settledIndex < len) {
        el._scrambleTimer = requestAnimationFrame(tick);
      } else {
        for (var j = 0; j < len; j++) {
          charSpans[j].textContent = chars[j];
          charSpans[j].className = 'scramble-char settled';
        }
        cursor.classList.add('blink');
        setTimeout(function () {
          if (cursor && cursor.parentNode) {
            cursor.parentNode.removeChild(cursor);
          }
        }, 650);
        el._scrambleTimer = null;
      }
    }

    el._scrambleTimer = requestAnimationFrame(tick);
  }

  // --- Row Logos: Synchronized Morph Engine (.opt-ic beside animated lines) ---
  function getStrokables(svg) {
    if (!svg) return [];
    var shapes = Array.prototype.slice.call(
      svg.querySelectorAll('path, rect, circle, line, polyline, polygon')
    );
    return shapes.filter(function (shape) {
      var stroke = shape.getAttribute('stroke');
      if (!stroke || stroke === 'none') {
        var comp = window.getComputedStyle(shape).stroke;
        if (!comp || comp === 'none') return false;
      }
      return true;
    });
  }

  function getFills(svg) {
    if (!svg) return [];
    var shapes = Array.prototype.slice.call(
      svg.querySelectorAll('path, circle, rect')
    );
    return shapes.filter(function (shape) {
      var fill = shape.getAttribute('fill');
      return fill && fill !== 'none' && fill !== 'transparent';
    });
  }

  function prepareLogo(icon) {
    if (!icon) return;
    if (isReduced) {
      icon.classList.add('anim-ready');
      icon.classList.add('morphed');
      return;
    }
    var svg = icon.querySelector('svg');
    if (!svg) {
      icon.classList.add('anim-ready');
      return;
    }

    var strokables = getStrokables(svg);
    var fills = getFills(svg);

    if (typeof anime !== 'undefined') {
      strokables.forEach(function (s) {
        var len = anime.setDashoffset(s);
        s.style.strokeDashoffset = len;
      });
    }
    fills.forEach(function (f) {
      f.style.opacity = '0';
    });

    icon.classList.add('anim-ready');
  }

  function morphLogo(icon) {
    if (!icon) return;
    if (isReduced) {
      icon.classList.add('anim-ready');
      icon.classList.add('morphed');
      return;
    }
    var svg = icon.querySelector('svg');
    if (!svg) return;

    var strokables = getStrokables(svg);
    var fills = getFills(svg);

    if (typeof anime !== 'undefined') {
      try {
        anime.remove(icon);
        if (strokables.length > 0) anime.remove(strokables);
        if (fills.length > 0) anime.remove(fills);

        strokables.forEach(function (s) {
          var len = anime.setDashoffset(s);
          s.style.strokeDashoffset = len;
        });
        fills.forEach(function (f) {
          f.style.opacity = '0';
        });

        // 1. Container badge shape morph: circle -> squircle, scale, rotate, glowing pulse
        anime({
          targets: icon,
          // The badge is readable while it is still turning into a
          // squircle. On the full 850ms curve it spent the first third
          // of a second at almost no strength and the reader waited for
          // the shape to arrive before they could read the line beside it.
          opacity: { value: [0, 1], duration: 300, easing: 'linear' },
          scale: [0.35, 1],
          rotate: [-35, 0],
          borderRadius: ['50%', '9px'],
          boxShadow: [
            '0 0 0px 0px transparent',
            '0 0 20px 4px color-mix(in srgb, var(--color-cta) 75%, transparent)',
            '0 0 0px 0px transparent'
          ],
          borderColor: [
            'var(--color-cta)',
            'color-mix(in srgb, var(--color-cta) 26%, transparent)'
          ],
          duration: 850,
          easing: 'easeInOutExpo',
          complete: function () {
            icon.classList.add('morphed');
          }
        });

        // 2. SVG line-art morph (stroke drawing)
        if (strokables.length > 0) {
          anime({
            targets: strokables,
            strokeDashoffset: [anime.setDashoffset, 0],
            duration: 900,
            delay: anime.stagger(60, { start: 40 }),
            easing: 'easeInOutExpo'
          });
        }

        // 3. SVG fills / accents
        if (fills.length > 0) {
          anime({
            targets: fills,
            opacity: [0, 1],
            scale: [0.3, 1],
            duration: 500,
            delay: 350,
            easing: 'easeInOutExpo'
          });
        }
      } catch (e) {
        // Show the finished logo: undo the hidden strokes and fills set up above.
        strokables.forEach(function (s) { s.style.strokeDashoffset = ''; });
        fills.forEach(function (f) { f.style.opacity = ''; });
        icon.classList.add('anim-ready');
        icon.classList.add('morphed');
      }
    } else {
      icon.classList.add('anim-ready');
      icon.classList.add('morphed');
    }
  }

  function getHeadingElements() {
    var selector = HEADING_KEYS.map(function (k) { return '[data-i18n="' + k + '"]'; }).join(', ');
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  }

  function getTargetElements() {
    var selector = TARGET_KEYS.map(function (k) { return '[data-i18n="' + k + '"]'; }).join(', ');
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  }

  var headingEls = getHeadingElements();
  var targetEls = getTargetElements();
  var rowLis = Array.prototype.slice.call(document.querySelectorAll('.opt-li'));

  // Immediately prepare all elements so no raw text or un-morphed logos are visible before animation
  headingEls.forEach(prepareHeading);
  targetEls.forEach(prepareScramble);
  rowLis.forEach(function (li) {
    var ic = li.querySelector('.opt-ic');
    if (ic) prepareLogo(ic);
  });

  if (!('IntersectionObserver' in window) || isReduced) {
    return;
  }

  var handledSet = new WeakSet();

  var textIo = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        var el = entry.target;
        if (!handledSet.has(el)) {
          handledSet.add(el);

          // If an .opt-li row enters view, morph its logo and coordinate heading & paragraph
          if (el.classList.contains('opt-li')) {
            var ic = el.querySelector('.opt-ic');
            if (ic) morphLogo(ic);
            var h = el.querySelector('h3[data-i18n]');
            if (h && !handledSet.has(h)) {
              handledSet.add(h);
              animateHeading(h);
              textIo.unobserve(h);
            }
            var p = el.querySelector('p[data-i18n]');
            if (p && !handledSet.has(p)) {
              handledSet.add(p);
              scrambleElement(p, false);
              textIo.unobserve(p);
            }
            textIo.unobserve(el);
            return;
          }

          // Standalone elements outside .opt-li (e.g. feat.h, feat.sub, cta.h)
          var rowLi = el.closest('.opt-li');
          if (rowLi && !handledSet.has(rowLi)) {
            handledSet.add(rowLi);
            var rowIc = rowLi.querySelector('.opt-ic');
            if (rowIc) morphLogo(rowIc);
          }

          var key = el.getAttribute('data-i18n');
          if (HEADING_KEYS.indexOf(key) !== -1) {
            animateHeading(el);
          } else {
            scrambleElement(el, false);
          }
          textIo.unobserve(el);
        }
      }
    });
  }, { rootMargin: '0px 0px -5% 0px', threshold: 0.1 });

  rowLis.forEach(function (li) { textIo.observe(li); });
  headingEls.forEach(function (el) { textIo.observe(el); });
  targetEls.forEach(function (el) { textIo.observe(el); });

  // Interactive hover morph for list items
  rowLis.forEach(function (li) {
    li.addEventListener('mouseenter', function () {
      if (isReduced || !handledSet.has(li)) return;
      var ic = li.querySelector('.opt-ic');
      if (ic && ic.classList.contains('morphed') && typeof anime !== 'undefined') {
        var strokables = getStrokables(ic.querySelector('svg'));
        if (strokables.length > 0) {
          // Leaving a row while its lines are still drawing and coming
          // back used to start a second draw on top of the first, so the
          // line jumped backwards to wherever the old tween had got to
          // and then drew again. Stopping what is already running first
          // is what the logo morph above already does.
          anime.remove(strokables);
          anime({
            targets: strokables,
            strokeDashoffset: [anime.setDashoffset, 0],
            duration: 600,
            delay: anime.stagger(40),
            easing: 'easeInOutExpo'
          });
        }
      }
    });
  });

  // Global trigger for language updates
  window.__triggerScramble = function () {
    if (isReduced) return;
    var hTargets = getHeadingElements();
    var pTargets = getTargetElements();

    // Re-morph all row logos alongside the translated text
    rowLis.forEach(function (li) {
      var ic = li.querySelector('.opt-ic');
      if (ic) morphLogo(ic);
    });

    hTargets.forEach(function (el) {
      el.removeAttribute('data-raw-text');
      prepareHeading(el);
      if (handledSet.has(el)) {
        animateHeading(el);
      }
    });

    pTargets.forEach(function (el) {
      el.removeAttribute('data-raw-text');
      prepareScramble(el);
      if (handledSet.has(el)) {
        scrambleElement(el, false);
      }
    });
  };
})();
