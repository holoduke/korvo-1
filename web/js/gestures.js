/* Touch and mouse gestures. A press on a control runs its action on release
 * (a tap) or its hold action after a long press; a press that moves 16 px
 * becomes a swipe on a registered surface, committed past a share of the
 * surface's size or on a flick. Modules register:
 *
 *   Panel.defineAction(name, tap, hold)   controls marked data-<name>
 *   Panel.addSwipe({root, axis, accepts(el, delta), size(), commit,
 *                   begin(), move(raw, size) -> offset, end(dir, velocity)})
 *     end gets +1 (towards the next item), -1 (the previous) or 0 (snap back),
 *     and the finger's speed along the axis (px/ms) for the glide to set off at.
 *
 * Inside a scroller that can move along the swipe's axis, native scrolling
 * wins (a long lamp list, a row of room buttons wider than the screen). */
(function () {
  "use strict";
  const Panel = window.Panel;

  const DRAG_START = 16; /* px before a press becomes a drag */
  const MOVE_CANCEL = 10; /* px of movement that cancels a tap or long press */
  const LONG_PRESS_MS = 450;
  const FLICK_VEL = 0.45; /* px/ms toward the target counts as a flick */
  const FLICK_MIN = 24; /* px a flick must travel */

  const actions = new Map(); /* name -> {tap, hold} */
  Panel.defineAction = (name, tap, hold) => actions.set(name, { tap, hold });
  const actionTarget = (el) => el.closest([...actions.keys()].map((n) => `[data-${n}]`).join(","));
  const actionOf = (el) => [...actions.entries()].find(([n]) => el.hasAttribute(`data-${n}`))[1];

  const swipes = [];
  const roots = new Set();
  Panel.addSwipe = function (def) {
    swipes.push(def);
    if (roots.has(def.root)) return;
    roots.add(def.root);
    def.root.addEventListener("pointerdown", (e) => onDown(e, def.root));
    def.root.addEventListener("pointermove", onMove, { passive: false });
    def.root.addEventListener("pointerup", onUp);
    def.root.addEventListener("pointercancel", onUp);
    def.root.addEventListener("contextmenu", (e) => e.preventDefault());
  };

  function scrolls(el, root, axis) {
    for (let n = el; n && n !== root; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const overflow = axis === "x" ? cs.overflowX : cs.overflowY;
      if (overflow !== "auto" && overflow !== "scroll") continue;
      if (axis === "x" ? n.scrollWidth > n.clientWidth + 1 : n.scrollHeight > n.clientHeight + 1) return true;
    }
    return false;
  }

  let g = null; /* the active gesture */
  let swallowClick = false; /* the click synthesized from a long press's lift */
  window.addEventListener(
    "click",
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    },
    { capture: true }
  );
  /* A mouse long press produces no click; the next real press starts clean. */
  window.addEventListener("pointerdown", () => (swallowClick = false), { capture: true });

  function onDown(e, root) {
    if (g || e.button > 0 || Panel.overlayOpen()) return;
    if (Panel.justWokeHouse && Panel.justWokeHouse()) return; /* the press that woke the house saver: dismiss only */
    if (e.target.closest(".vslider")) return; /* the brightness slider handles its own pointer */
    const target = actionTarget(e.target);
    const gest = (g = {
      id: e.pointerId,
      root,
      el: e.target,
      x0: e.clientX,
      y0: e.clientY,
      target,
      swipe: null,
      cancelled: false,
      samples: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }],
    });
    if (!target) return;
    target.classList.add("pressed");
    const { hold } = actionOf(target);
    if (!hold) return;
    gest.lpTimer = setTimeout(() => {
      if (g !== gest || gest.swipe || gest.cancelled) return;
      target.classList.remove("pressed");
      /* The hold action (a popup) now owns the finger: end this gesture here,
       * because its pointerup lands on the popup, not on this surface. On touch
       * the browser also turns the lift into a click on whatever is under the
       * finger by then (the popup backdrop, which would close it at once), so
       * that one click is swallowed. */
      g = null;
      swallowClick = true;
      if (navigator.vibrate) navigator.vibrate(12);
      hold(target);
    }, LONG_PRESS_MS);
  }

  function onMove(e) {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    g.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    if (g.samples.length > 8) g.samples.shift();
    if (!g.swipe) {
      if (Math.hypot(dx, dy) > MOVE_CANCEL) {
        clearTimeout(g.lpTimer);
        if (g.target) g.target.classList.remove("pressed");
      }
      if (g.cancelled || (Math.abs(dx) < DRAG_START && Math.abs(dy) < DRAG_START)) return;
      const axis = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
      const d = axis === "x" ? dx : dy;
      const swipe = !scrolls(g.el, g.root, axis) && swipes.find((s) => s.root === g.root && s.axis === axis && s.accepts(g.el, d));
      if (!swipe) {
        g.cancelled = true; /* native scrolling, or nothing to swipe */
        return;
      }
      Object.assign(g, { swipe, axis, d0: d, size: swipe.size(), off: 0 });
      if (swipe.begin) swipe.begin();
      g.root.setPointerCapture(g.id);
    }
    const d = g.axis === "x" ? dx : dy;
    g.off = g.swipe.move(d - Math.sign(g.d0) * DRAG_START, g.size);
    e.preventDefault();
  }

  /* Ends the gesture in progress without a tap or a committed swipe: for a
   * surface that takes the fingers over (the house on Start, once a second
   * finger lands on it). A swipe under way snaps back. */
  Panel.cancelSwipe = function () {
    if (!g) return;
    const gest = g;
    g = null;
    clearTimeout(gest.lpTimer);
    if (gest.target) gest.target.classList.remove("pressed");
    if (!gest.swipe) return;
    try {
      gest.root.releasePointerCapture(gest.id);
    } catch (e) {}
    gest.swipe.end(0);
  };

  function velocity(gest) {
    const s = gest.samples;
    const a = s.find((p) => s[s.length - 1].t - p.t < 110) || s[0];
    const b = s[s.length - 1];
    return b.t > a.t ? (b[gest.axis] - a[gest.axis]) / (b.t - a.t) : 0;
  }

  function onUp(e) {
    if (!g || e.pointerId !== g.id) return;
    const gest = g;
    g = null;
    clearTimeout(gest.lpTimer);
    if (gest.target) gest.target.classList.remove("pressed");
    if (gest.swipe) {
      const dir = gest.off < 0 ? 1 : -1;
      const far = Math.abs(gest.off) > gest.size * gest.swipe.commit;
      const flick = -dir * velocity(gest) > FLICK_VEL && Math.abs(gest.off) > FLICK_MIN;
      gest.swipe.end(far || flick ? dir : 0, velocity(gest));
      return;
    }
    if (gest.cancelled || e.type === "pointercancel" || !gest.target || gest.target.disabled) return;
    if (Math.hypot(e.clientX - gest.x0, e.clientY - gest.y0) > MOVE_CANCEL) return;
    /* A tap that opens an overlay: on touch the browser still turns this lift
     * into a click, which would land on the overlay's backdrop and close it. */
    const wasOpen = Panel.overlayOpen();
    actionOf(gest.target).tap(gest.target);
    if (!wasOpen && Panel.overlayOpen()) swallowClick = true;
  }
  /* A release outside the surface (finger slid off, or onto an overlay) must
   * still end the gesture, or the next press would be ignored. */
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
})();
