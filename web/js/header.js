/* Header: the forecast, a column per climate sensor and air monitor, the
 * device columns (vacuum, bike, car), and the date and clock. Every column has
 * the same three lines (name, a large value, a small one), so the text lines up.
 * A device with its own section opens it when tapped. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;
  const { DAYS_SHORT, DAYS_LONG, MONTHS } = Util;
  const FC_DAYS = 3;

  /* ---- Weather ------------------------------------------------------------------ */
  const wxIcon = () => '<div class="wx"><div class="sun"></div><div class="cloud"><i></i><i></i><i></i></div></div>';
  function applyWx(el, condition) {
    const c = condition || "";
    const clear = !c.includes("partlycloudy") && (c.includes("sunny") || c.includes("clear"));
    const sun = clear || c.includes("partlycloudy");
    const cloud = !clear;
    const colour =
      c.includes("rain") || c.includes("pour") || c.includes("lightning") ? "#7fa8d0" : c.includes("snow") ? "#dfe6f0" : "var(--text_dim)";
    const sunEl = el.querySelector(".sun");
    sunEl.hidden = !sun;
    sunEl.style.background = c.includes("night") ? "#c3c9d6" : "#ffcf4d";
    const cl = el.querySelector(".cloud");
    cl.hidden = !cloud;
    cl.style.color = colour;
  }
  function renderForecastDay(i, condition, temperature, date) {
    const col = $("fc" + i);
    if (!col) return;
    const day = date || new Date(Date.now() + i * 86400e3);
    col.querySelector(".fc-day").textContent = DAYS_SHORT[day.getDay()];
    if (Number.isFinite(temperature)) col.querySelector(".fc-temp").textContent = Math.round(temperature) + "°";
    applyWx(col, condition);
  }
  let haveForecast = false; /* until then, today's column shows the live weather */
  async function loadForecast() {
    try {
      const res = await Panel.client.callService("weather", "get_forecasts", { type: "daily" }, { entity_id: cfg.weather }, true);
      const fc = (((res || {}).response || {})[cfg.weather] || {}).forecast || [];
      const today = new Date().toDateString();
      /* Skip a leftover entry for yesterday; label days from their own dates. */
      const days = fc.filter((d) => new Date(d.datetime).toDateString() === today || new Date(d.datetime) > new Date()).slice(0, FC_DAYS);
      days.forEach((d, i) => renderForecastDay(i, d.condition, d.temperature, new Date(d.datetime)));
      if (days.length) haveForecast = true;
    } catch (e) {
      /* keep the live current-weather column */
    }
  }
  Panel.track([cfg.weather], () => {
    const s = Panel.st(cfg.weather);
    if (!haveForecast && s) renderForecastDay(0, s.state, s.attributes.temperature);
  });
  Panel.on("loaded", loadForecast);
  /* Again every half hour, and as soon as the connection is back after an outage. */
  setInterval(() => Panel.isLoaded() && Panel.connected() && loadForecast(), 30 * 60e3);
  Panel.on("status", (s) => s === "connected" && Panel.isLoaded() && loadForecast());

  /* ---- Climate and air columns --------------------------------------------------- */
  const sensorOf = new Map(); /* entity id -> sensor index */
  cfg.sensors.forEach((s, i) => [s.temp, s.humidity].forEach((id) => id && sensorOf.set(id, i)));
  const airOf = new Map(); /* entity id -> air monitor index */
  cfg.air.forEach((a, i) => ["co2", "pm25", "quality", "temp", "humidity"].forEach((k) => a[k] && airOf.set(a[k], i)));

  function renderSensor(i) {
    const s = cfg.sensors[i];
    const col = document.querySelector(`[data-sensor="${i}"]`);
    const t = Panel.num(s.temp);
    col.classList.toggle("stale", !Number.isFinite(t)); /* no reading: sensor offline */
    const te = col.querySelector(".s-temp");
    te.textContent = Number.isFinite(t) ? Util.fmt(t, 1) + "°" : "--";
    te.style.color = Number.isFinite(t) ? Panel.comfortTemp(t, s.indoor) : "var(--text)";
    if (s.humidity) {
      const h = Panel.num(s.humidity);
      const he = col.querySelector(".s-hum");
      he.querySelector("span").textContent = Number.isFinite(h) ? Math.round(h) + "%" : "--";
      he.style.color = Number.isFinite(h) ? Panel.comfortHum(h, s.indoor) : "var(--hum)";
    }
  }

  function renderAir(i) {
    const a = cfg.air[i];
    const col = document.querySelector(`[data-air="${i}"]`);
    const co2 = Panel.num(a.co2);
    const pm = Panel.num(a.pm25);
    const t = Panel.num(a.temp);
    const h = Panel.num(a.humidity);
    const q = Panel.quality(a.quality);
    const co2El = col.querySelector(".a-co2");
    co2El.innerHTML = Number.isFinite(co2) ? `${Math.round(co2)}<small>ppm</small>` : "--";
    co2El.style.color = Number.isFinite(co2) ? Panel.co2Colour(co2) : "var(--text)";
    const pmEl = col.querySelector(".a-pm");
    pmEl.textContent = "PM2.5 " + (Number.isFinite(pm) ? Math.round(pm) : "--");
    pmEl.style.color = Number.isFinite(pm) ? Panel.pmColour(pm) : "var(--text_dim)";
    const tEl = col.querySelector(".a-temp");
    tEl.textContent = Number.isFinite(t) ? Util.fmt(t, 1) + "°" : "--";
    tEl.style.color = Number.isFinite(t) ? Panel.comfortTemp(t, true) : "var(--text)";
    const hEl = col.querySelector(".a-hum");
    hEl.querySelector("span").textContent = Number.isFinite(h) ? Math.round(h) + "%" : "--";
    hEl.style.color = Number.isFinite(h) ? Panel.comfortHum(h, true) : "var(--hum)";
    col.querySelector(".aq-dot").style.background = q ? q[1] : "var(--tile)";
    const txt = col.querySelector(".aq-txt");
    txt.textContent = q ? q[0] : "";
    txt.style.color = q ? q[1] : "";
    col.classList.toggle("stale", !Number.isFinite(co2) && !Number.isFinite(t));
  }

  /* An arrow next to a sensor's name when it changed 0.3° or more in the last hour. */
  function renderTrends() {
    const now = Date.now();
    cfg.sensors.forEach((s, i) => {
      const d = Panel.valueAt(s.temp, now) - Panel.valueAt(s.temp, now - 3600e3);
      document.querySelector(`[data-sensor="${i}"] .trend`).innerHTML = Number.isFinite(d)
        ? d >= 0.3 ? icon("arrow-up") : d <= -0.3 ? icon("arrow-down") : ""
        : "";
    });
  }

  Panel.on("reading", (id) => {
    if (sensorOf.has(id)) renderSensor(sensorOf.get(id));
    if (airOf.has(id)) renderAir(airOf.get(id));
  });
  Panel.on("history", renderTrends);
  Panel.on("minute", renderTrends);

  /* ---- Device columns ---------------------------------------------------------- */
  const DEVICES = [
    ["vacuum", cfg.vacuum],
    ["bike", cfg.bike],
    ["car", cfg.car],
  ].filter(([, conf]) => conf);

  /* A device column's battery and status. `lock` adds a lock icon after the
   * status, `active` accents it (cleaning, riding, charging). */
  Panel.setDevice = function (kind, { battery, status, lock = false, active = false, offline = false }) {
    const col = document.querySelector(`[data-device="${kind}"]`);
    if (!col) return;
    const batt = col.querySelector(".vh-batt");
    batt.querySelector("span").textContent = Number.isFinite(battery) ? Math.round(battery) + "%" : "--";
    batt.style.color = Util.batteryColour(battery);
    const statusEl = col.querySelector(".vh-status");
    statusEl.textContent = status; /* zone names come from HA: text, not markup */
    if (lock) statusEl.insertAdjacentHTML("beforeend", icon("lock"));
    col.classList.toggle("active", active);
    col.classList.toggle("stale", offline);
  };

  function renderBike() {
    const bike = cfg.bike;
    const where = Panel.st(bike.location);
    const speed = Panel.num(bike.speed);
    const offline = Panel.isLoaded() && Panel.unavailable(Panel.st(bike.battery));
    const riding = Number.isFinite(speed) && speed >= 3;
    /* Riding shows the speed; parked shows where (home, away or a zone's name). */
    Panel.setDevice("bike", {
      battery: Panel.num(bike.battery),
      status: offline ? "Offline" : riding ? `${Math.round(speed)} km/u` : Panel.unavailable(where) ? "" : Util.place(where.state),
      lock: !offline && !riding && (Panel.st(bike.lock) || {}).state === "on",
      active: riding,
      offline,
    });
  }

  function renderCar() {
    const car = cfg.car;
    const charging = ((Panel.st(car.charging) || {}).state || "").toLowerCase();
    const range = Panel.num(car.range);
    const offline = Panel.isLoaded() && Panel.unavailable(Panel.st(car.battery));
    const busy = charging === "charging" || charging === "starting";
    /* Charging or full while plugged in; otherwise how far it can go. */
    Panel.setDevice("car", {
      battery: Panel.num(car.battery),
      status: offline ? "Offline" : busy ? "Laadt" : charging === "complete" ? "Vol" : Number.isFinite(range) ? `${Math.round(range)} km` : "",
      lock: !offline && (Panel.st(car.lock) || {}).state === "locked",
      active: busy,
      offline,
    });
  }
  if (cfg.bike) Panel.track(["battery", "location", "lock", "speed"].map((k) => cfg.bike[k]), renderBike);
  if (cfg.car) Panel.track([cfg.car.battery, cfg.car.range, cfg.car.charging, cfg.car.lock], renderCar);

  /* ---- Clock ------------------------------------------------------------------- */
  let lastMinute = -1;
  function tickClock() {
    const d = new Date();
    const m = d.getHours() * 60 + d.getMinutes();
    if (m === lastMinute) return;
    lastMinute = m;
    $("clock").textContent = Util.hm(d);
    $("dow").textContent = DAYS_LONG[d.getDay()];
    $("date").textContent = d.getDate() + " " + MONTHS[d.getMonth()];
    Panel.emit("minute");
  }

  /* ---- Build ------------------------------------------------------------------- */
  function columnsHtml() {
    const sensors = cfg.sensors.map(
      (s, i) =>
        `<button class="sensor-col" data-sensor="${i}"><div class="s-name"><span>${s.label}</span><span class="trend"></span></div>` +
        `<div class="s-temp">--</div><div class="s-hum">${s.humidity ? icon("drop") + "<span>--</span>" : ""}</div></button>`
    );
    const air = cfg.air.map(
      (a, i) =>
        `<div class="rule"></div><button class="sensor-col air-col" data-air="${i}">` +
        `<div class="s-name"><span>${a.short}</span><span class="aq-dot"></span><span class="aq-txt"></span></div>` +
        `<div class="air-grid">` +
        `<div class="s-temp a-co2">--</div><div class="s-temp a-temp">--</div>` +
        `<div class="s-hum a-pm">PM2.5 --</div><div class="s-hum a-hum">${icon("drop")}<span>--</span></div>` +
        `</div></button>`
    );
    const devices = DEVICES.map(([kind, conf], i) => {
      const tag = Panel.sectionIndex(kind) >= 0 ? "button" : "div";
      return (
        (i === 0 ? '<div class="rule"></div>' : "") +
        `<${tag} class="sensor-col dev-hdr" data-device="${kind}" aria-label="${conf.label}">` +
        `<div class="s-name">${icon(kind)}<span>${conf.label}</span></div>` +
        `<div class="s-temp vh-batt"><span>--</span></div>` +
        `<div class="s-hum vh-status">...</div></${tag}>`
      );
    });
    return [...sensors, ...air, ...devices].join("");
  }

  Panel.on("build", () => {
    $("forecast").innerHTML = Array.from(
      { length: FC_DAYS },
      (_, i) => `<div class="fc-col" id="fc${i}"><div class="fc-day${i === 0 ? " today" : ""}">--</div>${wxIcon()}<div class="fc-temp">--</div></div>`
    ).join("");
    $("sensors").innerHTML = columnsHtml();
    $("gear").innerHTML = icon("gear");
    cfg.sensors.forEach((_, i) => renderSensor(i));
    cfg.air.forEach((_, i) => renderAir(i));
    if (cfg.bike) renderBike();
    if (cfg.car) renderCar();
    /* The strip scrolls sideways when it cannot fit; its edge fades meanwhile. */
    Util.watchOverflow(document.querySelector(".hdr-strip"), $("sensors"));
    tickClock();
    setInterval(tickClock, 1000);
  });

  $("sensors").addEventListener("click", (e) => {
    const col = e.target.closest("[data-sensor],[data-air],[data-device]");
    if (!col) return;
    if (col.dataset.sensor) Panel.openClimate(+col.dataset.sensor);
    else if (col.dataset.air) Panel.openAir(+col.dataset.air);
    else Panel.showSection(col.dataset.device);
  });
})();
