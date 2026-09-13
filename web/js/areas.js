/* Rooms (areas) in each floor's bottom row.
 *
 * A floor page shows its lamps on the left and its scenes on the right. The
 * room buttons filter the lamps: "Alle" lists every lamp of the floor, a room
 * only its own. The scenes stay the floor's. The brightness slider follows
 * the chosen room, and the room is part of the URL (#verlichting/0/keuken). */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  if (!cfg.floors || !cfg.floors.some((f) => (cfg.tabs[f.tab].areas || []).length)) return;

  const chosen = new Map(); /* floor index -> area index; -1 = Alle */

  const slug = (label) => label.toLowerCase().replace(/\./g, "").trim().replace(/\s+/g, "-");
  const floorTab = (fi) => cfg.tabs[cfg.floors[fi].tab];
  const areasOf = (fi) => floorTab(fi).areas || [];

  Panel.areaSlug = slug;
  Panel.areaIndex = (fi) => (chosen.has(fi) ? chosen.get(fi) : -1);
  Panel.activeArea = function () {
    const sec = cfg.sections[Panel.section];
    if (!sec || sec.kind !== "floors") return null;
    const ai = Panel.areaIndex(Panel.floor);
    return ai >= 0 ? areasOf(Panel.floor)[ai] : null;
  };
  /* Mean brightness of the room's lamps that are on; 0 when all are off. */
  Panel.areaBrightness = function (area) {
    const present = area.lights.filter((id) => Panel.st(id) && !Panel.unavailable(Panel.st(id)));
    if (!present.length) return -1;
    const on = present.filter((id) => Panel.st(id).state === "on").map((id) => Panel.brightnessPct(id)).filter((v) => v >= 0);
    return on.length ? Math.round(on.reduce((a, b) => a + b, 0) / on.length) : 0;
  };

  function renderFloor(fi) {
    const row = document.querySelector(`[data-floor-row="${fi}"]`);
    if (!row) return;
    const ai = Panel.areaIndex(fi);
    row.querySelectorAll("[data-area]").forEach((c) => c.classList.toggle("active", +c.dataset.area === ai));
    if (Panel.renderLamps) Panel.renderLamps(fi, ai >= 0 ? areasOf(fi)[ai] : null);
  }

  Panel.setArea = function (fi, ai, fromUrl) {
    const list = areasOf(fi);
    if (!list.length) return;
    ai = Number.isInteger(ai) && ai >= 0 && ai < list.length ? ai : -1;
    const changed = Panel.areaIndex(fi) !== ai;
    chosen.set(fi, ai);
    renderFloor(fi);
    if (changed && Panel.syncSlider) Panel.syncSlider();
    if (!fromUrl && Panel.writeHash) Panel.writeHash();
  };
  Panel.setAreaBySlug = (fi, s) => Panel.setArea(fi, s ? areasOf(fi).findIndex((a) => slug(a.label) === s) : -1, true);

  Panel.areaTap = function (el) {
    const row = el.closest("[data-floor-row]");
    if (row) Panel.setArea(+row.dataset.floorRow, +el.dataset.area);
  };

  /* A fade on the row's right edge while more room buttons hide there. */
  function markOverflow(el) {
    el.classList.toggle("overflowing", el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }
  /* Called by app.js once the rows exist (they are built at boot, after this loads). */
  Panel.initAreas = function () {
    document.querySelectorAll(".areas").forEach((el) => {
      new ResizeObserver(() => markOverflow(el)).observe(el);
      el.addEventListener("scroll", () => markOverflow(el), { passive: true });
      markOverflow(el);
    });
  };

  /* The slider shows the chosen room's brightness as its lamps change. */
  Panel.onAreaLight = function (id) {
    const area = Panel.activeArea();
    if (!area || !area.lights.includes(id) || !Panel.onTabBrightness) return;
    const v = Panel.areaBrightness(area);
    if (v >= 0) Panel.onTabBrightness(v);
  };
})();
