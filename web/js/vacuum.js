/* Schoonmaak section: the robot vacuum's page. Header with status, battery and
 * locate; left the rooms as large tiles (tap to choose, a live sweep on the
 * rooms of the current run, when each room was last cleaned) and the robot's
 * recent runs; right the actions, the mode/suction/water choices and the
 * consumables. The robot keeps its map in the Xiaomi cloud; the room tiles are
 * laid out so a real map image can later sit underneath them. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const vac = cfg.vacuum;
  if (!vac) return;

  const STATUS_NL = {
    idle: "Klaar", busy: "Bezig", delay: "Wacht", mopping: "Dweilen", "sweeping and mopping": "Zuigen en dweilen",
    paused: "Gepauzeerd", sweeping: "Zuigen", error: "Storing", charging: "Opladen", "go charging": "Terug naar dock",
    breakcharging: "Tussendoor laden", gowash: "Dweil wassen", charged: "Opgeladen", buildingmap: "Kaart maken",
    updating: "Update", sleeping: "Slaapt", relocation: "Zoekt positie", stationworking: "Station bezig",
    mappingpause: "Kaart gepauzeerd", gochargebreak: "Laadpauze", washbreak: "Waspauze", "linking device": "Verbinden",
    godust: "Stof legen",
  };
  const STATE_NL = { docked: "In dock", cleaning: "Aan het schoonmaken", returning: "Terug naar dock", idle: "Klaar", paused: "Gepauzeerd", error: "Storing" };
  const MODE_NL = { BothWork: "Zuigen + dweilen", OnlySweep: "Zuigen", OnlyMop: "Dweilen", SweepFirst: "Eerst zuigen" };
  const FAN_NL = { Quiet: "Stil", Auto: "Auto", Strong: "Sterk", Max: "Max" };
  const WATER_NL = { Low: "Laag", Mid: "Midden", High: "Hoog" };
  const CONSUMABLES = {
    sideBrush: "Zijborstel", rollBrush: "Hoofdborstel", filter: "Filter", mop: "Dweil",
    engineSensor: "Sensoren", dustbag: "Stofzak", mopCleaningTrough: "Wasbak",
  };
  const DAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];

  const selected = new Set(); /* chosen room ids */
  Panel.vacRooms = selected;
  let records = null; /* robot's run log, newest first */
  const lastByRoom = new Map(); /* room id -> ms */
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
  function ago(ms) {
    if (!ms) return "nog niet gedaan";
    const d = new Date(ms);
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const days = Math.round((new Date(new Date().toDateString()) - new Date(d.toDateString())) / 86400e3);
    if (days === 0) return `vandaag ${hm}`;
    if (days === 1) return `gisteren ${hm}`;
    if (days < 7) return `${DAYS[d.getDay()]} ${hm}`;
    return `${days} dagen geleden`;
  }

  const chips = (kind, labels) =>
    Object.entries(labels).map(([opt, l]) => `<button class="vchip" data-vac="${kind}" data-opt="${opt}">${l}</button>`).join("");

  Panel.buildVacuum = function (container) {
    root = container;
    root.innerHTML =
      `<div class="vp-head"><span class="vac-ic">${icon("vacuum")}</span>` +
      `<div class="vac-title"><b>${vac.label}</b><span class="vac-status">...</span></div>` +
      `<div class="vac-batt"><i><s></s></i><span>--</span></div>` +
      `<button class="vbtn ghost" data-vac="locate" aria-label="Zoek robot">${icon("locate")}</button></div>` +
      `<div class="vs-body">` +
      `<section class="vs-map"><div class="vs-section-title">Kamers <em>tik om te kiezen</em></div>` +
      `<div class="vs-rooms">` +
      vac.rooms
        .map(
          (r) =>
            `<button class="vs-room" data-vac="room" data-room="${r.id}"><span class="vs-rname">${r.label}</span>` +
            `<span class="vs-rid">#${r.id}</span><span class="vs-rlast">${icon("clock")}<span></span></span><i class="vs-sweep"></i></button>`
        )
        .join("") +
      `</div><div class="vs-section-title">Laatste rondes</div><div class="vs-rec-list"></div></section>` +
      `<section class="vs-side"><div class="vs-actions">` +
      `<button class="vbtn primary" data-vac="rooms">${icon("play")}<span>Kies kamers</span></button>` +
      `<button class="vbtn" data-vac="start">${icon("play")}<span>Hele huis</span></button>` +
      `<button class="vbtn" data-vac="pause">${icon("pause")}<span>Pauze</span></button>` +
      `<button class="vbtn" data-vac="resume">${icon("play")}<span>Verder</span></button>` +
      `<button class="vbtn" data-vac="dock">${icon("dock")}<span>Naar dock</span></button>` +
      `</div>` +
      `<div class="vs-group"><span class="vlabel">Modus</span><div class="vs-chips">${chips("mode", MODE_NL)}</div></div>` +
      `<div class="vs-group"><span class="vlabel">Zuigkracht</span><div class="vs-chips">${chips("fan", FAN_NL)}</div></div>` +
      `<div class="vs-group vs-water"><span class="vlabel">Water</span><div class="vs-chips">${chips("water", WATER_NL)}</div></div>` +
      `<div class="vs-section-title">Onderhoud</div><div class="vs-cons-list"></div>` +
      `</section></div>`;
    render();
  };

  function render() {
    if (!root) return;
    const v = st(vac.vacuum);
    const statusRaw = ((st(vac.status) || {}).state || "").toLowerCase();
    const vstate = v ? v.state : "unavailable";
    const offline = Panel.unavailable(v);
    const busy = ["cleaning", "returning"].includes(vstate);
    const paused = vstate === "paused" || statusRaw === "paused";
    const area = Panel.num(vac.area);
    let status = offline ? "Niet bereikbaar" : STATUS_NL[statusRaw] || STATE_NL[vstate] || vstate;
    if (busy && Number.isFinite(area) && area > 0) status += ` · ${Math.round(area)} m²`;
    q(".vac-status").textContent = status;
    root.classList.toggle("busy", busy);
    root.classList.toggle("offline", offline);

    const batt = Panel.num(vac.battery);
    const bEl = q(".vac-batt");
    bEl.querySelector("span").textContent = Number.isFinite(batt) ? Math.round(batt) + "%" : "--";
    bEl.querySelector("s").style.width = (Number.isFinite(batt) ? batt : 0) + "%";
    bEl.classList.toggle("low", Number.isFinite(batt) && batt < 20);

    const live = v && ["cleaning", "paused"].includes(vstate) ? parseList(v.attributes["robotic_vacuum.clean_values"]) : [];
    qa(".vs-room").forEach((el) => {
      const id = +el.dataset.room;
      el.classList.toggle("active", selected.has(id));
      el.classList.toggle("live", live.includes(id));
      el.querySelector(".vs-rlast span").textContent = live.includes(id) ? "nu bezig" : ago(lastByRoom.get(id));
    });

    for (const [kind, id] of [["mode", vac.mode], ["fan", vac.fan], ["water", vac.water]]) {
      const cur = (st(id) || {}).state;
      qa(`[data-vac="${kind}"]`).forEach((c) => c.classList.toggle("active", c.dataset.opt === cur));
    }
    q(".vs-water").hidden = (st(vac.mode) || {}).state === "OnlySweep";

    const n = selected.size;
    const roomsBtn = q('[data-vac="rooms"]');
    roomsBtn.querySelector("span").textContent = n ? `${n === 1 ? "Kamer" : n + " kamers"} schoonmaken` : "Kies kamers";
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
      for (const row of hist[vac.vacuum] || []) {
        if (row.s !== "cleaning") continue;
        parseList(row.a["robotic_vacuum.clean_values"]).forEach((id) => {
          if (!lastByRoom.has(id) || lastByRoom.get(id) < row.t) lastByRoom.set(id, row.t);
        });
      }
    } catch (e) {
      /* keep what we had */
    }
    loading = false;
    render();
  }

  Panel.vacTap = function (el) {
    const kind = el.dataset.vac;
    const target = { entity_id: vac.vacuum };
    const fail = () => {};
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
      const list = JSON.stringify([...selected].sort((a, b) => a - b));
      /* start-clean(clean-type = 3 AreaClean, clean-values = "[id,...]") */
      Panel.client
        .callService("xiaomi_miot", "call_action", { entity_id: vac.vacuum, siid: 17, aiid: 1, params: [3, list] })
        .catch(fail);
      selected.clear();
      return render();
    }
    if (kind === "start" || kind === "resume") return Panel.client.callService("vacuum", "start", null, target).catch(fail);
    if (kind === "pause") return Panel.client.callService("vacuum", "pause", null, target).catch(fail);
    if (kind === "dock") return Panel.client.callService("vacuum", "return_to_base", null, target).catch(fail);
    if (kind === "locate") return Panel.client.callService("button", "press", null, { entity_id: vac.locate }).catch(fail);
  };

  Panel.onVacuum = render;
  const prevOnSection = Panel.onSection;
  Panel.onSection = function (si) {
    if (prevOnSection) prevOnSection(si);
    if (cfg.sections[si] && cfg.sections[si].kind === "vacuum") load(false);
  };
})();
