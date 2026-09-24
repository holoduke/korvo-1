/* A room, opened by a tap on the house: not a popup but a panel beside the
 * house, tied to the room by a leader line that runs from the room's label to
 * the panel and follows the house as it turns. The panel holds the room's
 * lamps as tiles (the power button switches, the name opens the lamp popup),
 * a line of facts, and all of it on or off at once. Outside the swipe roots,
 * so the tiles take plain clicks here. */
(function () {
  "use strict";
  const Panel = window.Panel;
  let host = null; /* the .house element */
  let panel = null;
  let leader = null; /* the svg */
  let current = null; /* {floor, name, lights, card, presence, centre} as hud.js knows it */
  let raf = 0;
  let openedAt = 0; /* the tap that opened the panel must not also tap what appears under the finger */

  const html = () =>
    `<svg class="house-leader" aria-hidden="true"><path class="hl-path" d=""></path><circle class="hl-dot" r="4"></circle><circle class="hl-ring" r="9"></circle></svg>` +
    `<aside class="house-info" hidden>` +
    `<div class="hi-head"><div class="hi-title" data-hi-title></div><button class="hi-close" data-hi-climate aria-label="Klimaat" hidden>${icon("thermometer")}</button><button class="hi-close" data-hi-close aria-label="Sluiten">${icon("close")}</button></div>` +
    `<div class="hi-facts" data-hi-facts></div>` +
    `<div class="hi-lamps" data-hi-lamps></div>` +
    `<div class="hi-cover" data-hi-cover hidden></div>` +
    `<div class="hi-actions"><button class="ap-btn primary" data-hi-on>Alles aan</button><button class="ap-btn" data-hi-off>Alles uit</button></div>` +
    `</aside>`;

  const $q = (sel) => panel.querySelector(sel);

  function render() {
    if (!current) return;
    const lights = current.lights;
    $q("[data-hi-title]").textContent = current.name;
    $q("[data-hi-climate]").hidden = !current.card;
    /* a door on its own (tapped in the house) shows no lamps, only its controls */
    $q("[data-hi-lamps]").hidden = !!current.door;
    $q("[data-hi-lamps]").innerHTML = current.door ? "" : lights.length ? lights.map(Panel.lightTile).join("") : `<div class="hi-empty">Geen lampen in deze kamer</div>`;
    lights.forEach(Panel.renderLight); /* the tiles then follow their lamps on their own */
    const cover = $q("[data-hi-cover]");
    cover.hidden = current.cover == null;
    cover.innerHTML = current.cover == null ? "" : Panel.coverBlock(current.cover);
    if (current.cover != null) Panel.emit("cover", current.cover); /* covers.js fills the fresh block in */
    facts();
    $q("[data-hi-on]").disabled = !lights.length;
    $q("[data-hi-off]").disabled = !lights.length;
    $q(".hi-actions").hidden = !!current.door;
  }
  /* The line of facts: lamps on, climate, presence. */
  function facts() {
    const lights = current.lights;
    const on = lights.filter((id) => (Panel.st(id) || {}).state === "on").length;
    const parts = [lights.length ? `${on} van ${lights.length} lampen aan` : null];
    if (current.card) {
      const t = Panel.num(current.card.entities.temperature);
      const h = Panel.num(current.card.entities.humidity);
      if (Number.isFinite(t)) parts.push(`${Util.fmt(t, 1)}°${Number.isFinite(h) ? ` · ${Math.round(h)}%` : ""}`);
    }
    if (current.presence) parts.push((Panel.st(current.presence) || {}).state === "on" ? "iemand aanwezig" : "niemand");
    $q("[data-hi-facts]").textContent = parts.filter(Boolean).join("  ·  ");
  }

  /* The leader: from the room's label (its projected centre) a short run at
   * 45°, then straight to the panel's edge at the height of its title. */
  function draw() {
    raf = 0;
    if (!current || panel.hidden) return;
    const house = Panel.house;
    const p = house && house.project(current.centre);
    const path = leader.querySelector(".hl-path");
    const dot = leader.querySelector(".hl-dot");
    const ring = leader.querySelector(".hl-ring");
    if (!p) {
      path.setAttribute("d", "");
      dot.setAttribute("r", 0);
      ring.setAttribute("r", 0);
    } else {
      const hr = host.getBoundingClientRect();
      const pr = panel.getBoundingClientRect();
      const stacked = pr.width >= hr.width - 40; /* a phone: the panel lies under the house */
      const tx = stacked ? pr.left - hr.left + 28 : pr.left - hr.left - 2;
      const ty = stacked ? pr.top - hr.top + 1 : pr.top - hr.top + 30;
      const dx = tx - p.x, dy = ty - p.y;
      /* the elbow: diagonal first, then the straight run */
      const run = Math.min(Math.abs(dx), Math.abs(dy)) * 0.6;
      const ex = p.x + Math.sign(dx) * run, ey = p.y + Math.sign(dy) * run;
      path.setAttribute("d", `M${p.x.toFixed(1)} ${p.y.toFixed(1)} L${ex.toFixed(1)} ${ey.toFixed(1)} L${tx.toFixed(1)} ${ty.toFixed(1)}`);
      dot.setAttribute("cx", p.x.toFixed(1));
      dot.setAttribute("cy", p.y.toFixed(1));
      dot.setAttribute("r", 4);
      ring.setAttribute("cx", p.x.toFixed(1));
      ring.setAttribute("cy", p.y.toFixed(1));
      ring.setAttribute("r", 9);
    }
    raf = requestAnimationFrame(draw);
  }

  Panel.openRoom = function (room) {
    if (!panel) return;
    current = room;
    render();
    panel.hidden = false;
    openedAt = performance.now();
    leader.classList.add("on");
    leader.classList.remove("drawn");
    void leader.getBoundingClientRect();
    leader.classList.add("drawn"); /* the line draws itself in */
    if (!raf) raf = requestAnimationFrame(draw);
    Panel.emit("room", room);
  };
  Panel.closeRoom = function () {
    if (!current) return;
    current = null;
    panel.hidden = true;
    leader.classList.remove("on", "drawn");
    cancelAnimationFrame(raf);
    raf = 0;
    Panel.emit("room", null);
  };
  Panel.currentRoom = () => current;

  Panel.on("start", () => {
    host = document.querySelector(".start-page .house");
    if (!host) return;
    host.insertAdjacentHTML("beforeend", html());
    panel = host.querySelector(".house-info");
    leader = host.querySelector(".house-leader");
    $q("[data-hi-close]").addEventListener("click", Panel.closeRoom);
    /* the room's climate popup (the last 24 h) */
    $q("[data-hi-climate]").addEventListener("click", () => {
      if (current && current.card) Panel.openClimateFor(current.card.entities.temperature);
    });
    $q("[data-hi-lamps]").addEventListener("click", (e) => {
      if (performance.now() - openedAt < 500) return;
      const power = e.target.closest("[data-power]");
      const lamp = e.target.closest("[data-lamp]");
      if (power) Panel.toggleLight(power.dataset.power);
      else if (lamp) Panel.openLightPopup(lamp.dataset.lamp);
    });
    /* the door's buttons (the panel keeps its pointer events, so not via defineAction) */
    $q("[data-hi-cover]").addEventListener("click", (e) => {
      const b = e.target.closest("[data-coveract]");
      if (!b || performance.now() - openedAt < 500) return;
      const [i, key] = b.dataset.coveract.split("|");
      Panel.coverAction(+i, key);
    });
    $q("[data-hi-on]").addEventListener("click", () => current && Panel.setBrightness(current.lights, 100));
    $q("[data-hi-off]").addEventListener("click", () => current && Panel.setBrightness(current.lights, 0));
    /* touches on the panel stay with it: no section swipe, no house orbit */
    ["pointerdown", "touchstart"].forEach((ev) => panel.addEventListener(ev, (e) => e.stopPropagation(), { passive: true }));
  });
  Panel.on("light", (id) => current && !panel.hidden && current.lights.includes(id) && facts());
  Panel.on("section", () => Panel.currentRoom() && !Panel.onScreen("start") && Panel.closeRoom());
  Panel.on("escape", Panel.closeRoom);
})();
