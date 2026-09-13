/* Rooms (areas) in a floor's bottom row. "Alle" lists every lamp of the floor,
 * a room only its own; the scenes stay the floor's. The brightness slider
 * follows the chosen room, and the room is part of the URL (#verlichting/0/keuken). */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;

  const chosen = new Map(); /* floor index -> area index; -1 = Alle */
  const areasOf = (fi) => cfg.tabs[cfg.floors[fi].tab].areas || [];

  Panel.areaIndex = (fi) => (chosen.has(fi) ? chosen.get(fi) : -1);
  /* The chosen room of a floor, or null for Alle. */
  Panel.areaOf = (fi) => areasOf(fi)[Panel.areaIndex(fi)] || null;
  Panel.activeArea = () => (cfg.sections[Panel.section].kind === "floors" ? Panel.areaOf(Panel.floor) : null);
  /* Mean brightness of the room's lamps that are on: 0 when all are off, -1 when none is there. */
  Panel.areaBrightness = function (area) {
    const present = area.lights.filter((id) => !Panel.unavailable(Panel.st(id)));
    if (!present.length) return -1;
    const on = present.filter((id) => Panel.st(id).state === "on").map(Panel.brightnessPct).filter((v) => v >= 0);
    return on.length ? Math.round(on.reduce((a, b) => a + b, 0) / on.length) : 0;
  };

  Panel.setArea = function (fi, ai) {
    const list = areasOf(fi);
    if (!list.length) return;
    ai = Number.isInteger(ai) && ai >= 0 && ai < list.length ? ai : -1;
    const changed = Panel.areaIndex(fi) !== ai;
    chosen.set(fi, ai);
    const row = document.querySelector(`[data-floor-row="${fi}"]`);
    row.querySelectorAll("[data-area]").forEach((c) => c.classList.toggle("active", +c.dataset.area === ai));
    Panel.renderLamps(fi, Panel.areaOf(fi));
    if (changed) Panel.emit("area", fi);
  };
  Panel.setAreaBySlug = (fi, slug) => Panel.setArea(fi, slug ? areasOf(fi).findIndex((a) => Util.slug(a.label) === slug) : -1);

  Panel.defineAction("area", (el) => {
    const row = el.closest("[data-floor-row]");
    if (row) Panel.setArea(+row.dataset.floorRow, +el.dataset.area);
  });

  /* The slider shows the chosen room's brightness as its lamps change. */
  const roomLights = cfg.tabs.flatMap((t) => (t.areas || []).flatMap((a) => a.lights));
  Panel.track(roomLights, (changed) => {
    const area = Panel.activeArea();
    if (!area || !changed.some((id) => area.lights.includes(id))) return;
    const v = Panel.areaBrightness(area);
    if (v >= 0) Panel.showBrightness(v);
  });

  Panel.on("build", () => document.querySelectorAll(".areas").forEach((el) => Util.watchOverflow(el)));
})();
