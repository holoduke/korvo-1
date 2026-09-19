/* Doors the panel drives (cfg.covers: the garage door): a block with the
 * door's state and its buttons — open, stop, close, and the ventilation
 * position when the door has one; every button acts on the first tap (the
 * user finds a confirmation irritating). The block appears on the door's
 * lighting tab, in the room's panel beside the house, and when the door
 * itself is tapped in the 3D house (hud.js); the Start screen also carries a
 * widget for it beside the house, with a shutter that draws the door's
 * position. Home Assistant reports the door's state (opening, open, closing,
 * closed) and its position; every block on screen follows it. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const covers = cfg.covers || [];
  const st = (id) => Panel.st(id);
  const MOVE_MS = 12000; /* about what the real door takes: the shutter in the widget moves at that pace */

  const ACTIONS = [
    { key: "open", label: "Open", icon: "chevron-up" },
    { key: "stop", label: "Stop", icon: "close" },
    { key: "close", label: "Dicht", icon: "chevron-down" },
    { key: "vent", label: "Kier", icon: "vent" },
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

  const buttons = (i) =>
    `<div class="cover-actions">` +
    ACTIONS.filter((a) => a.key !== "vent" || covers[i].entities.vent)
      .map((a) => `<button class="ap-btn" data-coveract="${i}|${a.key}" aria-label="${a.label}">${icon(a.icon)}<span>${a.label}</span></button>`)
      .join("") +
    `</div>`;
  Panel.coverBlock = function (i) {
    const c = covers[i];
    return (
      `<div class="cover" data-cover="${i}">` +
      `<div class="cover-head"><span class="t-icon cover-ic">${icon("garage")}</span><span class="t-text"><span class="t-name">${Util.esc(c.label)}</span><span class="t-sub" data-cover-state>...</span></span></div>` +
      buttons(i) +
      `</div>`
    );
  };
  /* The widget beside the house: the name, a drawn door whose shutter stands
   * where the real one does (rolling while it moves), the state, the buttons. */
  Panel.coverWidget = function (i) {
    const c = covers[i];
    return (
      `<div class="cover cw" data-cover="${i}">` +
      `<div class="cw-title">${icon("garage")}<span>${Util.esc(c.label)}</span></div>` +
      `<div class="cw-door" aria-hidden="true"><div class="cw-frame"><div class="cw-glow"></div><div class="cw-shutter"></div></div><div class="cw-ground"></div></div>` +
      `<div class="cw-state" data-cover-state>...</div>` +
      buttons(i) +
      `</div>`
    );
  };

  function render(i) {
    const v = view(i);
    document.querySelectorAll(`[data-cover="${i}"]`).forEach((el) => {
      el.classList.toggle("unavail", v.un);
      el.classList.toggle("open", !v.un && (v.state === "open" || v.moving));
      el.classList.toggle("moving", v.moving);
      el.classList.toggle("opening", v.state === "opening");
      el.classList.toggle("closing", v.state === "closing");
      /* the drawn shutter: where the door is, or where it is heading while it moves */
      const pos = v.state === "opening" ? 100 : v.state === "closing" ? 0 : v.state === "open" ? (v.pos == null ? 100 : v.pos) : 0;
      const shutter = el.querySelector(".cw-shutter");
      if (shutter && el.dataset.moving === "1" && !v.moving) {
        /* The door has arrived while the shutter was still on its slow way: a
         * running transition keeps its pace even when the duration changes, so
         * pin the shutter where it is and let the short transition take it
         * the rest of the way. */
        shutter.style.transition = "none";
        shutter.style.height = `${shutter.getBoundingClientRect().height}px`;
        void shutter.offsetHeight;
        shutter.style.transition = "";
        shutter.style.height = "";
      }
      el.dataset.moving = v.moving ? "1" : "0";
      el.style.setProperty("--pos", String(pos / 100));
      el.style.setProperty("--move-ms", `${MOVE_MS}ms`);
      el.querySelector("[data-cover-state]").textContent = v.text;
      ACTIONS.forEach((a) => {
        const b = el.querySelector(`[data-coveract="${i}|${a.key}"]`);
        if (!b) return;
        b.disabled = !v.can[a.key];
        b.classList.toggle("primary", a.key === (v.state === "closed" ? "open" : v.moving ? "stop" : "close") && v.can[a.key]);
      });
    });
  }

  /* One of the buttons. */
  Panel.coverAction = function (i, key) {
    const c = covers[i];
    const a = ACTIONS.find((x) => x.key === key);
    if (!c || !a || !view(i).can[key]) return;
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

  /* The widget on the Start screen, beside the house; it steps aside while a
   * room's panel is open there (the garage's panel carries the door itself). */
  let widget = null;
  Panel.on("start", () => {
    const house = document.querySelector(".start-page .house");
    if (!house || !covers.length) return;
    house.insertAdjacentHTML("beforeend", `<div class="house-cover" data-house-cover>${covers.map((_, i) => Panel.coverWidget(i)).join("")}</div>`);
    widget = house.querySelector("[data-house-cover]");
    widget.addEventListener("click", (e) => {
      const b = e.target.closest("[data-coveract]");
      if (!b) return;
      const [i, key] = b.dataset.coveract.split("|");
      Panel.coverAction(+i, key);
    });
    /* touches on the widget stay with it: no section swipe, no house orbit */
    ["pointerdown", "touchstart"].forEach((ev) => widget.addEventListener(ev, (e) => e.stopPropagation(), { passive: true }));
    covers.forEach((_, i) => render(i));
  });
  Panel.on("room", (room) => widget && (widget.hidden = !!room));

  covers.forEach((c, i) => Panel.track([c.entities.cover, c.entities.vent].filter(Boolean), () => render(i)));
  Panel.on("loaded", () => covers.forEach((_, i) => render(i)));
  Panel.on("cover", render); /* a block just put on screen (the room panel) */
  Panel.on("build", () => covers.forEach((_, i) => render(i)));
})();
