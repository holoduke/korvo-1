/* Schoonmaak: the Xiaomi robot vacuum's panel (PANEL_VACUUM, on its floor's
 * place in cleaning.js). Left the rooms as large tiles (tap to choose, a live
 * sweep on the rooms of the current run, when each room was last cleaned) and
 * the robot's recent runs; right the actions, the mode/suction/water choices
 * and the consumables. Battery and status sit in the app header's vacuum
 * column. The robot keeps its map in the Xiaomi cloud; the room tiles are laid
 * out so a real map image can later sit underneath. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const vac = cfg.vacuum;
  if (!vac) return;

  const STATE_NL = { docked: "In dock", idle: "Klaar", paused: "Pauze", error: "Storing" };
  /* What the robot says it is doing (sensor.<robot>_status / its status_desc). */
  const STATUS_NL = {
    sweeping: "Zuigt", mopping: "Dweilt", "sweeping and mopping": "Zuigt en dweilt", paused: "Gepauzeerd",
    idle: "Staat stil", busy: "Bezig", delay: "Wacht op de starttijd", error: "Storing",
    charging: "Laadt op", breakcharging: "Laadt tussendoor op", "go charging": "Gaat naar het dock",
    gochargebreak: "Gaat opladen, gaat daarna verder", charged: "Opgeladen", sleeping: "Slaapt",
    gowash: "Gaat de dweil wassen", washbreak: "Wast de dweil, gaat daarna verder", godust: "Gaat stof legen",
    stationworking: "Station is bezig", buildingmap: "Maakt een kaart", mappingpause: "Kaart maken staat stil",
    relocation: "Zoekt zijn plek op de kaart", updating: "Werkt zijn software bij", "linking device": "Maakt verbinding",
  };
  /* What the station or robot is doing on top of that (its robot_status attribute). */
  const ROBOT_NL = {
    washmop: "Wast de dweil", backwashmop: "Gaat de dweil wassen", hotdry: "Droogt de dweil",
    clctdust: "Leegt het stof", backclctdust: "Gaat stof legen", relocate: "Zoekt zijn plek op de kaart",
    charging: "Laadt op", chargeasleep: "Laadt op en slaapt", asleep: "Slaapt",
  };
  const MODE_NL = { BothWork: "Zuigen\u00a0+ dweilen" /* breaks as "Zuigen +" / "dweilen" */, OnlySweep: "Zuigen", OnlyMop: "Dweilen", SweepFirst: "Eerst zuigen" };
  const FAN_NL = { Quiet: "Stil", Auto: "Auto", Strong: "Sterk", Max: "Max" };
  const WATER_NL = { Low: "Laag", Mid: "Midden", High: "Hoog" };
  const CONSUMABLES = {
    sideBrush: "Zijborstel", rollBrush: "Hoofdborstel", filter: "Filter", mop: "Dweil",
    engineSensor: "Sensoren", dustbag: "Stofzak", mopCleaningTrough: "Wasbak",
  };
  /* The robot now and then misses a command (xiaomi_miot then only logs "No
   * response from the device"), so they go through a command queue. A choice
   * (mode, suction, water) shows within seconds; stopping a job takes longer. */
  const CHOICE_MS = 8000;
  const STOP_MS = 20000;
  const CHOICE_NOUN = { mode: "modus", fan: "zuigkracht", water: "waterstand" };
  /* A choice is read from its property select and written through the robot's
   * action select (the xm2216 does not answer property writes). */
  const CHOICE_SETTER = { mode: vac.setMode, fan: vac.setFan, water: vac.setWater };
  const JOB_STATES = ["cleaning", "paused", "returning"];
  /* Station and settings: read from the robot's attributes, set through its MIoT
   * actions (siid 17), as its spec requires. xiaomi_miot polls these every 20-70 s,
   * so a change can take that long to show. */
  const SETTING_MS = 90000;
  const SETTINGS = [
    { key: "dnd", label: "Niet storen", attr: "robotic_vacuum.disturb_switch", aiid: 24 },
    { key: "resume", label: "Verder na opladen", attr: "break_clean_switch-17-2", aiid: 25 },
    { key: "carpet", label: "Extra zuigkracht op tapijt", attr: "carpet_boost_switch-17-7", aiid: 34 },
    { key: "drying", label: "Dweil drogen na wassen", attr: "robotic_vacuum.drying_switch", aiid: 48 },
  ];
  const CHOICES = {
    dryTime: { label: "Droogtijd", noun: "droogtijd", attr: "robotic_vacuum.drying_time", aiid: 43, options: { 120: "2 uur", 180: "3 uur", 240: "4 uur" } },
    washFreq: { label: "Dweil wassen elke", noun: "wasfrequentie", attr: "mop_wash_frequency-17-23", aiid: 44, options: { 5: "5 min", 10: "10 min", 15: "15 min" } },
    count: { label: "Zuigen per ronde", noun: "aantal keer zuigen", attr: "robotic_vacuum.clean_count", aiid: 28, options: { 1: "Eén keer", 2: "Twee keer" } },
  };
  const STATION = [
    { key: "wash", label: "Dweil wassen", aiid: 40, icon: "drop" },
    { key: "dry", label: "Dweil drogen", aiid: 41, icon: "fan" },
    { key: "dust", label: "Stof legen", aiid: 42, icon: "vacuum" },
  ];
  const switchedOn = (value) => value === true || Number(value) === 1;
  const queue = Panel.commandQueue(vac.label, () => render());
  const twoTap = Util.confirmer(3000, () => render());
  const selected = new Set(); /* chosen room ids */
  let records = null; /* robot's own run log, newest first: {when, area, secs} */
  let historyRuns = null; /* finished runs from HA's history, newest first: {when, area, secs, rooms} */
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
  Util.onOrientationFlip(() => root && root.querySelectorAll(".vs-body, .vs-map, .vs-side").forEach((el) => (el.scrollLeft = el.scrollTop = 0)));
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
  const { ago, esc, fmt } = Util;
  const roomLabel = new Map(vac.rooms.map((r) => [r.id, r.label]));
  /* The station's tanks (robot attributes, MIoT siid 17 piid 51-54):
   * value -> [what is wrong, what to do about it]. A fault code on its own says
   * nothing (Xiaomi documents none of them), so a tank in this state is the
   * explanation the alert shows beside the code. */
  const TANKS = [
    ["clean_water_cistern-17-51", {
      1: ["Schoonwatertank ontbreekt", "zet de schoonwatertank terug in het station"],
      2: ["Schoonwatertank is onbruikbaar", "haal de schoonwatertank eruit en zet hem goed terug"],
      3: ["Schoonwatertank is bijna leeg", "vul de schoonwatertank met schoon water"],
    }],
    ["robotic_vacuum.drain_cistern", {
      1: ["Vuilwatertank ontbreekt", "zet de vuilwatertank terug in het station"],
      2: ["Vuilwatertank is onbruikbaar", "leeg de vuilwatertank en zet hem goed terug"],
    }],
    ["robotic_vacuum.dust_bag", { 1: ["Stofzak ontbreekt", "plaats een stofzak in het station"] }],
    ["robotic_vacuum.mop_clean_tank", { 1: ["Wasbak ontbreekt", "zet de wasbak terug in het station"] }],
  ];
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  /* Apparaten names this robot as the house does ("Stofzuiger beneden"), which is
   * also the name its photo is filed under; its own label is just "Stofzuiger". */
  const photoLabel = ((cfg.appliances || []).find((ap) => ap.kind === "robot" && ap.floor === vac.floor) || {}).label || vac.label;

  /* What the robot is doing, in words. Its status sensor says most of it; while
   * the station works, the robot's own robot_status says which job that is. */
  function doingText(offline, faulted, vstate, statusRaw, robotRaw) {
    if (offline) return "Niet bereikbaar";
    if (faulted || vstate === "error" || statusRaw === "error") return "Storing";
    if (statusRaw === "stationworking") return ROBOT_NL[robotRaw] || "Station is bezig";
    return STATUS_NL[statusRaw] || ROBOT_NL[robotRaw] || STATE_NL[vstate] || "Klaar";
  }

  /* One row of equal tiles per choice: the grid gets its column count as --n. */
  const chips = (kind, labels) =>
    `<div class="vs-chips" style="--n:${Object.keys(labels).length}">` +
    Object.entries(labels).map(([opt, l]) => `<button class="vchip" data-vac="${kind}" data-opt="${opt}">${l}</button>`).join("") +
    `</div>`;

  const choiceChips = (name) =>
    `<div class="vs-chips" style="--n:${Object.keys(CHOICES[name].options).length}">` +
    Object.entries(CHOICES[name].options).map(([value, l]) => `<button class="vchip" data-vac="choice" data-choice="${name}" data-opt="${value}">${l}</button>`).join("") +
    `</div>`;

  function build(panel) {
    root = panel.querySelector(".vp");
    root.innerHTML =
      `<div class="vs-body">` +
      `<section class="vs-map">` +
      Panel.robotHeroHtml(vac.vacuum, photoLabel) +
      `<div class="vs-rooms" style="--n:${Math.ceil(vac.rooms.length / 2)}">` +
      vac.rooms
        .map(
          (r) =>
            `<button class="vs-room" data-vac="room" data-room="${r.id}"><span class="vs-rname">${r.label}</span>` +
            `<span class="vs-pct"></span>` +
            `<span class="vs-rlast">${icon("clock")}<span></span></span><span class="vs-rplan"></span><i class="vs-sweep"></i><i class="vs-prog"><b></b></i></button>`
        )
        .join("") +
      `</div><div class="vs-plan"></div>` +
      `<div class="vs-section-title">Laatste rondes</div><div class="vs-rec-list"></div></section>` +
      `<section class="vs-side"><div class="vs-actions">` +
      `<button class="vbtn primary" data-vac="rooms">${icon("play")}<span>Kies kamers</span></button>` +
      `<button class="vbtn" data-vac="start">${icon("play")}<span>Hele huis</span></button>` +
      `<button class="vbtn" data-vac="pause">${icon("pause")}<span>Pauze</span></button>` +
      `<button class="vbtn" data-vac="resume">${icon("play")}<span>Ga verder</span></button>` +
      `<button class="vbtn" data-vac="stop">${icon("stop")}<span>Stop</span></button>` +
      `<button class="vbtn" data-vac="dock">${icon("dock")}<span>Naar dock</span></button>` +
      `<button class="vbtn" data-vac="locate">${icon("locate")}<span>Zoek robot</span></button>` +
      `</div>` +
      `<div class="vs-group"><span class="vlabel">Modus</span>${chips("mode", MODE_NL)}</div>` +
      `<div class="vs-group"><span class="vlabel">Zuigkracht</span>${chips("fan", FAN_NL)}</div>` +
      `<div class="vs-group vs-water"><span class="vlabel">Water</span>${chips("water", WATER_NL)}</div>` +
      `<div class="vs-section-title">Station</div><div class="vs-station">` +
      STATION.map((s) => `<button class="vbtn" data-vac="station" data-station="${s.key}">${icon(s.icon)}<span>${s.label}</span></button>`).join("") +
      `</div>` +
      Object.keys(CHOICES).map((name) => `<div class="vs-group"><span class="vlabel">${CHOICES[name].label}</span>${choiceChips(name)}</div>`).join("") +
      `<div class="vs-section-title">Instellingen</div><div class="vs-settings">` +
      SETTINGS.map((s) => Panel.settingHtml(`data-vac="setting" data-setting="${s.key}"`, s.label)).join("") +
      `</div>` +
      `<div class="vs-section-title">Onderhoud</div><div class="vs-cons-list"></div>` +
      `</section></div>`;
    render();
  }
  Panel.defineRobot({ floor: vac.floor, className: "xiaomi-robot", html: () => `<div id="vacPage" class="vp"></div>`, build });

  function render() {
    if (!root) return;
    const v = st(vac.vacuum);
    const a = (v && v.attributes) || {};
    const statusRaw = ((st(vac.status) || {}).state || "").toLowerCase();
    const robotRaw = String(a["robotic_vacuum.robot_status"] || "").toLowerCase();
    /* The robot keeps its state while the station reports a problem, so a fault
     * is its own flag: it decides the status shown and the "Ga verder" tile. */
    const faulted = Number(a["robotic_vacuum.error"]) > 0 || Number(a["robotic_vacuum.station_error"]) > 0;
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
    else if (faulted || vstate === "error" || statusRaw === "error") status = "Storing";
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

    const minutes = Math.round((Number(a["robotic_vacuum.clean_time"]) || 0) / 60);
    /* The page says in words what the header only has room to abbreviate, with
     * the rooms and the progress of a running job under it. */
    const doing = doingText(offline, faulted, vstate, statusRaw, robotRaw);
    /* Where it is, when that is not already what it is doing ("Laadt op · In dock"). */
    const restState = vstate === "docked" && doing !== STATE_NL.docked ? STATE_NL.docked : "";
    q(".vs-status").textContent = doing;
    q(".vs-substatus").textContent = (
      running
        ? [runRooms.length ? runRooms.map((id) => roomLabel.get(id) || `#${id}`).join(", ") : "Hele huis", done > 0 ? `${Math.round(done)} m²` : "", minutes > 0 ? `${minutes} min` : ""]
        : [restState]
    )
      .filter(Boolean)
      .join(" · ");
    const battery = Panel.num(vac.battery);
    q(".vs-batt span").textContent = Number.isFinite(battery) ? `${fmt(battery)}%` : "--";
    const bar = q(".vs-batt i b");
    bar.style.width = (Number.isFinite(battery) ? Util.clamp(battery, 0, 100) : 0) + "%";
    bar.style.background = Util.batteryColour(battery);

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

    queue.settle();
    /* Out of reach (off, or off the wifi): say so, offer to reconnect, and nothing
     * else to tap until it is back. Otherwise the robot's own faults and tanks. */
    const unreachable = offline && Panel.isLoaded();
    const tanks = TANKS.map(([key, labels]) => labels[a[key]]).filter(Boolean);
    const faults = [
      Number(a["robotic_vacuum.error"]) > 0 && `Storing (code ${a["robotic_vacuum.error"]})`,
      Number(a["robotic_vacuum.station_error"]) > 0 && `Storing in het station (code ${a["robotic_vacuum.station_error"]})`,
    ].filter(Boolean);
    const notices = [...faults, ...tanks.map(([what]) => what)];
    /* A tank that needs attention explains the code, and says what to do. */
    const todo = tanks.length ? `${cap(tanks[0][1])}${faults.length ? ' en tik daarna op "Ga verder"' : ""}.` : "";
    q(".vs-alert").hidden = !(unreachable || notices.length);
    q(".vs-alert span").textContent = unreachable ? Panel.unreachableText(v) : [notices.join(" · "), todo].filter(Boolean).join(". ");
    q(".vs-alert [data-reconnect]").hidden = !unreachable;
    qa(".vs-actions .vbtn, .vchip, .vs-setting").forEach((b) => (b.disabled = unreachable));
    for (const [kind, id] of [["mode", vac.mode], ["fan", vac.fan], ["water", vac.water]]) {
      const cur = (st(id) || {}).state;
      qa(`[data-vac="${kind}"]`).forEach((c) => {
        c.classList.toggle("active", c.dataset.opt === cur);
        c.classList.toggle("pending", queue.has(`${kind}|${c.dataset.opt}`));
      });
    }
    q(".vs-water").hidden = (st(vac.mode) || {}).state === "OnlySweep";
    SETTINGS.forEach((s) => {
      const el = q(`[data-setting="${s.key}"]`);
      el.classList.toggle("on", switchedOn(a[s.attr]));
      el.classList.toggle("pending", queue.has(`${s.key}|on`) || queue.has(`${s.key}|off`));
    });
    qa('[data-vac="choice"]').forEach((c) => {
      c.classList.toggle("active", String(a[CHOICES[c.dataset.choice].attr]) === c.dataset.opt);
      c.classList.toggle("pending", queue.has(`${c.dataset.choice}|${c.dataset.opt}`));
    });
    /* The station works with the robot in it. */
    qa(".vs-station .vbtn").forEach((b) => (b.disabled = unreachable || vstate !== "docked"));

    const n = selected.size;
    const roomsBtn = q('[data-vac="rooms"]');
    /* Three tiles at a time. During a job: pause or resume, stop and dock (on the
     * way home just stop and locate). Otherwise the two starts, plus dock when the
     * robot stands still away from its dock, else locate. */
    const job = busy || paused;
    const away = !job && vstate === "idle" && !["charging", "charged", "breakcharging"].includes(statusRaw);
    /* "Ga verder" whenever the robot can carry on where it stopped: paused, or
     * standing still on a fault (a full tank, a blocked brush). It takes the
     * place of "Hele huis", which would start a new round instead. */
    const stuck = !offline && !job && (faulted || vstate === "error" || statusRaw === "error");
    q('[data-vac="start"]').hidden = job || stuck;
    /* Off the clock: pick rooms and start them. During a job the same tiles add a
     * room to the run — robotkamers can't append, so it stops and restarts with
     * the rooms already running plus the newly picked ones. */
    const extraRooms = [...selected].filter((id) => !runRooms.includes(id));
    if (job) {
      roomsBtn.hidden = !extraRooms.length;
      roomsBtn.disabled = !extraRooms.length || offline;
      roomsBtn.querySelector("span").textContent = extraRooms.length > 1 ? `${extraRooms.length} kamers toevoegen` : "Kamer toevoegen";
    } else {
      roomsBtn.hidden = false;
      roomsBtn.disabled = !n || offline;
      roomsBtn.querySelector("span").textContent = n ? `Start ${n === 1 ? "kamer" : n + " kamers"}` : "Kies kamers";
    }
    q('[data-vac="pause"]').hidden = !busy || vstate === "returning";
    q('[data-vac="resume"]').hidden = !(paused || stuck);
    const stopBtn = q('[data-vac="stop"]');
    stopBtn.hidden = !job;
    stopBtn.classList.toggle("armed", twoTap.armed("stop"));
    stopBtn.classList.toggle("pending", queue.has("job|stop"));
    stopBtn.querySelector("span").textContent = twoTap.armed("stop") ? "Nogmaals tikken" : "Stop";
    q('[data-vac="dock"]').hidden = !(job || away || stuck) || vstate === "returning";
    q('[data-vac="locate"]').hidden = job ? vstate !== "returning" : away || stuck;

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

    /* Runs from Home Assistant's history first (the robot's own log often gets
     * no answer); its own log when the history has none. */
    const runs = historyRuns && historyRuns.length ? historyRuns : records;
    q(".vs-rec-list").innerHTML =
      runs === null
        ? `<div class="vs-empty">Laden...</div>`
        : runs.length
          ? runs
              .slice(0, 5)
              .map(
                (r) =>
                  `<div class="vs-rec"><span>${ago(r.when)}${r.rooms && r.rooms.length ? ` · ${esc(r.rooms.map((id) => roomLabel.get(id) || `#${id}`).join(", "))}` : ""}</span>` +
                  `<b>${Math.round(r.area)} m²</b><em>${Math.round(r.secs / 60)} min</em></div>`
              )
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

  /* Finished runs from the vacuum's history, newest first: clean_time drops when
   * a new job starts; a run keeps the most area and time it reached, its rooms and
   * when it last grew. The newest run counts once the robot is out of its job. */
  function runsFrom(rows) {
    const runs = [];
    let run = null;
    let prevTime = -1;
    for (const row of rows) {
      const a = row.a || {};
      const area = Number(a["robotic_vacuum.clean_area"]);
      const time = Number(a["robotic_vacuum.clean_time"]);
      if (!Number.isFinite(area) || !Number.isFinite(time)) continue;
      if (run && time < prevTime) {
        if (run.area > 0) runs.push(run);
        run = null;
      }
      prevTime = time;
      if (!run) run = { when: row.t, area: 0, secs: 0, rooms: [] };
      if (area > run.area || time > run.secs) {
        run.area = Math.max(run.area, area);
        run.secs = Math.max(run.secs, time);
        run.when = row.t;
        const rooms = parseList(a["robotic_vacuum.clean_values"]);
        if (rooms.length) run.rooms = rooms;
      }
    }
    const v = st(vac.vacuum);
    if (run && run.area > 0 && !(v && JOB_STATES.includes(v.state))) runs.push(run);
    return runs.reverse();
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
    /* The history first: it answers at once, the robot's own log can take seconds. */
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
      historyRuns = runsFrom(rows);
    } catch (e) {
      historyRuns = historyRuns || [];
    }
    render();
    try {
      /* Read-only: the robot's run log (the integration does not poll it). The
       * robot often does not answer: xiaomi_miot then responds {error}. */
      const res = await Panel.client.callService(
        "xiaomi_miot", "get_properties",
        { entity_id: vac.vacuum, mapping: { clean_records: { siid: 17, piid: 46 } } },
        null, true
      );
      const response = (res || {}).response || {};
      if (response.error) throw new Error(response.error);
      records = JSON.parse(response.clean_records || "[]")
        .filter((r) => /^20\d\d\//.test(r.d || "")) /* entries logged before the clock was set say 1970 */
        .map((r) => ({ when: new Date(`${r.d.replace(/\//g, "-")}T${r.t}`).getTime(), area: r.A, secs: r.T }))
        .sort((a, b) => b.when - a.when);
    } catch (e) {
      records = records || [];
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
      const vs = (st(vac.vacuum) || {}).state;
      const running = JOB_STATES.includes(vs);
      /* A room the robot is already doing can't be "added" — leave it be. */
      if (running && parseList(((st(vac.vacuum) || {}).attributes || {})["robotic_vacuum.clean_values"]).includes(id)) return;
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      return render();
    }
    if (kind === "mode" || kind === "fan" || kind === "water") {
      const option = el.dataset.opt;
      const current = () => (st(vac[kind]) || {}).state;
      if (current() === option) return; /* already set */
      queue.send(`${kind}|${option}`, {
        send: () => Panel.client.callService("select", "select_option", { option }, { entity_id: CHOICE_SETTER[kind] }),
        landed: () => current() === option,
        wait: CHOICE_MS,
        failed: `${CHOICE_NOUN[kind]} is niet aangepast`,
      });
      return render();
    }
    /* Ends the running job where the robot is (a second tap confirms). */
    if (kind === "stop") {
      if (queue.has("job|stop") || !twoTap.tap("stop", true)) return;
      queue.send("job|stop", {
        send: () => Panel.client.callService("vacuum", "stop", null, target),
        landed: () => !JOB_STATES.includes((st(vac.vacuum) || {}).state),
        wait: STOP_MS,
        failed: "de ronde is niet gestopt",
      });
      return render();
    }
    const attrsNow = () => (st(vac.vacuum) || {}).attributes || {};
    const miotAction = (aiid, value) => () =>
      Panel.client.callService("xiaomi_miot", "call_action", { entity_id: vac.vacuum, siid: 17, aiid, params: [value] }, null);
    if (kind === "setting") {
      const s = SETTINGS.find((x) => x.key === el.dataset.setting);
      const next = !switchedOn(attrsNow()[s.attr]);
      queue.send(`${s.key}|${next ? "on" : "off"}`, {
        send: miotAction(s.aiid, next),
        landed: () => switchedOn(attrsNow()[s.attr]) === next,
        wait: SETTING_MS,
        failed: `${s.label.toLowerCase()} is niet aangepast`,
      });
      return render();
    }
    if (kind === "choice") {
      const choice = CHOICES[el.dataset.choice];
      const value = Number(el.dataset.opt);
      if (Number(attrsNow()[choice.attr]) === value) return; /* already set */
      queue.send(`${el.dataset.choice}|${value}`, {
        send: miotAction(choice.aiid, value),
        landed: () => Number(attrsNow()[choice.attr]) === value,
        wait: SETTING_MS,
        failed: `${choice.noun} is niet aangepast`,
      });
      return render();
    }
    if (kind === "station") {
      const action = STATION.find((x) => x.key === el.dataset.station);
      return miotAction(action.aiid, true)().catch(fail);
    }
    if (kind === "rooms") {
      if (!selected.size) return;
      /* The robotkamers integration stops any open job first: the robot silently
       * ignores a new start while an old one is still pending. During a run this
       * doubles as "add a room" — union the picked rooms with the ones already
       * running so the robot restarts on the whole set. */
      const vs = (st(vac.vacuum) || {}).state;
      const runNow = JOB_STATES.includes(vs) ? parseList(((st(vac.vacuum) || {}).attributes || {})["robotic_vacuum.clean_values"]) : [];
      const gebieden = [...new Set([...runNow, ...selected])].sort((a, b) => a - b);
      Panel.client.callService(vac.roomsDomain, "stofzuig", { gebieden }).catch(fail);
      selected.clear();
      return render();
    }
    if (kind === "start" || kind === "resume") return Panel.client.callService("vacuum", "start", null, target).catch(fail);
    if (kind === "pause") return Panel.client.callService("vacuum", "pause", null, target).catch(fail);
    if (kind === "dock") return Panel.client.callService(vac.roomsDomain, "naar_station").catch(fail);
    if (kind === "locate") return Panel.client.callService("button", "press", null, { entity_id: vac.locate }).catch(fail);
  });

  /* The run log and room history are fetched when this robot is shown (after a
   * reload straight onto #schoonmaak the section opens before the socket does:
   * then on the first state dump), and again when a run ends. */
  const onScreen = () => Panel.robotOnScreen(vac.floor);
  let wasJob = false;
  Panel.track(
    ["vacuum", "status", "battery", "area", "mode", "fan", "water", "locate"].map((k) => vac[k]),
    () => {
      render();
      /* A run that ended is new history (two weeks of it: not for every state change). */
      const job = JOB_STATES.includes((st(vac.vacuum) || {}).state);
      if (wasJob && !job && Panel.isLoaded() && onScreen()) load(true);
      wasJob = job;
    }
  );
  const shownNow = () => Panel.isLoaded() && onScreen() && load(false);
  Panel.on("section", shownNow);
  Panel.on("robot", shownNow);
  Panel.on("loaded", shownNow);
})();
