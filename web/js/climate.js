/* Klimaat and Luchtkwaliteit popups, opened from the header's climate and air
 * columns: the last 24 h as a chart, the current values and advice (whether
 * ventilating helps, CO2 and fine dust). */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;
  const css = Panel.cssVar;
  const ranges = Panel.chartRanges;

  let popup = null; /* {kind: "climate"|"air", idx} */
  let chartAnim = 0;
  const isOpen = () => popup && !$("climate").hidden;

  /* Magnus formula: saturation vapour pressure (hPa) -> absolute humidity g/m3. */
  function absHumidity(t, rh) {
    const es = 6.112 * Math.exp((17.62 * t) / (243.12 + t));
    return (216.7 * ((es * rh) / 100)) / (273.15 + t);
  }

  /* Each series has its own colour for its axis and legend (and for its line
   * outdoors); indoors and for air the line takes the colour of its band. The
   * second series is dashed. */
  const PM_COLOUR = "#c792ea";
  /* Everything that has a climate chart: the header's sensors first (so a
   * header column's index is its own), then the climate cards that are not in
   * the header, such as the bedrooms upstairs. */
  const SOURCES = [
    ...cfg.sensors,
    ...(cfg.sensorCards || [])
      .filter((c) => c.kind === "climate" && c.entities.temperature && !cfg.sensors.some((s) => s.temp === c.entities.temperature))
      .map((c) => ({ temp: c.entities.temperature, humidity: c.entities.humidity || null, label: c.label, indoor: !/buiten/i.test(c.label) })),
  ];
  /* their day of readings, for the chart */
  Panel.keepHistory(SOURCES.slice(cfg.sensors.length).flatMap((s) => [s.temp, s.humidity]));
  function spec() {
    if (popup.kind === "climate") {
      const s = SOURCES[popup.idx];
      return {
        left: { id: s.temp, colour: css("--accent"), bands: s.indoor ? Panel.bands.temp : null, range: ranges.temp, fmt: (v) => v + "°" },
        right: s.humidity
          ? { id: s.humidity, colour: css("--hum"), bands: s.indoor ? Panel.bands.hum : null, dashed: true, range: ranges.hum, fmt: (v) => v + "%" }
          : null,
      };
    }
    const a = cfg.air[popup.idx];
    return {
      left: { id: a.co2, colour: css("--text"), bands: Panel.bands.co2, range: ranges.co2, fmt: (v) => String(v) },
      right: { id: a.pm25, colour: PM_COLOUR, bands: Panel.bands.pm, dashed: true, range: ranges.pm, fmt: (v) => String(v) },
      thresholds: [
        { v: cfg.airBands.co2Good, colour: css("--warn") },
        { v: cfg.airBands.co2Poor, colour: css("--bad") },
      ],
    };
  }
  /* A legend mark: the series' line style in its colour. */
  const mark = (s) => `<i class="lg${s.dashed ? " dashed" : ""}" style="--c:${s.colour}"></i>`;

  const span = (vals, digits, unit) => {
    const [lo, hi] = Util.minMax(vals);
    return `${Util.fmt(lo, digits)}${unit} - ${Util.fmt(hi, digits)}${unit}`;
  };

  function draw(progress) {
    if (!popup) return;
    const { series, spanH } = Panel.drawChart($("climChart"), spec(), progress);
    const conf = popup.kind === "climate" ? SOURCES[popup.idx] : cfg.air[popup.idx];
    $("climTitle").textContent = `${conf.label}  •  laatste ${spanH} uur`;
    const [a, b] = series;
    const range = $("climRange");
    if (popup.kind === "climate") {
      if (a.vals.length && b && b.vals.length) {
        range.innerHTML =
          `<span class="part">${mark(a)}Min ${Util.fmt(Util.minMax(a.vals)[0], 1)}°&nbsp; Max ${Util.fmt(Util.minMax(a.vals)[1], 1)}°</span>` +
          `<span class="part">${mark(b)}${icon("drop")} ${span(b.vals, 0, "%")}</span>`;
      } else if (a.vals.length) {
        range.innerHTML = `<span class="part">${mark(a)}Min ${Util.fmt(Util.minMax(a.vals)[0], 1)}°&nbsp; Max ${Util.fmt(Util.minMax(a.vals)[1], 1)}°</span>`;
      } else {
        range.textContent = "Nog geen geschiedenis (wordt opgehaald)";
      }
    } else {
      const parts = [];
      if (a.vals.length) parts.push(`<span class="part">${mark(a)}<b class="k">CO2</b> ${Math.round(Util.minMax(a.vals)[0])} - ${Math.round(Util.minMax(a.vals)[1])} ppm</span>`);
      if (b.vals.length) parts.push(`<span class="part">${mark(b)}<b class="k">PM2.5</b> ${Math.round(Util.minMax(b.vals)[0])} - ${Math.round(Util.minMax(b.vals)[1])} µg/m³</span>`);
      range.innerHTML = parts.length ? parts.join("") : "Nog geen geschiedenis (wordt opgehaald)";
    }
  }

  function setAdvice(kind, html) {
    const adv = $("climAdvice");
    adv.className = "clim-advice" + (kind ? " " + kind : "");
    adv.innerHTML = html;
  }

  function renderClimateText(i) {
    const s = SOURCES[i];
    const t = Panel.num(s.temp);
    const h = s.humidity ? Panel.num(s.humidity) : NaN;
    $("climNow").innerHTML = Number.isFinite(t) ? `${Util.fmt(t, 1)}°` + (Number.isFinite(h) ? `&ensp;${icon("drop")}${Math.round(h)}%` : "") : "--";

    if (!s.indoor) {
      setAdvice("dim", Number.isFinite(t) && Number.isFinite(h) ? `Buitenlucht bevat ${Util.fmt(absHumidity(t, h), 1)} g/m³ vocht` : "");
      return;
    }
    const out = cfg.sensors.find((x) => !x.indoor);
    const ot = out ? Panel.num(out.temp) : NaN;
    const oh = out && out.humidity ? Panel.num(out.humidity) : NaN;
    if (![t, h, ot, oh].every(Number.isFinite)) return setAdvice("", "");
    const ahIn = absHumidity(t, h);
    const ahOut = absHumidity(ot, oh);
    const d = ahIn - ahOut;
    const c = cfg.comfort;
    if (h <= c.humMax && h >= c.humMin && d < 1) {
      setAdvice("ok", `Vochtigheid is goed (${Util.fmt(ahIn, 1)} g/m³ binnen, ${Util.fmt(ahOut, 1)} buiten)`);
    } else if (d >= 1) {
      setAdvice("ok", `${icon("check")} Ventileren helpt: buitenlucht is droger (${Util.fmt(ahOut, 1)} vs ${Util.fmt(ahIn, 1)} g/m³)`);
    } else if (d <= -1) {
      setAdvice("warn", `${icon("warning")} Niet ventileren: buitenlucht is vochtiger (${Util.fmt(ahOut, 1)} vs ${Util.fmt(ahIn, 1)} g/m³)`);
    } else {
      setAdvice("dim", "Ventileren maakt nu weinig verschil");
    }
  }

  function renderAirText(i) {
    const a = cfg.air[i];
    const co2 = Panel.num(a.co2);
    const pm = Panel.num(a.pm25);
    const t = Panel.num(a.temp);
    const h = Panel.num(a.humidity);
    const q = Panel.quality(a.quality);
    const fin = Number.isFinite;
    $("climNow").innerHTML = q ? `<span class="aq-badge" style="color:${q[1]}"><i style="background:${q[1]}"></i>${q[0]}</span>` : "";

    /* label: text, or [long, short] where the short form is used on phones. */
    const stat = (label, value, colour) => {
      const l = Array.isArray(label) ? `<span class="l-long">${label[0]}</span><span class="l-short">${label[1]}</span>` : label;
      return `<div class="stat"><div class="stat-v" style="color:${colour}">${value}</div><div class="stat-l">${l}</div></div>`;
    };
    $("climStats").innerHTML =
      stat("CO2", fin(co2) ? `${Math.round(co2)}<small>ppm</small>` : "--", fin(co2) ? Panel.co2Colour(co2) : "var(--text_dim)") +
      stat("PM2.5", fin(pm) ? `${Math.round(pm)}<small>µg/m³</small>` : "--", fin(pm) ? Panel.pmColour(pm) : "var(--text_dim)") +
      stat("Kwaliteit", q ? q[0] : "--", q ? q[1] : "var(--text_dim)") +
      stat(["Temperatuur", "Temp"], fin(t) ? `${Util.fmt(t, 1)}°` : "--", fin(t) ? Panel.comfortTemp(t, true) : "var(--text_dim)") +
      stat(["Vochtigheid", "Vocht"], fin(h) ? `${Math.round(h)}%` : "--", fin(h) ? Panel.comfortHum(h, true) : "var(--text_dim)");

    const ab = cfg.airBands;
    const raw = parseFloat((Panel.st(a.co2) || {}).state);
    if (fin(raw) && !fin(co2)) {
      setAdvice("dim", "CO2-sensor warmt op na een herstart, even geduld");
    } else if (fin(pm) && pm > ab.pm25Poor) {
      setAdvice("warn", `${icon("warning")} Veel fijnstof (${Math.round(pm)} µg/m³): afzuigkap aan en goed doorluchten`);
    } else if (fin(co2) && co2 > ab.co2Poor) {
      setAdvice("warn", `${icon("warning")} Ventileer nu: CO2 is hoog (${Math.round(co2)} ppm)`);
    } else if (fin(co2) && co2 > ab.co2Good) {
      setAdvice("warn", `Even ventileren: CO2 loopt op (${Math.round(co2)} ppm)`);
    } else if (fin(pm) && pm > ab.pm25Good) {
      setAdvice("warn", `Iets verhoogd fijnstof (${Math.round(pm)} µg/m³)`);
    } else if (fin(co2) || fin(pm)) {
      setAdvice("ok", `${icon("check")} Frisse lucht${fin(co2) ? `: ${Math.round(co2)} ppm CO2` : ""}`);
    } else {
      setAdvice("dim", "Nog geen metingen (apparaat niet bereikbaar)");
    }
  }

  const renderText = () => (popup.kind === "climate" ? renderClimateText(popup.idx) : renderAirText(popup.idx));

  function open(kind, idx) {
    popup = { kind, idx };
    $("climate").querySelector(".box").classList.toggle("air", kind === "air");
    $("climStats").hidden = kind !== "air";
    Panel.openOverlay($("climate"));
    renderText();
    cancelAnimationFrame(chartAnim);
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 520);
      draw(1 - Math.pow(1 - p, 3));
      if (p < 1) chartAnim = requestAnimationFrame(step);
    };
    chartAnim = requestAnimationFrame(step);
  }
  Panel.openClimate = (i) => open("climate", i);
  /* By the temperature entity: any climate sensor, in the header or not. */
  Panel.openClimateFor = (tempId) => {
    const i = SOURCES.findIndex((s) => s.temp === tempId);
    if (i >= 0) open("climate", i);
    return i >= 0;
  };
  Panel.openAir = (i) => open("air", i);

  function close() {
    popup = null;
    Panel.closeOverlay($("climate"));
  }
  $("climClose").innerHTML = icon("close");
  $("climClose").addEventListener("click", close);
  $("climate").addEventListener("click", (e) => e.target === $("climate") && close());
  window.addEventListener("resize", () => isOpen() && draw(1));

  Panel.on("reading", (id) => {
    if (!isOpen()) return;
    const s = spec();
    const out = cfg.sensors.find((x) => !x.indoor) || {}; /* the advice compares with outdoors */
    /* An air popup also shows the monitor's own temp/humidity/quality tiles, which
     * aren't the charted co2/pm series, so watch them too or those tiles go stale. */
    const air = popup.kind === "air" ? cfg.air[popup.idx] : {};
    if (![s.left, s.right].some((line) => line && line.id === id) && ![out.temp, out.humidity, air.temp, air.humidity, air.quality].includes(id)) return; /* another sensor */
    renderText();
    draw(1);
  });
  Panel.on("history", () => isOpen() && draw(1));
})();
