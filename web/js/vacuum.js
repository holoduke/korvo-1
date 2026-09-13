/* Schoonmaak sheet: the robot vacuum's full view, opened from the vacuum card.
 * Left: the rooms as large tiles (selection shared with the card, a live sweep
 * on the rooms of the current run, when each room was last cleaned). Right: the
 * card's controls mirrored, consumables, and the robot's recent runs.
 * The robot keeps its map in the Xiaomi cloud; the room tiles are laid out so a
 * real map image can later sit underneath them. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;
  const vac = cfg.vacuum;
  if (!vac) return;

  const CONSUMABLES = {
    sideBrush: "Zijborstel",
    rollBrush: "Hoofdborstel",
    filter: "Filter",
    mop: "Dweil",
    engineSensor: "Sensoren",
    dustbag: "Stofzak",
    mopCleaningTrough: "Wasbak",
  };
  const DAYS = ["zo", "ma", "di", "wo", "do", "vr", "za"];
  let records = null; /* robot's clean records, newest first */
  const lastByRoom = new Map(); /* room id -> ms */
  let loadedAt = 0;
  let loading = false;

  const sheet = $("vacSheet");
  const isOpen = () => !sheet.hidden;

  function parseList(raw) {
    try {
      const v = JSON.parse(raw || "[]");
      return Array.isArray(v) ? v.map(Number) : [];
    } catch (e) {
      return [];
    }
  }
  const liveRooms = () => {
    const s = Panel.st(vac.vacuum);
    return s && ["cleaning", "paused"].includes(s.state) ? parseList(s.attributes["robotic_vacuum.clean_values"]) : [];
  };

  function ago(ms) {
    if (!ms) return "nog niet gedaan";
    const d = new Date(ms);
    const today = new Date();
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400e3);
    if (days === 0) return `vandaag ${hm}`;
    if (days === 1) return `gisteren ${hm}`;
    if (days < 7) return `${DAYS[d.getDay()]} ${hm}`;
    return `${days} dagen geleden`;
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
      const raw = (((res || {}).response) || {}).clean_records;
      const list = JSON.parse(raw || "[]");
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

  function render() {
    if (!isOpen()) return;
    const card = $("vac");
    const selected = Panel.vacRooms;
    const live = liveRooms();
    const s = Panel.st(vac.vacuum);

    $("vsStatus").textContent = card ? card.querySelector(".vac-status").textContent : "";
    $("vsBatt").textContent = card ? card.querySelector(".vac-batt span").textContent : "";
    sheet.querySelector(".vs-box").classList.toggle("busy", !!(card && card.classList.contains("busy")));

    const grid = $("vsRooms");
    if (!grid.children.length) {
      grid.innerHTML = vac.rooms
        .map(
          (r) =>
            `<button class="vs-room" data-room="${r.id}"><span class="vs-rname">${r.label}</span>` +
            `<span class="vs-rid">#${r.id}</span><span class="vs-rlast">${icon("clock")}<span></span></span><i class="vs-sweep"></i></button>`
        )
        .join("");
    }
    grid.querySelectorAll(".vs-room").forEach((el) => {
      const id = +el.dataset.room;
      el.classList.toggle("active", selected.has(id));
      el.classList.toggle("live", live.includes(id));
      el.querySelector(".vs-rlast span").textContent = live.includes(id) ? "nu bezig" : ago(lastByRoom.get(id));
    });

    /* Controls mirror the card, so their rules live in one place (app.js). */
    sheet.querySelectorAll(".vs-controls [data-vac]").forEach((el) => {
      const twin = card && card.querySelector(`[data-vac="${el.dataset.vac}"]${el.dataset.opt ? `[data-opt="${el.dataset.opt}"]` : ""}`);
      if (!twin) return;
      el.hidden = twin.hidden;
      el.disabled = twin.disabled;
      el.classList.toggle("active", twin.classList.contains("active"));
      const label = twin.querySelector("span");
      if (label && el.querySelector("span")) el.querySelector("span").textContent = label.textContent;
    });
    const modeRow = card && card.querySelector(".vwater");
    sheet.querySelectorAll(".vs-water").forEach((el) => (el.hidden = !!(modeRow && modeRow.hidden)));

    let cons = [];
    try {
      cons = JSON.parse((s && s.attributes["robotic_vacuum.consumables"]) || "[]");
    } catch (e) {
      cons = [];
    }
    $("vsCons").innerHTML = cons.length
      ? cons
          .filter((c) => CONSUMABLES[c.type])
          .map((c) => {
            const used = Math.max(0, Math.min(100, Number(c.used) || 0));
            const tone = used >= 90 ? "bad" : used >= 70 ? "warn" : "ok";
            return (
              `<div class="vs-cons"><span>${CONSUMABLES[c.type]}</span>` +
              `<i class="bar ${tone}"><b style="width:${used}%"></b></i><em>${used}% gebruikt</em></div>`
            );
          })
          .join("")
      : `<div class="vs-empty">Geen gegevens</div>`;

    $("vsRecords").innerHTML =
      records === null
        ? `<div class="vs-empty">Laden...</div>`
        : records.length
          ? records
              .slice(0, 5)
              .map(
                (r) =>
                  `<div class="vs-rec"><span>${ago(r.when.getTime())}</span><b>${r.area} m²</b><em>${Math.round(r.secs / 60)} min</em></div>`
              )
              .join("")
          : `<div class="vs-empty">Nog geen rondes</div>`;
  }

  function controlsHtml() {
    const chip = (kind, opt, label) => `<button class="vchip" data-vac="${kind}" data-opt="${opt}">${label}</button>`;
    return (
      `<div class="vs-actions">` +
      `<button class="vbtn primary" data-vac="rooms">${icon("play")}<span>Kies kamers</span></button>` +
      `<button class="vbtn" data-vac="start">${icon("play")}<span>Hele huis</span></button>` +
      `<button class="vbtn" data-vac="pause">${icon("pause")}<span>Pauze</span></button>` +
      `<button class="vbtn" data-vac="resume">${icon("play")}<span>Verder</span></button>` +
      `<button class="vbtn" data-vac="dock">${icon("dock")}<span>Naar dock</span></button>` +
      `<button class="vbtn" data-vac="locate">${icon("locate")}<span>Zoek</span></button>` +
      `</div>` +
      `<div class="vs-group"><span class="vlabel">Modus</span><div class="vs-chips">` +
      chip("mode", "BothWork", "Zuigen + dweilen") + chip("mode", "OnlySweep", "Zuigen") +
      chip("mode", "OnlyMop", "Dweilen") + chip("mode", "SweepFirst", "Eerst zuigen") +
      `</div></div>` +
      `<div class="vs-group"><span class="vlabel">Zuigkracht</span><div class="vs-chips">` +
      chip("fan", "Quiet", "Stil") + chip("fan", "Auto", "Auto") + chip("fan", "Strong", "Sterk") + chip("fan", "Max", "Max") +
      `</div></div>` +
      `<div class="vs-group vs-water"><span class="vlabel">Water</span><div class="vs-chips">` +
      chip("water", "Low", "Laag") + chip("water", "Mid", "Midden") + chip("water", "High", "Hoog") +
      `</div></div>`
    );
  }

  Panel.openVacuum = function () {
    $("vsTitle").textContent = vac.label;
    if (!$("vsControls").children.length) $("vsControls").innerHTML = controlsHtml();
    Panel.openOverlay(sheet);
    render();
    load(false);
  };
  Panel.onVacuum = () => render();

  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) return Panel.closeOverlay(sheet);
    if (e.target.closest("#vsClose")) return Panel.closeOverlay(sheet);
    const room = e.target.closest(".vs-room");
    if (room) {
      const id = +room.dataset.room;
      if (Panel.vacRooms.has(id)) Panel.vacRooms.delete(id);
      else Panel.vacRooms.add(id);
      /* Re-renders the card, whose hook re-renders this sheet. */
      return Panel.vacTap({ dataset: { vac: "noop" } });
    }
    const ctl = e.target.closest("[data-vac]");
    if (ctl && !ctl.disabled) Panel.vacTap(ctl);
  });
  $("vsClose").innerHTML = icon("close");
})();
