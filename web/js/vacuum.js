/* Schoonmaak section: the robot vacuum's page. Left the rooms as large tiles
 * (tap to choose, a live sweep on the rooms of the current run, when each room
 * was last cleaned) and the robot's recent runs; right the actions, the
 * mode/suction/water choices and the consumables. Battery and status sit in
 * the app header's vacuum column. The robot keeps its map in the Xiaomi cloud;
 * the room tiles are laid out so a real map image can later sit underneath. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const vac = cfg.vacuum;
  if (!vac) return;

  const STATE_NL = { docked: "In dock", idle: "Klaar", paused: "Pauze", error: "Storing" };
  const MODE_NL = { BothWork: "Zuigen\u00a0+ dweilen" /* breaks as "Zuigen +" / "dweilen" */, OnlySweep: "Zuigen", OnlyMop: "Dweilen", SweepFirst: "Eerst zuigen" };
  const FAN_NL = { Quiet: "Stil", Auto: "Auto", Strong: "Sterk", Max: "Max" };
  const WATER_NL = { Low: "Laag", Mid: "Midden", High: "Hoog" };
  const CONSUMABLES = {
    sideBrush: "Zijborstel", rollBrush: "Hoofdborstel", filter: "Filter", mop: "Dweil",
    engineSensor: "Sensoren", dustbag: "Stofzak", mopCleaningTrough: "Wasbak",
  };
  const selected = new Set(); /* chosen room ids */
  let records = null; /* robot's run log, newest first */
  const lastByRoom = new Map(); /* room id -> ms */
  /* Learned sizes, from finished runs in HA's history: m² per set of rooms
   * ("5,8"; "" is the whole house). The robot reports the area cleaned so far
   * but no progress and no room sizes (those live in the Xiaomi cloud map). */
  const areaBySet = new Map();
  /* {"5,8": m², ...} as learned so far; part of the diagnostics report. */
  Panel.vacLearned = () => Object.fromEntries(areaBySet);
  let loadedAt = 0;
  let loading = false;
  let root = null;
  const st = Panel.st;
  const q = (sel) => root.querySelector(sel);
  const qa = (sel) => [...root.querySelectorAll(sel)];

  function parseList(raw) {
    try {
      const v = JSON.parse(raw || "[]");
      return Array.isArray(v) ? v.map(Number) : [];
    } catch (e) {
      return [];
    }
  }
  const { ago } = Util;

  /* One row of equal tiles per choice: the grid gets its column count as --n. */
  const chips = (kind, labels) =>
    `<div class="vs-chips" style="--n:${Object.keys(labels).length}">` +
    Object.entries(labels).map(([opt, l]) => `<button class="vchip" data-vac="${kind}" data-opt="${opt}">${l}</button>`).join("") +
    `</div>`;

  function build(page) {
    root = page.querySelector(".vp");
    root.innerHTML =
      `<div class="vs-body">` +
      `<section class="vs-map">` +
      `<div class="vs-rooms">` +
      vac.rooms
        .map(
          (r) =>
            `<button class="vs-room" data-vac="room" data-room="${r.id}"><span class="vs-rname">${r.label}</span>` +
            `<span class="vs-rid">#${r.id}</span><span class="vs-pct"></span>` +
            `<span class="vs-rlast">${icon("clock")}<span></span></span><span class="vs-rplan"></span><i class="vs-sweep"></i><i class="vs-prog"><b></b></i></button>`
        )
        .join("") +
      `</div><div class="vs-plan"></div>` +
      `<div class="vs-section-title">Laatste rondes</div><div class="vs-rec-list"></div></section>` +
      `<section class="vs-side"><div class="vs-actions">` +
      `<button class="vbtn primary" data-vac="rooms">${icon("play")}<span>Kies kamers</span></button>` +
      `<button class="vbtn" data-vac="start">${icon("play")}<span>Hele huis</span></button>` +
      `<button class="vbtn" data-vac="pause">${icon("pause")}<span>Pauze</span></button>` +
      `<button class="vbtn" data-vac="resume">${icon("play")}<span>Verder</span></button>` +
      `<button class="vbtn" data-vac="dock">${icon("dock")}<span>Naar dock</span></button>` +
      `<button class="vbtn" data-vac="locate">${icon("locate")}<span>Zoek robot</span></button>` +
      `</div>` +
      `<div class="vs-group"><span class="vlabel">Modus</span>${chips("mode", MODE_NL)}</div>` +
      `<div class="vs-group"><span class="vlabel">Zuigkracht</span>${chips("fan", FAN_NL)}</div>` +
      `<div class="vs-group vs-water"><span class="vlabel">Water</span>${chips("water", WATER_NL)}</div>` +
      `<div class="vs-section-title">Onderhoud</div><div class="vs-cons-list"></div>` +
      `</section></div>`;
    render();
  }
  Panel.definePage("vacuum", { className: "vac-page", html: () => `<div id="vacPage" class="vp"></div>`, build });

  function render() {
    if (!root) return;
    const v = st(vac.vacuum);
    const statusRaw = ((st(vac.status) || {}).state || "").toLowerCase();
    const vstate = v ? v.state : "unavailable";
    const offline = Panel.unavailable(v);
    const busy = ["cleaning", "returning"].includes(vstate);
    const paused = vstate === "paused" || statusRaw === "paused";
    const area = Panel.num(vac.area);
    const running = !offline && ["cleaning", "paused", "returning"].includes(vstate);
    const runRooms = running ? parseList(v.attributes["robotic_vacuum.clean_values"]) : [];
    const done = Number.isFinite(area) ? area : 0;
    const expected = running ? expectedArea(runRooms) : null;
    /* Capped below 100: the robot decides when a room is finished, not the estimate. */
    const pct = expected ? Math.min(99, Math.round((done / expected) * 100)) : null;
    /* Header status, a word or two (the column is narrow; details are on the page).
     * During a job that is its progress, including mop-wash trips to the dock. */
    let status;
    if (offline) status = "Offline";
    else if (vstate === "error" || statusRaw === "error") status = "Storing";
    else if (running && pct !== null) status = `${pct}%`;
    else if (vstate === "returning") status = "Terug";
    else if (paused) status = "Pauze";
    else if (busy) status = done > 0 ? `${Math.round(done)} m²` : "Bezig";
    else if (statusRaw === "charging" || statusRaw === "breakcharging") status = "Laadt";
    else if (statusRaw === "charged") status = "Vol";
    else status = STATE_NL[vstate] || "Klaar";
    root.classList.toggle("offline", offline);

    /* Battery and status live in the header, visible from every section. */
    Panel.setDevice("vacuum", { battery: Panel.num(vac.battery), status, active: busy, offline });

    const minutes = Math.round((Number(v && v.attributes["robotic_vacuum.clean_time"]) || 0) / 60);
    qa(".vs-room").forEach((el) => {
      const id = +el.dataset.room;
      const live = runRooms.includes(id);
      const measured = live && pct !== null;
      el.classList.toggle("active", selected.has(id));
      el.classList.toggle("live", live);
      el.classList.toggle("measured", measured);
      el.querySelector(".vs-pct").textContent = measured ? pct + "%" : "";
      el.querySelector(".vs-prog b").style.width = (measured ? pct : 0) + "%";
      el.querySelector(".vs-rlast span").textContent = !live
        ? ago(lastByRoom.get(id))
        : measured
          ? `${Math.round(done)} van ~${Math.round(expected)} m²`
          : done > 0
            ? `${Math.round(done)} m² · ${minutes} min`
            : "nu bezig";
    });

    for (const [kind, id] of [["mode", vac.mode], ["fan", vac.fan], ["water", vac.water]]) {
      const cur = (st(id) || {}).state;
      qa(`[data-vac="${kind}"]`).forEach((c) => c.classList.toggle("active", c.dataset.opt === cur));
    }
    q(".vs-water").hidden = (st(vac.mode) || {}).state === "OnlySweep";

    const n = selected.size;
    const roomsBtn = q('[data-vac="rooms"]');
    roomsBtn.querySelector("span").textContent = n ? `Start ${n === 1 ? "kamer" : n + " kamers"}` : "Kies kamers";
    roomsBtn.disabled = !n || busy || offline;
    q('[data-vac="start"]').hidden = busy || paused;
    roomsBtn.hidden = busy || paused;
    q('[data-vac="pause"]').hidden = !busy || vstate === "returning";
    q('[data-vac="resume"]').hidden = !paused;
    q('[data-vac="dock"]').hidden = !(busy || paused) || vstate === "returning";

    let cons = [];
    try {
      cons = JSON.parse((v && v.attributes["robotic_vacuum.consumables"]) || "[]");
    } catch (e) {
      cons = [];
    }
    q(".vs-cons-list").innerHTML = cons.length
      ? cons
          .filter((c) => CONSUMABLES[c.type])
          .map((c) => {
            const used = Math.max(0, Math.min(100, Number(c.used) || 0));
            const tone = used >= 90 ? "bad" : used >= 70 ? "warn" : "ok";
            return `<div class="vs-cons"><span>${CONSUMABLES[c.type]}</span><i class="bar ${tone}"><b style="width:${used}%"></b></i><em>${used}% gebruikt</em></div>`;
          })
          .join("")
      : `<div class="vs-empty">Geen gegevens</div>`;

    q(".vs-rec-list").innerHTML =
      records === null
        ? `<div class="vs-empty">Laden...</div>`
        : records.length
          ? records
              .slice(0, 5)
              .map((r) => `<div class="vs-rec"><span>${ago(r.when.getTime())}</span><b>${r.area} m²</b><em>${Math.round(r.secs / 60)} min</em></div>`)
              .join("")
          : `<div class="vs-empty">Nog geen rondes</div>`;
  }

  /* A run's rooms and the largest area it reached. clean_time only counts up
   * during a run, so a drop marks the start of the next one; trips back to wash
   * the mop stay in the same run. The rooms are taken from the row where the
   * area last grew, because the first row of a new job still carries the
   * previous run's area and time. Runs that cleaned nothing are ignored, and
   * the largest finished run per set of rooms wins. */
  function learnRuns(rows) {
    let run = null;
    let prevTime = -1;
    const commit = () => {
      if (run && run.area > 0) areaBySet.set(run.key, Math.max(areaBySet.get(run.key) || 0, run.area));
      run = null;
    };
    for (const row of rows) {
      const a = row.a || {};
      const area = Number(a["robotic_vacuum.clean_area"]);
      const time = Number(a["robotic_vacuum.clean_time"]);
      if (!Number.isFinite(area) || !Number.isFinite(time)) continue;
      const key = parseList(a["robotic_vacuum.clean_values"]).sort((x, y) => x - y).join(",");
      if (run && time < prevTime) commit();
      prevTime = time;
      if (!run) run = { key, area: 0 };
      if (area > run.area) run = { key, area };
      else if (run.area === 0) run.key = key;
    }
    /* The last run is not counted: without a later restart of clean_time it may
     * still be going (the robot docks mid-run to wash its mop, at part of the area). */
  }

  /* m² expected for a set of rooms: a finished run of exactly that set, or the
   * sum of the room sizes. A room's size comes from a run of that room alone,
   * or from a run of several rooms where it was the only unknown one. */
  function expectedArea(rooms) {
    const key = [...rooms].sort((x, y) => x - y).join(",");
    if (areaBySet.has(key)) return areaBySet.get(key);
    if (!rooms.length) return null;
    const size = new Map();
    for (const [k, m2] of areaBySet) if (k && !k.includes(",")) size.set(+k, m2);
    for (let pass = 0; pass < 3; pass++) {
      for (const [k, m2] of areaBySet) {
        if (!k.includes(",")) continue;
        const ids = k.split(",").map(Number);
        const unknown = ids.filter((id) => !size.has(id));
        if (unknown.length !== 1) continue;
        const rest = m2 - ids.filter((id) => size.has(id)).reduce((sum, id) => sum + size.get(id), 0);
        if (rest > 0) size.set(unknown[0], rest);
      }
    }
    return rooms.every((id) => size.has(id)) ? rooms.reduce((sum, id) => sum + size.get(id), 0) : null;
  }

  async function load(force) {
    if (loading || (!force && Date.now() - loadedAt < 60e3)) return;
    loading = true;
    loadedAt = Date.now();
    try {
      /* Read-only: the robot's run log (the integration does not poll it). */
      const res = await Panel.client.callService(
        "xiaomi_miot", "get_properties",
        { entity_id: vac.vacuum, mapping: { clean_records: { siid: 17, piid: 46 } } },
        null, true
      );
      const list = JSON.parse((((res || {}).response) || {}).clean_records || "[]");
      records = list
        .filter((r) => /^20\d\d\//.test(r.d || "")) /* entries logged before the clock was set say 1970 */
        .map((r) => ({ when: new Date(`${r.d.replace(/\//g, "-")}T${r.t}`), area: r.A, secs: r.T }))
        .sort((a, b) => b.when - a.when);
    } catch (e) {
      records = records || [];
    }
    try {
      const hist = await Panel.client.historyFull([vac.vacuum], new Date(Date.now() - 14 * 86400e3));
      const rows = [...(hist[vac.vacuum] || [])].sort((a, b) => a.t - b.t);
      for (const row of rows) {
        if (row.s !== "cleaning") continue;
        parseList(row.a["robotic_vacuum.clean_values"]).forEach((id) => {
          if (!lastByRoom.has(id) || lastByRoom.get(id) < row.t) lastByRoom.set(id, row.t);
        });
      }
      learnRuns(rows);
    } catch (e) {
      /* keep what we had */
    }
    loading = false;
    render();
  }

  Panel.defineAction("vac", (el) => {
    const kind = el.dataset.vac;
    const target = { entity_id: vac.vacuum };
    const fail = Panel.commandFailed(vac.label);
    if (kind === "room") {
      const id = +el.dataset.room;
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      return render();
    }
    if (kind === "mode" || kind === "fan" || kind === "water") {
      const entity = vac[kind];
      const s = st(entity);
      if (s) Panel.client.states.set(entity, { ...s, state: el.dataset.opt }); /* optimistic; HA confirms */
      render();
      return Panel.client.callService("select", "select_option", { option: el.dataset.opt }, { entity_id: entity }).catch(fail);
    }
    if (kind === "rooms") {
      if (!selected.size) return;
      /* The robotkamers integration stops any open job first: the robot silently
       * ignores a new start while an old one is still pending. */
      Panel.client
        .callService(vac.roomsDomain, "stofzuig", { gebieden: [...selected].sort((a, b) => a - b) })
        .catch(fail);
      selected.clear();
      return render();
    }
    if (kind === "start" || kind === "resume") return Panel.client.callService("vacuum", "start", null, target).catch(fail);
    if (kind === "pause") return Panel.client.callService("vacuum", "pause", null, target).catch(fail);
    if (kind === "dock") return Panel.client.callService(vac.roomsDomain, "naar_station").catch(fail);
    if (kind === "locate") return Panel.client.callService("button", "press", null, { entity_id: vac.locate }).catch(fail);
  });

  /* The run log and room history are fetched when the page is shown, but only
   * once HA is connected: after a reload straight onto #schoonmaak the section
   * opens before the socket does, and the first state dump marks the connection. */
  const onPage = () => cfg.sections[Panel.section].kind === "vacuum";
  Panel.track(
    ["vacuum", "status", "battery", "area", "mode", "fan", "water", "locate"].map((k) => vac[k]),
    () => {
      render();
      if (onPage()) load(false);
    }
  );
  Panel.on("section", () => Panel.isLoaded() && onPage() && load(false));
})();
