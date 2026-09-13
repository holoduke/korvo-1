/* Schoonmaak planning: cleaning schedules for chosen rooms (or the whole
 * house) on chosen weekdays at a time. They run in Home Assistant, not in the
 * panel, so they also run while no screen is open: each schedule is an
 * automation the panel writes and reads back through Home Assistant's
 * automation config API (id "panel_stofzuig_<n>"). Switching a schedule off or
 * on switches its automation; a run is skipped while the robot is busy. The
 * list sits on the Schoonmaak page, the editor opens as an overlay, and each
 * room tile says when that room is next planned. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;
  const vac = cfg.vacuum;
  if (!vac) return;
  const { esc } = Util;

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
  const roomLabel = new Map(vac.rooms.map((r) => [r.id, r.label]));

  let schedules = null; /* [{id, entity, time, days, rooms}], null until loaded; rooms null = whole house */
  let draft = null; /* the schedule in the editor: {id | null, time, days: Set, rooms: Set} */
  let root = null;
  let loading = false;
  const twoTap = Util.confirmer(3000, () => renderEditor());

  /* ---- Schedules <-> automations ------------------------------------------------ */
  const enabled = (s) => (Panel.st(s.entity) || {}).state === "on";
  const pad2 = (n) => String(n).padStart(2, "0");

  function parse(entity, config) {
    const trigger = [].concat(config.triggers || config.trigger || [])[0] || {};
    const weekday = [].concat(config.conditions || config.condition || []).find((c) => c.condition === "time" && c.weekday);
    const action = [].concat(config.actions || config.action || [])[0] || {};
    const areas = action.data && action.data.gebieden;
    return {
      id: config.id,
      entity,
      time: String(trigger.at || "").slice(0, 5),
      days: weekday ? [].concat(weekday.weekday) : ALL_DAYS,
      rooms: Array.isArray(areas) ? areas.map(Number) : null,
    };
  }

  function automation(id, d) {
    const days = ALL_DAYS.filter((key) => d.days.has(key));
    const rooms = [...d.rooms].sort((a, b) => a - b);
    return {
      id,
      alias: `Stofzuigplanning ${roomsText(rooms.length ? rooms : null)} ${daysText(days)} ${d.time}`,
      description: "Gemaakt en beheerd in het wandpaneel (Schoonmaak, Planning). Slaat over als de robot al bezig is.",
      mode: "single",
      triggers: [{ trigger: "time", at: `${d.time}:00` }],
      conditions: [
        { condition: "time", weekday: days },
        { condition: "state", entity_id: vac.vacuum, state: ["docked", "idle"] },
      ],
      /* Rooms go through robotkamers, which first clears any open job; the whole
       * house is the robot's own start. */
      actions: rooms.length
        ? [{ action: `${vac.roomsDomain}.stofzuig`, data: { gebieden: rooms } }]
        : [{ action: "vacuum.start", target: { entity_id: vac.vacuum } }],
    };
  }

  async function load() {
    if (loading) return;
    loading = true;
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
      Panel.track(
        schedules.map((s) => s.entity),
        () => render()
      );
    } catch (e) {
      schedules = schedules || [];
    }
    loading = false;
    render();
  }

  /* ---- Words ------------------------------------------------------------------- */
  function roomsText(rooms) {
    return rooms ? rooms.map((id) => roomLabel.get(id) || `#${id}`).join(", ") : "Hele huis";
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
  function when(date) {
    const days = Math.round((new Date(date.toDateString()) - new Date(new Date().toDateString())) / 86400e3);
    return `${days === 0 ? "vandaag" : days === 1 ? "morgen" : DAYS[(date.getDay() + 6) % 7][1]} ${Util.hm(date)}`;
  }

  /* ---- The list on the page -------------------------------------------------------- */
  function rowHtml(s) {
    const on = enabled(s);
    const next = on && nextRun(s);
    return (
      `<div class="pl-row${on ? "" : " off"}">` +
      `<button class="pl-main" data-plan="edit|${s.id}"><b class="pl-time">${s.time}</b>` +
      `<span class="pl-info"><span class="pl-rooms">${esc(roomsText(s.rooms))}</span>` +
      `<span class="pl-days">${DAYS.map(([key, label]) => `<i class="${s.days.includes(key) ? "on" : ""}">${label}</i>`).join("")}</span>` +
      `<small>${on ? (next ? `volgende ${when(next)}` : "") : "staat uit"}</small></span></button>` +
      `<button class="pl-switch${on ? " on" : ""}" data-plan="toggle|${s.id}" aria-label="${on ? "Planning uitzetten" : "Planning aanzetten"}"><i></i></button>` +
      `</div>`
    );
  }

  function render() {
    if (!root) return;
    root.innerHTML =
      `<div class="vs-section-title">Planning</div>` +
      `<div class="pl-list">` +
      (schedules === null
        ? `<div class="vs-empty">Laden...</div>`
        : schedules.length
          ? schedules.map(rowHtml).join("")
          : `<div class="vs-empty">Nog niets gepland: kies kamers, dagen en een tijd.</div>`) +
      `</div>` +
      `<button class="vbtn pl-new" data-plan="new">${icon("plus")}<span>Nieuwe planning</span></button>`;
    /* Each room tile: when it is next planned (by a room schedule or the whole house). */
    document.querySelectorAll("#vacPage .vs-room").forEach((tile) => {
      const id = +tile.dataset.room;
      const next = (schedules || [])
        .filter((s) => enabled(s) && (!s.rooms || s.rooms.includes(id)))
        .map((s) => nextRun(s))
        .filter(Boolean)
        .sort((a, b) => a - b)[0];
      tile.querySelector(".vs-rplan").innerHTML = next ? `${icon("calendar")}<span>${when(next)}</span>` : "";
    });
  }

  Panel.defineAction("plan", (el) => {
    const [what, id] = el.dataset.plan.split("|");
    if (what === "new") return openEditor(null);
    const s = (schedules || []).find((x) => x.id === id);
    if (!s) return;
    if (what === "edit") return openEditor(s);
    Panel.client
      .callService("automation", enabled(s) ? "turn_off" : "turn_on", null, { entity_id: s.entity })
      .catch(Panel.commandFailed("Planning"));
  });

  /* ---- Editor ----------------------------------------------------------------------- */
  function openEditor(s) {
    draft = s
      ? { id: s.id, time: s.time || DEFAULT_TIME, days: new Set(s.days), rooms: new Set(s.rooms || []) }
      : { id: null, time: DEFAULT_TIME, days: new Set(PRESETS[0][1]), rooms: new Set() };
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
    return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
  }

  function renderEditor() {
    if (!draft) return;
    const days = ALL_DAYS.filter((key) => draft.days.has(key));
    const rooms = [...draft.rooms].sort((a, b) => a - b);
    const armed = twoTap.armed("delete");
    $("planTitle").textContent = draft.id ? "Planning wijzigen" : "Nieuwe planning";
    $("planBody").innerHTML =
      `<div class="pl-field"><span class="vlabel">Kamers</span><div class="pl-chips">` +
      `<button class="vchip${rooms.length ? "" : " active"}" data-edit="whole">Hele huis</button>` +
      vac.rooms.map((r) => `<button class="vchip${draft.rooms.has(r.id) ? " active" : ""}" data-edit="room|${r.id}">${esc(r.label)}</button>`).join("") +
      `</div></div>` +
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
      `<p class="pl-summary">${esc(days.length ? `${roomsText(rooms.length ? rooms : null)} · ${daysText(days)} om ${draft.time}` : "Kies minstens één dag")}</p>` +
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

  Panel.on("build", () => {
    root = document.querySelector("#vacPage .vs-plan");
    render();
  });
  Panel.on("loaded", load);
  Panel.on("section", () => Panel.isLoaded() && cfg.sections[Panel.section].kind === "vacuum" && load());
  Panel.on("minute", render); /* "vandaag" becomes "morgen" */
})();
