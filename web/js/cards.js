/* Device cards, shared by the Sensoren and Energie sections (css/cards.css).
 *   Panel.cardHtml(attrs, icon, label)   an empty card; attrs are extra
 *                                        attributes, e.g. 'data-sensor-card="3"'
 *   Panel.fillCard(card, view, flash)    its contents, where view is
 *     {tone, big, unit, colour, level, chips, foot}: tone is active, warn, idle
 *     or offline; big the large value (in colour, when given) with its unit;
 *     level (0..100) a battery bar under it; chips [icon, text, class] (left out
 *     without text); foot [html, class] entries (a falsy entry is left out, an
 *     empty html keeps its place). flash lights the card up briefly. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { esc } = Util;

  Panel.cardHtml = (attrs, iconName, label) =>
    `<article class="dc-card" ${attrs}><header class="dc-head"><span class="dc-icon">${icon(iconName)}</span>` +
    `<b>${esc(label)}</b><i class="dc-dot"></i></header><div class="dc-body"></div></article>`;

  const cls = (name) => (name ? ` class="${name}"` : "");

  Panel.fillCard = function (card, view, flash) {
    card.className = `dc-card tone-${view.tone}`;
    const chips = (view.chips || []).filter((chip) => chip && chip[1]);
    const foot = (view.foot || []).filter(Boolean);
    card.querySelector(".dc-body").innerHTML =
      `<div class="dc-value"><b${view.colour ? ` style="color:${view.colour}"` : ""}>${esc(view.big)}</b>` +
      (view.unit ? `<span>${esc(view.unit)}</span>` : "") +
      `</div>` +
      (Number.isFinite(view.level)
        ? `<div class="dc-level"><i style="width:${Util.clamp(view.level, 0, 100)}%;background:${Util.batteryColour(view.level)}"></i></div>`
        : "") +
      (chips.length ? `<div class="dc-chips">${chips.map(([ic, text, c]) => `<span${cls(c)}>${icon(ic)}${esc(text)}</span>`).join("")}</div>` : "") +
      (foot.length ? `<footer class="dc-foot">${foot.map(([html, c]) => `<span${cls(c)}>${html}</span>`).join("")}</footer>` : "");
    if (flash) {
      void card.offsetWidth; /* restart the animation */
      card.classList.add("flash");
    }
  };
})();
