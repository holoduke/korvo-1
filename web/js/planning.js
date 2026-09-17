/* Schoonmaak planning: cleaning schedules per robot, for chosen rooms (or the
 * whole floor) on chosen weekdays at a time. They run in Home Assistant, not in
 * the panel, so they also run while no screen is open: each schedule is an
 * automation the panel writes and reads back through Home Assistant's
 * automation config API (id "panel_stofzuig_<n>"); the robot it belongs to is
 * the one in its "only when docked or idle" condition. Switching a schedule off
 * or on switches its automation; a run is skipped while the robot is busy.
 * Each robot's panel lists its own schedules, the editor opens as an overlay,
 * and the Xiaomi's room tiles say when that room is next planned. A robot
 * without rooms (Tuya) plans its whole floor. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;
  const { esc } = Util;

  /* The robots that can be planned: {floor, label, vacuum, rooms, roomsDomain, whole}. */
  const robots = [
    ...(cfg.vacuum
      ? [{ floor: cfg.vacuum.floor, label: cfg.vacuum.label, vacuum: cfg.vacuum.vacuum, rooms: cfg.vacuum.rooms, roomsDomain: cfg.vacuum.roomsDomain, whole: "Hele huis" }]
      : []),
    ...(cfg.tuyaVacuums || []).map((r) => ({ floor: r.floor, label: r.label, vacuum: r.entities.vacuum, rooms: [], roomsDomain: null, whole: "Hele verdieping" })),
  ];
  if (!robots.length) return;

  const ID_PREFIX = "panel_stofzuig_";
  const DAYS = [["mon", "ma"], ["tue", "di"], ["wed", "wo"], ["thu", "do"], ["fri", "vr"], ["sat", "za"], ["sun", "zo"]];
  const ALL_DAYS = DAYS.map(([key]) => key);
  const PRESETS = [
    ["Werkdagen", ["mon", "tue", "wed", "thu", "fri"]],
    ["Weekend", ["sat", "sun"]],
    ["Elke dag", ALL_DAYS],
  ];
  const STEP_MIN = 15;
  const DEFAULT_TIME = "10:00";

  let schedules = null; /* [{id, entity, robot, time, days, rooms}], null until loaded; rooms null = whole floor */
  let draft = null; /* the schedule in the editor: {id | null, robot, time, days: Set, rooms: Set} */
  let loading = false;
  const twoTap = Util.confirmer(3000, () => renderEditor());

  /* A robot's panel (cleaning.js) and the list slot in it. */
  const panelOf = (robot) => document.querySelector(`.vac-page [data-robot-panel="${robot.floor}"]`);

  /* ---- Schedules <-> automations ------------------------------------------------ */
  const enabled = (s) => (Panel.st(s.entity) || {}).state === "on";

  function parse(entity, config) {
    const list = (x, y) => [].concat(x || y || []);
    const trigger = list(config.triggers, config.trigger)[0] || {};
    const conditions = list(config.conditions, config.condition);
    const weekday = conditions.find((c) => c.condition === "time" && c.weekday);
    const docked = conditions.find((c) => c.condition === "state");
    const action = list(config.actions, config.action)[0] || {};
    const robot = robots.find((r) => docked && [].concat(docked.entity_id).includes(r.vacuum));
    if (!robot) return null; /* a robot no longer on the panel */
    const areas = action.data && action.data.gebieden;
    return {
      id: config.id,
      entity,
      robot,
      time: String(trigger.at || "").slice(0, 5),
      days: weekday ? [].concat(weekday.weekday) : ALL_DAYS,
      rooms: Array.isArray(areas) ? areas.map(Number) : null,
    };
  }

  function automation(id, d) {
    const { robot } = d;
    const days = ALL_DAYS.filter((key) => d.days.has(key));
    const rooms = [...d.rooms].sort((a, b) => a - b);
    return {
      id,
      alias: `Stofzuigplanning ${robot.label}: ${roomsText(robot, rooms.length ? rooms : null)} ${daysText(days)} ${d.time}`,
      description: "Gemaakt en beheerd in het wandpaneel (Schoonmaak, Planning). Slaat over als de robot al bezig is.",
      mode: "single",
      triggers: [{ trigger: "time", at: `${d.time}:00` }],
      conditions: [
        { condition: "time", weekday: days },
        { condition: "state", entity_id: robot.vacuum, state: ["docked", "idle"] },
      ],
      /* Rooms go through robotkamers, which first clears any open job; the whole
       * floor is the robot's own start. */
      actions: rooms.length
        ? [{ action: `${robot.roomsDomain}.stofzuig`, data: { gebieden: rooms } }]
        : [{ action: "vacuum.start", target: { entity_id: robot.vacuum } }],
    };
  }

  let loadedAt = 0;
  async function load(force = true) {
    if (loading || (!force && Date.now() - loadedAt < 5 * 60e3)) return;
    loading = true;
    loadedAt = Date.now();
    try {
      const all = await Panel.client.getStates();
      const found = all.filter((s) => s.entity_id.startsWith("automation.") && String((s.attributes || {}).id || "").startsWith(ID_PREFIX));
      const parsed = await Promise.all(
        found.map((s) =>
          Panel.client
            .automationConfig(s.attributes.id)
            .then((config) => config && parse(s.entity_id, config))
            .catch(() => null)
        )
      );
      schedules = parsed.filter(Boolean).sort((a, b) => a.time.localeCompare(b.time));
      Panel.track(schedules.map((s) => s.entity), render); /* the same handler each load: registered once */
    } catch (e) {
      schedules = schedules || [];
    }
    loading = false;
    render();
  }

  /* ---- Words ------------------------------------------------------------------- */
  function roomsText(robot, rooms) {
    const label = new Map(robot.rooms.map((r) => [r.id, r.label]));
    return rooms ? rooms.map((id) => label.get(id) || `#${id}`).join(", ") : robot.whole;
  }
  function daysText(days) {
    const preset = PRESETS.find(([, keys]) => keys.length === days.length && keys.every((k) => days.includes(k)));
    return preset ? preset[0].toLowerCase() : DAYS.filter(([key]) => days.includes(key)).map(([, label]) => label).join(" ");
  }

  /* The next moment a schedule runs, or null without days. */
  function nextRun(s, from = new Date()) {
    const [h, m] = s.time.split(":").map(Number);
    for (let d = 0; d <= 7; d++) {
      const t = new Date(from);
      t.setDate(t.getDate() + d);
      t.setHours(h, m, 0, 0);
      if (t > from && s.days.includes(DAYS[(t.getDay() + 6) % 7][0])) return t;
    }
    return null;
  }
  const when = Util.soon;

  /* ---- The lists on the robots' panels ---------------------------------------------- */
  function rowHtml(s) {
    const on = enabled(s);
    const next = on && nextRun(s);
    return (
      `<div class="pl-row${on ? "" : " off"}">` +
      `<button class="pl-main" data-plan="edit|${s.id}"><b class="pl-time">${s.time}</b>` +
      `<span class="pl-info"><span class="pl-rooms">${esc(roomsText(s.robot, s.rooms))}</span>` +
      `<span class="pl-days">${DAYS.map(([key, label]) => `<i class="${s.days.includes(key) ? "on" : ""}">${label}</i>`).join("")}</span>` +
      `<small>${on ? (next ? `volgende ${when(next)}` : "") : "staat uit"}</small></span></button>` +
      `<button class="pl-switch${on ? " on" : ""}" data-plan="toggle|${s.id}" aria-label="${on ? "Planning uitzetten" : "Planning aanzetten"}"><i class="toggle-pill"></i></button>` +
      `</div>`
    );
  }

  function render() {
    robots.forEach((robot) => {
      const panel = panelOf(robot);
      const slot = panel && panel.querySelector(".vs-plan");
      if (!slot) return;
      const mine = (schedules || []).filter((s) => s.robot === robot);
      slot.innerHTML =
        `<div class="vs-section-title">Planning</div>` +
        `<div class="pl-list">` +
        (schedules === null
          ? `<div class="vs-empty">Laden...</div>`
          : mine.length
            ? mine.map(rowHtml).join("")
            : `<div class="vs-empty">Nog niets gepland: kies ${robot.rooms.length ? "kamers, " : ""}dagen en een tijd.</div>`) +
        `</div>` +
        `<button class="vbtn pl-new" data-plan="new">${icon("plus")}<span>Nieuwe planning</span></button>`;
      /* Each room tile: when it is next planned (by a room schedule or the whole floor). */
      panel.querySelectorAll(".vs-room").forEach((tile) => {
        const id = +tile.dataset.room;
        const next = mine
          .filter((s) => enabled(s) && (!s.rooms || s.rooms.includes(id)))
          .map((s) => nextRun(s))
          .filter(Boolean)
          .sort((a, b) => a - b)[0];
        tile.querySelector(".vs-rplan").innerHTML = next ? `${icon("calendar")}<span>${when(next)}</span>` : "";
      });
    });
  }

  Panel.defineAction("plan", (el) => {
    const [what, id] = el.dataset.plan.split("|");
    if (what === "new") {
      const floor = el.closest("[data-robot-panel]").dataset.robotPanel;
      return openEditor(null, robots.find((r) => r.floor === floor));
    }
    const s = (schedules || []).find((x) => x.id === id);
    if (!s) return;
    if (what === "edit") return openEditor(s, s.robot);
    Panel.client
      .callService("automation", enabled(s) ? "turn_off" : "turn_on", null, { entity_id: s.entity })
      .catch(Panel.commandFailed("Planning"));
  });

  /* ---- Editor ----------------------------------------------------------------------- */
  function openEditor(s, robot) {
    draft = s
      ? { id: s.id, robot, time: s.time || DEFAULT_TIME, days: new Set(s.days), rooms: new Set(s.rooms || []) }
      : { id: null, robot, time: DEFAULT_TIME, days: new Set(PRESETS[0][1]), rooms: new Set() };
    renderEditor();
    Panel.openOverlay($("plan"));
  }
  function closeEditor() {
    draft = null;
    Panel.closeOverlay($("plan"));
  }

  function shift(time, minutes) {
    const [h, m] = time.split(":").map(Number);
    const total = (((Math.round((h * 60 + m + minutes) / STEP_MIN) * STEP_MIN) % 1440) + 1440) % 1440;
    return `${Util.pad2(Math.floor(total / 60))}:${Util.pad2(total % 60)}`;
  }

  function renderEditor() {
    if (!draft) return;
    const { robot } = draft;
    const days = ALL_DAYS.filter((key) => draft.days.has(key));
    const rooms = [...draft.rooms].sort((a, b) => a - b);
    const armed = twoTap.armed("delete");
    $("planTitle").textContent = `${draft.id ? "Planning wijzigen" : "Nieuwe planning"}${robots.length > 1 ? ` · ${robot.label}` : ""}`;
    $("planBody").innerHTML =
      (robot.rooms.length
        ? `<div class="pl-field"><span class="vlabel">Kamers</span><div class="pl-chips">` +
          `<button class="vchip${rooms.length ? "" : " active"}" data-edit="whole">${esc(robot.whole)}</button>` +
          robot.rooms.map((r) => `<button class="vchip${draft.rooms.has(r.id) ? " active" : ""}" data-edit="room|${r.id}">${esc(r.label)}</button>`).join("") +
          `</div></div>`
        : "") +
      `<div class="pl-field"><span class="vlabel">Dagen</span><div class="pl-days-edit">` +
      DAYS.map(([key, label]) => `<button class="vchip${draft.days.has(key) ? " active" : ""}" data-edit="day|${key}">${label}</button>`).join("") +
      `</div><div class="pl-presets">` +
      PRESETS.map(([label, keys], i) => {
        const active = keys.length === days.length && keys.every((k) => draft.days.has(k));
        return `<button class="pl-preset${active ? " active" : ""}" data-edit="preset|${i}">${label}</button>`;
      }).join("") +
      `</div></div>` +
      `<div class="pl-field"><span class="vlabel">Tijd</span><div class="pl-time-edit">` +
      `<button class="vchip" data-edit="time|-60" aria-label="Een uur eerder">−1 u</button>` +
      `<button class="vchip" data-edit="time|-15" aria-label="Kwartier eerder">${icon("minus")}</button>` +
      `<b>${draft.time}</b>` +
      `<button class="vchip" data-edit="time|15" aria-label="Kwartier later">${icon("plus")}</button>` +
      `<button class="vchip" data-edit="time|60" aria-label="Een uur later">+1 u</button>` +
      `</div></div>` +
      `<p class="pl-summary">${esc(days.length ? `${roomsText(robot, rooms.length ? rooms : null)} · ${daysText(days)} om ${draft.time}` : "Kies minstens één dag")}</p>` +
      `<div class="pl-actions">` +
      (draft.id ? `<button class="vbtn${armed ? " armed" : ""}" data-edit="delete">${icon("close")}<span>${armed ? "Nogmaals tikken" : "Verwijderen"}</span></button>` : "") +
      `<button class="vbtn primary" data-edit="save"${days.length ? "" : " disabled"}>${icon("check")}<span>Opslaan</span></button>` +
      `</div>`;
  }

  const toggle = (set, value) => (set.has(value) ? set.delete(value) : set.add(value));

  async function save() {
    const id = draft.id || `${ID_PREFIX}${Date.now()}`;
    try {
      await Panel.client.saveAutomation(id, automation(id, draft));
      closeEditor();
      /* Home Assistant reloads its automations first; then the new entity exists. */
      setTimeout(load, 800);
    } catch (err) {
      Panel.commandFailed("Planning")(err);
    }
  }
  async function remove() {
    try {
      await Panel.client.deleteAutomation(draft.id);
      closeEditor();
      setTimeout(load, 800);
    } catch (err) {
      Panel.commandFailed("Planning")(err);
    }
  }

  $("planClose").innerHTML = icon("close");
  $("planClose").addEventListener("click", closeEditor);
  $("plan").addEventListener("click", (e) => {
    if (e.target === $("plan")) return closeEditor();
    const button = e.target.closest("[data-edit]");
    if (!button || button.disabled || !draft) return;
    const [what, arg] = button.dataset.edit.split("|");
    if (what === "whole") draft.rooms.clear();
    else if (what === "room") toggle(draft.rooms, +arg);
    else if (what === "day") toggle(draft.days, arg);
    else if (what === "preset") draft.days = new Set(PRESETS[+arg][1]);
    else if (what === "time") draft.time = shift(draft.time, +arg);
    else if (what === "save") return save();
    else if (what === "delete") return twoTap.tap("delete", true) && remove();
    renderEditor();
  });

  Panel.on("build", render);
  Panel.on("loaded", () => load());
  /* A visit re-reads the schedules now and then (made or changed in HA itself);
   * on/off changes come through the tracked automation entities. */
  Panel.on("section", () => Panel.isLoaded() && Panel.onScreen("vacuum") && load(false));
  Panel.on("minute", render); /* "vandaag" becomes "morgen" */
})();
