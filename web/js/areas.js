/* Rooms (areas) in each floor's bottom row.
 *
 * "Alle" shows the floor's own scenes, as before. A room shows the same
 * scenes, applied to only that room's lamps: scene.apply with the per-lamp
 * states stored in the scene (light groups in a scene are expanded to their
 * members, a lamp's own entry wins over its group's), plus scenes that belong
 * to the room alone. A room without any scene shows its lamps instead. The
 * brightness slider follows the chosen room, and the room is part of the URL
 * (#verlichting/0/keuken). */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  if (!cfg.floors || !cfg.floors.some((f) => (cfg.tabs[f.tab].areas || []).length)) return;

  /* Attributes scene.apply may set on a lamp; the stored scenes also carry
   * read-only ones (supported modes, min/max kelvin, friendly name). */
  const LIGHT_KEYS = ["state", "brightness", "color_mode", "color_temp_kelvin", "hs_color", "xy_color", "rgb_color", "rgbw_color", "rgbww_color", "effect"];

  const chosen = new Map(); /* floor index -> area index; -1 = Alle */
  const lastScene = new Map(); /* "floor:area" -> key of the scene last started there */
  const configs = new Map(); /* scene entity id -> {entities} or null (no stored config) */
  let groups = new Map(); /* light group id -> member ids */
  let loading = null;

  const slug = (label) => label.toLowerCase().replace(/\./g, "").trim().replace(/\s+/g, "-");
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
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

  /* ---- Scene data --------------------------------------------------------------- */
  function expand(ids) {
    const out = new Set();
    const walk = (id, depth) => {
      const members = groups.get(id);
      if (members && depth < 6) members.forEach((m) => walk(m, depth + 1));
      else out.add(id);
    };
    ids.forEach((id) => walk(id, 0));
    return out;
  }
  function sceneLights(sceneId) {
    const c = configs.get(sceneId);
    const ids = c && c.entities ? Object.keys(c.entities) : ((Panel.st(sceneId) || {}).attributes || {}).entity_id || [];
    return expand(ids.filter((id) => id.startsWith("light.")));
  }
  const pick = (stored) =>
    typeof stored === "string" ? { state: stored } : Object.fromEntries(Object.entries(stored || {}).filter(([k]) => LIGHT_KEYS.includes(k)));

  /* The scene's states for the room's lamps only; null without a stored config. */
  function entitiesFor(sceneId, room) {
    const c = configs.get(sceneId);
    if (!c || !c.entities) return null;
    const entries = Object.entries(c.entities).filter(([id]) => id.startsWith("light."));
    entries.sort(([a], [b]) => (groups.has(a) ? 0 : 1) - (groups.has(b) ? 0 : 1)); /* groups first, lamps override */
    const out = {};
    for (const [id, stored] of entries) {
      const values = pick(stored);
      for (const lamp of expand([id])) if (room.has(lamp)) out[lamp] = values;
    }
    return Object.keys(out).length ? out : null;
  }

  function ensureLoaded() {
    if (loading) return loading;
    loading = (async () => {
      let failed = false;
      try {
        const all = await Panel.client.getStates();
        groups = new Map(
          all.filter((s) => s.entity_id.startsWith("light.") && Array.isArray((s.attributes || {}).entity_id)).map((s) => [s.entity_id, s.attributes.entity_id])
        );
      } catch (e) {
        failed = true;
      }
      const sceneIds = new Set(cfg.floors.flatMap((f) => cfg.tabs[f.tab].scenes.map((s) => s.id)));
      await Promise.all(
        [...sceneIds].map(async (id) => {
          try {
            configs.set(id, await Panel.client.sceneConfig(id));
          } catch (e) {
            failed = true;
          }
        })
      );
      if (failed) loading = null; /* try again on the next room or reconnect */
      renderAll(true);
    })();
    return loading;
  }

  /* The tiles a room shows: floor scenes that touch its lamps, then its own. */
  function roomScenes(fi, ai) {
    const t = floorTab(fi);
    const area = areasOf(fi)[ai];
    const room = new Set(area.lights);
    const list = [];
    t.scenes.forEach((s, si) => {
      const lights = [...sceneLights(s.id)];
      if (!lights.some((l) => room.has(l))) return;
      list.push({ key: s.id, label: s.label, sceneId: s.id, whole: lights.every((l) => room.has(l)), icon: t.icons && t.icons[si], swatch: t.swatches && t.swatches[si] });
    });
    area.scenes.forEach((s) => list.push({ key: s.id, label: s.label, sceneId: s.id, whole: true, icon: null, swatch: null }));
    return list;
  }

  /* ---- Rendering ---------------------------------------------------------------- */
  function lead(s) {
    if (s.swatch && s.swatch.a === "rainbow") return '<span class="swatch rainbow"></span>';
    if (s.swatch && s.swatch.a) return `<span class="swatch" style="background:${s.swatch.b ? `linear-gradient(90deg, ${s.swatch.a}, ${s.swatch.b})` : s.swatch.a}"></span>`;
    return `<span class="t-icon">${icon(s.icon || "bolt")}</span>`;
  }
  function labelOf(fi, id) {
    const known = [...floorTab(fi).devices, ...floorTab(fi).lights].find((d) => d.id === id);
    if (known) return known.label;
    const s = Panel.st(id);
    return (s && s.attributes && s.attributes.friendly_name) || id.replace(/^light\./, "").replace(/_/g, " ");
  }

  function renderFloor(fi, force) {
    const panel = document.querySelector(`[data-floor-panel="${fi}"]`);
    const row = document.querySelector(`[data-floor-row="${fi}"]`);
    if (!panel || !row) return;
    const ai = Panel.areaIndex(fi);
    row.querySelectorAll("[data-area]").forEach((c) => c.classList.toggle("active", +c.dataset.area === ai));
    const t = floorTab(fi);
    if (ai < 0) {
      if (panel.dataset.showing && panel.dataset.showing !== "all") {
        panel.innerHTML = Panel.gridHtml(t, cfg.floors[fi].tab);
        [...t.lights, ...t.devices].forEach((l) => Panel.renderLight(l.id));
        Panel.renderScenes();
      }
      panel.dataset.showing = "all";
      return;
    }
    const area = areasOf(fi)[ai];
    const scenes = roomScenes(fi, ai);
    const showing = `${ai}|${scenes.map((s) => s.key).join(",")}`;
    if (force || panel.dataset.showing !== showing) {
      panel.dataset.showing = showing;
      if (scenes.length) {
        const compact = scenes.length > 6;
        panel.innerHTML =
          `<div class="grid${compact ? " compact" : ""}">` +
          scenes
            .map(
              (s, i) =>
                `<button class="tile scene" data-roomscene="${fi}:${ai}:${i}" data-key="${esc(s.key)}">${lead(s)}` +
                `<span class="t-name">${esc(s.label)}</span>${compact ? "" : '<span class="t-sub">scene</span>'}</button>`
            )
            .join("") +
          `</div>`;
      } else {
        const present = area.lights.filter((id) => Panel.st(id));
        const lamps = (present.length ? present : area.lights).map((id) => ({ id, label: labelOf(fi, id) }));
        panel.innerHTML = `<div class="grid${lamps.length > 6 ? " compact" : ""}">${lamps.map((l) => Panel.lightTile(l)).join("")}</div>`;
        lamps.forEach((l) => Panel.renderLight(l.id));
      }
    }
    const active = lastScene.get(`${fi}:${ai}`);
    panel.querySelectorAll("[data-roomscene]").forEach((el) => {
      const on = el.dataset.key === active;
      el.classList.toggle("active", on);
      const sub = el.querySelector(".t-sub");
      if (sub) sub.textContent = on ? "actief" : "scene";
    });
  }
  function renderAll(force) {
    cfg.floors.forEach((_, fi) => renderFloor(fi, force));
    if (Panel.syncSlider) Panel.syncSlider();
  }

  /* ---- Actions ------------------------------------------------------------------ */
  Panel.setArea = function (fi, ai, fromUrl) {
    const list = areasOf(fi);
    if (!list.length) return;
    ai = Number.isInteger(ai) && ai >= 0 && ai < list.length ? ai : -1;
    const changed = Panel.areaIndex(fi) !== ai;
    chosen.set(fi, ai);
    renderFloor(fi);
    if (ai >= 0) ensureLoaded();
    if (changed && Panel.syncSlider) Panel.syncSlider();
    if (!fromUrl && Panel.writeHash) Panel.writeHash();
  };
  Panel.setAreaBySlug = (fi, s) => Panel.setArea(fi, s ? areasOf(fi).findIndex((a) => slug(a.label) === s) : -1, true);

  Panel.areaTap = function (el) {
    const row = el.closest("[data-floor-row]");
    if (row) Panel.setArea(+row.dataset.floorRow, +el.dataset.area);
  };

  Panel.roomSceneTap = async function (el) {
    const [fi, ai, idx] = el.dataset.roomscene.split(":").map(Number);
    const area = areasOf(fi)[ai];
    const item = roomScenes(fi, ai)[idx];
    if (!area || !item) return;
    lastScene.set(`${fi}:${ai}`, item.key);
    renderFloor(fi);
    if (item.whole) {
      /* Only this room's lamps are in the scene: start it as it is. */
      Panel.client.callService("scene", "turn_on", null, { entity_id: item.sceneId }).catch(() => {});
      return;
    }
    if (!configs.get(item.sceneId)) {
      try {
        configs.set(item.sceneId, await Panel.client.sceneConfig(item.sceneId));
      } catch (e) {
        return;
      }
    }
    const entities = entitiesFor(item.sceneId, new Set(area.lights));
    if (entities) Panel.client.callService("scene", "apply", { entities }).catch(() => {});
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

  /* ---- Hooks from app.js -------------------------------------------------------- */
  Panel.onAreaLight = function (id) {
    const area = Panel.activeArea();
    if (!area || !area.lights.includes(id) || !Panel.onTabBrightness) return;
    const v = Panel.areaBrightness(area);
    if (v >= 0) Panel.onTabBrightness(v);
  };
  Panel.onAreasReady = function () {
    ensureLoaded();
  };
})();
