/* Doors the panel drives (cfg.covers: the garage door): a block with the
 * door's state and its buttons — open, stop, close, and the ventilation
 * position when the door has one. Opening needs a second tap (a door to the
 * street must not open from a brush of the hand); stopping and closing act at
 * once. The block appears on the door's lighting tab, in the room's panel
 * beside the house, and when the door itself is tapped in the 3D house
 * (hud.js). Home Assistant reports the door's state (opening, open, closing,
 * closed) and its position; every block on screen follows it. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const covers = cfg.covers || [];
  const CONFIRM_MS = 4000;
  const st = (id) => Panel.st(id);
  const twoTap = Util.confirmer(CONFIRM_MS, () => covers.forEach((_, i) => render(i)));

  const ACTIONS = [
    { key: "open", label: "Open", icon: "chevron-up", confirm: true },
    { key: "stop", label: "Stop", icon: "close" },
    { key: "close", label: "Dicht", icon: "chevron-down" },
    { key: "vent", label: "Kier", icon: "vent", confirm: true },
  ];

  /* What the door is doing, and which buttons make sense right now. */
  function view(i) {
    const c = covers[i];
    const s = st(c.entities.cover);
    const loaded = Panel.isLoaded();
    const un = loaded && Panel.unavailable(s);
    const state = s ? s.state : null;
    const pos = s && Number.isFinite(+(s.attributes || {}).current_position) ? +(s.attributes || {}).current_position : null;
    const moving = state === "opening" || state === "closing";
    const text = !s && !loaded ? "..." : un ? "niet bereikbaar" : state === "opening" ? "gaat open…" : state === "closing" ? "gaat dicht…" : state === "open" ? (pos != null && pos > 0 && pos < 100 ? `open · ${pos}%` : "open") : state === "closed" ? "dicht" : "onbekend";
    const can = {
      open: !un && state !== "opening" && !(state === "open" && (pos == null || pos >= 100)),
      stop: !un && moving,
      close: !un && state !== "closing" && state !== "closed",
      vent: !un && !!c.entities.vent && !moving,
    };
    return { state, pos, moving, un, text, can, tone: un ? "warn" : state === "open" || moving ? "warn" : "ok" };
  }

  Panel.coverBlock = function (i) {
    const c = covers[i];
    return (
      `<div class="cover" data-cover="${i}">` +
      `<div class="cover-head"><span class="t-icon cover-ic">${icon("garage")}</span><span class="t-text"><span class="t-name">${Util.esc(c.label)}</span><span class="t-sub" data-cover-state>...</span></span></div>` +
      `<div class="cover-actions">` +
      ACTIONS.filter((a) => a.key !== "vent" || c.entities.vent)
        .map((a) => `<button class="ap-btn" data-coveract="${i}|${a.key}" aria-label="${a.label}">${icon(a.icon)}<span>${a.label}</span></button>`)
        .join("") +
      `</div></div>`
    );
  };

  function render(i) {
    const v = view(i);
    document.querySelectorAll(`[data-cover="${i}"]`).forEach((el) => {
      el.classList.toggle("unavail", v.un);
      el.classList.toggle("open", !v.un && (v.state === "open" || v.moving));
      el.classList.toggle("moving", v.moving);
      el.querySelector("[data-cover-state]").textContent = v.text;
      ACTIONS.forEach((a) => {
        const b = el.querySelector(`[data-coveract="${i}|${a.key}"]`);
        if (!b) return;
        const armed = a.confirm && twoTap.armed(`${i}|${a.key}`);
        b.disabled = !v.can[a.key];
        b.classList.toggle("armed", armed);
        b.classList.toggle("primary", !armed && a.key === (v.state === "closed" ? "open" : v.moving ? "stop" : "close") && v.can[a.key]);
        b.querySelector("span").textContent = armed ? `Nog eens: ${a.label.toLowerCase()}` : a.label;
      });
    });
  }

  /* One of the buttons: open and the ventilation position after a second tap. */
  Panel.coverAction = function (i, key) {
    const c = covers[i];
    const a = ACTIONS.find((x) => x.key === key);
    if (!c || !a || !view(i).can[key]) return;
    if (a.confirm && !twoTap.tap(`${i}|${key}`, true)) return;
    const fail = Panel.commandFailed(c.label);
    if (key === "vent") Panel.client.callService("button", "press", null, { entity_id: c.entities.vent }).catch(fail);
    else Panel.client.callService("cover", `${key}_cover`, null, { entity_id: c.entities.cover }).catch(fail);
    Panel.sound && Panel.sound.tap && Panel.sound.tap();
  };
  Panel.defineAction("coveract", (el) => {
    const [i, key] = el.dataset.coveract.split("|");
    Panel.coverAction(+i, key);
  });
  /* The door of a lighting tab, and of a room of the plan (its tab's door). */
  Panel.coverOfTab = (ti) => covers.findIndex((c) => c.tab === ti);
  Panel.coverOfOpening = (key) => covers.findIndex((c) => c.opening === key);

  covers.forEach((c, i) => Panel.track([c.entities.cover, c.entities.vent].filter(Boolean), () => render(i)));
  Panel.on("loaded", () => covers.forEach((_, i) => render(i)));
  Panel.on("cover", render); /* a block just put on screen (the room panel) */
  Panel.on("build", () => covers.forEach((_, i) => render(i)));
})();
