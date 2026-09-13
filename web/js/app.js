/* Web panel core: preferences, theme, HA state, and rendering of the header,
 * the sections (Verlichting with its floors, Schoonmaak, Garage), tiles and
 * bottom rows. Gestures live in interact.js, the vacuum page in vacuum.js,
 * popups, screensaver, settings and splash in extras.js. */
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
  cfg.tabs.forEach((t) => {
    [...t.lights, ...t.devices, ...t.scenes].forEach((e) => ids.add(e.id));
    (t.areas || []).forEach((a) => [...a.lights, ...a.scenes.map((s) => s.id)].forEach((id) => ids.add(id)));
  });
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
  const vacIds = new Set(
    vac ? ["vacuum", "status", "battery", "area", "mode", "fan", "water", "locate"].map((k) => vac[k]).filter(Boolean) : []
  );
  vacIds.forEach((id) => ids.add(id));
  const bike = cfg.bike;
  const bikeIds = new Set(bike ? ["battery", "location", "lock", "speed"].map((k) => bike[k]).filter(Boolean) : []);
  bikeIds.forEach((id) => ids.add(id));
  const car = cfg.car;
  const carIds = new Set(car ? Object.values(car.entities) : []);
  carIds.forEach((id) => ids.add(id));
  const client = demo ? HA.createDemo(cfg) : HA.createClient([...ids]);
  Panel.client = client;
  let loaded = false; /* initial state dump received */

  const st = (id) => client.states.get(id);
  Panel.st = st;
  const unavailable = (s) => !s || s.state === "unavailable" || s.state === "unknown" || s.state === "none";
  Panel.unavailable = unavailable;
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
        .join("") +
      /* Devices (vacuum, bike, car): the climate columns' three lines each, name
       * with a small icon, battery, and a short status, so the text lines up. */
      [
        cfg.vacuum && ["button", "data-vachdr", cfg.vacuum.label, "vacuum"],
        cfg.bike && ["div", "data-bike", cfg.bike.label, "bike"],
        cfg.car && ["button", "data-carhdr", "", "car"], /* icon only: no title (user request) */
      ]
        .filter(Boolean)
        .map(
          ([tag, attr, label, ic], i) =>
            (i === 0 ? '<div class="rule"></div>' : "") +
            `<${tag} class="sensor-col dev-hdr" ${attr} aria-label="${label || (ic === "car" ? cfg.car.label : ic)}">` +
            `<div class="s-name">${icon(ic)}${label ? `<span>${label}</span>` : ""}</div>` +
            `<div class="s-temp vh-batt"><span>--</span></div>` +
            `<div class="s-hum vh-status">...</div></${tag}>`
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
  Panel.battColour = (v) => (!Number.isFinite(v) ? "var(--text)" : v < 20 ? "var(--bad)" : v < 40 ? "var(--warn)" : "var(--ok)");
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
    col.classList.toggle("stale", !Number.isFinite(t)); /* no reading: sensor offline */
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

  const WHERE_NL = { home: "Thuis", not_home: "Weg" };
  function renderBike() {
    const row = bike && document.querySelector("[data-bike]");
    if (!row) return;
    const batt = Panel.num(bike.battery);
    const where = st(bike.location);
    const speed = Panel.num(bike.speed);
    const locked = (st(bike.lock) || {}).state === "on";
    const offline = loaded && unavailable(st(bike.battery));
    const riding = Number.isFinite(speed) && speed >= 3;
    /* Riding shows the speed; parked shows where (home, away or a zone's name)
     * and a lock icon when locked. Short: the header column is narrow. */
    const status = offline ? "Offline" : riding ? `${Math.round(speed)} km/u` : unavailable(where) ? "" : WHERE_NL[where.state] || where.state;
    row.querySelector(".vh-batt span").textContent = Number.isFinite(batt) ? Math.round(batt) + "%" : "--";
    row.querySelector(".vh-batt").style.color = Panel.battColour(batt);
    const statusEl = row.querySelector(".vh-status");
    statusEl.textContent = status; /* zone names come from HA: text, not markup */
    if (!offline && !riding && locked) statusEl.insertAdjacentHTML("beforeend", icon("lock"));
    row.classList.toggle("riding", riding);
    row.classList.toggle("stale", offline);
  }

  function renderCar() {
    const row = car && document.querySelector("[data-carhdr]");
    if (!row) return;
    const batt = Panel.num(car.battery);
    const range = Panel.num(car.range);
    const charging = ((st(car.charging) || {}).state || "").toLowerCase();
    const locked = (st(car.lock) || {}).state === "locked";
    const offline = loaded && unavailable(st(car.battery));
    const busy = charging === "charging" || charging === "starting";
    /* Charging or full while plugged in; otherwise how far it can go. */
    const status = offline ? "Offline" : busy ? "Laadt" : charging === "complete" ? "Vol" : Number.isFinite(range) ? `${Math.round(range)} km` : "";
    row.querySelector(".vh-batt span").textContent = Number.isFinite(batt) ? Math.round(batt) + "%" : "--";
    row.querySelector(".vh-batt").style.color = Panel.battColour(batt);
    const statusEl = row.querySelector(".vh-status");
    statusEl.textContent = status;
    if (!offline && locked) statusEl.insertAdjacentHTML("beforeend", icon("lock"));
    row.classList.toggle("riding", busy); /* accent status while charging */
    row.classList.toggle("stale", offline);
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

  /* ---- Sections and floors ------------------------------------------------------ */
  Panel.section = 0;
  Panel.floor = 0; /* index into cfg.floors (0 = begane grond) */
  /* Floors are shown top to bottom from the highest, like a lift panel. */
  Panel.floorOrder = cfg.floors.map((_, i) => i).reverse();
  Panel.floorPos = (fi) => Panel.floorOrder.indexOf(fi);
  /* The PANEL_TABS index whose lights the slider, drawer and bottom row use,
   * or -1 on a section without lights (Schoonmaak). */
  Panel.activeTab = function () {
    const s = cfg.sections[Panel.section];
    return s.kind === "floors" ? cfg.floors[Panel.floor].tab : s.kind === "tab" ? s.tab : -1;
  };

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

  function buildSections() {
    $("tabbar").insertAdjacentHTML(
      "afterbegin",
      cfg.sections.map((s, i) => `<button class="tab${i === 0 ? " active" : ""}" data-tab="${i}">${s.name}</button>`).join("")
    );
    $("track").innerHTML = cfg.sections.map(pageHtml).join("");
  }

  function pageHtml(sec, si) {
    if (sec.kind === "floors") {
      const order = Panel.floorOrder;
      return (
        `<section class="page floors-page" data-page="${si}">` +
        `<nav class="rail" aria-label="Verdieping"><div class="rail-track"><i class="rail-ind"></i>` +
        order
          .map((fi) => `<button class="rail-btn" data-floor="${fi}"><b>${cfg.floors[fi].label}</b><span>${cfg.floors[fi].name}</span></button>`)
          .join("") +
        `</div></nav>` +
        `<div class="floor-view"><div class="floor-track">` +
        order.map((fi) => `<div class="floor" data-floor-panel="${fi}">${floorHtml(fi)}</div>`).join("") +
        `</div></div>` +
        `<div class="floor-rows">` +
        cfg.floors.map((f, fi) => `<div class="floor-row${fi === 0 ? " active" : ""}" data-floor-row="${fi}">${rowHtml(cfg.tabs[f.tab], f.tab)}</div>`).join("") +
        `</div></section>`
      );
    }
    if (sec.kind === "vacuum") {
      return `<section class="page vac-page" data-page="${si}"><div id="vacPage" class="vp"></div></section>`;
    }
    if (sec.kind === "car") {
      return `<section class="page car-page" data-page="${si}"><div id="carPage" class="cp"></div></section>`;
    }
    const t = cfg.tabs[sec.tab];
    return `<section class="page tab-page" data-page="${si}">${gridHtml(t, sec.tab)}${rowHtml(t, sec.tab)}</section>`;
  }

  /* ---- Floor page: lamps on the left, the floor's scenes on the right ------------ */
  /* Every lamp of a floor: the drawer's, then room lamps it does not list. */
  function floorLamps(t) {
    const seen = new Set();
    const out = [];
    const add = (id, label) => {
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ id, label });
    };
    t.devices.forEach((d) => add(d.id, d.label));
    (t.areas || []).forEach((a) => a.lights.forEach((id) => add(id, null)));
    return out;
  }
  function lampLabel(lamp) {
    if (lamp.label) return lamp.label;
    const name = ((st(lamp.id) || {}).attributes || {}).friendly_name || lamp.id.replace(/^light\./, "").replace(/_/g, " ");
    const short = name.replace(/^lamp\s+/i, "");
    return short.charAt(0).toUpperCase() + short.slice(1);
  }
  const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  /* The lamps shown for a floor and room: once HA has answered, only lamps it has. */
  function shownLamps(fi, area) {
    const room = area ? new Set(area.lights) : null;
    return floorLamps(cfg.tabs[cfg.floors[fi].tab]).filter((l) => (!room || room.has(l.id)) && (!loaded || st(l.id)));
  }
  function lampTile(lamp) {
    return (
      `<button class="tile" data-light="${lamp.id}"><span class="t-icon">${icon("power")}</span>` +
      `<span class="t-text"><span class="t-name">${escHtml(lampLabel(lamp))}</span><span class="t-sub">...</span></span></button>`
    );
  }
  function floorHtml(fi) {
    const ti = cfg.floors[fi].tab;
    const t = cfg.tabs[ti];
    const scenes = t.scenes
      .map((s, i) => {
        const sw = t.swatches && t.swatches[i];
        const lead = sw ? swatchHtml(sw) : `<span class="t-icon">${icon((t.icons && t.icons[i]) || "bolt")}</span>`;
        return `<button class="tile scene" data-scene="${ti}:${i}">${lead}<span class="t-text"><span class="t-name">${s.label}</span><span class="t-sub">scene</span></span></button>`;
      })
      .join("");
    return (
      `<div class="split${t.scenes.length ? "" : " no-scenes"}">` +
      `<div class="split-half split-lamps"><div class="split-title">Lampen</div>` +
      `<div class="split-list"><div class="grid" data-lamps="${fi}">${shownLamps(fi, null).map(lampTile).join("")}</div></div></div>` +
      `<div class="split-half split-scenes"><div class="split-title">Scènes</div>` +
      `<div class="split-list"><div class="grid">${scenes}</div></div></div>` +
      `</div>`
    );
  }
  const areaOf = (fi) => {
    const ai = Panel.areaIndex ? Panel.areaIndex(fi) : -1;
    return ai >= 0 ? cfg.tabs[cfg.floors[fi].tab].areas[ai] : null;
  };
  /* A list that is taller than its half scrolls natively (touch-action pan-y);
   * one that fits leaves vertical swipes to the floor switch. */
  function markScroll(list) {
    list.classList.toggle("scrolls", list.scrollHeight > list.clientHeight + 1);
  }
  function watchLists() {
    document.querySelectorAll(".split-list").forEach((list) => {
      const ro = new ResizeObserver(() => markScroll(list));
      ro.observe(list);
      if (list.firstElementChild) ro.observe(list.firstElementChild);
      markScroll(list);
    });
  }

  /* Rebuild a floor's lamp list for "Alle" (area null) or one room. */
  Panel.renderLamps = function (fi, area) {
    const grid = document.querySelector(`[data-lamps="${fi}"]`);
    if (!grid) return;
    const lamps = shownLamps(fi, area);
    grid.innerHTML = lamps.map(lampTile).join("");
    lamps.forEach((l) => renderLight(l.id));
    grid.closest(".split-lamps").querySelector(".split-title").textContent = area ? `Lampen · ${area.label}` : "Lampen";
    const list = grid.closest(".split-list");
    list.scrollTop = 0;
    markScroll(list);
  };

  function gridHtml(t, ti) {
    if (t.sceneTiles) {
      const gridN = t.scenes.length - Math.min(t.quick, t.scenes.length);
      const compact = gridN > 6;
      let html = `<div class="grid${compact ? " compact" : ""}">`;
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
    if ((t.areas || []).length) {
      /* The floor's main switch, Alle and one button per room, then every lamp. */
      let row = '<div class="row has-areas">';
      if (t.sceneTiles && t.lights.length) row += `<button class="sq" data-light="${t.lights[0].id}" data-group="1">${icon("power")}</button>`;
      row +=
        `<div class="areas"><button class="chip area-chip active" data-area="-1">Alle</button>` +
        t.areas.map((a, i) => `<button class="chip area-chip" data-area="${i}">${a.label}</button>`).join("") +
        `</div>`;
      row +=
        `<button class="allbtn" data-all="${ti}">${icon("list")}<span class="txt">Alle lampen</span>` +
        `<span class="chev">${icon("chevron-down")}</span></button>`;
      return row + "</div>";
    }
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
      /* The slider shows a chosen room's own brightness instead. */
      if (ti === Panel.activeTab() && Panel.onTabBrightness && !(Panel.activeArea && Panel.activeArea())) Panel.onTabBrightness(v);
    });
  }

  function handleStates(changed) {
    const first = !loaded;
    loaded = true;
    const allIds = first ? [...ids] : changed;
    let vacChanged = false;
    let bikeChanged = false;
    let carChanged = false;
    for (const id of allIds) {
      const s = st(id);
      if (id.startsWith("light.")) {
        if (pending.has(id) && s && (s.state === "on") === pending.get(id).on) {
          clearTimeout(pending.get(id).timer);
          pending.delete(id);
        }
        renderLight(id);
        syncTabBrightness(id);
        if (Panel.onAreaLight) Panel.onAreaLight(id);
      } else if (id.startsWith("scene.")) {
        if (!first) handleScene(id);
        else sceneSeen.set(id, s ? s.state : undefined);
      } else if (id === cfg.weather) {
        if (!haveForecast && s) renderForecastDay(0, s.state, s.attributes.temperature);
      } else if (id.startsWith("media_player.")) {
        if (Panel.onMedia) Panel.onMedia();
      } else if (bikeIds.has(id)) {
        bikeChanged = true;
      } else if (carIds.has(id)) {
        carChanged = true;
      } else if (vacIds.has(id)) {
        vacChanged = true;
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
    if (vacChanged && Panel.onVacuum) Panel.onVacuum();
    if (bikeChanged) renderBike();
    if (carChanged) {
      renderCar();
      if (Panel.onCar) Panel.onCar();
    }
    if (first) {
      newestScenes();
      /* Now that HA has answered, drop lamps it does not have from the lists. */
      cfg.floors.forEach((_, fi) => Panel.renderLamps(fi, areaOf(fi)));
      loadHistory();
      loadForecast().then(() => (haveForecast = true));
      if (Panel.onReady) Panel.onReady();
    }
  }

  /* ---- Boot ------------------------------------------------------------------ */
  Panel.boot = function () {
    buildHeader();
    buildSections();
    if (Panel.buildVacuum && $("vacPage")) Panel.buildVacuum($("vacPage"));
    if (Panel.buildCar && $("carPage")) Panel.buildCar($("carPage"));
    if (Panel.initAreas) Panel.initAreas();
    watchLists();
    cfg.sensors.forEach((_, i) => renderSensor(i));
    cfg.air.forEach((_, i) => renderAir(i));
    renderBike();
    renderCar();
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
    /* Visible before the gesture layer measures anything (slider, indicators). */
    $("app").hidden = false;
    if (Panel.initInteract) Panel.initInteract();
    if (Panel.initExtras) Panel.initExtras();
    client.start();
  };
})();
