// The CSS loop carries the motion. JS only eases pointer speed, provides a
// pause toggle, and reveals a static list while keyboard users follow links.
(function () {
  var SLOW = 0.2;
  var SETTLE_MS = 320;
  var keyboard = true;

  function init() {
    var section = document.getElementById('tools');
    if (!section || !canAnimate) return;
    var ticker = section.querySelector('.ticker');
    var row = section.querySelector('.tick-row');
    var track = section.querySelector('.tick-track');
    var button = section.querySelector('.ticker-control');
    var frame = 0;

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Tab') keyboard = true;
    });
    document.addEventListener('pointerdown', function () { keyboard = false; });

    function drift() {
      var animations = track.getAnimations ? track.getAnimations() : [];
      for (var i = 0; i < animations.length; i++) {
        if (animations[i].animationName === 'tick-drift') return animations[i];
      }
      return null;
    }

    function cancelSettle() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }

    function settle(target) {
      cancelSettle();
      var animation = drift();
      if (!animation || animation.playbackRate === target) return;
      var from = animation.playbackRate;
      var started = null;
      frame = requestAnimationFrame(function tick(now) {
        if (started === null) started = now;
        var t = Math.min(1, (now - started) / SETTLE_MS);
        animation.playbackRate = from + (target - from) * (1 - Math.pow(1 - t, 3));
        frame = t < 1 ? requestAnimationFrame(tick) : 0;
      });
    }

    row.addEventListener('pointerenter', function () { settle(SLOW); });
    row.addEventListener('pointerleave', function () { settle(1); });
    row.addEventListener('focusin', function (event) {
      if (!keyboard) return;
      cancelSettle();
      ticker.classList.add('is-keyboard');
      row.scrollLeft = 0;
      event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    row.addEventListener('focusout', function (event) {
      if (event.relatedTarget && row.contains(event.relatedTarget)) return;
      ticker.classList.remove('is-keyboard');
      settle(row.matches(':hover') ? SLOW : 1);
    });
    button.addEventListener('click', function () {
      var paused = ticker.classList.toggle('is-paused');
      button.setAttribute('aria-pressed', String(paused));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
