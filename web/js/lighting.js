/* Lighting: lamp and scene tiles, the split pages (the tab's scenes on the left,
 * its lamps on the right), the bottom row and the light services.
 *
 * A tab's lamps are the lamps its scenes switch on plus its own lights, with a
 * light group counted as its members. A scene that only switches things off
 * adds nothing ("alles uit" beneden also covers the garage). A tab without
 * scenes keeps its configured lamps. Scene data and group members come from
 * Home Assistant once it has answered; lamps found that way are followed too. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const st = (id) => Panel.st(id);

  /* ---- Lights ------------------------------------------------------------------ */
  const brightnessOf = (s) =>
    s && s.attributes && typeof s.attributes.brightness === "number" ? Math.round((s.attributes.brightness * 100) / 255) : -1;
  Panel.brightnessPct = (id) => brightnessOf(st(id));
  Panel.caps = function (id) {
    const a = (st(id) || {}).attributes || {};
    const modes = a.supported_color_modes || [];
    return {
      color: modes.some((m) => ["hs", "xy", "rgb", "rgbw", "rgbww"].includes(m)),
      warmth: modes.includes("color_temp"),
      minK: a.min_color_temp_kelvin || 2200,
      maxK: a.max_color_temp_kelvin || 6500,
    };
  };

  const nameOf = new Map(); /* entity id -> friendly name, from Home Assistant */
  /* The configured label, else Home Assistant's name without a leading "lamp". */
  Panel.lightLabel = function (id) {
    for (const t of cfg.tabs) {
      const known = [...t.devices, ...t.lights].find((d) => d.id === id);
      if (known) return known.label;
    }
    const name = nameOf.get(id) || ((st(id) || {}).attributes || {}).friendly_name || id.replace(/^light\./, "").replace(/_/g, " ");
    const short = name.replace(/^lamp\s+/i, "");
    return short.charAt(0).toUpperCase() + short.slice(1);
  };
  Panel.lightTile = (id) =>
    `<button class="tile" data-light="${id}"><span class="t-icon">${icon("power")}</span>` +
    `<span class="t-text"><span class="t-name">${Util.esc(Panel.lightLabel(id))}</span><span class="t-sub">...</span></span></button>`;

  const pending = new Map(); /* light id -> {on, timer}: optimistic toggle */
  function renderLight(id) {
    const s = st(id);
    const p = pending.get(id);
    const loaded = Panel.isLoaded();
    const un = loaded && Panel.unavailable(s);
    const on = p ? p.on : s && s.state === "on";
    document.querySelectorAll(`[data-light="${CSS.escape(id)}"]`).forEach((el) => {
      el.classList.toggle("unavail", un);
      el.classList.toggle("on", !un && !!on);
      el.classList.toggle("pending", !!p);
      const ic = el.classList.contains("sq") ? el : el.querySelector(".t-icon");
      const want = un ? "warning" : "power";
      if (ic.dataset.icon !== want) {
        ic.dataset.icon = want;
        ic.innerHTML = icon(want);
      }
      const sub = el.querySelector(".t-sub");
      if (sub) sub.textContent = !s && !loaded ? "..." : un ? "niet beschikbaar" : on ? "aan" : "uit";
    });
  }
  Panel.renderLight = renderLight;

  Panel.toggleLight = function (id) {
    const s = st(id);
    if (Panel.unavailable(s)) return;
    const on = s.state !== "on";
    clearTimeout((pending.get(id) || {}).timer);
    pending.set(id, { on, timer: setTimeout(() => (pending.delete(id), renderLight(id)), 4000) });
    renderLight(id);
    Panel.client.callService("light", "toggle", null, { entity_id: id }).catch(() => {
      pending.delete(id);
      renderLight(id);
    });
  };
  Panel.setBrightness = function (entityIds, value) {
    const off = value <= 0;
    Panel.client
      .callService("light", off ? "turn_off" : "turn_on", off ? null : { brightness_pct: value }, { entity_id: entityIds })
      .catch(() => {});
  };
  Panel.setHue = (id, hue) => Panel.client.callService("light", "turn_on", { hs_color: [hue, 100] }, { entity_id: id }).catch(() => {});
  Panel.setKelvin = (id, k) => Panel.client.callService("light", "turn_on", { color_temp_kelvin: k }, { entity_id: id }).catch(() => {});

  /* The tab's main light (a group) sets the slider while no room is chosen. */
  Panel.tabBrightness = cfg.tabs.map(() => -1);
  function syncTabBrightness(id) {
    cfg.tabs.forEach((t, ti) => {
      if (!t.lights[0] || t.lights[0].id !== id) return;
      const v = Panel.brightnessPct(id);
      if (v < 0) return;
      Panel.tabBrightness[ti] = v;
      if (ti === Panel.activeTab() && !Panel.activeArea()) Panel.showBrightness(v);
    });
  }

  function onLights(changed) {
    for (const id of changed) {
      const s = st(id);
      const p = pending.get(id);
      if (p && s && (s.state === "on") === p.on) {
        clearTimeout(p.timer);
        pending.delete(id);
      }
      renderLight(id);
      syncTabBrightness(id);
    }
  }

  /* ---- Scenes ------------------------------------------------------------------ */
  function highlightScene(tab, idx) {
    document.querySelectorAll(`[data-scene^="${tab}:"]`).forEach((el) => {
      const on = +el.dataset.scene.split(":")[1] === idx;
      el.classList.toggle("active", on);
      el.querySelector(".t-sub").textContent = on ? "actief" : "scene";
    });
    const pill = document.querySelector(`[data-pill="${tab}"] b`);
    if (pill) pill.textContent = idx >= 0 ? cfg.tabs[tab].scenes[idx].label : "-";
  }
  Panel.activateScene = function (tab, idx) {
    highlightScene(tab, idx);
    Panel.client.callService("scene", "turn_on", null, { entity_id: cfg.tabs[tab].scenes[idx].id }).catch(() => {});
  };

  /* A scene's state is its last-activated timestamp: a new one means it was just
   * activated (from anywhere). At start the newest per tab counts as active. */
  const sceneSeen = new Map();
  function onScenes(changed, first) {
    for (const id of changed) {
      const s = st(id);
      if (first) {
        sceneSeen.set(id, s ? s.state : undefined);
        continue;
      }
      if (!s) continue;
      const prev = sceneSeen.get(id);
      sceneSeen.set(id, s.state);
      if (prev !== undefined && prev !== s.state) {
        cfg.tabs.forEach((t, ti) => t.scenes.forEach((sc, i) => sc.id === id && highlightScene(ti, i)));
      }
    }
    if (first) {
      cfg.tabs.forEach((t, ti) => {
        let best = -1;
        let bestT = 0;
        t.scenes.forEach((sc, i) => {
          const ts = Date.parse((st(sc.id) || {}).state);
          if (Number.isFinite(ts) && ts > bestT) [best, bestT] = [i, ts];
        });
        if (best >= 0) highlightScene(ti, best);
      });
    }
  }

  /* ---- A tab's lamps ------------------------------------------------------------- */
  const lampsOfTab = new Map(); /* tab index -> [lamp ids], once known */
  let groupMembers = new Map(); /* light group -> member ids */
  let knownIds = null; /* every entity id HA has */

  function expandLights(ids, depth = 0) {
    return ids.flatMap((id) => (groupMembers.has(id) && depth < 6 ? expandLights(groupMembers.get(id), depth + 1) : [id]));
  }

  async function loadLamps() {
    try {
      const all = await Panel.client.getStates();
      knownIds = new Set(all.map((s) => s.entity_id));
      all.forEach((s) => s.attributes && s.attributes.friendly_name && nameOf.set(s.entity_id, s.attributes.friendly_name));
      groupMembers = new Map(
        all.filter((s) => s.entity_id.startsWith("light.") && Array.isArray((s.attributes || {}).entity_id)).map((s) => [s.entity_id, s.attributes.entity_id])
      );
    } catch (e) {
      /* no group data: the lamps are what the scenes list */
    }
    const tabs = [...new Set([...cfg.floors.map((f) => f.tab), ...cfg.sections.filter((s) => s.kind === "tab").map((s) => s.tab)])];
    await Promise.all(
      tabs.map(async (ti) => {
        const t = cfg.tabs[ti];
        const own = t.scenes.length
          ? t.lights.map((l) => l.id)
          : [...t.lights.map((l) => l.id), ...t.devices.map((d) => d.id), ...(t.areas || []).flatMap((a) => a.lights)];
        const found = new Set(expandLights(own));
        await Promise.all(
          t.scenes.map(async (sc) => {
            let entities = null;
            try {
              entities = ((await Panel.client.sceneConfig(sc.id)) || {}).entities || null;
            } catch (e) {
              entities = null;
            }
            const lit = entities
              ? Object.entries(entities).filter(([, v]) => (typeof v === "string" ? v : v && v.state) !== "off").map(([id]) => id)
              : ((st(sc.id) || {}).attributes || {}).entity_id || []; /* no stored config: every light it lists */
            expandLights(lit.filter((id) => id.startsWith("light."))).forEach((id) => found.add(id));
          })
        );
        lampsOfTab.set(ti, [...found].filter((id) => id.startsWith("light.") && !groupMembers.has(id) && (!knownIds || knownIds.has(id))));
      })
    );
    Panel.track([...lampsOfTab.values()].flat(), onLights);
    tabs.forEach((ti) => renderTabLamps(ti));
  }

  /* Rebuild a tab's lamp list: all its lamps, or one room's (area). */
  function renderTabLamps(ti, area) {
    const grid = document.querySelector(`[data-lamps="${ti}"]`);
    const lamps = lampsOfTab.get(ti);
    if (!grid || !lamps) return;
    if (area === undefined) {
      const fi = cfg.floors.findIndex((f) => f.tab === ti);
      area = fi >= 0 ? Panel.areaOf(fi) : null;
    }
    const room = area ? new Set(area.lights) : null;
    const byLabel = (x, y) => Panel.lightLabel(x).localeCompare(Panel.lightLabel(y), "nl");
    const shown = lamps.filter((id) => !room || room.has(id)).sort(byLabel);
    grid.innerHTML = shown.length ? shown.map(Panel.lightTile).join("") : `<div class="split-empty">Geen lampen</div>`;
    shown.forEach(renderLight);
    grid.closest(".split-lamps").querySelector(".split-title").textContent = area ? `Lampen · ${area.label}` : "Lampen";
    const list = grid.closest(".split-list");
    list.scrollTop = 0;
    markScroll(list);
  }
  /* A floor's lamps for "Alle" (area null) or one room. */
  Panel.renderLamps = (fi, area) => renderTabLamps(cfg.floors[fi].tab, area);

  /* ---- Markup -------------------------------------------------------------------- */
  function sceneLead(t, i) {
    const sw = t.swatches && t.swatches[i];
    if (!sw) return `<span class="t-icon">${icon((t.icons && t.icons[i]) || "bolt")}</span>`;
    if (sw.a === "rainbow") return '<span class="swatch rainbow"></span>';
    return `<span class="swatch" style="background:${sw.b ? `linear-gradient(90deg, ${sw.a}, ${sw.b})` : sw.a}"></span>`;
  }

  /* A tab's page content: scenes left, lamps right (filled once they are known). */
  Panel.lightingPanel = function (ti) {
    const t = cfg.tabs[ti];
    const scenes = t.scenes
      .map((s, i) => `<button class="tile scene" data-scene="${ti}:${i}">${sceneLead(t, i)}<span class="t-text"><span class="t-name">${s.label}</span><span class="t-sub">scene</span></span></button>`)
      .join("");
    return (
      `<div class="split${t.scenes.length ? "" : " no-scenes"}">` +
      `<div class="split-half split-scenes"><div class="split-title">Scènes</div>` +
      `<div class="split-list"><div class="grid">${scenes}</div></div></div>` +
      `<div class="split-half split-lamps"><div class="split-title">Lampen</div>` +
      `<div class="split-list"><div class="grid" data-lamps="${ti}"><div class="split-empty">Lampen laden…</div></div></div></div>` +
      `</div>`
    );
  };

  /* A tab's bottom row: its main switch, the rooms (or the active scene), "Alle lampen". */
  Panel.lightingRow = function (ti) {
    const t = cfg.tabs[ti];
    const areas = t.areas || [];
    let row = `<div class="row${areas.length ? " has-areas" : ""}">`;
    if (t.sceneTiles && t.lights.length) row += `<button class="sq" data-light="${t.lights[0].id}">${icon("power")}</button>`;
    if (areas.length) {
      row +=
        `<div class="areas"><button class="chip area-chip active" data-area="-1">Alle</button>` +
        areas.map((a, i) => `<button class="chip area-chip" data-area="${i}">${a.label}</button>`).join("") +
        `</div>`;
    } else if (t.scenes.length) {
      row += `<div class="pill" data-pill="${ti}"><span><span class="lbl">Actieve scene:</span><b>-</b></span></div>`;
    }
    row += `<button class="allbtn" data-all="${ti}">${icon("list")}<span class="txt">Alle lampen</span><span class="chev">${icon("chevron-down")}</span></button>`;
    return row + "</div>";
  };

  Panel.definePage("tab", { className: "tab-page", html: (sec) => Panel.lightingPanel(sec.tab) + Panel.lightingRow(sec.tab) });

  /* A list taller than its half scrolls natively (touch-action pan-y); one that
   * fits leaves vertical swipes to the floor switch. */
  function markScroll(list) {
    list.classList.toggle("scrolls", list.scrollHeight > list.clientHeight + 1);
  }

  Panel.defineAction(
    "light",
    (el) => Panel.toggleLight(el.dataset.light),
    (el) => Panel.openLightPopup(el.dataset.light)
  );
  Panel.defineAction("scene", (el) => {
    const [tab, idx] = el.dataset.scene.split(":").map(Number);
    Panel.activateScene(tab, idx);
  });

  const lightIds = new Set();
  cfg.tabs.forEach((t) => {
    [...t.lights, ...t.devices].forEach((e) => lightIds.add(e.id));
    (t.areas || []).forEach((a) => a.lights.forEach((id) => lightIds.add(id)));
  });
  Panel.track(lightIds, onLights);
  Panel.track(cfg.tabs.flatMap((t) => t.scenes.map((s) => s.id)), onScenes);

  Panel.on("build", () => {
    document.querySelectorAll(".split-list").forEach((list) => {
      const ro = new ResizeObserver(() => markScroll(list));
      ro.observe(list);
      ro.observe(list.firstElementChild);
      markScroll(list);
    });
    lightIds.forEach(renderLight);
  });
  Panel.on("loaded", loadLamps);
})();
