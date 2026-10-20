/* The weather popup, opened from the header's forecast: what it is now, the
 * coming seven days, the next 48 hours as a chart (temperature and rain), and
 * today and tomorrow in a few sentences.
 *
 * Now comes from the panel's own weather entity (Buienradar, a station near
 * by); the days and hours from the forecast entity (Open-Meteo: seven days,
 * hourly, no key), both through weather.get_forecasts. Buienradar's own
 * two-hour rain radar adds whether a shower is on its way. The sentences are
 * made here from those numbers: no text service, nothing leaves the house. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;
  const { esc, fmt, DAYS_SHORT, DAYS_LONG } = Util;
  const NOW_ID = cfg.weather;
  const FC_ID = cfg.forecast || cfg.weather;
  const RAIN_2H = cfg.health && cfg.health.rain; /* Buienradar: average mm/h over the next two hours */
  const RAIN_2H_TOTAL = "sensor.buienradar_precipitation_forecast_total";

  const CONDITION = {
    "clear-night": "helder", cloudy: "bewolkt", exceptional: "uitzonderlijk weer", fog: "mist", hail: "hagel",
    lightning: "onweer", "lightning-rainy": "onweersbuien", partlycloudy: "half bewolkt", pouring: "zware regen",
    rainy: "regen", snowy: "sneeuw", "snowy-rainy": "natte sneeuw", sunny: "zonnig", windy: "winderig", "windy-variant": "winderig en bewolkt",
  };
  const WIND_DIR = ["noord", "noordoost", "oost", "zuidoost", "zuid", "zuidwest", "west", "noordwest"];
  /* km/h -> Beaufort */
  const BFT = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
  const beaufort = (kmh) => (Number.isFinite(kmh) ? BFT.findIndex((x) => kmh < x) === -1 ? 12 : BFT.findIndex((x) => kmh < x) : NaN);
  const BFT_WORD = ["windstil", "zwak", "zwak", "matig", "matig", "vrij krachtig", "krachtig", "hard", "stormachtig", "storm", "zware storm", "zeer zware storm", "orkaan"];
  const dirOf = (deg) => (Number.isFinite(deg) ? WIND_DIR[Math.round(((deg % 360) + 360) % 360 / 45) % 8] : "");
  const hm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const condNL = (c) => CONDITION[c] || (c ? String(c).replace(/-/g, " ") : "");

  let daily = [], hourly = [], loadedAt = 0, busy = false;
  async function forecast(type, id = FC_ID) {
    const res = await Panel.client.callService("weather", "get_forecasts", { type }, { entity_id: id }, true);
    return (((res || {}).response || {})[id] || {}).forecast || [];
  }
  /* The days as the header shows them: where Buienradar (the header's source)
   * has a day, its sky, temperatures and chance of rain; Open-Meteo adds the
   * millimetres, and the days beyond Buienradar's five. One picture everywhere. */
  function merge(om, bz) {
    const key = (x) => new Date(x.datetime).toDateString();
    const byDay = new Map(bz.map((x) => [key(x), x]));
    const out = om.map((x) => {
      const b = byDay.get(key(x));
      byDay.delete(key(x));
      return b
        ? { ...x, condition: b.condition, temperature: b.temperature, templow: b.templow ?? x.templow, precipitation_probability: b.precipitation_probability, wind_speed: b.wind_speed ?? x.wind_speed, wind_bearing: b.wind_bearing ?? x.wind_bearing }
        : x;
    });
    return [...out, ...byDay.values()].sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  }
  async function load() {
    if (busy || !Panel.client) return;
    busy = true;
    try {
      const [om, h, bz] = await Promise.all([
        forecast("daily"),
        forecast("hourly").catch(() => []),
        FC_ID !== NOW_ID ? forecast("daily", NOW_ID).catch(() => []) : Promise.resolve([]),
      ]);
      const d = bz.length ? merge(om, bz) : om;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      daily = d.filter((x) => new Date(x.datetime) >= today || sameDay(new Date(x.datetime), today));
      hourly = h.filter((x) => new Date(x.datetime) > Date.now() - 3600e3);
      loadedAt = Date.now();
    } catch (e) {
      /* the popup says so; tried again on the next open */
    } finally {
      busy = false;
    }
    if (isOpen()) render();
  }

  /* ---- In words ---------------------------------------------------------------------- */
  /* The rain in some hours as a sentence: dry, a shower around a time, or rain from a time on. */
  function rainText(hours) {
    const wet = hours.filter((h) => (h.precipitation || 0) >= 0.2);
    const total = hours.reduce((s, h) => s + (h.precipitation || 0), 0);
    if (!hours.length) return "";
    if (!wet.length) return total > 0.05 ? "Het blijft vrijwel droog." : "Het blijft droog.";
    const first = new Date(wet[0].datetime);
    const last = new Date(wet[wet.length - 1].datetime);
    const mm = `${fmt(total, total < 10 ? 1 : 0)} mm`;
    if (wet.length <= 2) return `Kans op een bui rond ${hm(first)} (${mm}).`;
    if (wet.length >= hours.length - 1) return `Het regent het grootste deel van de tijd, samen zo'n ${mm}.`;
    return `Regen tussen ${hm(first)} en ${hm(new Date(last.getTime() + 3600e3))}, samen zo'n ${mm}.`;
  }
  function windText(kmh, bearing, gust) {
    const b = beaufort(kmh);
    if (!Number.isFinite(b)) return "";
    const dir = dirOf(bearing);
    let t = b === 0 ? "Het is windstil" : `De wind is ${BFT_WORD[b]}${dir ? ` uit het ${dir}en` : ""} (${b} Bft)`;
    if (Number.isFinite(gust) && beaufort(gust) >= 6 && beaufort(gust) > b) t += `, met windstoten tot ${Math.round(gust)} km/u`;
    return t + ".";
  }
  function sunText() {
    const s = Panel.st("sun.sun");
    if (!s) return "";
    const a = s.attributes || {};
    const rise = new Date(a.next_rising), set = new Date(a.next_setting);
    if (s.state === "above_horizon" && !isNaN(set)) return `De zon gaat om ${hm(set)} onder.`;
    if (!isNaN(rise)) return `De zon komt om ${hm(rise)} op.`;
    return "";
  }
  function todayText() {
    const now = new Date();
    const d = daily.find((x) => sameDay(new Date(x.datetime), now));
    const rest = hourly.filter((h) => sameDay(new Date(h.datetime), now) && new Date(h.datetime) >= new Date(now.getTime() - 3600e3));
    const live = Panel.st(NOW_ID);
    const parts = [];
    const late = now.getHours() >= 18;
    if (d) {
      const cond = condNL(d.condition);
      if (late) parts.push(`${cap(cond || "Het weer")} vandaag, met ${Math.round(d.temperature)}° als hoogste.`);
      else parts.push(`${cap(cond || "Vandaag")}${cond ? " vandaag" : ""}, het wordt ${Math.round(d.temperature)}°${Number.isFinite(d.apparent_temperature) && Math.abs(d.apparent_temperature - d.temperature) >= 2 ? ` (voelt als ${Math.round(d.apparent_temperature)}°)` : ""}.`);
    } else if (live) {
      parts.push(`Nu ${condNL(live.state)} en ${fmt(Number(live.attributes.temperature), 1)}°.`);
    }
    parts.push(rainText(rest));
    if (d && Number.isFinite(d.precipitation_probability) && d.precipitation_probability >= 30) parts.push(`De kans op regen is ${d.precipitation_probability}%.`);
    const radar = Panel.num(RAIN_2H_TOTAL);
    const radarAvg = Panel.num(RAIN_2H);
    if (Number.isFinite(radar) && radar > 0.1) parts.push(`Buienradar ziet de komende twee uur ${fmt(radar, 1)} mm aankomen.`);
    else if (Number.isFinite(radarAvg) && radarAvg === 0 && rest.some((h) => (h.precipitation || 0) >= 0.2)) parts.push("De komende twee uur blijft het nog droog.");
    const w = rest[0] || d;
    if (w) parts.push(windText(w.wind_speed, w.wind_bearing, w.wind_gust_speed));
    /* tonight: the lowest of the hours to tomorrow morning */
    const night = hourly.filter((h) => {
      const t = new Date(h.datetime);
      return t > now && t.getTime() - now.getTime() < 18 * 3600e3 && (t.getHours() >= 22 || t.getHours() <= 7);
    });
    if (night.length) {
      const low = Math.min(...night.map((h) => h.temperature));
      parts.push(`Vannacht koelt het af tot ${Math.round(low)}°${low <= 3 ? ", kans op vorst aan de grond" : ""}.`);
    }
    parts.push(sunText());
    return parts.filter(Boolean).join(" ");
  }
  /* The calendar day after today: not now + 24 h, which lands on the same day
   * (or skips one) around the DST change. */
  function tomorrow() {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    return t;
  }
  function tomorrowText() {
    const t = tomorrow();
    const d = daily.find((x) => sameDay(new Date(x.datetime), t));
    if (!d) return "";
    const hours = hourly.filter((h) => sameDay(new Date(h.datetime), t) && new Date(h.datetime).getHours() >= 7);
    const parts = [];
    const lo = Number.isFinite(d.templow) ? `${Math.round(d.templow)}° in de ochtend tot ` : "";
    parts.push(`${cap(condNL(d.condition) || "Wisselend")}, van ${lo}${Math.round(d.temperature)}° als hoogste.`);
    /* the hours tell when; when they see no rain but the day total does, the day total speaks */
    const wetHours = hours.some((h) => (h.precipitation || 0) >= 0.2);
    parts.push(!wetHours && d.precipitation >= 0.5 ? `Er valt in de loop van de dag zo'n ${fmt(d.precipitation, 1)} mm regen.` : rainText(hours) || "Droog.");
    if (Number.isFinite(d.precipitation_probability) && d.precipitation_probability >= 30) parts.push(`De kans op regen is ${d.precipitation_probability}%.`);
    parts.push(windText(d.wind_speed, d.wind_bearing, d.wind_gust_speed));
    const today = daily.find((x) => sameDay(new Date(x.datetime), new Date()));
    if (today && Number.isFinite(today.temperature)) {
      const diff = Math.round(d.temperature - today.temperature);
      if (Math.abs(diff) >= 3) parts.push(diff > 0 ? `Dat is ${diff}° warmer dan vandaag.` : `Dat is ${-diff}° kouder dan vandaag.`);
    }
    return parts.filter(Boolean).join(" ");
  }
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

  /* ---- Drawing --------------------------------------------------------------------- */
  /* Where: the place of the forecast (Open-Meteo's entity is named after the
   * home zone, "Thuis in Rijnsburg") and Buienradar's station that measures now. */
  const STATION = "sensor.buienradar_stationname";
  function renderPlace() {
    const fc = Panel.st(FC_ID);
    const place = fc ? String((fc.attributes || {}).friendly_name || "").replace(/^thuis in\s+/i, "") : "";
    const station = String((Panel.st(STATION) || {}).state || "").replace(/\s*\(\d+\)$/, "");
    const parts = [place && `${icon("home")}${esc(place)}`, station && !/^(unknown|unavailable)$/.test(station) && `nu gemeten in ${esc(station)}`].filter(Boolean);
    $("wxPlace").innerHTML = parts.join(" · ");
    $("wxPlace").hidden = !parts.length;
  }
  function renderNow() {
    renderPlace();
    const s = Panel.st(NOW_ID);
    if (!s) return ($("wxNow").innerHTML = "");
    const a = s.attributes || {};
    $("wxNow").innerHTML =
      `<span class="wx-now-label">nu</span><span class="wx-now-ic">${Panel.wx.html()}</span>` +
      `<b>${Number.isFinite(Number(a.temperature)) ? fmt(Number(a.temperature), 1) + "°" : "–"}</b>` +
      `<span class="wx-now-cond">${esc(condNL(s.state))}</span>`;
    Panel.wx.apply($("wxNow"), s.state);
  }
  function renderDays() {
    if (!daily.length) {
      $("wxDays").innerHTML = `<p class="wx-empty">${loadedAt ? "Geen verwachting beschikbaar." : "Verwachting laden…"}</p>`;
      return;
    }
    const today = new Date();
    $("wxDays").innerHTML = daily
      .slice(0, 7)
      .map((d) => {
        const t = new Date(d.datetime);
        const name = sameDay(t, today) ? "Vandaag" : sameDay(t, tomorrow()) ? "Morgen" : DAYS_LONG[t.getDay()];
        const rain = d.precipitation || 0;
        const chance = Number.isFinite(d.precipitation_probability) ? d.precipitation_probability : NaN;
        return (
          `<div class="wx-day${sameDay(t, today) ? " today" : ""}">` +
          `<div class="wx-day-name"><span class="long">${esc(cap(name))}</span><span class="short">${esc(sameDay(t, today) ? "nu" : DAYS_SHORT[t.getDay()])}</span></div>` +
          Panel.wx.html() +
          `<div class="wx-day-t"><b>${Math.round(d.temperature)}°</b>${Number.isFinite(d.templow) ? `<span>${Math.round(d.templow)}°</span>` : ""}</div>` +
          `<div class="wx-day-rain${rain >= 0.2 || chance >= 50 ? " wet" : ""}">${
            rain >= 0.2 ? `${fmt(rain, rain < 10 ? 1 : 0)} mm` : chance >= 30 ? "buien" : "droog"
          }${Number.isFinite(chance) && chance >= 10 ? ` · ${chance}%` : ""}</div>` +
          `<div class="wx-day-wind">${Number.isFinite(beaufort(d.wind_speed)) ? `${beaufort(d.wind_speed)} Bft ${esc(dirOf(d.wind_bearing).replace("noord", "N").replace("zuid", "Z").replace("oost", "O").replace("west", "W").toUpperCase())}` : ""}</div>` +
          `</div>`
        );
      })
      .join("");
    $("wxDays").querySelectorAll(".wx-day").forEach((el, i) => Panel.wx.apply(el, daily[i].condition));
  }
  /* 48 hours: rain as bars from the bottom, the temperature as a line with its values. */
  function drawChart(progress = 1) {
    const canvas = $("wxChart");
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height;
    c.clearRect(0, 0, W, H);
    const hours = hourly.slice(0, 48);
    if (hours.length < 2) {
      c.fillStyle = Panel.cssVar("--text_dim");
      c.font = "600 14px Montserrat, system-ui, sans-serif";
      c.textAlign = "center";
      c.fillText(loadedAt ? "Geen uurverwachting" : "Laden…", W / 2, H / 2);
      return;
    }
    const L = 34, R = 8, T = 18, B = 24;
    const pw = W - L - R, ph = H - T - B;
    const temps = hours.map((h) => h.temperature);
    let lo = Math.floor(Math.min(...temps)) - 1, hi = Math.ceil(Math.max(...temps)) + 1;
    if (hi - lo < 6) {
      const m = (hi + lo) / 2;
      lo = Math.floor(m - 3);
      hi = Math.ceil(m + 3);
    }
    const x = (i) => L + (i / (hours.length - 1)) * pw;
    const y = (t) => T + (1 - (t - lo) / (hi - lo)) * ph;
    const dim = Panel.cssVar("--text_dim");
    const accent = Panel.cssVar("--accent");
    c.font = "600 11px Montserrat, system-ui, sans-serif";
    /* night: a soft band between sunset and sunrise (18-7 as a stand-in when sun.sun has no forecast) */
    hours.forEach((h, i) => {
      const hr = new Date(h.datetime).getHours();
      if (hr >= 20 || hr < 7) {
        c.fillStyle = "rgba(0, 0, 0, 0.18)";
        const step = pw / (hours.length - 1);
        c.fillRect(Math.floor(x(i) - step / 2), T, Math.ceil(step) + 1, ph); /* whole pixels, overlapping: no seams */
      }
    });
    /* the value axis */
    c.strokeStyle = "rgba(255, 255, 255, 0.07)";
    c.fillStyle = dim;
    c.textAlign = "right";
    for (let k = 0; k <= 3; k++) {
      const t = lo + ((hi - lo) * k) / 3;
      c.beginPath();
      c.moveTo(L, y(t));
      c.lineTo(W - R, y(t));
      c.stroke();
      c.fillText(`${Math.round(t)}°`, L - 6, y(t) + 4);
    }
    /* rain: bars from the bottom, 4 mm/h fills the plot */
    const shown = Math.max(1, Math.floor(hours.length * progress));
    const bw = Math.max(2, pw / hours.length - 2);
    hours.slice(0, shown).forEach((h, i) => {
      const mm = h.precipitation || 0;
      if (mm <= 0) return;
      const bh = Math.min(1, mm / 4) * ph;
      c.fillStyle = "rgba(100, 170, 255, 0.55)";
      c.fillRect(x(i) - bw / 2, T + ph - bh, bw, bh);
    });
    /* days and hours along the bottom */
    c.textAlign = "center";
    hours.forEach((h, i) => {
      const t = new Date(h.datetime);
      if (t.getHours() === 0 && i > 0) {
        c.strokeStyle = "rgba(255, 255, 255, 0.18)";
        c.beginPath();
        c.moveTo(x(i), T);
        c.lineTo(x(i), T + ph);
        c.stroke();
        c.fillStyle = Panel.cssVar("--text");
        c.fillText(DAYS_SHORT[t.getDay()], x(i), H - 6);
      } else if (t.getHours() % 6 === 0) {
        c.fillStyle = dim;
        c.fillText(`${t.getHours()}u`, x(i), H - 6);
      }
    });
    /* the temperature line */
    c.strokeStyle = accent;
    c.lineWidth = 2.5;
    c.lineJoin = "round";
    c.beginPath();
    hours.slice(0, shown).forEach((h, i) => (i ? c.lineTo(x(i), y(h.temperature)) : c.moveTo(x(i), y(h.temperature))));
    c.stroke();
    /* the highest and lowest of the period */
    if (progress >= 1) {
      const iMax = temps.indexOf(Math.max(...temps)), iMin = temps.indexOf(Math.min(...temps));
      for (const [i, up] of [[iMax, true], [iMin, false]]) {
        c.fillStyle = accent;
        c.beginPath();
        c.arc(x(i), y(temps[i]), 3.5, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = Panel.cssVar("--text");
        c.fillText(`${Math.round(temps[i])}°`, Math.min(W - R - 12, Math.max(L + 12, x(i))), y(temps[i]) + (up ? -9 : 17));
      }
    }
  }
  let anim = 0;
  function animateChart() {
    cancelAnimationFrame(anim);
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 700);
      drawChart(1 - Math.pow(1 - p, 3));
      if (p < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }
  function renderText() {
    const today = todayText(), tomorrow = tomorrowText();
    $("wxText").innerHTML =
      (today ? `<div class="wx-par"><h3>Vandaag</h3><p>${esc(today)}</p></div>` : "") +
      (tomorrow ? `<div class="wx-par"><h3>Morgen</h3><p>${esc(tomorrow)}</p></div>` : "") +
      (!today && !tomorrow ? `<p class="wx-empty">${loadedAt ? "Geen verwachting beschikbaar." : "Verwachting laden…"}</p>` : "");
  }
  function render(animate) {
    renderNow();
    renderDays();
    renderText();
    if (animate) animateChart();
    else drawChart(1);
  }

  const isOpen = () => !$("weather").hidden;
  Panel.openWeather = function () {
    Panel.openOverlay($("weather"));
    render(true);
    /* half an hour old or never loaded: fetch, the popup fills in when it arrives */
    if (Date.now() - loadedAt > 30 * 60e3) load().then(() => isOpen() && animateChart());
  };
  function close() {
    cancelAnimationFrame(anim);
    Panel.closeOverlay($("weather"));
  }
  $("wxClose").innerHTML = icon("close");
  $("wxClose").addEventListener("click", close);
  $("weather").addEventListener("click", (e) => e.target === $("weather") && close());
  window.addEventListener("resize", () => isOpen() && drawChart(1));
  Panel.track([NOW_ID, FC_ID, STATION, RAIN_2H, RAIN_2H_TOTAL].filter(Boolean), () => isOpen() && (renderNow(), renderText()));
  Panel.on("loaded", () => load());
  Panel.everyAwake(30 * 60e3, () => Panel.isLoaded() && load());
})();
