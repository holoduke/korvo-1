/* Web panel core: preferences, theme, HA state, and rendering of the header,
 * tabs, tiles and bottom rows. Gestures live in interact.js; the climate
 * popup, screensaver, settings and splash in extras.js. Mirrors main/panel_ui.c. */
(function () {
  "use strict";

  const cfg = window.PANEL_CONFIG;
  const $ = (id) => document.getElementById(id);
  const Panel = (window.Panel = { cfg, $ });

  /* ---- Preferences (per browser) ------------------------------------------ */
  const SAVER_TIMES = [60e3, 300e3, 1800e3, 7200e3];
  const SAVER_LABELS = ["1 min", "5 min", "30 min", "2 uur"];
  function pref(key, def) {
    try {
      const v = localStorage.getItem("panel." + key);
      return v === null ? def : JSON.parse(v);
    } catch (e) {
      return def;
    }
  }
  function setPref(key, v) {
    try {
      localStorage.setItem("panel." + key, JSON.stringify(v));
    } catch (e) {
      /* private mode: keep it for this session only */
    }
  }
  Panel.prefs = {
    theme: pref("theme", 0),
    saverMode: pref("saverMode", 1), /* 0 = scherm uit, 1 = AI oog */
    saverIdx: pref("saverIdx", 1),
  };
  Panel.setPref = (key, v) => {
    Panel.prefs[key] = v;
    setPref(key, v);
  };
  Panel.SAVER_TIMES = SAVER_TIMES;
  Panel.SAVER_LABELS = SAVER_LABELS;

  /* ---- Theme ---------------------------------------------------------------- */
  Panel.applyTheme = function (idx) {
    const t = cfg.themes[idx] || cfg.themes[0];
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(t)) if (k !== "name") root.setProperty("--" + k, v);
    document.querySelector('meta[name="theme-color"]').setAttribute("content", t.toolbar);
    document.documentElement.style.colorScheme = t.name === "Licht" ? "light" : "dark";
  };
  Panel.applyTheme(Panel.prefs.theme);

  /* ---- Connection ------------------------------------------------------------ */
  const demo = new URLSearchParams(location.search).has("demo");
  const ids = new Set([cfg.weather]);
  cfg.tabs.forEach((t) => [...t.lights, ...t.devices, ...t.scenes].forEach((e) => ids.add(e.id)));
  cfg.sensors.forEach((s) => {
    ids.add(s.temp);
    if (s.humidity) ids.add(s.humidity);
  });
  /* Air monitors: entity id -> [monitor index, reading kind]. */
  const AIR_KINDS = ["co2", "pm25", "quality", "temp", "humidity"];
  const airOf = new Map();
  cfg.air.forEach((a, i) => AIR_KINDS.forEach((k) => a[k] && (ids.add(a[k]), airOf.set(a[k], [i, k]))));
  cfg.media.forEach((m) => ids.add(m.id));
  const vac = cfg.vacuum;
  const vacIds = new Set(["vacuum", "status", "battery", "area", "mode", "fan", "water", "locate"].map((k) => vac[k]).filter(Boolean));
  vacIds.forEach((id) => ids.add(id));
  const client = demo ? HA.createDemo(cfg) : HA.createClient([...ids]);
  Panel.client = client;
  let loaded = false; /* initial state dump received */

  const st = (id) => client.states.get(id);
  Panel.st = st;
  const unavailable = (s) => !s || s.state === "unavailable" || s.state === "unknown" || s.state === "none";
  const pct = (s) => (s && s.attributes && typeof s.attributes.brightness === "number" ? Math.round((s.attributes.brightness * 100) / 255) : -1);
  Panel.brightnessPct = (id) => pct(st(id));
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
  const num = (s) => {
    const v = s ? parseFloat(s.state) : NaN;
    return Number.isFinite(v) ? v : NaN;
  };
  /* A CO2 reading below the valid floor is the sensor warming up, not air. */
  const co2Valid = (v) => Number.isFinite(v) && v >= cfg.airBands.co2MinValid;
  Panel.co2Valid = co2Valid;
  Panel.num = (id) => {
    const v = num(st(id));
    const air = airOf.get(id);
    return air && air[1] === "co2" && !co2Valid(v) ? NaN : v;
  };
  const esc = (id) => CSS.escape(id);

  /* ---- Services ------------------------------------------------------------ */
  const pending = new Map(); /* light id -> {on, timer}: optimistic toggle */

  Panel.toggleLight = function (id) {
    const s = st(id);
    if (unavailable(s)) return;
    const on = s.state !== "on";
    clearTimeout((pending.get(id) || {}).timer);
    pending.set(id, { on, timer: setTimeout(() => (pending.delete(id), renderLight(id)), 4000) });
    renderLight(id);
    client.callService("light", "toggle", null, { entity_id: id }).catch(() => {
      pending.delete(id);
      renderLight(id);
    });
  };
  Panel.activateScene = function (tab, idx) {
    highlightScene(tab, idx);
    client.callService("scene", "turn_on", null, { entity_id: cfg.tabs[tab].scenes[idx].id }).catch(() => {});
  };
  Panel.setBrightness = function (entityIds, value) {
    const off = value <= 0;
    client
      .callService("light", off ? "turn_off" : "turn_on", off ? null : { brightness_pct: value }, { entity_id: entityIds })
      .catch(() => {});
  };
  Panel.setHue = (id, hue) =>
    client.callService("light", "turn_on", { hs_color: [hue, 100] }, { entity_id: id }).catch(() => {});
  Panel.setKelvin = (id, k) =>
    client.callService("light", "turn_on", { color_temp_kelvin: k }, { entity_id: id }).catch(() => {});

  /* ---- Header ----------------------------------------------------------------- */
  const FC_DAYS = 3;
  const DAY_SHORT = ["zo", "ma", "di", "wo", "do", "vr", "za"];
  const DAY_LONG = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];
  const MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
  Panel.DAY_SHORT = DAY_SHORT;

  function wxIcon() {
    return '<div class="wx"><div class="sun"></div><div class="cloud"><i></i><i></i><i></i></div></div>';
  }
  function applyWx(el, condition) {
    const c = condition || "";
    let sun = false,
      cloud = false,
      colour = "var(--text_dim)";
    if (c.includes("partlycloudy")) sun = cloud = true;
    else if (c.includes("sunny") || c.includes("clear")) sun = true;
    else if (c.includes("rain") || c.includes("pour") || c.includes("lightning")) {
      cloud = true;
      colour = "#7fa8d0";
    } else if (c.includes("snow")) {
      cloud = true;
      colour = "#dfe6f0";
    } else cloud = true;
    const sunEl = el.querySelector(".sun");
    sunEl.hidden = !sun;
    sunEl.style.background = c.includes("night") ? "#c3c9d6" : "#ffcf4d";
    const cl = el.querySelector(".cloud");
    cl.hidden = !cloud;
    cl.style.color = colour;
  }

  function buildHeader() {
    const fc = $("forecast");
    fc.innerHTML = Array.from({ length: FC_DAYS }, (_, i) =>
      `<div class="fc-col" id="fc${i}"><div class="fc-day${i === 0 ? " today" : ""}">--</div>${wxIcon()}<div class="fc-temp">--</div></div>`
    ).join("");
    $("sensors").innerHTML =
      cfg.sensors
        .map(
          (s, i) =>
            `<button class="sensor-col" data-sensor="${i}"><div class="s-name"><span>${s.label}</span><span class="trend"></span></div>` +
            `<div class="s-temp">--</div><div class="s-hum">${s.humidity ? icon("drop") + "<span>--</span>" : ""}</div></button>`
        )
        .join("") +
      cfg.air
        .map(
          (a, i) =>
            `<div class="rule"></div><button class="sensor-col air-col" data-air="${i}">` +
            `<div class="s-name"><span>${a.short}</span><span class="aq-dot"></span><span class="aq-txt"></span></div>` +
            `<div class="air-grid">` +
            `<div class="s-temp a-co2">--</div><div class="s-temp a-temp">--</div>` +
            `<div class="s-hum a-pm">PM2.5 --</div><div class="s-hum a-hum">${icon("drop")}<span>--</span></div>` +
            `</div></button>`
        )
        .join("");
    $("gear").innerHTML = icon("gear");
  }

  let lastMinute = -1;
  function tickClock() {
    const d = new Date();
    const m = d.getHours() * 60 + d.getMinutes();
    if (m === lastMinute) return;
    lastMinute = m;
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    $("clock").textContent = hm;
    $("saverClock").textContent = hm;
    $("dow").textContent = DAY_LONG[d.getDay()];
    $("date").textContent = d.getDate() + " " + MONTHS[d.getMonth()];
    renderTrends();
    if (Panel.onMinute) Panel.onMinute();
  }

  function comfortTemp(v, indoor) {
    if (!indoor) return "var(--text)";
    const c = cfg.comfort;
    return v < c.tempMin ? "var(--cold)" : v <= c.tempMax ? "var(--ok)" : v <= c.tempHot ? "var(--warn)" : "var(--bad)";
  }
  function comfortHum(v, indoor) {
    if (!indoor) return "var(--hum)";
    const c = cfg.comfort;
    const off = v < c.humMin ? c.humMin - v : v > c.humMax ? v - c.humMax : 0;
    return off <= 0 ? "var(--ok)" : off > c.humMargin ? "var(--bad)" : "var(--warn)";
  }
  const b = cfg.airBands;
  const co2Colour = (v) => (v <= b.co2Good ? "var(--ok)" : v <= b.co2Poor ? "var(--warn)" : "var(--bad)");
  const pmColour = (v) => (v <= b.pm25Good ? "var(--ok)" : v <= b.pm25Poor ? "var(--warn)" : "var(--bad)");
  const QUALITY = {
    good: ["goed", "var(--ok)"],
    fair: ["redelijk", "var(--warn)"],
    moderate: ["matig", "var(--warn)"],
    poor: ["slecht", "var(--bad)"],
    very_poor: ["zeer slecht", "var(--bad)"],
    extremely_poor: ["extreem slecht", "var(--bad)"],
  };
  Panel.comfortTemp = comfortTemp;
  Panel.comfortHum = comfortHum;
  Panel.co2Colour = co2Colour;
  Panel.pmColour = pmColour;
  Panel.quality = (id) => QUALITY[(st(id) || {}).state] || null;

  function renderSensor(i) {
    const s = cfg.sensors[i];
    const col = document.querySelector(`[data-sensor="${i}"]`);
    const t = Panel.num(s.temp);
    const te = col.querySelector(".s-temp");
    te.textContent = Number.isFinite(t) ? t.toFixed(1) + "°" : "--";
    te.style.color = Number.isFinite(t) ? comfortTemp(t, s.indoor) : "var(--text)";
    if (s.humidity) {
      const h = Panel.num(s.humidity);
      const he = col.querySelector(".s-hum");
      he.querySelector("span").textContent = Number.isFinite(h) ? Math.round(h) + "%" : "--";
      he.style.color = Number.isFinite(h) ? comfortHum(h, s.indoor) : "var(--hum)";
    }
  }

  function renderAir(i) {
    const a = cfg.air[i];
    const col = document.querySelector(`[data-air="${i}"]`);
    if (!col) return;
    const co2 = Panel.num(a.co2);
    const pm = Panel.num(a.pm25);
    const t = Panel.num(a.temp);
    const h = Panel.num(a.humidity);
    const q = Panel.quality(a.quality);
    const co2El = col.querySelector(".a-co2");
    co2El.innerHTML = Number.isFinite(co2) ? `${Math.round(co2)}<small>ppm</small>` : "--";
    co2El.style.color = Number.isFinite(co2) ? co2Colour(co2) : "var(--text)";
    const pmEl = col.querySelector(".a-pm");
    pmEl.textContent = "PM2.5 " + (Number.isFinite(pm) ? Math.round(pm) : "--");
    pmEl.style.color = Number.isFinite(pm) ? pmColour(pm) : "var(--text_dim)";
    const tEl = col.querySelector(".a-temp");
    tEl.textContent = Number.isFinite(t) ? t.toFixed(1) + "°" : "--";
    tEl.style.color = Number.isFinite(t) ? comfortTemp(t, true) : "var(--text)";
    const hEl = col.querySelector(".a-hum");
    hEl.querySelector("span").textContent = Number.isFinite(h) ? Math.round(h) + "%" : "--";
    hEl.style.color = Number.isFinite(h) ? comfortHum(h, true) : "var(--hum)";
    const dot = col.querySelector(".aq-dot");
    dot.style.background = q ? q[1] : "var(--tile)";
    col.querySelector(".aq-txt").textContent = q ? q[0] : "";
    col.querySelector(".aq-txt").style.color = q ? q[1] : "";
    col.classList.toggle("stale", !Number.isFinite(co2) && !Number.isFinite(t));
  }

  /* The ALPSTUGA's first CO2 and PM2.5 reading after it comes back from
   * "unavailable" is always exactly 0 (seen in HA history on 2026-09-13):
   * a startup artefact, kept out of the charts. */
  const startupGuarded = (id) => {
    const air = airOf.get(id);
    return !!air && (air[1] === "co2" || air[1] === "pm25");
  };
  const lastRaw = new Map();

  /* 24 h readings per sensor entity: [{t, v}] sorted by time (history + live). */
  Panel.hist = {};
  function pushReading(id, s) {
    const v = Panel.num(id);
    if (!Number.isFinite(v)) return;
    const arr = (Panel.hist[id] = Panel.hist[id] || []);
    const t = s.lastChanged || Date.now();
    if (arr.length && arr[arr.length - 1].t >= t) return;
    arr.push({ t, v });
    const cut = Date.now() - 25 * 3600e3;
    while (arr.length && arr[0].t < cut) arr.shift();
  }
  Panel.valueAt = function (id, t) {
    const arr = Panel.hist[id] || [];
    let v = NaN;
    for (const p of arr) {
      if (p.t > t) break;
      v = p.v;
    }
    return v;
  };
  function renderTrends() {
    const now = Date.now();
    cfg.sensors.forEach((s, i) => {
      const el = document.querySelector(`[data-sensor="${i}"] .trend`);
      if (!el) return;
      const cur = Panel.valueAt(s.temp, now);
      const old = Panel.valueAt(s.temp, now - 3600e3);
      const d = cur - old;
      el.innerHTML = Number.isFinite(d) ? (d >= 0.3 ? icon("arrow-up") : d <= -0.3 ? icon("arrow-down") : "") : "";
    });
  }

  async function loadHistory() {
    const co2Ids = new Set(cfg.air.map((a) => a.co2));
    const histIds = [
      ...cfg.sensors.flatMap((s) => [s.temp, s.humidity]),
      ...cfg.air.flatMap((a) => [a.co2, a.pm25, a.temp, a.humidity]),
    ].filter(Boolean);
    try {
      const res = await client.history(histIds, new Date(Date.now() - 24 * 3600e3));
      for (const id of histIds) {
        const guard = startupGuarded(id);
        const rows = [];
        let prevNumeric = true;
        for (const r of [...(res[id] || [])].sort((x, y) => x.t - y.t)) {
          const v = parseFloat(r.s);
          const numeric = Number.isFinite(v);
          const startupZero = guard && numeric && v === 0 && !prevNumeric;
          prevNumeric = numeric;
          if (numeric && !startupZero && (!co2Ids.has(id) || co2Valid(v))) rows.push({ t: r.t, v });
        }
        const live = (Panel.hist[id] || []).filter((p) => !rows.length || p.t > rows[rows.length - 1].t);
        Panel.hist[id] = rows.concat(live);
      }
      renderTrends();
      if (Panel.onHistory) Panel.onHistory();
    } catch (e) {
      /* retried on the next half-hour refresh */
    }
  }

  async function loadForecast() {
    try {
      const res = await client.callService("weather", "get_forecasts", { type: "daily" }, { entity_id: cfg.weather }, true);
      const fc = (((res || {}).response || {})[cfg.weather] || {}).forecast || [];
      const today = new Date().toDateString();
      /* Skip a leftover entry for yesterday; label days from their own dates. */
      const days = fc.filter((d) => new Date(d.datetime).toDateString() === today || new Date(d.datetime) > new Date()).slice(0, FC_DAYS);
      days.forEach((d, i) => renderForecastDay(i, d.condition, d.temperature, new Date(d.datetime)));
    } catch (e) {
      /* keep the live current-weather column */
    }
  }
  function renderForecastDay(i, condition, temperature, date) {
    const col = $("fc" + i);
    if (!col) return;
    const day = date || new Date(Date.now() + i * 86400e3);
    col.querySelector(".fc-day").textContent = DAY_SHORT[day.getDay()];
    if (Number.isFinite(temperature)) col.querySelector(".fc-temp").textContent = Math.round(temperature) + "°";
    applyWx(col, condition);
  }
  let haveForecast = false;

  /* ---- Tabs, tiles and rows -------------------------------------------------- */
  Panel.tab = 0;
  const activeScene = cfg.tabs.map(() => -1);
  const tabBrightness = cfg.tabs.map(() => -1);
  Panel.tabBrightness = tabBrightness;

  function lightTile(entity, extraClass) {
    return (
      `<button class="tile ${extraClass || ""}" data-light="${entity.id}">` +
      `<span class="t-icon">${icon("power")}</span><span class="t-name">${entity.label}</span><span class="t-sub">...</span></button>`
    );
  }
  Panel.lightTile = lightTile;

  function swatchHtml(sw) {
    if (sw.a === "rainbow") return '<span class="swatch rainbow"></span>';
    const bg = sw.b ? `linear-gradient(90deg, ${sw.a}, ${sw.b})` : sw.a;
    return `<span class="swatch" style="background:${bg}"></span>`;
  }

  function buildTabs() {
    const bar = $("tabbar");
    bar.insertAdjacentHTML(
      "afterbegin",
      cfg.tabs.map((t, i) => `<button class="tab${i === 0 ? " active" : ""}" data-tab="${i}">${t.name}</button>`).join("")
    );
    $("track").innerHTML = cfg.tabs
      .map((t, ti) => {
        const hasVac = isVacTab(t);
        return `<section class="page${hasVac ? " has-vac" : ""}" data-page="${ti}">${gridHtml(t, ti)}${hasVac ? vacHtml() : ""}${rowHtml(t, ti)}</section>`;
      })
      .join("");
  }

  /* ---- Robot vacuum ("Schoonmaak") -------------------------------------------- */
  const isVacTab = (t) => !!vac && t.name === vac.tab;
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
  const vacRooms = new Set(); /* selected room ids */
  Panel.vacRooms = vacRooms;
  Panel.vacStatusNl = (raw, vstate) => STATUS_NL[raw] || STATE_NL[vstate] || vstate;

  function chips(kind, labels) {
    return Object.entries(labels)
      .map(([opt, l]) => `<button class="vchip" data-vac="${kind}" data-opt="${opt}">${l}</button>`)
      .join("");
  }
  function vacHtml() {
    return (
      `<div class="vac" id="vac">` +
      `<div class="vac-head"><span class="vac-ic">${icon("vacuum")}</span>` +
      `<div class="vac-title"><b>${vac.label}</b><span class="vac-status">...</span></div>` +
      `<div class="vac-batt"><i><s></s></i><span>--</span></div>` +
      `<button class="vbtn ghost" data-vac="locate" aria-label="Zoek robot">${icon("locate")}</button>` +
      `<button class="vbtn open" data-vac="open">${icon("expand")}<span>Kamers &amp; onderhoud</span></button></div>` +
      `<div class="vac-rooms"><span class="vlabel">Kamers</span>` +
      vac.rooms.map((r) => `<button class="vchip room" data-vac="room" data-room="${r.id}">${r.label}</button>`).join("") +
      `</div>` +
      `<div class="vac-modes"><span class="vlabel">Modus</span>${chips("mode", MODE_NL)}` +
      `<span class="vlabel">Zuigkracht</span>${chips("fan", FAN_NL)}` +
      `<span class="vlabel vwater">Water</span>${chips("water", WATER_NL)}</div>` +
      `<div class="vac-actions">` +
      `<button class="vbtn primary" data-vac="rooms">${icon("play")}<span>Kamers schoonmaken</span></button>` +
      `<button class="vbtn" data-vac="start">${icon("play")}<span>Hele huis</span></button>` +
      `<button class="vbtn" data-vac="pause">${icon("pause")}<span>Pauze</span></button>` +
      `<button class="vbtn" data-vac="resume">${icon("play")}<span>Verder</span></button>` +
      `<button class="vbtn" data-vac="dock">${icon("dock")}<span>Naar dock</span></button>` +
      `</div></div>`
    );
  }

  function renderVacuum() {
    const card = $("vac");
    if (!card) return;
    const v = st(vac.vacuum);
    const statusRaw = ((st(vac.status) || {}).state || "").toLowerCase();
    const vstate = v ? v.state : "unavailable";
    const offline = unavailable(v);
    const busy = ["cleaning", "returning"].includes(vstate);
    const paused = vstate === "paused" || statusRaw === "paused";
    const area = Panel.num(vac.area);
    let status = offline ? "Niet bereikbaar" : STATUS_NL[statusRaw] || STATE_NL[vstate] || vstate;
    if (busy && Number.isFinite(area) && area > 0) status += ` · ${Math.round(area)} m²`;
    card.querySelector(".vac-status").textContent = status;
    card.classList.toggle("busy", busy);
    card.classList.toggle("offline", offline);
    const batt = Panel.num(vac.battery);
    const b = card.querySelector(".vac-batt");
    b.querySelector("span").textContent = Number.isFinite(batt) ? Math.round(batt) + "%" : "--";
    b.querySelector("s").style.width = (Number.isFinite(batt) ? batt : 0) + "%";
    b.classList.toggle("low", Number.isFinite(batt) && batt < 20);
    for (const [kind, id] of [["mode", vac.mode], ["fan", vac.fan], ["water", vac.water]]) {
      const cur = (st(id) || {}).state;
      card.querySelectorAll(`[data-vac="${kind}"]`).forEach((c) => c.classList.toggle("active", c.dataset.opt === cur));
    }
    const mode = (st(vac.mode) || {}).state;
    card.querySelectorAll('[data-vac="water"], .vwater').forEach((c) => (c.hidden = mode === "OnlySweep"));
    card.querySelectorAll('[data-vac="room"]').forEach((c) => c.classList.toggle("active", vacRooms.has(+c.dataset.room)));
    const n = vacRooms.size;
    const roomsBtn = card.querySelector('[data-vac="rooms"]');
    roomsBtn.querySelector("span").textContent = n ? `${n === 1 ? "Kamer" : n + " kamers"} schoonmaken` : "Kies kamers";
    roomsBtn.disabled = !n || busy || offline;
    card.querySelector('[data-vac="start"]').hidden = busy || paused;
    card.querySelector('[data-vac="rooms"]').hidden = busy || paused;
    card.querySelector('[data-vac="pause"]').hidden = !busy || vstate === "returning";
    card.querySelector('[data-vac="resume"]').hidden = !paused;
    card.querySelector('[data-vac="dock"]').hidden = !(busy || paused) || vstate === "returning";
    if (Panel.onVacuum) Panel.onVacuum();
  }

  Panel.vacTap = function (el) {
    const kind = el.dataset.vac;
    const target = { entity_id: vac.vacuum };
    if (kind === "open") return Panel.openVacuum && Panel.openVacuum();
    if (kind === "noop") return renderVacuum(); /* selection changed elsewhere (the sheet) */
    const fail = () => {};
    if (kind === "room") {
      const id = +el.dataset.room;
      if (vacRooms.has(id)) vacRooms.delete(id);
      else vacRooms.add(id);
      return renderVacuum();
    }
    if (kind === "mode" || kind === "fan" || kind === "water") {
      const entity = vac[kind];
      const s = st(entity);
      if (s) client.states.set(entity, { ...s, state: el.dataset.opt }); /* optimistic; HA confirms */
      renderVacuum();
      return client.callService("select", "select_option", { option: el.dataset.opt }, { entity_id: entity }).catch(fail);
    }
    if (kind === "rooms") {
      if (!vacRooms.size) return;
      const list = JSON.stringify([...vacRooms].sort((a, b) => a - b));
      /* start-clean(clean-type = 3 AreaClean, clean-values = "[id,...]") */
      client
        .callService("xiaomi_miot", "call_action", { entity_id: vac.vacuum, siid: 17, aiid: 1, params: [3, list] })
        .catch(fail);
      vacRooms.clear();
      return renderVacuum();
    }
    if (kind === "start" || kind === "resume") return client.callService("vacuum", "start", null, target).catch(fail);
    if (kind === "pause") return client.callService("vacuum", "pause", null, target).catch(fail);
    if (kind === "dock") return client.callService("vacuum", "return_to_base", null, target).catch(fail);
    if (kind === "locate") return client.callService("button", "press", null, { entity_id: vac.locate }).catch(fail);
  };

  function gridHtml(t, ti) {
    if (t.sceneTiles) {
      const gridN = t.scenes.length - Math.min(t.quick, t.scenes.length);
      /* Compact tiles for many scenes, or to make room for the vacuum section. */
      const compact = gridN > 6 || isVacTab(t);
      let html = `<div class="grid${compact ? " compact" : ""}${isVacTab(t) && gridN <= 6 ? " c3" : ""}">`;
      for (let i = 0; i < gridN; i++) {
        const sw = t.swatches && t.swatches[i];
        const lead = sw ? swatchHtml(sw) : `<span class="t-icon">${icon((t.icons && t.icons[i]) || "bolt")}</span>`;
        html +=
          `<button class="tile scene" data-scene="${ti}:${i}">${lead}<span class="t-name">${t.scenes[i].label}</span>` +
          (compact ? "" : `<span class="t-sub">scene</span>`) +
          `</button>`;
      }
      return html + "</div>";
    }
    return `<div class="grid">${t.lights.slice(0, 6).map((l) => lightTile(l)).join("")}</div>`;
  }

  function rowHtml(t, ti) {
    let html = '<div class="row">';
    if (t.sceneTiles) {
      if (t.lights.length) html += `<button class="sq" data-light="${t.lights[0].id}" data-group="1">${icon("power")}</button>`;
      const first = t.scenes.length - Math.min(t.quick, t.scenes.length);
      for (let i = first; i < t.scenes.length; i++) {
        const ic = t.icons && t.icons[i];
        html += `<button class="sq quick" data-scene="${ti}:${i}" aria-label="${t.scenes[i].label}">${ic ? icon(ic) : t.scenes[i].label}</button>`;
      }
      html += `<div class="pill" data-pill="${ti}"><span><span class="lbl">Actieve scene:</span><b>-</b></span></div>`;
    } else {
      t.scenes.forEach((s, i) => (html += `<button class="chip" data-scene="${ti}:${i}">${s.label}</button>`));
    }
    html +=
      `<button class="allbtn" data-all="${ti}">${icon("list")}<span class="txt">Alle lampen</span>` +
      `<span class="chev">${icon("chevron-down")}</span></button>`;
    return html + "</div>";
  }

  function renderLight(id) {
    const s = st(id);
    const p = pending.get(id);
    const un = loaded ? unavailable(s) : false;
    const on = p ? p.on : s && s.state === "on";
    document.querySelectorAll(`[data-light="${esc(id)}"]`).forEach((el) => {
      el.classList.toggle("unavail", un);
      el.classList.toggle("on", !un && !!on);
      el.classList.toggle("pending", !!p);
      const ic = el.classList.contains("sq") ? el : el.querySelector(".t-icon");
      const want = un ? "warning" : "power";
      if (ic && ic.dataset.icon !== want) {
        ic.dataset.icon = want;
        ic.innerHTML = icon(want);
      }
      const sub = el.querySelector(".t-sub");
      if (sub) sub.textContent = !s && !loaded ? "..." : un ? "niet beschikbaar" : on ? "aan" : "uit";
    });
  }
  Panel.renderLight = renderLight;

  function highlightScene(tab, idx) {
    activeScene[tab] = idx;
    document.querySelectorAll(`[data-scene^="${tab}:"]`).forEach((el) => {
      const i = +el.dataset.scene.split(":")[1];
      const on = i === idx;
      el.classList.toggle("active", on);
      const sub = el.querySelector(".t-sub");
      if (sub) sub.textContent = on ? "actief" : "scene";
    });
    const pill = document.querySelector(`[data-pill="${tab}"] b`);
    if (pill) pill.textContent = idx >= 0 ? cfg.tabs[tab].scenes[idx].label : "-";
  }
  Panel.renderScenes = () => activeScene.forEach((idx, t) => highlightScene(t, idx));

  /* A scene's HA state is its last-activated timestamp. */
  const sceneSeen = new Map();
  function handleScene(id) {
    const s = st(id);
    if (!s) return;
    const prev = sceneSeen.get(id);
    sceneSeen.set(id, s.state);
    if (prev === undefined || prev === s.state) return;
    cfg.tabs.forEach((t, ti) => t.scenes.forEach((sc, i) => sc.id === id && highlightScene(ti, i)));
  }
  function newestScenes() {
    cfg.tabs.forEach((t, ti) => {
      let best = -1,
        bestT = 0;
      t.scenes.forEach((sc, i) => {
        const s = st(sc.id);
        const ts = s ? Date.parse(s.state) : NaN;
        if (Number.isFinite(ts) && ts > bestT) {
          bestT = ts;
          best = i;
        }
      });
      if (best >= 0) highlightScene(ti, best);
    });
  }

  function syncTabBrightness(id) {
    cfg.tabs.forEach((t, ti) => {
      if (!t.lights[0] || t.lights[0].id !== id) return;
      const v = pct(st(id));
      if (v < 0) return;
      tabBrightness[ti] = v;
      if (ti === Panel.tab && Panel.onTabBrightness) Panel.onTabBrightness(v);
    });
  }

  function handleStates(changed) {
    const first = !loaded;
    loaded = true;
    const allIds = first ? [...ids] : changed;
    for (const id of allIds) {
      const s = st(id);
      if (id.startsWith("light.")) {
        if (pending.has(id) && s && (s.state === "on") === pending.get(id).on) {
          clearTimeout(pending.get(id).timer);
          pending.delete(id);
        }
        renderLight(id);
        syncTabBrightness(id);
      } else if (id.startsWith("scene.")) {
        if (!first) handleScene(id);
        else sceneSeen.set(id, s ? s.state : undefined);
      } else if (id === cfg.weather) {
        if (!haveForecast && s) renderForecastDay(0, s.state, s.attributes.temperature);
      } else if (id.startsWith("media_player.")) {
        if (Panel.onMedia) Panel.onMedia();
      } else if (vacIds.has(id)) {
        renderVacuum();
      } else if (airOf.has(id)) {
        const prev = lastRaw.get(id);
        lastRaw.set(id, s ? s.state : undefined);
        const startupZero =
          startupGuarded(id) && s && parseFloat(s.state) === 0 && prev !== undefined && !Number.isFinite(parseFloat(prev));
        if (s && !startupZero) pushReading(id, s);
        renderAir(airOf.get(id)[0]);
        if (Panel.onSensor) Panel.onSensor(id);
      } else {
        cfg.sensors.forEach((sn, i) => {
          if (sn.temp === id || sn.humidity === id) {
            if (s) pushReading(id, s);
            renderSensor(i);
          }
        });
        if (Panel.onSensor) Panel.onSensor(id);
      }
    }
    if (first) {
      newestScenes();
      loadHistory();
      loadForecast().then(() => (haveForecast = true));
      if (Panel.onReady) Panel.onReady();
    }
  }

  /* ---- Boot ------------------------------------------------------------------ */
  Panel.boot = function () {
    buildHeader();
    buildTabs();
    cfg.sensors.forEach((_, i) => renderSensor(i));
    cfg.air.forEach((_, i) => renderAir(i));
    renderVacuum();
    /* Fade the header strip's right edge only while more columns hide there. */
    const strip = document.querySelector(".hdr-strip");
    const fade = () =>
      strip.classList.toggle("overflowing", strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2);
    new ResizeObserver(fade).observe(strip);
    new ResizeObserver(fade).observe($("sensors"));
    strip.addEventListener("scroll", fade, { passive: true });
    ids.forEach((id) => id.startsWith("light.") && renderLight(id));
    tickClock();
    setInterval(tickClock, 1000);
    setInterval(() => {
      if (!loaded) return;
      loadForecast();
      loadHistory();
    }, 30 * 60e3);

    client.on("status", (s) => {
      $("status").className = "status " + (s === "connected" ? "connected" : s === "connecting" ? "connecting" : "");
      if (Panel.onStatus) Panel.onStatus(s);
    });
    client.on("states", handleStates);
    /* Visible before the gesture layer measures anything (slider, indicator). */
    $("app").hidden = false;
    if (Panel.initInteract) Panel.initInteract();
    if (Panel.initExtras) Panel.initExtras();
    client.start();
  };
})();
