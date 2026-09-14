/* A lift-style rail of floor buttons (css/rail.css) with an indicator that
 * slides between them: Verlichting's floors and Schoonmaak's robots.
 *   Panel.railHtml(buttons, attr)   buttons [{key, label, name}] top to bottom;
 *                                   each gets attr="key", its action attribute
 *   Panel.railIndicator(nav)        -> place(position, animate): the indicator
 *                                   on the button at that index (fractions
 *                                   put it between two, following a swipe) */
(function () {
  "use strict";
  const Panel = window.Panel;

  Panel.railHtml = (buttons, attr) =>
    `<nav class="rail" aria-label="Verdieping"><div class="rail-track"><i class="rail-ind"></i>` +
    buttons.map((b) => `<button class="rail-btn" ${attr}="${b.key}"><b>${b.label}</b><span>${b.name}</span></button>`).join("") +
    `</div></nav>`;

  Panel.railIndicator = function (nav) {
    const ind = nav.querySelector(".rail-ind");
    return function place(pos, animate) {
      const btns = [...nav.querySelectorAll(".rail-btn")];
      const i = Util.clamp(Math.floor(pos), 0, btns.length - 1);
      const f = Util.clamp(pos - i, 0, 1);
      const a = btns[i];
      const b = btns[Math.min(btns.length - 1, i + 1)];
      ind.style.transition = animate ? "transform .32s cubic-bezier(.22,.61,.36,1), height .32s" : "none";
      ind.style.height = a.offsetHeight + (b.offsetHeight - a.offsetHeight) * f + "px";
      ind.style.transform = `translate3d(0,${a.offsetTop + (b.offsetTop - a.offsetTop) * f}px,0)`;
    };
  };
})();
