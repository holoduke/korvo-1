/* The "Vision" screensaver: the boot splash's Terminator look, but alive with
 * the house's own data (saver mode 3; saver.js shows and hides it).
 *
 *   left        a live feed of the house: it opens with a snapshot of
 *               everything, then types a new line every 1.6 s from a large
 *               pool of real readings (rooms with their hour's trend, outside,
 *               the heat pump, car, bike, batteries, power, lamps, the door,
 *               vacuum, music, network, Zigbee, the sun), and at once when
 *               something changes (marked with a delta); the list moves up and
 *               the oldest lines leave at the top
 *   right       the 3D house turning in a 2x2 frame, beside it two wireframes
 *               with real figures (the grid's power, the outdoor air), and
 *               under them, across the width, a graph that shows another 24
 *               hours of real history every 9 s (power, each room's climate,
 *               outside against inside, the air, the heat pump, the car, the
 *               batteries, the internet): drawn in from the left, then swept
 *               by a scan line that reads off the value where it passes
 *   foot        the title, how the systems are, a Knight Rider scanner
 *
 * Drawing: a 2D canvas for the frames, wires and graph (vision.js), a second
 * WebGL house (house3d.js) on its own canvas in the big frame. Nothing runs
 * while it is hidden or the panel sleeps. Every minute the whole HUD moves a
 * few pixels, so a wall tablet does not keep one image all night. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const V = Panel.Vision;
  const { RED, HOT, PALE, AMBER, rgba } = V;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- Markup ---------------------------------------------------------------------- */
  const root = document.createElement("div");
  root.id = "vision";
  root.className = "vn";
  root.hidden = true;
  root.innerHTML =
    `<canvas class="vn-canvas"></canvas>` +
    `<div class="vn-house"><canvas></canvas></div>` +
    `<div class="vn-hud">` +
    `<div class="vn-top"><span class="vn-brand">Cyberdyne Systems</span><span class="vn-model">Series T-1000 &middot; Home unit &middot; live</span><span class="vn-clock"></span></div>` +
    `<pre class="vn-log"></pre>` +
    `<div class="vn-title"><span>T-1000 Automation</span></div>` +
    `<div class="vn-bottom"><div class="vn-status"></div><div class="vn-bar"></div></div>` +
    `</div>` +
    `<div class="vn-scan"></div>`;
  document.body.appendChild(root);
  const canvas = root.querySelector(".vn-canvas");
  const ctx = canvas.getContext("2d");
  const houseBox = root.querySelector(".vn-house");
  const log = root.querySelector(".vn-log");
  const q = (sel) => root.querySelector(sel);

  /* ---- Reading the house --------------------------------------------------------------- */
  const st = (id) => (id ? Panel.st(id) : null);
  const num = (id) => (id ? Panel.num(id) : NaN);
  const attr = (id, a) => ((st(id) || {}).attributes || {})[a];
  const isOn = (id) => (st(id) || {}).state === "on";
  const ok = Number.isFinite;
  const fmt = (v, d = 1) => (ok(v) ? Util.fmt(v, d) : "--");
  const unit = (id) => attr(id, "unit_of_measurement") || "";
  const hm = (d) => (d instanceof Date && !isNaN(d) ? d.toTimeString().slice(0, 5) : null);
  const STATE_NL = {
    on: "AAN", off: "UIT", open: "OPEN", closed: "DICHT", opening: "OPENT", closing: "SLUIT",
    unavailable: "OFFLINE", unknown: "ONBEKEND", docked: "IN DOCK", cleaning: "BEZIG", returning: "KEERT TERUG",
    idle: "STIL", playing: "SPEELT", paused: "PAUZE", charging: "LAADT", heating: "VERWARMT", cooling: "KOELT",
    home: "THUIS", not_home: "ONDERWEG", operating: "DRAAIT", running: "DRAAIT", standby: "STAND-BY", stopped: "GESTOPT", complete: "KLAAR", disconnected: "LOSGEKOPPELD",
    /* the weather entity's conditions */
    sunny: "ZONNIG", "clear-night": "HELDER", partlycloudy: "HALF BEWOLKT", cloudy: "BEWOLKT", fog: "MIST",
    rainy: "REGEN", pouring: "STORTREGEN", snowy: "SNEEUW", "snowy-rainy": "NATTE SNEEUW", hail: "HAGEL",
    lightning: "ONWEER", "lightning-rainy": "ONWEER", windy: "WIND", "windy-variant": "WIND", exceptional: "UITZONDERLIJK",
  };
  const nl = (state) => STATE_NL[String(state).toLowerCase()] || String(state).replace(/_/g, " ").toUpperCase();
  const says = (id) => {
    const s = st(id);
    return s ? nl(s.state) : "--";
  };
  const energy = (kind) => cfg.energy.filter((e) => e.kind === kind);
  /* kW whatever the sensor reports in */
  const kw = (id) => (/^w$/i.test(unit(id)) ? num(id) / 1000 : num(id));
  /* Mbit/s from whatever a speed sensor reports in (KiB/s, kB/s, Mbit/s ...) */
  function toMbit(u, v) {
    u = u.toLowerCase();
    if (/^kib\/s$/.test(u)) return (v * 8 * 1024) / 1e6;
    if (/^kb\/s$/.test(u)) return (v * 8) / 1000;
    if (/^mib\/s$/.test(u)) return v * 8 * 1.048576;
    if (/^mb\/s$/.test(u)) return v * 8;
    if (/^kbit\/s$/.test(u)) return v / 1000;
    return v; /* Mbit/s */
  }
  const mbit = (id) => toMbit(unit(id), num(id));
  const LIGHTS = [...new Set((JSON.stringify(cfg).match(/light\.[a-z0-9_]+/g) || []).filter((id) => !id.startsWith("light.lampen_")))];
  const lightsOn = () => LIGHTS.filter(isOn);
  const grid = energy("grid")[0];
  const heat = energy("heatpump")[0];
  const outdoor = cfg.sensors.find((s) => !s.indoor);
  const indoors = cfg.sensors.filter((s) => s.indoor);
  const air = (cfg.air || [])[0];
  const car = cfg.car && cfg.car.entities;
  const net = (cfg.network || {}).entities || {};
  const health = cfg.health || {};
  const netKw = () => (grid ? kw(grid.entities.powerIn) - (kw(grid.entities.powerOut) || 0) : NaN);
  function roomOff(s) {
    const t = num(s.temp), h = num(s.humidity), c = cfg.comfort || {};
    return s.indoor && ((ok(t) && (t < c.tempMin || t > c.tempHot)) || (ok(h) && (h < c.humMin - c.humMargin || h > c.humMax + c.humMargin)));
  }

  /* ---- History (24 h: the graph, the trends, the day's ranges) ------------------------ */
  let hist = {}; /* entity id -> [[t, value]] */
  let histAt = 0;
  const series = (id) => hist[id] || [];
  /* A day of a power meter is thousands of readings; the graph is a few
   * hundred pixels wide. Per 5 minutes the lowest and the highest are kept
   * (in their order), so peaks survive and every frame has little to draw. */
  const THIN_MS = 5 * 60e3;
  function thin(pts) {
    if (pts.length < 600) return pts;
    const out = [];
    let i = 0;
    while (i < pts.length) {
      const end = Math.floor(pts[i][0] / THIN_MS) * THIN_MS + THIN_MS;
      let lo = pts[i], hi = pts[i];
      for (; i < pts.length && pts[i][0] < end; i++) {
        if (pts[i][1] < lo[1]) lo = pts[i];
        if (pts[i][1] > hi[1]) hi = pts[i];
      }
      if (lo === hi) out.push(lo);
      else out.push(...(lo[0] < hi[0] ? [lo, hi] : [hi, lo]));
    }
    return out;
  }
  /* Series in the units shown, worked out once per history load, not per frame. */
  const derived = new Map();
  /* the value ms ago, from the history */
  function ago(id, ms) {
    const pts = series(id), t = Date.now() - ms;
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i][0] <= t) return pts[i][1];
    return NaN;
  }
  /* "▲0.4° 1U": how a value moved in the last hour */
  function trend(id, d = 1, u = "°") {
    const now = num(id), then = ago(id, 3600e3);
    if (!ok(now) || !ok(then)) return "";
    const diff = now - then;
    if (Math.abs(diff) < Math.pow(10, -d) / 2) return "= 1U";
    return `${diff > 0 ? "▲" : "▼"}${fmt(Math.abs(diff), d)}${u} 1U`;
  }
  function range(id) {
    const vs = series(id).map((p) => p[1]);
    return vs.length ? [Math.min(...vs), Math.max(...vs)] : [NaN, NaN];
  }

  /* ---- The graph's datasets: a title and up to four series of real history ------------- */
  const hpApp = (cfg.appliances || []).find((a) => a.kind === "heatpump");
  const hp = Object.assign({}, hpApp && hpApp.entities, heat && heat.entities); /* the heat pump's every sensor */
  const fridge = ((cfg.appliances || []).find((a) => a.kind === "fridge") || {}).entities || {};
  const batteries = energy("battery");
  const bike = energy("bike")[0];
  const S = (id, label, u, d, scale) => (id ? { id, label, unit: u, d, scale } : null);
  const wToKw = (id) => (v) => (/^w$/i.test(unit(id)) ? v / 1000 : v);
  const asMbit = (id) => (v) => toMbit(unit(id), v);
  /* options: bars = hourly averages of the first series under the lines;
   * band = the space between the first two series filled */
  const DATASETS = (() => {
    const list = [];
    const add = (title, ser, opt = {}) => {
      ser = ser.filter(Boolean);
      if (ser.length) list.push(Object.assign({ title, series: ser }, opt));
    };
    const g = grid ? grid.entities : {};
    const rooms = indoors.map((s) => () => add(`KLIMAAT · ${s.label.toUpperCase()}`, [S(s.temp, "TEMP", "°", 1), S(s.humidity, "VOCHT", "%", 0)]));
    const others = [
      () => add("STROOMVERBRUIK", [S(g.powerIn, "IMPORT", "KW", 2, wToKw(g.powerIn)), S(g.powerOut, "EXPORT", "KW", 2, wToKw(g.powerOut))], { bars: true }),
      () => outdoor && add("BUITEN VS BINNEN", [S(outdoor.temp, "BUITEN", "°", 1), indoors[0] && S(indoors[0].temp, indoors[0].label.toUpperCase(), "°", 1)], { band: true }),
      () => add("WARMTEPOMP · TEMPERATUREN", [S(hp.hotWaterTop, "WARM WATER", "°", 1), S(hp.room, "KAMER BT50", "°", 1), S(hp.outdoor, "BUITEN BT1", "°", 1)]),
      () => add("VERMOGEN PER FASE", [1, 2, 3].map((k) => S(g["in" + k], "L" + k, "KW", 2, wToKw(g["in" + k])))),
      () => air && add("LUCHTKWALITEIT", [S(air.co2, "CO2", "PPM", 0), S(air.pm25, "PM2.5", "µG", 0)]),
      () => add("AANVOER & RETOUR", [S(hp.supply, "AANVOER BT2", "°", 1), S(hp.ret, "RETOUR BT3", "°", 1), S(hp.calcSupply, "BEREKEND", "°", 1)], { band: true }),
      () => add("NETSPANNING", [1, 2, 3].map((k) => S(g["voltage" + k], "L" + k, "V", 1))),
      () => add("COMPRESSOR", [S(hp.freq, "FREQUENTIE", "HZ", 0)], { bars: true }),
      () => car && add("TESLA · ACCU", [S(car.battery, "ACCU", "%", 0), S(car.range, "BEREIK", "KM", 0)]),
      () => add("BRONCIRCUIT", [S(hp.brineIn, "BRON IN BT10", "°", 1), S(hp.brineOut, "BRON UIT BT11", "°", 1)], { band: true }),
      () => add("STROOM PER FASE", [1, 2, 3].map((k) => S(g["current" + k], "L" + k, "A", 1))),
      () => net.down && add("INTERNET", [S(net.down, "DOWN", "MBIT", 1, asMbit(net.down)), S(net.up, "UP", "MBIT", 1, asMbit(net.up))]),
      () => add("KOUDEMIDDEL", [S(hp.discharge, "PERSGAS BT14", "°", 1), S(hp.condenser, "CONDENSOR BT12", "°", 1), S(hp.liquid, "VLOEISTOF BT15", "°", 1), S(hp.suction, "ZUIGGAS BT17", "°", 1)]),
      () => outdoor && add("BUITEN · TEMP & VOCHT", [S(outdoor.temp, "TEMP", "°", 1), S(outdoor.humidity, "VOCHT", "%", 0)]),
      () => add("WARM WATER", [S(hp.hotWaterTop, "BOVEN BT7", "°", 1), S(hp.hotWaterCharge, "LADEN BT6", "°", 1)], { band: true }),
      () => car && add("TESLA · LADEN", [S(car.chargerPower, "VERMOGEN", "KW", 1)], { bars: true }),
      () => add("GRAADMINUTEN", [S(hp.degreeMinutes, "GM", "GM", 0)], { bars: true }),
      () => add("ADGUARD", [S(net.dnsBlocked, "GEBLOKKEERD", "%", 1), S(net.dnsSpeed, "REACTIE", "MS", 2)]),
      () => add("WASMACHINE & DROGER", energy("washer").concat(energy("dryer")).map((m) => S(m.entities.power, m.label.toUpperCase(), "W", 0)), { bars: true }),
      ...batteries.map((b) => () => add(`${b.label.toUpperCase()} · LAADSTAND`, [S(b.entities.soc, "SOC", "%", 0), S(b.entities.power, "VERMOGEN", "W", 0)])),
      ...batteries.map((b) => () => add(`${b.label.toUpperCase()} · CELSPANNING`, [1, 2, 3, 4].map((k) => S(b.entities["cell" + k], "CEL " + k, "V", 3)))),
      () => bike && add(`${bike.label.toUpperCase()} · ACCU`, [S(bike.entities.battery, "ACCU", "%", 0)]),
      () => add("KOELKAST", [S(fridge.temp, "TEMP", "°", 1)]),
      () => cfg.vacuum && add("STOFZUIGER · ACCU", [S(cfg.vacuum.battery, "ACCU", "%", 0)]),
      () => add("POMPEN", [S(hp.pumpHeat, "CV-POMP GP1", "%", 0), S(hp.pumpBrine, "BRONPOMP GP2", "%", 0)]),
    ];
    /* the rooms between the others, so it never shows six rooms in a row */
    for (let i = 0; i < Math.max(rooms.length, others.length); i++) {
      if (others[i]) others[i]();
      if (rooms[i]) rooms[i]();
    }
    return list;
  })();

  /* The day once, then only what came since: the P1 meter's sensors report
   * every few seconds, so a full day for every series every 10 minutes was
   * tens of thousands of rows for the recorder and the tablet each time. */
  let histFrom = 0; /* ms up to which hist is complete */
  async function loadHistory() {
    histAt = Date.now();
    const dayAgo = Date.now() - 24 * 3600e3;
    const since = histFrom > dayAgo ? histFrom - 60e3 : dayAgo;
    try {
      const res = await Panel.client.history(HIST_IDS, new Date(since));
      const out = {};
      for (const id of HIST_IDS) {
        const fresh = (res[id] || []).map((r) => [r.t, parseFloat(r.s)]).filter(([, v]) => ok(v));
        const kept = since === dayAgo ? [] : (hist[id] || []).filter(([t]) => t >= dayAgo);
        const last = kept.length ? kept[kept.length - 1][0] : -Infinity;
        out[id] = thin(kept.concat(fresh.filter(([t]) => t > last)));
      }
      hist = out;
      histFrom = histAt;
      derived.clear();
    } catch (e) {
      /* unreachable for now: tried again in 10 minutes */
    }
  }

  /* ---- The snapshot that opens the feed ---------------------------------------------------- */
  function snapshot() {
    const out = [["#", "Environment"]];
    for (const s of cfg.sensors) {
      const t = num(s.temp), h = num(s.humidity);
      out.push([s.label, `${fmt(t)}°  ${ok(h) ? Math.round(h) + "%" : "--"}`, roomOff(s) ? "warn" : "ok"]);
    }
    if (air) out.push([`CO2 ${air.short || ""}`.trim(), ok(num(air.co2)) ? `${Math.round(num(air.co2))} PPM` : "--", num(air.co2) > 1000 ? "warn" : "ok"]);
    if (st(cfg.weather)) out.push(["Weer", `${fmt(attr(cfg.weather, "temperature"))}°  ${says(cfg.weather)}`, "ok"]);
    out.push(["#", "Power"]);
    if (grid) out.push(["Stroomnet", ok(netKw()) ? `${netKw() >= 0 ? "IMPORT" : "EXPORT"} ${fmt(Math.abs(netKw()), 2)} KW` : "--", "ok"]);
    if (heat) out.push([heat.label, says(heat.entities.status), isOn(heat.entities.alarm) ? "warn" : "ok"]);
    if (car) out.push([cfg.car.label, `${ok(num(car.battery)) ? Math.round(num(car.battery)) + "%" : "--"}${ok(num(car.range)) ? " · " + Math.round(num(car.range)) + " KM" : ""}`, num(car.battery) < 20 ? "warn" : "ok"]);
    for (const b of energy("battery")) out.push([b.label, ok(num(b.entities.soc)) ? Math.round(num(b.entities.soc)) + "%" : "--", num(b.entities.soc) < 15 ? "warn" : "ok"]);
    out.push(["#", "House"]);
    out.push(["Lampen aan", `${lightsOn().length} / ${LIGHTS.length}`, "ok"]);
    for (const cv of cfg.covers || []) out.push([cv.label, says(cv.entities.cover), (st(cv.entities.cover) || {}).state === "open" ? "warn" : "ok"]);
    if (cfg.vacuum) out.push([cfg.vacuum.label, says(cfg.vacuum.vacuum), "ok"]);
    out.push(["#", "Network"]);
    if (net.down) out.push(["Internet", `${fmt(mbit(net.down), 0)} / ${fmt(mbit(net.up), 0)} MBIT/S`, (st(net.wan) || {}).state === "off" ? "warn" : "ok"]);
    if (health.zigbee) out.push(["Zigbee", isOn(health.zigbee) ? "ONLINE" : "OFFLINE", isOn(health.zigbee) ? "ok" : "warn"]);
    out.push(["#", "Live feed"]);
    return out;
  }
  /* how many readings are out of range, for the status line */
  function warnings() {
    let n = cfg.sensors.filter(roomOff).length;
    if (air && num(air.co2) > 1000) n++;
    if (health.zigbee && !isOn(health.zigbee)) n++;
    if (net.wan && (st(net.wan) || {}).state === "off") n++;
    if (heat && isOn(heat.entities.alarm)) n++;
    for (const cv of cfg.covers || []) if ((st(cv.entities.cover) || {}).state === "open") n++;
    return n;
  }

  /* ---- The pool of readings the feed draws from ------------------------------------------- */
  /* Each gives [label, value, cls] from the house as it is now, or null when it
   * has nothing to say (an entity missing or unavailable). */
  const R = (label, value, cls = "ok") => (value == null || value === "" || /^--|NaN/.test(String(value)) ? null : [label, String(value), cls]);
  const pct = (id) => (ok(num(id)) ? Math.round(num(id)) + "%" : null);
  const POOL = [];
  for (const s of cfg.sensors) {
    POOL.push(() => R(s.label, ok(num(s.temp)) ? `${fmt(num(s.temp))}°${ok(num(s.humidity)) ? "  " + Math.round(num(s.humidity)) + "%" : ""}${trend(s.temp) ? "  " + trend(s.temp) : ""}` : null, roomOff(s) ? "warn" : "ok"));
  }
  if (outdoor) {
    POOL.push(() => {
      const [lo, hi] = range(outdoor.temp);
      return ok(lo) ? R("Buiten laatste 24 u", `${fmt(lo)}° – ${fmt(hi)}°`) : null;
    });
  }
  if (indoors.length) {
    POOL.push(() => {
      const temps = indoors.map((s) => [s, num(s.temp)]).filter(([, t]) => ok(t)).sort((a, b) => b[1] - a[1]);
      return temps.length > 1 ? R("Warmste kamer", `${temps[0][0].label.toUpperCase()} ${fmt(temps[0][1])}°`) : null;
    });
    POOL.push(() => {
      const temps = indoors.map((s) => [s, num(s.temp)]).filter(([, t]) => ok(t)).sort((a, b) => a[1] - b[1]);
      return temps.length > 1 ? R("Koelste kamer", `${temps[0][0].label.toUpperCase()} ${fmt(temps[0][1])}°`) : null;
    });
  }
  if (cfg.weather) {
    const w = cfg.weather;
    POOL.push(() => (st(w) ? R("Weer", `${fmt(attr(w, "temperature"))}°  ${says(w)}`) : null));
    POOL.push(() => (ok(attr(w, "wind_speed")) ? R("Wind", `${fmt(attr(w, "wind_speed"), 0)} ${String(attr(w, "wind_speed_unit") || "km/h").toUpperCase()}${ok(attr(w, "wind_bearing")) ? " · " + Math.round(attr(w, "wind_bearing")) + "°" : ""}`) : null));
    POOL.push(() => (ok(attr(w, "pressure")) ? R("Luchtdruk", `${fmt(attr(w, "pressure"), 0)} ${String(attr(w, "pressure_unit") || "hPa").toUpperCase()}`) : null));
    POOL.push(() => (ok(attr(w, "humidity")) ? R("Luchtvochtigheid buiten", `${Math.round(attr(w, "humidity"))}%`) : null));
  }
  if (health.rain) POOL.push(() => R("Neerslag verwacht", ok(num(health.rain)) ? `${fmt(num(health.rain))} MM/U` : null, num(health.rain) > 0.5 ? "warn" : "ok"));
  POOL.push(() => {
    const sun = st("sun.sun");
    if (!sun) return null;
    const a = sun.attributes || {};
    return sun.state === "above_horizon" ? R("Zonsondergang", hm(new Date(a.next_setting))) : R("Zonsopgang", hm(new Date(a.next_rising)));
  });
  if (air) {
    POOL.push(() => R(`CO2 ${air.short || ""}`.trim(), ok(num(air.co2)) ? `${Math.round(num(air.co2))} PPM  ${trend(air.co2, 0, "")}`.trim() : null, num(air.co2) > 1000 ? "warn" : "ok"));
    if (air.pm25) POOL.push(() => R("Fijnstof PM2.5", ok(num(air.pm25)) ? `${fmt(num(air.pm25), 0)} µG/M³` : null, num(air.pm25) > 25 ? "warn" : "ok"));
  }
  if (heat) {
    const e = heat.entities;
    POOL.push(() => R("Warmtepomp", says(e.status)));
    POOL.push(() => R("Compressor", `${says(e.compressor)}${ok(num(e.freq)) && num(e.freq) > 0 ? " · " + fmt(num(e.freq), 0) + " HZ" : ""}`));
    POOL.push(() => R("Warm water BT7", ok(num(e.hotWaterTop)) ? `${fmt(num(e.hotWaterTop))}°  ${trend(e.hotWaterTop)}`.trim() : null));
    POOL.push(() => R("Warmtepomp buiten BT1", ok(num(e.outdoor)) ? `${fmt(num(e.outdoor))}°` : null));
    POOL.push(() => R("Warmtepomp kamer BT50", ok(num(e.room)) ? `${fmt(num(e.room))}°` : null));
    if (e.heat) POOL.push(() => R("Warmte geleverd", ok(num(e.heat)) ? `${fmt(num(e.heat), 0)} ${unit(e.heat).toUpperCase()}` : null));
    if (e.water) POOL.push(() => R("Warm water geleverd", ok(num(e.water)) ? `${fmt(num(e.water), 0)} ${unit(e.water).toUpperCase()}` : null));
    if (e.cool) POOL.push(() => R("Passieve koeling", ok(num(e.cool)) ? `${fmt(num(e.cool), 0)} ${unit(e.cool).toUpperCase()}` : null));
    POOL.push(() => R("Warmtepomp alarm", st(e.alarm) ? (isOn(e.alarm) ? "ACTIEF" : "GEEN") : null, isOn(e.alarm) ? "warn" : "ok"));
  }
  if (grid) {
    const e = grid.entities;
    POOL.push(() => (ok(netKw()) ? R("Stroomnet", `${netKw() >= 0 ? "IMPORT" : "EXPORT"} ${fmt(Math.abs(netKw()), 2)} KW`) : null));
    POOL.push(() => {
      const [lo, hi] = range(e.powerIn).map((v) => (/^w$/i.test(unit(e.powerIn)) ? v / 1000 : v));
      return ok(hi) ? R("Piekverbruik 24 u", `${fmt(hi, 2)} KW`) : null;
    });
    if (e.tariff) POOL.push(() => R("Tarief nu", st(e.tariff) ? (/^(1|low|laag|dal)/i.test(st(e.tariff).state) ? "DAL" : "NORMAAL") : null));
    POOL.push(() => R("Meterstand T1 / T2", ok(num(e.import1)) ? `${fmt(num(e.import1), 0)} / ${fmt(num(e.import2), 0)} KWH` : null));
    POOL.push(() => (ok(num(e.export1)) ? R("Teruggeleverd totaal", `${fmt((num(e.export1) || 0) + (num(e.export2) || 0), 0)} KWH`) : null));
    for (const k of [1, 2, 3]) if (e["voltage" + k]) POOL.push(() => R(`Spanning fase L${k}`, ok(num(e["voltage" + k])) ? `${fmt(num(e["voltage" + k]), 1)} V` : null));
  }
  if (car) {
    const label = cfg.car.label || "Auto";
    POOL.push(() => R(`${label} accu`, pct(car.battery) && `${pct(car.battery)}${ok(num(car.range)) ? " · " + Math.round(num(car.range)) + " KM" : ""}`, num(car.battery) < 20 ? "warn" : "ok"));
    POOL.push(() => R(`${label} laden`, st(car.charging) ? `${says(car.charging)}${/charging/i.test(st(car.charging).state) && ok(num(car.chargerPower)) ? " · " + fmt(num(car.chargerPower), 1) + " KW" : ""}` : null));
    if (car.location) POOL.push(() => R(`${label} locatie`, st(car.location) ? says(car.location) : null));
    if (car.chargeLimit) POOL.push(() => R(`${label} laadlimiet`, pct(car.chargeLimit)));
    if (car.energyAdded) POOL.push(() => R(`${label} laatst geladen`, ok(num(car.energyAdded)) ? `${fmt(num(car.energyAdded), 1)} KWH` : null));
  }
  for (const b of energy("bike")) {
    POOL.push(() => R(`${b.label} accu`, pct(b.entities.battery)));
    if (b.entities.distance) POOL.push(() => R(`${b.label} gereden`, ok(num(b.entities.distance)) ? `${fmt(num(b.entities.distance), 0)} ${unit(b.entities.distance).toUpperCase()}` : null));
  }
  if (cfg.bike) {
    const label = energy("bike")[0] ? energy("bike")[0].label : cfg.bike.label;
    if (cfg.bike.location) POOL.push(() => R(`${label} locatie`, st(cfg.bike.location) ? says(cfg.bike.location) : null));
    if (cfg.bike.lock) POOL.push(() => R(`${label} slot`, st(cfg.bike.lock) ? (isOn(cfg.bike.lock) ? "OP SLOT" : "OPEN") : null));
  }
  for (const b of energy("battery")) {
    const e = b.entities;
    POOL.push(() => R(`${b.label} laadstand`, pct(e.soc) && `${pct(e.soc)}${ok(num(e.power)) ? " · " + fmt(num(e.power), 0) + " W" : ""}`, num(e.soc) < 15 ? "warn" : "ok"));
    if (e.delta) POOL.push(() => R(`${b.label} celverschil`, ok(num(e.delta)) ? `${fmt(num(e.delta), 3)} ${unit(e.delta).toUpperCase()}` : null));
    if (e.cycles) POOL.push(() => R(`${b.label} cycli`, ok(num(e.cycles)) ? fmt(num(e.cycles), 0) : null));
    if (e.health) POOL.push(() => R(`${b.label} gezondheid`, pct(e.health)));
    if (e.temp) POOL.push(() => R(`${b.label} temperatuur`, ok(num(e.temp)) ? `${fmt(num(e.temp))}°` : null));
  }
  for (const m of energy("washer").concat(energy("dryer"))) {
    POOL.push(() => {
      const p = num(m.entities.power);
      return R(m.label, ok(p) && p > 5 ? `BEZIG · ${Math.round(p)} W` : st(m.entities.machine) ? says(m.entities.machine) : null);
    });
  }
  POOL.push(() => R("Lampen aan", `${lightsOn().length} / ${LIGHTS.length}`));
  POOL.push(() => {
    const on = lightsOn();
    if (!on.length) return null;
    const id = on[Math.floor(Math.random() * on.length)];
    const b = attr(id, "brightness");
    return R(String(attr(id, "friendly_name") || id.slice(6).replace(/_/g, " ")), ok(b) ? `AAN · ${Math.round((b / 255) * 100)}%` : "AAN");
  });
  for (const cv of cfg.covers || []) POOL.push(() => R(cv.label, st(cv.entities.cover) ? says(cv.entities.cover) : null, (st(cv.entities.cover) || {}).state === "open" ? "warn" : "ok"));
  if (cfg.vacuum) {
    const v = cfg.vacuum;
    POOL.push(() => R(v.label, st(v.vacuum) ? `${says(v.vacuum)}${ok(num(v.battery)) ? " · " + Math.round(num(v.battery)) + "%" : ""}` : null));
    if (v.area) POOL.push(() => R(`${v.label} laatste ronde`, ok(num(v.area)) ? `${fmt(num(v.area), 0)} M²` : null));
  }
  for (const m of cfg.media || []) {
    POOL.push(() => {
      const s = st(m.id);
      if (!s || s.state !== "playing") return null;
      const a = s.attributes || {};
      const what = [a.media_artist, a.media_title].filter(Boolean).map((x) => String(x).split(" •")[0]).join(" – ");
      return R(`Muziek ${m.label}`, what || "SPEELT");
    });
  }
  if (net.down) POOL.push(() => R("Internet", ok(mbit(net.down)) ? `↓${fmt(mbit(net.down), 0)} ↑${fmt(mbit(net.up), 0)} MBIT/S` : null, (st(net.wan) || {}).state === "off" ? "warn" : "ok"));
  if (net.dnsQueries) POOL.push(() => R("DNS-verzoeken", ok(num(net.dnsQueries)) ? fmt(num(net.dnsQueries), 0) : null));
  if (net.dnsBlocked) POOL.push(() => R("AdGuard geblokkeerd", ok(num(net.dnsBlocked)) ? `${fmt(num(net.dnsBlocked))}%` : null));
  if (net.dnsSpeed) POOL.push(() => R("DNS reactietijd", ok(num(net.dnsSpeed)) ? `${fmt(num(net.dnsSpeed), 1)} MS` : null));
  if (health.zigbee) POOL.push(() => R("Zigbee mesh", st(health.zigbee) ? (isOn(health.zigbee) ? "ONLINE" : "OFFLINE") : null, isOn(health.zigbee) ? "ok" : "warn"));
  if (health.permitJoin) POOL.push(() => (isOn(health.permitJoin) ? R("Zigbee koppelen", "OPEN", "warn") : null));
  const bootedAt = Date.now();
  POOL.push(() => {
    const m = Math.floor((Date.now() - bootedAt) / 60e3);
    return R("Paneel online", m < 60 ? `${m} MIN` : `${Math.floor(m / 60)} U ${m % 60} MIN`);
  });

  /* What changes is news: watched values, compared every frame against the last
   * one reported. A number must move past its step to count. */
  const WATCH = [];
  const watch = (id, label, show, step) => id && WATCH.push({ id, label, show, step });
  const deg = (id) => `${fmt(num(id))}°`;
  for (const s of cfg.sensors) watch(s.temp, s.label, deg, 0.2);
  for (const cv of cfg.covers || []) watch(cv.entities.cover, cv.label, says);
  if (cfg.vacuum) watch(cfg.vacuum.vacuum, cfg.vacuum.label, says);
  if (grid) watch(grid.entities.powerIn, "Stroomverbruik", (id) => `${fmt(kw(id), 2)} KW`, () => (/^w$/i.test(unit(grid.entities.powerIn)) ? 500 : 0.5));
  if (heat) {
    watch(heat.entities.status, "Warmtepomp", says);
    watch(heat.entities.compressor, "Compressor", says);
    watch(heat.entities.alarm, "Warmtepomp alarm", says);
  }
  if (car) watch(car.charging, (cfg.car.label || "Auto") + " laden", says);
  if (car && car.location) watch(car.location, (cfg.car.label || "Auto") + " locatie", says);
  if (cfg.bike && cfg.bike.lock) watch(cfg.bike.lock, "Fietsslot", (id) => (isOn(id) ? "OP SLOT" : "OPEN"));
  for (const m of energy("washer").concat(energy("dryer"))) watch(m.entities.machine, m.label, says);
  for (const m of cfg.media || []) watch(m.id, `Muziek ${m.label}`, says);
  if (net.wan) watch(net.wan, "Internet", (id) => ((st(id) || {}).state === "off" ? "OFFLINE" : "ONLINE"));
  if (health.zigbee) watch(health.zigbee, "Zigbee", (id) => (isOn(id) ? "ONLINE" : "OFFLINE"));
  if (health.permitJoin) watch(health.permitJoin, "Zigbee koppelen", (id) => (isOn(id) ? "OPEN" : "DICHT"));

  /* Everything the screensaver reads, so the app keeps those states up to date. */
  const TRACK = [...new Set((JSON.stringify({ hp, fr: fridge, e: cfg.energy, c: cfg.car, b: cfg.bike, n: cfg.network, h: cfg.health, a: cfg.air, s: cfg.sensors, v: cfg.vacuum, cv: cfg.covers, m: cfg.media, w: cfg.weather }).match(/\b(sensor|binary_sensor|switch|number|device_tracker|vacuum|cover|media_player|weather)\.[a-z0-9_]+/g) || []).concat(["sun.sun"], LIGHTS))];
  Panel.track(TRACK, () => {});

  /* ---- The feed --------------------------------------------------------------------------- */
  let feed = []; /* {time, label, value, cls, head} */
  let typing = null; /* the newest line while it is typed: {line, at} */
  const clock = () => new Date().toTimeString().slice(0, 8);
  let feedDirty = true; /* the list changed (or the column did): draw it on the next frame */
  function push(line, typed = true) {
    feedDirty = true;
    feed.push(line);
    if (feed.length > 120) feed = feed.slice(-120);
    typing = typed && !reduced ? { line, at: performance.now() } : null;
  }
  /* readings in a shuffled order, every one once before any comes again */
  let order = [], next = 0;
  function nextReading() {
    for (let tries = 0; tries < POOL.length; tries++) {
      if (next >= order.length) {
        order = POOL.map((_, i) => i);
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        next = 0;
      }
      const r = POOL[order[next++]]();
      if (r) return r;
    }
    return null;
  }
  let lightCount;
  function resetChanges() {
    for (const w of WATCH) {
      const s = st(w.id);
      w.state = s ? s.state : undefined;
      w.shown = s ? w.show(w.id) : "";
    }
    lightCount = lightsOn().length;
  }
  function checkChanges() {
    for (const w of WATCH) {
      const s = st(w.id);
      if (!s || s.state === w.state) continue;
      if (w.state === undefined) {
        w.state = s.state;
        w.shown = w.show(w.id);
        continue;
      }
      const a = parseFloat(s.state), b = parseFloat(w.state);
      const step = typeof w.step === "function" ? w.step() : w.step;
      if (step && !ok(b) && ok(a)) {
        /* it was unavailable when we started watching: from here on its number is the base */
        w.state = s.state;
        w.shown = w.show(w.id);
        continue;
      }
      if (step && (!ok(a) || !ok(b) || Math.abs(a - b) < step)) continue;
      const shown = w.show(w.id);
      if (shown !== w.shown) push({ time: clock(), label: "Δ " + w.label, value: `${w.shown} → ${shown}`, cls: "ev" });
      w.state = s.state;
      w.shown = shown;
    }
    const lc = lightsOn().length;
    if (lc !== lightCount) push({ time: clock(), label: "Δ Lampen aan", value: `${lightCount} → ${lc}`, cls: "ev" });
    lightCount = lc;
  }
  let cols = 40;
  function measure() {
    const probe = document.createElement("span");
    probe.style.visibility = "hidden";
    probe.textContent = "0".repeat(40);
    log.appendChild(probe);
    const w = probe.getBoundingClientRect().width / 40;
    probe.remove();
    cols = w > 0 ? Math.floor(log.clientWidth / w) - 1 : 40;
  }
  const CPS = 0.16; /* typed characters per ms */
  function renderFeed(now) {
    const lh = parseFloat(getComputedStyle(log).lineHeight) || 18;
    const room = Math.max(4, Math.floor(log.clientHeight / lh));
    const frag = document.createDocumentFragment();
    for (const line of feed.slice(-room)) {
      const el = document.createElement("div");
      if (line.head) {
        el.className = "hd";
        el.textContent = "> " + line.label.toUpperCase();
        frag.appendChild(el);
        continue;
      }
      const time = line.time ? line.time + " " : "";
      const lab = line.label.toUpperCase();
      let value = line.value.toUpperCase();
      const fit = cols - time.length - lab.length - 5;
      if (value.length > fit) value = value.slice(0, Math.max(4, fit - 1)) + "…";
      const lead = lab + " " + ".".repeat(Math.max(3, cols - time.length - lab.length - value.length - 2)) + " ";
      const live = typing && typing.line === line;
      let budget = live ? Math.floor((now - typing.at) * CPS) : Infinity;
      if (line.cls === "ev") el.className = "evl";
      if (time) {
        const t = document.createElement("span");
        t.className = "tm";
        t.textContent = time.slice(0, budget);
        el.appendChild(t);
        budget -= time.length;
      }
      if (budget > 0) el.appendChild(document.createTextNode(lead.slice(0, budget)));
      budget -= lead.length;
      if (budget > 0) {
        const v = document.createElement("span");
        v.className = line.cls;
        v.textContent = value.slice(0, budget);
        el.appendChild(v);
      }
      if (live && budget < value.length) {
        const c = document.createElement("span");
        c.className = "cur";
        c.textContent = " ";
        el.appendChild(c);
      }
      frag.appendChild(el);
    }
    log.replaceChildren(frag);
    /* the section heads' margins take room too: the oldest lines leave until it fits */
    while (log.childElementCount > 1 && log.scrollHeight > log.clientHeight + 1) log.firstElementChild.remove();
  }
  let intro = [], lastFeed = 0;
  const FEED_MS = 1600; /* between new readings */
  function feedStep(now) {
    if (intro.length) {
      /* the opening snapshot runs in fast, a line every 55 ms */
      if (now - lastFeed < 55) return;
      lastFeed = now;
      const [label, value, cls] = intro.shift();
      push(label === "#" ? { head: true, label: value } : { time: "", label, value, cls }, false);
      return;
    }
    checkChanges();
    if (now - lastFeed < FEED_MS) return;
    lastFeed = now;
    const r = nextReading();
    if (r) push({ time: clock(), label: r[0], value: r[1], cls: r[2] });
  }

  /* ---- Layout ------------------------------------------------------------------------------- */
  let W = 0, H = 0, dpr = 1, L = null;
  function layout() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const portrait = H > W * 1.05;
    const foot = H * 0.08 + 128;
    let x, y, w, h;
    if (portrait) {
      x = 16; w = W - 32; y = H * 0.065; h = H * 0.37;
    } else {
      x = W * 0.37; w = W * 0.61; y = H * 0.085; h = H - foot - y;
    }
    const gap = 10;
    const cw = (w - gap * 2) / 3;
    const rowsH = h * 0.6, rh = (rowsH - gap) / 2;
    L = {
      cells: [
        { x, y, w: cw, h: rh },
        { x, y: y + rh + gap, w: cw, h: rh },
      ],
      house: { x: x + cw + gap, y, w: cw * 2 + gap, h: rowsH },
      graph: { x, y: y + rowsH + gap + 6, w, h: h - rowsH - gap - 6 },
      reticle: { x: W / 2, y: H * 0.46, r: Math.min(W, H) * 0.44 },
    };
    const hb = L.house;
    Object.assign(houseBox.style, { left: hb.x + 6 + "px", top: hb.y + 20 + "px", width: hb.w - 12 + "px", height: hb.h - 40 + "px" });
    measure();
    feedDirty = true;
  }

  /* ---- Drawing --------------------------------------------------------------------------------- */
  const brackets = (x, y, w, h, len, a) => V.brackets(ctx, x, y, w, h, len, a);
  const text = (s, x, y, size, color, align) => V.text(ctx, s, x, y, size, color, align);
  /* ---- The two small frames: a widget each, another one every 6 s ------------------------ */
  /* Each widget is a real reading drawn its own way: a wireframe turning with
   * the value, a gauge, a donut, bars, a radar, a thermometer, a battery, a
   * compass, the sun's arc, an oscilloscope, a sparkline or a heat strip of
   * the last 24 hours. The two frames take turns, 3 s apart, and never show
   * the same one; a widget without data now is passed over. */
  const CELL_MS = 6000;
  const COLS = [RED, PALE, HOT, AMBER];
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const ease = (x) => 1 - Math.pow(1 - clamp01(x), 3);
  const anyOk = (...ids) => ids.some((id) => id && ok(num(id)));
  function hist2(id, scale) {
    const key = `${id}|${scale ? scale.toString() : ""}`;
    if (!derived.has(key)) derived.set(key, series(id).map(([t, v]) => [t, scale ? scale(v) : v]));
    return derived.get(key);
  }
  const glow = (on, c = RED, blur = 8) => {
    ctx.shadowColor = on ? rgba(c, 0.9) : "transparent";
    ctx.shadowBlur = on ? blur : 0;
  };
  const small = (s, x, y, a = 0.6, align = "left", size = 7.5, c = HOT) => text(s, x, y, size, rgba(c, a), align);

  function vMesh(a, mesh, rot, speed, dt) {
    for (let k = 0; k < 3; k++) rot[k] += [0.4, 1, 0.25][k] * speed * dt * (reduced ? 0.2 : 1);
    V.wire(ctx, mesh, a.x + a.w / 2, a.y + a.h / 2, Math.min(a.w, a.h) * 0.44, rot, true);
  }
  /* a 270° gauge with ticks, the value as a glowing arc and a needle */
  function vGauge(a, v, lo, hi, k, d = 0) {
    const r = Math.max(10, Math.min(a.w / 2 - 4, a.h / 1.72));
    const cx = a.x + a.w / 2, cy = a.y + r + (a.h - r * 1.71) / 2;
    const A0 = Math.PI * 0.75, SW = Math.PI * 1.5;
    ctx.lineWidth = 5;
    ctx.strokeStyle = rgba(RED, 0.16);
    ctx.beginPath();
    ctx.arc(cx, cy, r, A0, A0 + SW);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(HOT, 0.45);
    ctx.beginPath();
    for (let i = 0; i <= 30; i++) {
      const an = A0 + (SW * i) / 30, l = i % 5 ? 3 : 7;
      ctx.moveTo(cx + Math.cos(an) * (r - 6), cy + Math.sin(an) * (r - 6));
      ctx.lineTo(cx + Math.cos(an) * (r - 6 - l), cy + Math.sin(an) * (r - 6 - l));
    }
    ctx.stroke();
    const f = clamp01((v - lo) / (hi - lo)) * k;
    if (ok(v)) {
      glow(true);
      ctx.lineWidth = 5;
      ctx.strokeStyle = rgba(RED, 0.95);
      ctx.beginPath();
      ctx.arc(cx, cy, r, A0, A0 + SW * f);
      ctx.stroke();
      const an = A0 + SW * f;
      ctx.lineWidth = 2;
      ctx.strokeStyle = rgba(PALE, 0.95);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(an) * (r - 10), cy + Math.sin(an) * (r - 10));
      ctx.stroke();
      glow(false);
    }
    ctx.fillStyle = rgba(PALE, 0.95);
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();
    small(fmt(lo, d), cx - r * 0.72, cy + r * 0.72 + 3, 0.6, "center");
    small(fmt(hi, d), cx + r * 0.72, cy + r * 0.72 + 3, 0.6, "center");
  }
  /* the last 24 hours as a line over a glowing area, its peak and low marked */
  function vSpark(a, pts, k, d) {
    if (pts.length < 2) return;
    const span = 24 * 3600e3, t0 = Date.now() - span;
    const vs = pts.map((p) => p[1]);
    let lo = Math.min(...vs), hi = Math.max(...vs);
    if (hi - lo < 1e-9) hi = lo + 1;
    const X = (t) => a.x + clamp01((t - t0) / span) * a.w;
    const Y = (v) => a.y + 8 + (1 - (v - lo) / (hi - lo)) * (a.h - 12);
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(RED, 0.14);
    ctx.beginPath();
    for (let i = 0; i <= 3; i++) {
      ctx.moveTo(a.x, a.y + 8 + ((a.h - 12) * i) / 3);
      ctx.lineTo(a.x + a.w, a.y + 8 + ((a.h - 12) * i) / 3);
    }
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    ctx.rect(a.x, a.y - 4, a.w * k, a.h + 8);
    ctx.clip();
    ctx.beginPath();
    pts.forEach(([t, v], i) => (i ? ctx.lineTo(X(t), Y(v)) : ctx.moveTo(X(t), Y(v))));
    ctx.lineTo(a.x + a.w, Y(vs[vs.length - 1]));
    const line = new Path2D();
    pts.forEach(([t, v], i) => (i ? line.lineTo(X(t), Y(v)) : line.moveTo(X(t), Y(v))));
    line.lineTo(a.x + a.w, Y(vs[vs.length - 1]));
    ctx.lineTo(a.x + a.w, a.y + a.h);
    ctx.lineTo(X(pts[0][0]), a.y + a.h);
    const grad = ctx.createLinearGradient(0, a.y, 0, a.y + a.h);
    grad.addColorStop(0, rgba(RED, 0.4));
    grad.addColorStop(1, rgba(RED, 0));
    ctx.fillStyle = grad;
    ctx.fill();
    glow(true);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = rgba(PALE, 0.95);
    ctx.stroke(line);
    glow(false);
    ctx.restore();
    if (k >= 1) {
      const iMax = vs.indexOf(Math.max(...vs)), iMin = vs.indexOf(Math.min(...vs));
      for (const [i, up] of [[iMax, true], [iMin, false]]) {
        const px = X(pts[i][0]), py = Y(vs[i]);
        ctx.fillStyle = rgba(up ? PALE : HOT, 0.95);
        ctx.beginPath();
        ctx.arc(px, py, 2.2, 0, Math.PI * 2);
        ctx.fill();
        small(fmt(vs[i], d), Math.min(a.x + a.w - 2, Math.max(a.x + 2, px)), up ? py - 4 : py + 9, 0.8, px < a.x + 20 ? "left" : px > a.x + a.w - 20 ? "right" : "center");
      }
    }
  }
  /* bars side by side, the highest pale, values above and names under */
  function vBars(a, items, lo, hi, k, d) {
    const n = items.length, gap = 5, bw = (a.w - gap * (n - 1)) / n;
    const max = Math.max(...items.map((it) => (ok(it.v) ? it.v : -Infinity)));
    items.forEach((it, i) => {
      const x = a.x + i * (bw + gap), base = a.y + a.h - 10;
      ctx.fillStyle = rgba(RED, 0.08);
      ctx.fillRect(x, a.y + 10, bw, base - a.y - 10);
      if (!ok(it.v)) return;
      const bh = clamp01((it.v - lo) / (hi - lo)) * (base - a.y - 12) * k;
      const top = it.v === max ? PALE : RED;
      const grad = ctx.createLinearGradient(0, base - bh, 0, base);
      grad.addColorStop(0, rgba(top, 0.95));
      grad.addColorStop(1, rgba(RED, 0.25));
      ctx.fillStyle = grad;
      glow(it.v === max, RED, 10);
      ctx.fillRect(x, base - bh, bw, bh);
      glow(false);
      if (bw >= 18) small(fmt(it.v, d), x + bw / 2, base - bh - 3, 0.9, "center", bw > 34 ? 8 : 7, PALE);
      small(it.l.slice(0, Math.max(2, Math.floor(bw / 5.2))), x + bw / 2, a.y + a.h, 0.6, "center", 7);
    });
  }
  /* a ring in parts, the total in the middle, the parts named beside it */
  function vDonut(a, parts, k, center) {
    const legend = a.w > a.h * 1.7;
    const r = Math.min(legend ? a.w * 0.3 : a.w / 2, a.h / 2) - 2;
    const cx = legend ? a.x + r + 4 : a.x + a.w / 2, cy = a.y + a.h / 2, lw = Math.max(5, r * 0.26);
    ctx.lineWidth = lw;
    ctx.strokeStyle = rgba(RED, 0.14);
    ctx.beginPath();
    ctx.arc(cx, cy, r - lw / 2, 0, Math.PI * 2);
    ctx.stroke();
    const total = parts.reduce((s, p) => s + (ok(p.v) && p.v > 0 ? p.v : 0), 0);
    let an = -Math.PI / 2;
    if (total > 0)
      parts.forEach((p) => {
        if (!(p.v > 0)) return;
        const sw = (p.v / total) * Math.PI * 2 * k;
        glow(true, p.c, 6);
        ctx.strokeStyle = rgba(p.c, 0.92);
        ctx.beginPath();
        ctx.arc(cx, cy, r - lw / 2, an + 0.03, an + Math.max(0.04, sw - 0.03));
        ctx.stroke();
        glow(false);
        an += sw;
      });
    text(center, cx, cy + r * 0.12, Math.max(8, r * 0.34), rgba(PALE, 0.95), "center");
    if (legend)
      parts.forEach((p, i) => {
        const y = a.y + 10 + i * Math.min(14, (a.h - 6) / parts.length);
        ctx.fillStyle = rgba(p.c, 0.95);
        ctx.fillRect(cx + r + 12, y - 6, 7, 3);
        small(p.l, cx + r + 23, y - 2, 0.75);
        small(p.t || "", a.x + a.w, y - 2, 0.95, "right", 7.5, PALE);
      });
  }
  /* a radar: one spoke per item, the values as a glowing polygon */
  function vRadar(a, items, lo, hi, k) {
    const n = items.length, cx = a.x + a.w / 2, cy = a.y + a.h / 2 + 2, r = Math.min(a.w, a.h) / 2 - 9;
    const P = (i, f) => [cx + Math.cos(-Math.PI / 2 + (i / n) * Math.PI * 2) * r * f, cy + Math.sin(-Math.PI / 2 + (i / n) * Math.PI * 2) * r * f];
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(RED, 0.25);
    for (const f of [0.33, 0.66, 1]) {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) ctx[i ? "lineTo" : "moveTo"](...P(i % n, f));
      ctx.stroke();
    }
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      ctx.moveTo(cx, cy);
      ctx.lineTo(...P(i, 1));
    }
    ctx.stroke();
    ctx.beginPath();
    items.forEach((it, i) => ctx[i ? "lineTo" : "moveTo"](...P(i, clamp01((ok(it.v) ? it.v - lo : 0) / (hi - lo)) * k)));
    ctx.closePath();
    ctx.fillStyle = rgba(RED, 0.3);
    ctx.fill();
    glow(true);
    ctx.strokeStyle = rgba(PALE, 0.95);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    glow(false);
    items.forEach((it, i) => {
      const [x, y] = P(i, 1.2);
      small(it.l.slice(0, 3), x, y + 3, 0.6, "center", 7);
    });
  }
  /* a thermometer with a scale, and the 24 hours' range beside it */
  function vThermo(a, v, lo, hi, k, d, id) {
    const x = a.x + a.w * 0.28, top = a.y + 4, bot = a.y + a.h - 12, br = 8;
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = rgba(HOT, 0.7);
    ctx.beginPath();
    ctx.moveTo(x - 4, bot - 4);
    ctx.lineTo(x - 4, top + 4);
    ctx.arc(x, top + 4, 4, Math.PI, 0);
    ctx.lineTo(x + 4, bot - 4);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, bot + 2, br, 0, Math.PI * 2);
    ctx.stroke();
    const f = clamp01((v - lo) / (hi - lo)) * k;
    glow(true, RED, 12);
    ctx.fillStyle = rgba(RED, 0.95);
    ctx.beginPath();
    ctx.arc(x, bot + 2, br - 2.5, 0, Math.PI * 2);
    ctx.fill();
    const fh = (bot - top - 6) * f;
    ctx.fillRect(x - 2, bot - fh, 4, fh);
    glow(false);
    for (let i = 0; i <= 4; i++) {
      const y = bot - ((bot - top - 6) * i) / 4;
      ctx.fillStyle = rgba(HOT, 0.5);
      ctx.fillRect(x + 7, y, i % 2 ? 3 : 6, 1);
      if (i % 2 === 0) small(fmt(lo + ((hi - lo) * i) / 4, 0) + "°", x + 16, y + 3, 0.55, "left", 7);
    }
    const [mn, mx] = range(id);
    if (ok(mn) && a.w > 110) {
      const rx = a.x + a.w;
      small("24U MAX", rx, a.y + 12, 0.55, "right", 7);
      small(fmt(mx, d) + "°", rx, a.y + 24, 0.95, "right", 10, PALE);
      small("24U MIN", rx, a.y + 40, 0.55, "right", 7);
      small(fmt(mn, d) + "°", rx, a.y + 52, 0.95, "right", 10, PALE);
      const tr = trend(id, d);
      if (tr) small(tr, rx, a.y + 68, 0.8, "right", 7.5);
    }
  }
  /* a battery of ten cells */
  function vBattery(a, pct, k, note) {
    const bw = Math.min(a.w - 14, 170), bh = Math.min(a.h * 0.5, 44);
    const x = a.x + (a.w - bw - 6) / 2, y = a.y + (a.h - bh) / 2 - 6;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(HOT, 0.8);
    ctx.strokeRect(x, y, bw, bh);
    ctx.fillStyle = rgba(HOT, 0.8);
    ctx.fillRect(x + bw, y + bh * 0.3, 5, bh * 0.4);
    const lit = (clamp01(pct / 100) * 10) * k, low = pct < 20;
    for (let i = 0; i < 10; i++) {
      const f = clamp01(lit - i);
      const cw = (bw - 6 - 9 * 2) / 10;
      ctx.fillStyle = rgba(low ? AMBER : i >= 8 ? PALE : RED, 0.12 + 0.83 * f);
      glow(f > 0.5, low ? AMBER : RED, 6);
      ctx.fillRect(x + 3 + i * (cw + 2), y + 3, cw, bh - 6);
    }
    glow(false);
    if (note) small(note, a.x + a.w / 2, y + bh + 14, 0.8, "center", 8);
  }
  /* a wind compass: where the wind comes from, a sweep turning */
  function vCompass(a, bearing, now) {
    const cx = a.x + a.w / 2, cy = a.y + a.h / 2, r = Math.min(a.w, a.h) / 2 - 8;
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(RED, 0.35);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    for (let i = 0; i < 36; i++) {
      const an = (i / 36) * Math.PI * 2, l = i % 9 ? 3 : 7;
      ctx.moveTo(cx + Math.cos(an) * r, cy + Math.sin(an) * r);
      ctx.lineTo(cx + Math.cos(an) * (r - l), cy + Math.sin(an) * (r - l));
    }
    ctx.stroke();
    ["N", "O", "Z", "W"].forEach((l, i) => {
      const an = -Math.PI / 2 + (i * Math.PI) / 2;
      small(l, cx + Math.cos(an) * (r + 1) * 0.72, cy + Math.sin(an) * (r + 1) * 0.72 + 3, 0.7, "center", 8, PALE);
    });
    if (!reduced) {
      const sw = (now / 1600) % (Math.PI * 2);
      const g = ctx.createConicGradient ? ctx.createConicGradient(sw - 0.6, cx, cy) : null;
      if (g) {
        g.addColorStop(0, rgba(RED, 0));
        g.addColorStop(0.1, rgba(RED, 0.25));
        g.addColorStop(0.1001, rgba(RED, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const an = ((bearing - 90) * Math.PI) / 180; /* the wind's source */
    const fx = cx + Math.cos(an) * r * 0.8, fy = cy + Math.sin(an) * r * 0.8;
    const tx = cx - Math.cos(an) * r * 0.8, ty = cy - Math.sin(an) * r * 0.8;
    glow(true);
    ctx.strokeStyle = rgba(PALE, 0.95);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.fillStyle = rgba(PALE, 0.95);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx + Math.cos(an + 0.45) * 9, ty + Math.sin(an + 0.45) * 9);
    ctx.lineTo(tx + Math.cos(an - 0.45) * 9, ty + Math.sin(an - 0.45) * 9);
    ctx.fill();
    glow(false);
  }
  /* the sun's path over the horizon, where it is now, and when it rises and sets */
  function vSun(a, now) {
    const sun = st("sun.sun"), at = (sun && sun.attributes) || {};
    const up = sun && sun.state === "above_horizon";
    const ns = new Date(at.next_setting).getTime(), nr = new Date(at.next_rising).getTime();
    const hy = a.y + a.h * 0.7, cx = a.x + a.w / 2, r = Math.min(a.w / 2 - 8, a.h * 0.64);
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(RED, 0.6);
    ctx.beginPath();
    ctx.moveTo(a.x, hy);
    ctx.lineTo(a.x + a.w, hy);
    ctx.stroke();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = rgba(HOT, 0.45);
    ctx.beginPath();
    ctx.arc(cx, hy, r, Math.PI, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    let x, y;
    const t = Date.now();
    if (up) {
      const rise = nr - 24 * 3600e3, f = clamp01((t - rise) / (ns - rise));
      x = cx - Math.cos(f * Math.PI) * r;
      y = hy - Math.sin(f * Math.PI) * r;
    } else {
      const set = ns - 24 * 3600e3, f = clamp01((t - set) / (nr - set));
      x = cx + Math.cos(f * Math.PI) * r;
      y = hy + Math.sin(f * Math.PI) * (a.y + a.h - hy - 4);
    }
    if (ok(x) && ok(y)) {
      glow(true, up ? PALE : RED, 14);
      ctx.fillStyle = rgba(up ? PALE : RED, up ? 1 : 0.7);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      glow(false);
      if (!reduced && up) {
        ctx.strokeStyle = rgba(PALE, 0.6);
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const an = (i / 8) * Math.PI * 2 + now / 3000;
          ctx.moveTo(x + Math.cos(an) * 8, y + Math.sin(an) * 8);
          ctx.lineTo(x + Math.cos(an) * 11, y + Math.sin(an) * 11);
        }
        ctx.stroke();
      }
    }
    const hmOf = (ms) => (ok(ms) ? new Date(ms).toTimeString().slice(0, 5) : "--:--");
    small("↑ " + hmOf(nr), a.x, hy + 11, 0.75, "left", 8);
    small("↓ " + hmOf(ns), a.x + a.w, hy + 11, 0.75, "right", 8);
  }
  /* three phases as running sine waves, each as tall as its current */
  function vScope(a, amps, now) {
    const max = Math.max(1, ...amps.filter(ok));
    const mid = a.y + a.h / 2;
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(RED, 0.25);
    ctx.beginPath();
    ctx.moveTo(a.x, mid);
    ctx.lineTo(a.x + a.w, mid);
    for (let i = 1; i < 8; i++) {
      ctx.moveTo(a.x + (a.w * i) / 8, a.y);
      ctx.lineTo(a.x + (a.w * i) / 8, a.y + a.h);
    }
    ctx.stroke();
    amps.forEach((amp, p) => {
      const h = (Math.max(0.04, (ok(amp) ? amp : 0) / max)) * a.h * 0.42;
      ctx.beginPath();
      for (let x = 0; x <= a.w; x += 2) {
        const y = mid + Math.sin((x / a.w) * Math.PI * 6 - (reduced ? 0 : now / 260) + (p * Math.PI * 2) / 3) * h;
        x ? ctx.lineTo(a.x + x, y) : ctx.moveTo(a.x + x, y);
      }
      glow(true, COLS[p], 6);
      ctx.strokeStyle = rgba(COLS[p], 0.9);
      ctx.lineWidth = 1.3;
      ctx.stroke();
      glow(false);
      small(`L${p + 1} ${fmt(amp, 1)}A`, a.x + 2 + p * (a.w / 3), a.y + 7, 0.85, "left", 7, COLS[p]);
    });
  }
  /* the last 24 hours in hourly cells, warmer the higher, with the curve over them */
  function vHeat(a, pts, k) {
    const span = 24 * 3600e3, t0 = Date.now() - span;
    const hours = Array.from({ length: 24 }, (_, i) => {
      const s = t0 + i * 3600e3, vs = pts.filter(([t]) => t >= s && t < s + 3600e3).map((p) => p[1]);
      return vs.length ? vs.reduce((x, y) => x + y, 0) / vs.length : NaN;
    });
    const real = hours.filter(ok);
    const lo = Math.min(...real), hi = Math.max(...real) === lo ? lo + 1 : Math.max(...real);
    const cw = a.w / 24, ch = a.h - 12;
    const shown = Math.floor(24 * k);
    hours.forEach((v, i) => {
      if (i > shown) return;
      const f = ok(v) ? (v - lo) / (hi - lo) : 0;
      ctx.fillStyle = f > 0.85 ? rgba(PALE, 0.85) : rgba(RED, 0.08 + 0.8 * f);
      ctx.fillRect(a.x + i * cw, a.y, cw - 1.5, ch);
      const hr = new Date(t0 + i * 3600e3).getHours();
      if (hr % 6 === 0) small(String(hr).padStart(2, "0"), a.x + i * cw, a.y + a.h, 0.55, "left", 7);
    });
    ctx.beginPath();
    hours.forEach((v, i) => {
      if (i > shown || !ok(v)) return;
      const x = a.x + i * cw + cw / 2, y = a.y + 3 + (1 - (v - lo) / (hi - lo)) * (ch - 6);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = rgba(PALE, 0.9);
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  /* ---- The widgets ----------------------------------------------------------------- */
  const WIDGETS = [];
  const widget = (o) => WIDGETS.push(Object.assign({ ids: [], sub: () => "" }, o));
  const M = V.meshes;
  const spin = () => [Math.random() * 3, Math.random() * 3, Math.random() * 3];
  const avg = (vs) => (vs.length ? vs.reduce((x, y) => x + y, 0) / vs.length : NaN);
  if (grid) {
    const e = grid.entities, r = spin(), ico = M.icosahedron();
    const ph = (pre) => [1, 2, 3].map((k) => e[pre + k]);
    widget({ name: "GRID", has: () => ok(netKw()), big: () => `${fmt(Math.abs(netKw()), 2)} KW`, sub: () => (netKw() >= 0 ? "IMPORT" : "EXPORT"),
      draw: (a, k, now, dt) => vMesh(a, ico, r, 0.25 + Math.min(3, Math.abs(netKw()) || 0) * 0.6, dt) });
    widget({ name: "FASEVERDELING", has: () => anyOk(...ph("in")), big: () => `${fmt(ph("in").reduce((s, id) => s + (kw(id) || 0), 0), 2)} KW`,
      sub: () => { const v = ph("in").map((id) => kw(id) || 0); return `PIEK L${v.indexOf(Math.max(...v)) + 1}`; },
      draw: (a, k) => vDonut(a, ph("in").map((id, i) => ({ v: kw(id), c: COLS[i], l: "L" + (i + 1), t: fmt(kw(id), 2) })), k, "3F") });
    widget({ name: "NETSPANNING", has: () => anyOk(...ph("voltage")), big: () => `${fmt(avg(ph("voltage").map(num).filter(ok)), 1)} V`,
      sub: () => { const v = ph("voltage").map(num).filter(ok); return `Δ ${fmt(Math.max(...v) - Math.min(...v), 1)} V`; },
      draw: (a, k) => vBars(a, ph("voltage").map((id, i) => ({ l: "L" + (i + 1), v: num(id) })), 215, 250, k, 1) });
    widget({ name: "FASESTROOM", has: () => anyOk(...ph("current")), big: () => `${fmt(Math.max(...ph("current").map(num).filter(ok)), 1)} A`, sub: () => "OSCILLOSCOOP",
      draw: (a, k, now) => vScope(a, ph("current").map(num), now) });
    widget({ name: "VERBRUIK 24U", ids: [e.powerIn], has: () => series(e.powerIn).length > 1, big: () => `${fmt(kw(e.powerIn), 2)} KW`,
      sub: () => `PIEK ${fmt(range(e.powerIn).map(wToKw(e.powerIn))[1], 2)}`, draw: (a, k) => vSpark(a, hist2(e.powerIn, wToKw(e.powerIn)), k, 2) });
    widget({ name: "UURPROFIEL", ids: [e.powerIn], has: () => series(e.powerIn).length > 1,
      big: () => `${fmt(avg(hist2(e.powerIn, wToKw(e.powerIn)).map((p) => p[1])) * 24, 1)} KWH`, sub: () => "~24 UUR",
      draw: (a, k) => vHeat(a, hist2(e.powerIn, wToKw(e.powerIn)), k) });
  }
  if (outdoor) {
    const r = spin(), sph = M.sphere();
    widget({ name: "ATMOSPHERE", has: () => anyOk(outdoor.temp), big: () => `${fmt(num(outdoor.temp))}°C`, sub: () => (ok(num(outdoor.humidity)) ? `VOCHT ${Math.round(num(outdoor.humidity))}%` : ""),
      draw: (a, k, now, dt) => vMesh(a, sph, r, 0.5, dt) });
    widget({ name: "BUITEN 24U", ids: [outdoor.temp], has: () => series(outdoor.temp).length > 1, big: () => `${fmt(num(outdoor.temp))}°`,
      sub: () => { const [lo, hi] = range(outdoor.temp); return `${fmt(lo)}–${fmt(hi)}°`; }, draw: (a, k) => vSpark(a, hist2(outdoor.temp), k, 1) });
  }
  if (indoors.length > 1) {
    widget({ name: "KAMERTEMPERATUUR", has: () => anyOk(...indoors.map((s) => s.temp)), big: () => `Ø ${fmt(avg(indoors.map((s) => num(s.temp)).filter(ok)))}°`,
      sub: () => { const t = indoors.filter((s) => ok(num(s.temp))).sort((x, y) => num(y.temp) - num(x.temp)); return t.length ? `WARMST ${t[0].abbr || t[0].label}` : ""; },
      draw: (a, k) => vBars(a, indoors.map((s) => ({ l: s.abbr || s.label, v: num(s.temp) })), 14, 28, k, 1) });
    if (indoors.filter((s) => s.humidity).length >= 3)
      widget({ name: "VOCHTRADAR", has: () => anyOk(...indoors.map((s) => s.humidity)), big: () => `Ø ${Math.round(avg(indoors.map((s) => num(s.humidity)).filter(ok)))}%`, sub: () => "RELATIEF",
        draw: (a, k) => vRadar(a, indoors.filter((s) => s.humidity).map((s) => ({ l: s.abbr || s.label, v: num(s.humidity) })), 20, 90, k) });
  }
  if (air) {
    widget({ name: "CO2", ids: [air.co2], has: () => anyOk(air.co2), big: () => `${Math.round(num(air.co2))} PPM`, sub: () => trend(air.co2, 0, "") || (air.short || "").toUpperCase(),
      draw: (a, k) => vGauge(a, num(air.co2), 400, 2000, k) });
    if (air.pm25) widget({ name: "FIJNSTOF", has: () => anyOk(air.pm25), big: () => `${fmt(num(air.pm25), 0)} µG`, sub: () => "PM2.5", draw: (a, k) => vGauge(a, num(air.pm25), 0, 50, k) });
  }
  if (hp.hotWaterTop) widget({ name: "WARM WATER", ids: [hp.hotWaterTop], has: () => anyOk(hp.hotWaterTop), big: () => `${fmt(num(hp.hotWaterTop))}°C`, sub: () => "BT7 BOVEN",
    draw: (a, k) => vThermo(a, num(hp.hotWaterTop), 10, 65, k, 1, hp.hotWaterTop) });
  if (hp.freq) widget({ name: "COMPRESSOR", has: () => anyOk(hp.freq), big: () => `${fmt(num(hp.freq), 0)} HZ`, sub: () => says(hp.compressor),
    draw: (a, k) => vGauge(a, num(hp.freq), 0, ok(num(hp.freqMax)) ? num(hp.freqMax) : 120, k) });
  if (hp.supply) widget({ name: "AANVOER / RETOUR", has: () => anyOk(hp.supply, hp.ret), big: () => `ΔT ${fmt(num(hp.supply) - num(hp.ret))}°`, sub: () => "CV-CIRCUIT",
    draw: (a, k) => vBars(a, [{ l: "BT2", v: num(hp.supply) }, { l: "BT3", v: num(hp.ret) }, { l: "BER", v: num(hp.calcSupply) }].filter((x) => ok(x.v)), 10, 50, k, 1) });
  if (hp.brineIn) widget({ name: "BRONCIRCUIT", has: () => anyOk(hp.brineIn, hp.brineOut), big: () => `ΔT ${fmt(num(hp.brineIn) - num(hp.brineOut))}°`, sub: () => "BODEM",
    draw: (a, k) => vBars(a, [{ l: "IN", v: num(hp.brineIn) }, { l: "UIT", v: num(hp.brineOut) }], -5, 25, k, 1) });
  if (hp.degreeMinutes) widget({ name: "GRAADMINUTEN", has: () => anyOk(hp.degreeMinutes), big: () => `${fmt(num(hp.degreeMinutes), 0)} GM`, sub: () => (num(hp.degreeMinutes) < -60 ? "WARMTEVRAAG" : "IN BALANS"),
    draw: (a, k) => vGauge(a, num(hp.degreeMinutes), -700, 100, k) });
  if (hp.discharge) widget({ name: "KOUDEMIDDEL", has: () => anyOk(hp.discharge, hp.suction), big: () => `${fmt(num(hp.discharge))}°`, sub: () => "PERSGAS BT14",
    draw: (a, k) => vBars(a, [["PERS", hp.discharge], ["COND", hp.condenser], ["VLOEI", hp.liquid], ["ZUIG", hp.suction]].filter(([, id]) => id).map(([l, id]) => ({ l, v: num(id) })), 0, 90, k, 0) });
  if (hp.pumpHeat) widget({ name: "POMPEN", has: () => anyOk(hp.pumpHeat, hp.pumpBrine), big: () => `${fmt(num(hp.pumpHeat), 0)}%`, sub: () => "CV-POMP GP1",
    draw: (a, k) => vDonut(a, [{ v: num(hp.pumpHeat), c: RED, l: "GP1", t: fmt(num(hp.pumpHeat), 0) + "%" }, { v: num(hp.pumpBrine), c: PALE, l: "GP2", t: fmt(num(hp.pumpBrine), 0) + "%" }], k, "GP") });
  if (car) {
    widget({ name: (cfg.car.label || "AUTO").toUpperCase(), has: () => anyOk(car.battery), big: () => `${Math.round(num(car.battery))}%`, sub: () => says(car.charging),
      draw: (a, k) => vBattery(a, num(car.battery), k, ok(num(car.range)) ? `${Math.round(num(car.range))} KM BEREIK` : "") });
    if (car.chargerPower) widget({ name: "LAADVERMOGEN", has: () => /charging/i.test((st(car.charging) || {}).state || ""), big: () => `${fmt(num(car.chargerPower), 1)} KW`, sub: () => "LAADT",
      draw: (a, k) => vGauge(a, num(car.chargerPower), 0, 11, k, 0) });
  }
  if (bike) widget({ name: bike.label.toUpperCase(), has: () => anyOk(bike.entities.battery), big: () => `${Math.round(num(bike.entities.battery))}%`, sub: () => (cfg.bike && cfg.bike.lock ? (isOn(cfg.bike.lock) ? "OP SLOT" : "OPEN") : ""),
    draw: (a, k) => vBattery(a, num(bike.entities.battery), k, ok(num(bike.entities.distance)) ? `${fmt(num(bike.entities.distance), 0)} KM GEREDEN` : "") });
  for (const b of batteries) {
    const cells = [1, 2, 3, 4].map((k) => b.entities["cell" + k]).filter(Boolean);
    widget({ name: `${b.label.toUpperCase()} CELLEN`, has: () => anyOk(...cells), big: () => (ok(num(b.entities.delta)) ? `Δ ${fmt(num(b.entities.delta), 0)} ${unit(b.entities.delta).toUpperCase()}` : "--"), sub: () => (ok(num(b.entities.soc)) ? `SOC ${Math.round(num(b.entities.soc))}%` : ""),
      draw: (a, k) => { const v = cells.map(num).filter(ok); vBars(a, cells.map((id, i) => ({ l: "C" + (i + 1), v: num(id) })), Math.min(...v) - 0.02, Math.max(...v) + 0.01, k, 3); } });
  }
  if (batteries.length) widget({ name: "THUISACCU'S", has: () => anyOk(...batteries.map((b) => b.entities.soc)), big: () => `Ø ${Math.round(avg(batteries.map((b) => num(b.entities.soc)).filter(ok)))}%`, sub: () => "LAADSTAND",
    draw: (a, k) => vDonut(a, batteries.map((b, i) => ({ v: num(b.entities.soc), c: COLS[i], l: b.label.toUpperCase(), t: fmt(num(b.entities.soc), 0) + "%" })), k, "SOC") });
  if (net.down) widget({ name: "INTERNET", ids: [net.down], has: () => series(net.down).length > 1, big: () => `${fmt(mbit(net.down), 1)} MBIT`, sub: () => `UP ${fmt(mbit(net.up), 1)}`,
    draw: (a, k) => vSpark(a, hist2(net.down, asMbit(net.down)), k, 1) });
  if (net.dnsBlocked) widget({ name: "ADGUARD", has: () => anyOk(net.dnsBlocked), big: () => `${fmt(num(net.dnsBlocked))}%`, sub: () => (ok(num(net.dnsQueries)) ? `${fmt(num(net.dnsQueries), 0)} VERZOEKEN` : "GEBLOKKEERD"),
    draw: (a, k) => vDonut(a, [{ v: num(net.dnsBlocked), c: PALE, l: "BLOK", t: fmt(num(net.dnsBlocked), 0) + "%" }, { v: 100 - num(net.dnsBlocked), c: RED, l: "DOOR", t: fmt(100 - num(net.dnsBlocked), 0) + "%" }], k, "DNS") });
  if (net.dnsSpeed) widget({ name: "DNS-REACTIE", ids: [net.dnsSpeed], has: () => series(net.dnsSpeed).length > 1, big: () => `${fmt(num(net.dnsSpeed), 2)} MS`, sub: () => "24 UUR",
    draw: (a, k) => vSpark(a, hist2(net.dnsSpeed), k, 1) });
  if (cfg.weather) {
    const w = cfg.weather;
    widget({ name: "WIND", has: () => ok(attr(w, "wind_speed")), big: () => `${fmt(attr(w, "wind_speed"), 0)} ${String(attr(w, "wind_speed_unit") || "km/h").toUpperCase()}`,
      sub: () => { const b = attr(w, "wind_bearing"); return ok(b) ? ["N", "NO", "O", "ZO", "Z", "ZW", "W", "NW"][Math.round(b / 45) % 8] + ` · ${Math.round(b)}°` : ""; },
      draw: (a, k, now) => vCompass(a, attr(w, "wind_bearing") || 0, now) });
    widget({ name: "LUCHTDRUK", has: () => ok(attr(w, "pressure")), big: () => `${fmt(attr(w, "pressure"), 0)} HPA`, sub: () => says(w), draw: (a, k) => vGauge(a, attr(w, "pressure"), 970, 1050, k) });
  }
  widget({ name: "ZON", has: () => !!st("sun.sun"), big: () => `${fmt(attr("sun.sun", "elevation"), 1)}°`, sub: () => ((st("sun.sun") || {}).state === "above_horizon" ? "BOVEN HORIZON" : "ONDER HORIZON"),
    draw: (a, k, now) => vSun(a, now) });
  if (LIGHTS.length) widget({ name: "VERLICHTING", has: () => true, big: () => `${lightsOn().length} AAN`, sub: () => `VAN ${LIGHTS.length}`,
    draw: (a, k) => vDonut(a, [{ v: lightsOn().length, c: PALE, l: "AAN", t: String(lightsOn().length) }, { v: LIGHTS.length - lightsOn().length, c: RED, l: "UIT", t: String(LIGHTS.length - lightsOn().length) }], k, `${Math.round((lightsOn().length / LIGHTS.length) * 100)}%`) });
  if (fridge.temp) widget({ name: "KOELKAST", ids: [fridge.temp], has: () => anyOk(fridge.temp), big: () => `${fmt(num(fridge.temp))}°C`, sub: () => "KOELING",
    draw: (a, k) => vThermo(a, num(fridge.temp), 0, 12, k, 1, fridge.temp) });
  if (cfg.vacuum) {
    const r = spin(), tor = M.torus();
    widget({ name: "STOFZUIGER", has: () => !!st(cfg.vacuum.vacuum), big: () => (ok(num(cfg.vacuum.battery)) ? `${Math.round(num(cfg.vacuum.battery))}%` : "--"), sub: () => says(cfg.vacuum.vacuum),
      draw: (a, k, now, dt) => vMesh(a, tor, r, (st(cfg.vacuum.vacuum) || {}).state === "cleaning" ? 2 : 0.4, dt) });
  }
  if ((cfg.media || []).length) {
    const r = spin(), hel = M.helix();
    const playing = () => cfg.media.find((m) => (st(m.id) || {}).state === "playing");
    widget({ name: "AUDIO", has: () => !!playing(), big: () => String(attr(playing().id, "media_artist") || "SPEELT").split(" •")[0].toUpperCase().slice(0, 14),
      sub: () => playing().label.toUpperCase(), draw: (a, k, now, dt) => vMesh(a, hel, r, 1.4, dt) });
  }
  if (health.zigbee) {
    const r = spin(), star = M.octaStar();
    widget({ name: "ZIGBEE MESH", has: () => !!st(health.zigbee), big: () => (isOn(health.zigbee) ? "ONLINE" : "OFFLINE"), sub: () => (isOn(health.permitJoin) ? "KOPPELEN OPEN" : "BEVEILIGD"),
      draw: (a, k, now, dt) => vMesh(a, star, r, isOn(health.zigbee) ? 0.7 : 0.1, dt) });
  }
  for (const cv of cfg.covers || []) {
    const r = spin(), cubes = M.nestedCubes();
    widget({ name: cv.label.toUpperCase(), has: () => !!st(cv.entities.cover), big: () => says(cv.entities.cover), sub: () => ((st(cv.entities.cover) || {}).state === "closed" ? "PERIMETER SECURE" : "LET OP"),
      draw: (a, k, now, dt) => vMesh(a, cubes, r, /ing$/.test((st(cv.entities.cover) || {}).state || "") ? 2.5 : 0.35, dt) });
  }
  const HIST_IDS = [...new Set(DATASETS.flatMap((d) => d.series.map((s) => s.id)).concat(WIDGETS.flatMap((w) => w.ids), air ? [air.co2] : [], outdoor ? [outdoor.temp] : [], indoors.map((s) => s.temp)))];

  let CELLS = [{ first: true }, { first: true }];
  let wOrder = [], wNext = 0;
  const can = (w) => {
    try {
      return !!w.has();
    } catch (e) {
      return false;
    }
  };
  function pickWidget(i, now) {
    const other = CELLS[1 - i].w, dur = CELLS[i].first && i === 1 ? CELL_MS / 2 : CELL_MS;
    for (let tries = 0; tries < WIDGETS.length * 2; tries++) {
      if (wNext >= wOrder.length) {
        wOrder = WIDGETS.map((_, j) => j);
        for (let j = wOrder.length - 1; j > 0; j--) {
          const x = Math.floor(Math.random() * (j + 1));
          [wOrder[j], wOrder[x]] = [wOrder[x], wOrder[j]];
        }
        wNext = 0;
      }
      const w = WIDGETS[wOrder[wNext++]];
      if (w !== other && can(w)) {
        CELLS[i] = { w, at: now, dur };
        return;
      }
    }
    CELLS[i] = { w: null, at: now, dur };
  }
  function drawCell(i, now, dt) {
    const c = L.cells[i];
    if (!CELLS[i].w || now - CELLS[i].at > CELLS[i].dur) pickWidget(i, now);
    const cs = CELLS[i], w = cs.w;
    ctx.fillStyle = rgba(RED, 0.05);
    ctx.fillRect(c.x, c.y, c.w, c.h);
    brackets(c.x, c.y, c.w, c.h, 10, 0.7);
    const tiny = c.w < 150;
    const age = now - cs.at, k = reduced ? 1 : ease(age / 900);
    /* how long until the next: a thin line under the title */
    ctx.fillStyle = rgba(RED, 0.55);
    ctx.fillRect(c.x + 7, c.y + 17, (c.w - 14) * clamp01(age / cs.dur), 1);
    text("LIVE", c.x + c.w - 7, c.y + 13, 8, rgba(HOT, Math.floor(now / 600) % 2 ? 0.9 : 0.35), "right");
    if (!w) {
      text(`0${i ? 3 : 1} STANDBY`, c.x + 7, c.y + 13, tiny ? 8 : 10, rgba(PALE, 0.9));
      return;
    }
    ctx.save();
    /* a glitch as it comes in, a fade as it goes */
    ctx.globalAlpha = reduced ? 1 : Math.max(0, Math.min(age < 260 ? (Math.floor(age / 65) % 2 ? 0.25 : 1) : 1, (cs.dur - age) / 300));
    text(`0${i ? 3 : 1} ${w.name}`, c.x + 7, c.y + 13, tiny ? 8 : 10, rgba(PALE, 0.9));
    const a = { x: c.x + 9, y: c.y + 25, w: c.w - 18, h: c.h - 25 - 36 };
    try {
      w.draw(a, k, now, dt);
    } catch (e) {
      /* a reading that vanished mid-draw: the next frame picks again */
    }
    glow(false);
    ctx.setLineDash([]);
    let big = "--", sub = "";
    try {
      big = w.big();
      sub = w.sub();
    } catch (e) {}
    text(String(big), c.x + 7, c.y + c.h - 15, tiny ? 13 : 17, rgba(PALE, 0.95));
    text(String(sub || "").slice(0, 22), c.x + c.w - 7, c.y + c.h - 4, tiny ? 7.5 : 8.5, rgba(HOT, 0.85), "right");
    ctx.restore();
  }
  function drawHouseFrame() {
    const b = L.house;
    brackets(b.x, b.y, b.w, b.h, 16, 0.85);
    text("02 HOME UNIT · TARGET LOCKED", b.x + 10, b.y + 14, 10, rgba(PALE, 0.95));
    text(`${lightsOn().length} LAMPEN AAN`, b.x + b.w - 10, b.y + 14, 10, rgba(HOT, 0.85), "right");
    const inside = indoors.map((s) => num(s.temp)).filter(ok);
    const avg = inside.length ? inside.reduce((a, c) => a + c, 0) / inside.length : NaN;
    text(`GEMIDDELD BINNEN ${fmt(avg)}°`, b.x + 10, b.y + b.h - 7, 9.5, rgba(HOT, 0.85));
    const door = cfg.covers && cfg.covers[0] && cfg.covers[0].entities.cover;
    text((st(door) || {}).state === "closed" ? "PERIMETER SECURE" : "PERIMETER OPEN", b.x + b.w - 10, b.y + b.h - 7, 9.5, rgba(PALE, 0.9), "right");
  }

  /* The graph: one dataset at a time, 8 s each, with an axis of values and of
   * clock hours. It draws in from the left (1.6 s, a bright pen per line, the
   * first line over a glowing area, the band between two lines filled), then
   * marks the day's peak and low and the average, and a scan line sweeps it
   * reading off every series where it passes; the last 0.4 s it fades for the
   * next. Series of one unit share a scale; a dataset without history is
   * passed over. */
  const DS_MS = 8000, DRAW_MS = 1600, FADE_MS = 400, SCAN_MS = 4200;
  let ds = -1, dsAt = 0, plot = null;
  const valAt = (pts, t) => {
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i][0] <= t) return pts[i][1];
    return NaN;
  };
  function prep(d) {
    const ser = d.series.map((s) => {
      const pts = hist2(s.id, s.scale);
      const vs = pts.map((p) => p[1]);
      if (vs.length < 2) return { s, pts: [] };
      const min = Math.min(...vs), max = Math.max(...vs);
      return { s, pts, min, max, avg: avg(vs), iMin: vs.indexOf(min), iMax: vs.indexOf(max) };
    });
    const live = ser.filter((x) => x.pts.length);
    if (!live.length) return null;
    const scale = (xs) => {
      let lo = Math.min(...xs.map((x) => x.min)), hi = Math.max(...xs.map((x) => x.max));
      const pad = (hi - lo) * 0.1;
      if (pad) {
        lo -= pad;
        hi += pad;
      } else hi = lo + 1; /* a flat line (no export all day) lies along the bottom */
      xs.forEach((x) => Object.assign(x, { lo, hi }));
    };
    const shared = d.series.every((s) => s.unit === d.series[0].unit);
    if (shared) scale(live);
    else live.forEach((x) => scale([x]));
    return { d, ser, live, shared };
  }
  function nextDataset(now) {
    plot = null;
    for (let i = 1; i <= DATASETS.length; i++) {
      const k = (ds + i) % DATASETS.length;
      const p = prep(DATASETS[k]);
      if (p) {
        ds = k;
        plot = p;
        break;
      }
    }
    dsAt = now;
  }
  const withUnit = (v, s) => `${fmt(v, s.d)}${s.unit === "°" ? "°" : s.unit ? " " + s.unit : ""}`;
  function drawGraph(now) {
    const g = L.graph;
    const top = g.y + 22, bottom = g.y + g.h - 14, gh = bottom - top;
    if (!dsAt || now - dsAt > DS_MS || (!plot && now - dsAt > 1000)) nextDataset(now);
    const age = now - dsAt;
    brackets(g.x, g.y, g.w, g.h, 14, 0.8);
    const x0 = g.x + 40, x1 = g.x + g.w * 0.74, pw = x1 - x0;
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(RED, 0.14);
    ctx.beginPath();
    for (let i = 0; i <= 12; i++) { ctx.moveTo(x0 + (pw * i) / 12, top); ctx.lineTo(x0 + (pw * i) / 12, bottom); }
    for (let i = 0; i <= 4; i++) { ctx.moveTo(x0, top + (gh * i) / 4); ctx.lineTo(x1, top + (gh * i) / 4); }
    ctx.stroke();
    if (!plot) {
      text("04 SIGNAL ANALYSIS · 24 H", g.x + 10, g.y + 13, 10, rgba(PALE, 0.95));
      text(Object.keys(hist).length ? "GEEN GESCHIEDENIS" : "GESCHIEDENIS LADEN", (x0 + x1) / 2, top + gh / 2, 11, rgba(HOT, 0.8), "center");
      return;
    }
    const { d, ser, live, shared } = plot;
    ctx.save();
    ctx.globalAlpha = reduced ? 1 : Math.max(0, Math.min(1, age / 250, (DS_MS - age) / FADE_MS));
    text(`04 ${d.title} · 24 H`, g.x + 10, g.y + 13, 10, rgba(PALE, 0.95));
    text(`${String(ds + 1).padStart(2, "0")}/${String(DATASETS.length).padStart(2, "0")}`, g.x + g.w - 10, g.y + 13, 9, rgba(HOT, 0.7), "right");
    const span = 24 * 3600e3, tNow = Date.now(), t0 = tNow - span;
    const X = (t) => x0 + clamp01((t - t0) / span) * pw;
    const Y = (x, v) => top + (1 - (v - x.lo) / (x.hi - x.lo)) * gh;
    const first = live[0];
    /* the value axis (of the first series, or of all when they share one) and the hours */
    for (let i = 0; i <= 4; i++) {
      const v = first.hi - ((first.hi - first.lo) * i) / 4;
      small(fmt(v, Math.abs(first.hi - first.lo) < 5 ? first.s.d : 0), x0 - 5, top + (gh * i) / 4 + 3, 0.6, "right", 7.5);
      if (i === 0 && shared && first.s.unit) small(first.s.unit, x0 - 5, top + 13, 0.8, "right", 7, PALE);
    }
    for (let t = Math.ceil(t0 / (3 * 3600e3)) * 3 * 3600e3; t < tNow - 1800e3; t += 3 * 3600e3) {
      small(new Date(t).toTimeString().slice(0, 5), X(t), bottom + 11, 0.55, "center", 7.5);
    }
    small("NU", x1, bottom + 11, 0.8, "right", 7.5, PALE);
    const reveal = reduced ? 1 : ease(age / DRAW_MS);
    const edge = x0 + pw * reveal;
    const path = (x) => {
      const p = new Path2D();
      x.pts.forEach(([t, v], i) => (i ? p.lineTo(X(t), Y(x, v)) : p.moveTo(X(t), Y(x, v))));
      p.lineTo(x1, Y(x, x.pts[x.pts.length - 1][1]));
      return p;
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, top - 6, edge - x0, gh + 12);
    ctx.clip();
    /* hourly averages of the first series as bars */
    if (d.bars) {
      const bw = pw / 24;
      for (let i = 0; i < 24; i++) {
        const s0 = t0 + i * 3600e3, vs = first.pts.filter(([t]) => t >= s0 && t < s0 + 3600e3).map((p) => p[1]);
        if (!vs.length) continue;
        const v = avg(vs), bh = clamp01((v - first.lo) / (first.hi - first.lo)) * gh;
        const gr = ctx.createLinearGradient(0, bottom - bh, 0, bottom);
        gr.addColorStop(0, rgba(RED, 0.4));
        gr.addColorStop(1, rgba(RED, 0.05));
        ctx.fillStyle = gr;
        ctx.fillRect(x0 + i * bw + 1, bottom - bh, bw - 2, bh);
      }
    }
    /* the band between the first two lines */
    if (d.band && shared && live[1]) {
      const a = live[0], b = live[1];
      const p = new Path2D();
      a.pts.forEach(([t, v], i) => (i ? p.lineTo(X(t), Y(a, v)) : p.moveTo(X(t), Y(a, v))));
      p.lineTo(x1, Y(a, a.pts[a.pts.length - 1][1]));
      p.lineTo(x1, Y(b, b.pts[b.pts.length - 1][1]));
      for (let i = b.pts.length - 1; i >= 0; i--) p.lineTo(X(b.pts[i][0]), Y(b, b.pts[i][1]));
      p.closePath();
      ctx.fillStyle = rgba(HOT, 0.13);
      ctx.fill(p);
    } else {
      /* a glowing area under the first line */
      const p = path(first);
      p.lineTo(x1, bottom);
      p.lineTo(X(first.pts[0][0]), bottom);
      const gr = ctx.createLinearGradient(0, top, 0, bottom);
      gr.addColorStop(0, rgba(RED, 0.32));
      gr.addColorStop(1, rgba(RED, 0));
      ctx.fillStyle = gr;
      ctx.fill(p);
    }
    ser.forEach((x, k) => {
      if (!x.pts.length) return;
      const p = path(x);
      ctx.strokeStyle = rgba(COLS[k], 0.22);
      ctx.lineWidth = 5;
      ctx.stroke(p);
      ctx.strokeStyle = rgba(COLS[k], k === 0 ? 0.95 : 0.8);
      ctx.lineWidth = 1.4;
      ctx.stroke(p);
    });
    /* the first series' average, dashed */
    const ay = Y(first, first.avg);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = rgba(HOT, 0.55);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, ay);
    ctx.lineTo(x1, ay);
    ctx.stroke();
    ctx.setLineDash([]);
    small(`Ø ${withUnit(first.avg, first.s)}`, x1 - 3, ay - 3, 0.8, "right", 7.5);
    ctx.restore();
    /* the pens while drawing */
    if (reveal < 1) {
      const t = t0 + reveal * span;
      ser.forEach((x) => {
        if (!x.pts.length) return;
        const v = valAt(x.pts, t);
        if (!ok(v)) return;
        glow(true, RED, 12);
        ctx.fillStyle = rgba(PALE, 1);
        ctx.beginPath();
        ctx.arc(edge, Y(x, v), 2.8, 0, Math.PI * 2);
        ctx.fill();
        glow(false);
      });
    } else {
      /* the day's peak and low of the first series */
      const ka = reduced ? 1 : clamp01((age - DRAW_MS) / 400);
      ctx.globalAlpha *= ka;
      for (const [i, up] of [[first.iMax, true], [first.iMin, false]]) {
        const [t, v] = first.pts[i], px = X(t), py = Y(first, v);
        ctx.fillStyle = rgba(up ? PALE : HOT, 0.95);
        ctx.beginPath();
        if (up) {
          ctx.moveTo(px, py - 4);
          ctx.lineTo(px - 4, py - 10);
          ctx.lineTo(px + 4, py - 10);
        } else {
          ctx.moveTo(px, py + 4);
          ctx.lineTo(px - 4, py + 10);
          ctx.lineTo(px + 4, py + 10);
        }
        ctx.fill();
        const align = px < x0 + 40 ? "left" : px > x1 - 40 ? "right" : "center";
        small(`${up ? "MAX" : "MIN"} ${withUnit(v, first.s)} · ${new Date(t).toTimeString().slice(0, 5)}`, px, up ? Math.max(top + 2, py - 13) : Math.min(bottom - 2, py + 19), 0.9, align, 7.5, up ? PALE : HOT);
      }
      ctx.globalAlpha /= ka || 1;
      /* the scan line, reading off every series */
      if (!reduced) {
        const p = ((age - DRAW_MS) % SCAN_MS) / SCAN_MS;
        const sx = x0 + p * pw, at = t0 + p * span;
        const gr = ctx.createLinearGradient(sx - 50, 0, sx, 0);
        gr.addColorStop(0, rgba(RED, 0));
        gr.addColorStop(1, rgba(RED, 0.22));
        ctx.fillStyle = gr;
        ctx.fillRect(sx - 50, top, 50, gh);
        ctx.strokeStyle = rgba(PALE, 0.75);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx, top);
        ctx.lineTo(sx, bottom);
        ctx.stroke();
        const rows = [];
        ser.forEach((x, k) => {
          if (!x.pts.length) return;
          const v = valAt(x.pts, at);
          if (!ok(v)) return;
          ctx.fillStyle = rgba(COLS[k], 1);
          ctx.beginPath();
          ctx.arc(sx, Y(x, v), 2.6, 0, Math.PI * 2);
          ctx.fill();
          rows.push([k, withUnit(v, x.s)]);
        });
        if (rows.length) {
          const bw = 92, bh = 14 + rows.length * 11;
          const bx = sx + 10 + bw < x1 ? sx + 8 : sx - 8 - bw, by = top + 4;
          ctx.fillStyle = "rgba(14, 1, 0, 0.82)";
          ctx.fillRect(bx, by, bw, bh);
          ctx.strokeStyle = rgba(RED, 0.6);
          ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
          small(new Date(at).toTimeString().slice(0, 5), bx + 5, by + 10, 0.9, "left", 7.5, PALE);
          rows.forEach(([k, s], j) => {
            ctx.fillStyle = rgba(COLS[k], 1);
            ctx.fillRect(bx + 5, by + 16 + j * 11, 6, 3);
            small(s, bx + bw - 5, by + 20 + j * 11, 0.95, "right", 7.5, PALE);
          });
        }
      }
    }
    /* the legend: each series now, its average and its range */
    const lx = x1 + 16, lw = g.x + g.w - 10 - lx;
    const step = Math.min(34, (gh - 8) / Math.max(1, ser.length));
    ser.forEach((x, k) => {
      const s = x.s, yy = top + 6 + k * step;
      ctx.fillStyle = rgba(COLS[k], 0.95);
      ctx.fillRect(lx, yy - 6, 8, 3);
      small(s.label, lx + 12, yy - 2, 0.85, "left", 8.5);
      const v = s.scale ? s.scale(num(s.id)) : num(s.id);
      text(withUnit(v, s), lx + lw, yy - 2, 10, rgba(PALE, 0.95), "right");
      if (x.pts.length && step > 22) small(`Ø ${fmt(x.avg, s.d)} · ${fmt(x.min, s.d)}–${fmt(x.max, s.d)}`, lx + lw, yy + 9, 0.55, "right", 7.5);
    });
    /* which of how many, as ticks */
    const n = DATASETS.length, dw = Math.min(8, lw / n);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = rgba(i === ds ? PALE : RED, i === ds ? 0.95 : 0.35);
      ctx.fillRect(lx + lw - n * dw + i * dw, bottom + 6, Math.max(1.5, dw - 2), 2);
    }
    ctx.restore();
  }

  /* ---- The loop ---------------------------------------------------------------------------------- */
  let shown = false, raf = 0, last = 0, lastDraw = 0, lastStatus = 0, lastClock = 0, house = null;
  const FRAME_MS = 33; /* 30 frames a second is plenty for this, and kinder to a tablet on all night */
  function frame(now) {
    raf = 0;
    if (!shown || Panel.sleeping()) return;
    raf = requestAnimationFrame(frame);
    if (now - lastDraw < FRAME_MS) return;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = lastDraw = now;
    feedStep(now);
    /* only when there is something new, or a line is being typed */
    if (feedDirty || typing) {
      renderFeed(now);
      feedDirty = false;
      if (typing && now - typing.at > 2500) typing = null;
    }
    if (now - lastStatus > 2000) {
      lastStatus = now;
      const n = warnings();
      q(".vn-status").textContent = n ? `${n} melding${n > 1 ? "en" : ""}` : "Alle systemen nominaal";
      q(".vn-status").classList.toggle("warn", n > 0);
    }
    const d = new Date();
    /* a few times a second: written every frame it forced a re-layout each frame */
    if (now - lastClock > 90) {
      lastClock = now;
      q(".vn-clock").textContent = `${d.toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "short" })} · ${d.toTimeString().slice(0, 8)}.${String(Math.floor(d.getMilliseconds() / 10)).padStart(2, "0")}`;
    }
    if (Date.now() - histAt > 10 * 60e3) loadHistory();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    V.reticle(ctx, L.reticle.x, L.reticle.y, L.reticle.r, now / 1000);
    drawCell(0, now, dt);
    drawCell(1, now, dt);
    drawHouseFrame();
    drawGraph(now);
  }
  function run(on) {
    if (on && !raf && shown && !Panel.sleeping()) {
      last = 0;
      raf = requestAnimationFrame(frame);
      if (house) house.setActive(true);
    } else if (!on) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (house) house.setActive(false);
    }
  }
  /* The panel's sleep stage stops the drawing; waking restarts it. */
  setInterval(() => {
    if (!shown) return;
    if (Panel.sleeping()) run(false);
    else if (!raf) run(true);
  }, 1000);

  /* Burn-in: the whole HUD shifts a few pixels every minute. */
  setInterval(() => {
    if (!shown) return;
    const dx = Math.round(Math.random() * 12 - 6), dy = Math.round(Math.random() * 8 - 4);
    root.style.setProperty("--vn-shift", `translate(${dx}px, ${dy}px)`);
  }, 60e3);

  window.addEventListener("resize", () => shown && layout());

  Panel.visionSaver = {
    show() {
      if (shown) return;
      shown = true;
      root.hidden = false;
      feedDirty = true;
      root.classList.remove("in");
      void root.offsetWidth; /* restart the entrance */
      root.classList.add("in");
      layout();
      if (!house && window.HOUSE_PLAN) {
        /* null without WebGL (or past the browser's limit of contexts): the frame stays empty */
        house = Panel.house3d(houseBox.querySelector("canvas"), window.HOUSE_PLAN, { onInteract() {} });
        if (house) {
          house.setMood([1, 0.16, 0.1], 0.8); /* the house in the vision's red */
          house.setOrbitScale(0.6);
          house.setCinema(true);
        }
      }
      /* a fresh feed: the snapshot first, then the live readings */
      feed = [];
      typing = null;
      intro = snapshot();
      lastFeed = 0;
      resetChanges();
      ds = -1;
      dsAt = 0;
      plot = null;
      CELLS = [{ first: true }, { first: true }];
      if (!histAt || Date.now() - histAt > 10 * 60e3) loadHistory();
      run(true);
      Panel.emit("vision", true);
    },
    hide() {
      if (!shown) return;
      shown = false;
      run(false);
      root.hidden = true;
      Panel.emit("vision", false);
    },
    shown: () => shown,
  };
})();
