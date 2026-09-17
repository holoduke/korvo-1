/* Climate and air readings: which entities are sensors, CO2 validity, a 24 h
 * history per reading (Home Assistant's history at start, live values after;
 * other modules add readings with Panel.keepHistory) and the comfort and
 * air-quality colour bands that the header, the popups and the screensaver
 * share. Emits "reading" (id) and "history". */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;

  /* Air monitors: entity id -> reading kind. */
  const AIR_KINDS = ["co2", "pm25", "quality", "temp", "humidity"];
  const airKind = new Map();
  cfg.air.forEach((a) => AIR_KINDS.forEach((k) => a[k] && airKind.set(a[k], k)));

  /* A CO2 reading below the valid floor is the sensor warming up, not air. */
  const co2Valid = (v) => v >= cfg.airBands.co2MinValid;
  cfg.air.forEach((a) => a.co2 && Panel.validate(a.co2, co2Valid));

  /* ---- Colour bands ------------------------------------------------------------ */
  /* From low to high: [limit, tone, inclusive]. A value takes the first band it
   * stays below (or at, when inclusive). Tones are the status colours --cold,
   * --ok, --warn and --bad. The header, the popups and the charts share these. */
  const comfort = cfg.comfort;
  const air = cfg.airBands;
  Panel.bands = {
    temp: [[comfort.tempMin, "cold", false], [comfort.tempMax, "ok", true], [comfort.tempHot, "warn", true], [Infinity, "bad", true]],
    hum: [
      [comfort.humMin - comfort.humMargin, "bad", false],
      [comfort.humMin, "warn", false],
      [comfort.humMax, "ok", true],
      [comfort.humMax + comfort.humMargin, "warn", true],
      [Infinity, "bad", true],
    ],
    co2: [[air.co2Good, "ok", true], [air.co2Poor, "warn", true], [Infinity, "bad", true]],
    pm: [[air.pm25Good, "ok", true], [air.pm25Poor, "warn", true], [Infinity, "bad", true]],
  };
  Panel.bandTone = (bands, v) => bands.find(([limit, , inclusive]) => (inclusive ? v <= limit : v < limit))[1];
  Panel.comfortTemp = (v, indoor) => (indoor ? `var(--${Panel.bandTone(Panel.bands.temp, v)})` : "var(--text)");
  Panel.comfortHum = (v, indoor) => (indoor ? `var(--${Panel.bandTone(Panel.bands.hum, v)})` : "var(--hum)");
  Panel.co2Colour = (v) => `var(--${Panel.bandTone(Panel.bands.co2, v)})`;
  Panel.pmColour = (v) => `var(--${Panel.bandTone(Panel.bands.pm, v)})`;
  const QUALITY = {
    good: ["goed", "var(--ok)"],
    fair: ["redelijk", "var(--warn)"],
    moderate: ["matig", "var(--warn)"],
    poor: ["slecht", "var(--bad)"],
    very_poor: ["zeer slecht", "var(--bad)"],
    extremely_poor: ["extreem slecht", "var(--bad)"],
  };
  /* [label, colour] for an air-quality entity, or null. */
  Panel.quality = (id) => QUALITY[(Panel.st(id) || {}).state] || null;

  /* ---- History ----------------------------------------------------------------- */
  /* 24 h readings per sensor entity: [{t, v}] sorted by time (history + live). */
  Panel.hist = {};
  const historyIds = [
    ...cfg.sensors.flatMap((s) => [s.temp, s.humidity]),
    ...cfg.air.flatMap((a) => [a.co2, a.pm25, a.temp, a.humidity]),
  ].filter(Boolean);

  /* The ALPSTUGA's first CO2 and PM2.5 reading after it comes back from
   * "unavailable" is always exactly 0 (seen in HA history on 2026-09-13):
   * a startup artefact, kept out of the charts. */
  const startupGuarded = (id) => airKind.get(id) === "co2" || airKind.get(id) === "pm25";
  const lastRaw = new Map();

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
  /* The reading in effect at time t (NaN before the first one). */
  Panel.valueAt = function (id, t) {
    let v = NaN;
    for (const p of Panel.hist[id] || []) {
      if (p.t > t) break;
      v = p.v;
    }
    return v;
  };

  async function loadHistory() {
    try {
      const res = await Panel.client.history(historyIds, new Date(Date.now() - 24 * 3600e3));
      for (const id of historyIds) {
        const guard = startupGuarded(id);
        const rows = [];
        let prevNumeric = true;
        for (const r of [...(res[id] || [])].sort((x, y) => x.t - y.t)) {
          const v = parseFloat(r.s);
          const numeric = Number.isFinite(v);
          const startupZero = guard && numeric && v === 0 && !prevNumeric;
          prevNumeric = numeric;
          if (numeric && !startupZero && (airKind.get(id) !== "co2" || co2Valid(v))) rows.push({ t: r.t, v });
        }
        const live = (Panel.hist[id] || []).filter((p) => !rows.length || p.t > rows[rows.length - 1].t);
        Panel.hist[id] = rows.concat(live);
      }
      Panel.emit("history");
    } catch (e) {
      /* retried on the next half-hour refresh */
    }
  }

  function onReadings(changed) {
    for (const id of changed) {
      const s = Panel.st(id);
      const prev = lastRaw.get(id);
      lastRaw.set(id, s ? s.state : undefined);
      const startupZero =
        startupGuarded(id) && s && parseFloat(s.state) === 0 && prev !== undefined && !Number.isFinite(parseFloat(prev));
      if (s && !startupZero) pushReading(id, s);
      Panel.emit("reading", id);
    }
  }
  const sensorIds = [...cfg.sensors.flatMap((s) => [s.temp, s.humidity]), ...airKind.keys()].filter(Boolean);
  Panel.track(sensorIds, onReadings);
  /* Another module's numeric readings, kept the same way (24 h of history, then
   * live values) for its own charts. Call before the states arrive. */
  Panel.keepHistory = function (ids) {
    const fresh = ids.filter((id) => id && !historyIds.includes(id));
    historyIds.push(...fresh);
    Panel.track(fresh, onReadings);
  };
  Panel.on("loaded", loadHistory);
  /* Again every half hour, and as soon as the connection is back after an outage. */
  setInterval(() => Panel.isLoaded() && Panel.connected() && loadHistory(), 30 * 60e3);
  Panel.on("status", (s) => s === "connected" && Panel.isLoaded() && loadHistory());
})();
