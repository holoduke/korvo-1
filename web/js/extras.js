/* Klimaat and Luchtkwaliteit popups (24 h chart + advice), the "AI oog"
 * screensaver, settings and the boot splash. Ends by booting the app. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /* ---- Chart ---------------------------------------------------------------------- */
  /* Magnus formula: saturation vapour pressure (hPa) -> absolute humidity g/m3. */
  function absHumidity(t, rh) {
    const es = 6.112 * Math.exp((17.62 * t) / (243.12 + t));
    return (216.7 * ((es * rh) / 100)) / (273.15 + t);
  }

  /* Readings over [start, now] as polyline segments. Sensors report on change,
   * so a value holds until the next one, but a silence longer than 2 h breaks
   * the line (same carry-forward rule as the panel). */
  function segments(id, start, now) {
    const pts = (Panel.hist[id] || []).filter((p) => p.t <= now);
    const HOLD = 2 * 3600e3;
    const segs = [];
    let cur = null;
    let prev = null;
    for (const p of pts) {
      if (p.t < start) {
        prev = p;
        continue;
      }
      if (prev && !cur) {
        if (p.t - prev.t <= HOLD) cur = [{ t: start, v: prev.v }];
        else cur = [];
      }
      if (!cur) cur = [];
      const last = cur.length ? cur[cur.length - 1] : prev;
      if (last && p.t - last.t > HOLD) {
        if (cur.length) cur.push({ t: last.t + HOLD, v: last.v });
        segs.push(cur);
        cur = [];
      } else if (last) {
        cur.push({ t: p.t, v: last.v }); /* step: hold, then jump */
      }
      cur.push(p);
      prev = p;
    }
    if (!cur && prev && now - prev.t <= HOLD) cur = [{ t: start, v: prev.v }];
    if (cur && cur.length) {
      const last = cur[cur.length - 1];
      cur.push({ t: Math.min(now, last.t + HOLD), v: last.v });
      segs.push(cur);
    }
    return segs;
  }

  /* Axis range rules per quantity. */
  const RANGES = {
    temp: (v) => {
      if (!v.length) return [15, 30];
      const lo = Math.trunc(Math.min(...v)) - 1;
      const hi = Math.trunc(Math.max(...v)) + 2;
      return [lo, Math.max(hi, lo + 4)];
    },
    hum: (v) =>
      v.length
        ? [Math.max(0, (Math.trunc(Math.min(...v) / 10) - 1) * 10), Math.min(100, (Math.trunc(Math.max(...v) / 10) + 2) * 10)]
        : [30, 70],
    co2: (v) => {
      if (!v.length) return [400, 1000];
      const lo = Math.max(300, Math.floor(Math.min(...v) / 100) * 100 - 100);
      const hi = Math.ceil(Math.max(...v) / 100) * 100 + 100;
      return [lo, Math.max(hi, lo + 400)];
    },
    pm: (v) => [0, v.length ? Math.max(20, Math.ceil(Math.max(...v) / 5) * 5 + 5) : 20],
  };

  /* spec: {left: {id, colour, range, fmt}, right: {...} | null, bands: [left-axis values]} */
  function drawChart(spec, progress) {
    const canvas = $("climChart");
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);

    const now = Date.now();
    /* Window: the last 24 h, or less for a sensor that has not been around that
     * long yet (a newly added device), in whole hours and at least 3. */
    const firstT = Math.min(...[spec.left, spec.right].filter(Boolean).map((s) => ((Panel.hist[s.id] || [])[0] || { t: now }).t));
    const spanH = Math.max(3, Math.min(24, Math.ceil((now - firstT) / 3600e3)));
    const start = now - spanH * 3600e3;
    const series = [spec.left, spec.right].filter(Boolean).map((s) => {
      const segs = segments(s.id, start, now);
      const vals = segs.flat().map((p) => p.v);
      return { ...s, segs, vals, range: s.range(vals) };
    });

    const L = 50, R = 50, T = 4, B = 26;
    const pw = W - L - R, ph = H - T - B;
    const xOf = (t) => L + ((t - start) / (now - start)) * pw;
    const yOf = (s) => (v) => T + ph - ((v - s.range[0]) / (s.range[1] - s.range[0])) * ph;

    c.fillStyle = css("--tile_off");
    c.beginPath();
    c.roundRect(L, T, pw, ph, 12);
    c.fill();
    c.strokeStyle = css("--grid");
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 1; i <= 3; i++) {
      const y = Math.round(T + (ph * i) / 4) + 0.5;
      c.moveTo(L + 8, y);
      c.lineTo(L + pw - 8, y);
    }
    for (let i = 1; i <= 5; i++) {
      const x = Math.round(L + (pw * i) / 6) + 0.5;
      c.moveTo(x, T + 8);
      c.lineTo(x, T + ph - 8);
    }
    c.stroke();

    /* Threshold lines (e.g. CO2 800/1200 ppm), dashed, in the status colours. */
    const left = series[0];
    (spec.bands || []).forEach((band) => {
      if (band.v <= left.range[0] || band.v >= left.range[1]) return;
      const y = Math.round(yOf(left)(band.v)) + 0.5;
      c.save();
      c.setLineDash([5, 5]);
      c.strokeStyle = band.colour;
      c.globalAlpha = 0.55;
      c.beginPath();
      c.moveTo(L + 8, y);
      c.lineTo(L + pw - 8, y);
      c.stroke();
      c.restore();
    });

    c.font = "600 14px Montserrat, system-ui, sans-serif";
    series.forEach((s, k) => {
      const side = k === 0 ? "right" : "left";
      const x = k === 0 ? L - 6 : L + pw + 6;
      c.textAlign = side;
      c.fillStyle = s.colour;
      c.textBaseline = "top";
      c.fillText(s.fmt(s.range[1]), x, T + 2);
      c.textBaseline = "bottom";
      c.fillText(s.fmt(s.range[0]), x, T + ph - 2);
    });

    /* Time axis: whole hours back from the last full hour (every 6 h on a full
     * day, closer together on a shorter window), at their true position. */
    c.textAlign = "center";
    c.textBaseline = "top";
    c.fillStyle = css("--text_dim");
    const stepH = spanH <= 4 ? 1 : spanH <= 8 ? 2 : spanH <= 12 ? 3 : 6;
    const mark = new Date(now);
    mark.setMinutes(0, 0, 0);
    for (let m = mark.getTime(); m >= start; m -= stepH * 3600e3) {
      if (xOf(m) < L + 18) break; /* would collide with the axis labels */
      c.fillText(String(new Date(m).getHours()).padStart(2, "0") + ":00", xOf(m), T + ph + 6);
    }

    /* Lines, revealed left to right while the popup opens; the left series is
     * drawn last (on top) with a soft area fill. */
    c.save();
    c.beginPath();
    c.rect(L, 0, pw * progress, H);
    c.clip();
    c.lineJoin = "round";
    c.lineCap = "round";
    const path = (seg, y) => seg.forEach((p, i) => (i ? c.lineTo(xOf(p.t), y(p.v)) : c.moveTo(xOf(p.t), y(p.v))));
    [...series].reverse().forEach((s) => {
      const y = yOf(s);
      const fill = s === left;
      for (const seg of s.segs) {
        if (!seg.length) continue;
        if (fill) {
          const g = c.createLinearGradient(0, T, 0, T + ph);
          g.addColorStop(0, s.colour + "38");
          g.addColorStop(1, s.colour + "00");
          c.beginPath();
          path(seg, y);
          c.lineTo(xOf(seg[seg.length - 1].t), T + ph);
          c.lineTo(xOf(seg[0].t), T + ph);
          c.closePath();
          c.fillStyle = g;
          c.fill();
        }
        c.beginPath();
        path(seg, y);
        c.strokeStyle = s.colour;
        c.lineWidth = 3;
        c.stroke();
      }
    });
    c.restore();
    series.spanH = spanH;
    return series;
  }

  /* ---- Klimaat / Luchtkwaliteit popup ----------------------------------------- */
  let popup = null; /* {kind: "climate"|"air", idx} */
  let chartAnim = 0;

  function climateSpec(s) {
    return {
      left: { id: s.temp, colour: css("--accent"), range: RANGES.temp, fmt: (v) => v + "°" },
      right: s.humidity ? { id: s.humidity, colour: css("--hum"), range: RANGES.hum, fmt: (v) => v + "%" } : null,
    };
  }
  function airSpec(a) {
    return {
      left: { id: a.co2, colour: css("--accent"), range: RANGES.co2, fmt: (v) => String(v) },
      right: { id: a.pm25, colour: css("--scene_on"), range: RANGES.pm, fmt: (v) => String(v) },
      bands: [
        { v: cfg.airBands.co2Good, colour: css("--warn") },
        { v: cfg.airBands.co2Poor, colour: css("--bad") },
      ],
    };
  }

  function draw(progress) {
    if (!popup) return;
    const title = (label, res) => ($("climTitle").textContent = `${label}  •  laatste ${res.spanH} uur`);
    if (popup.kind === "climate") {
      const res = drawChart(climateSpec(cfg.sensors[popup.idx]), progress);
      const [t, h] = res;
      title(cfg.sensors[popup.idx].label, res);
      const range = $("climRange");
      if (t.vals.length && h && h.vals.length) {
        range.innerHTML =
          `<span class="part">Min ${Math.min(...t.vals).toFixed(1)}°&nbsp; Max ${Math.max(...t.vals).toFixed(1)}°</span>` +
          `<span class="part">${icon("drop")} ${Math.round(Math.min(...h.vals))}% - ${Math.round(Math.max(...h.vals))}%</span>`;
      } else if (t.vals.length) {
        range.textContent = `Min ${Math.min(...t.vals).toFixed(1)}°  Max ${Math.max(...t.vals).toFixed(1)}°`;
      } else {
        range.textContent = "Nog geen geschiedenis (wordt opgehaald)";
      }
    } else {
      const res = drawChart(airSpec(cfg.air[popup.idx]), progress);
      const [co2, pm] = res;
      title(cfg.air[popup.idx].label, res);
      const range = $("climRange");
      const parts = [];
      if (co2.vals.length) parts.push(`<span class="part"><b class="k" style="color:${css("--accent")}">CO2</b> ${Math.round(Math.min(...co2.vals))} - ${Math.round(Math.max(...co2.vals))} ppm</span>`);
      if (pm.vals.length) parts.push(`<span class="part"><b class="k" style="color:${css("--scene_on")}">PM2.5</b> ${Math.round(Math.min(...pm.vals))} - ${Math.round(Math.max(...pm.vals))} µg/m³</span>`);
      range.innerHTML = parts.length ? parts.join("") : "Nog geen geschiedenis (wordt opgehaald)";
    }
  }

  function setAdvice(kind, html) {
    const adv = $("climAdvice");
    adv.className = "clim-advice" + (kind ? " " + kind : "");
    adv.innerHTML = html;
  }

  function renderClimateText(i) {
    const s = cfg.sensors[i];
    const t = Panel.num(s.temp);
    const h = s.humidity ? Panel.num(s.humidity) : NaN;
    $("climNow").innerHTML = Number.isFinite(t)
      ? `${t.toFixed(1)}°` + (Number.isFinite(h) ? `&ensp;${icon("drop")}${Math.round(h)}%` : "")
      : "--";

    const out = cfg.sensors.find((x) => !x.indoor);
    if (!s.indoor) {
      setAdvice("dim", Number.isFinite(t) && Number.isFinite(h) ? `Buitenlucht bevat ${absHumidity(t, h).toFixed(1)} g/m³ vocht` : "");
      return;
    }
    const ot = out ? Panel.num(out.temp) : NaN;
    const oh = out && out.humidity ? Panel.num(out.humidity) : NaN;
    if (![t, h, ot, oh].every(Number.isFinite)) return setAdvice("", "");
    const ahIn = absHumidity(t, h);
    const ahOut = absHumidity(ot, oh);
    const d = ahIn - ahOut;
    const c = cfg.comfort;
    if (h <= c.humMax && h >= c.humMin && d < 1) {
      setAdvice("ok", `Vochtigheid is goed (${ahIn.toFixed(1)} g/m³ binnen, ${ahOut.toFixed(1)} buiten)`);
    } else if (d >= 1) {
      setAdvice("ok", `${icon("check")} Ventileren helpt: buitenlucht is droger (${ahOut.toFixed(1)} vs ${ahIn.toFixed(1)} g/m³)`);
    } else if (d <= -1) {
      setAdvice("warn", `${icon("warning")} Niet ventileren: buitenlucht is vochtiger (${ahOut.toFixed(1)} vs ${ahIn.toFixed(1)} g/m³)`);
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
    $("climNow").innerHTML = q ? `<span class="aq-badge" style="color:${q[1]}"><i style="background:${q[1]}"></i>${q[0]}</span>` : "";

    /* label: text, or [long, short] where the short form is used on phones. */
    const stat = (label, value, colour) => {
      const l = Array.isArray(label) ? `<span class="l-long">${label[0]}</span><span class="l-short">${label[1]}</span>` : label;
      return `<div class="stat"><div class="stat-v" style="color:${colour}">${value}</div><div class="stat-l">${l}</div></div>`;
    };
    const fin = Number.isFinite;
    const stats = $("climStats");
    stats.innerHTML =
      stat("CO2", fin(co2) ? `${Math.round(co2)}<small>ppm</small>` : "--", fin(co2) ? Panel.co2Colour(co2) : "var(--text_dim)") +
      stat("PM2.5", fin(pm) ? `${Math.round(pm)}<small>µg/m³</small>` : "--", fin(pm) ? Panel.pmColour(pm) : "var(--text_dim)") +
      stat("Kwaliteit", q ? q[0] : "--", q ? q[1] : "var(--text_dim)") +
      stat(["Temperatuur", "Temp"], fin(t) ? `${t.toFixed(1)}°` : "--", fin(t) ? Panel.comfortTemp(t, true) : "var(--text_dim)") +
      stat(["Vochtigheid", "Vocht"], fin(h) ? `${Math.round(h)}%` : "--", fin(h) ? Panel.comfortHum(h, true) : "var(--text_dim)");

    const ab = cfg.airBands;
    const raw = parseFloat((Panel.st(a.co2) || {}).state);
    if (Number.isFinite(raw) && !fin(co2)) {
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

  function renderText() {
    if (!popup) return;
    if (popup.kind === "climate") renderClimateText(popup.idx);
    else renderAirText(popup.idx);
  }

  function openPopup(kind, idx) {
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
  Panel.openClimate = (i) => openPopup("climate", i);
  Panel.openAir = (i) => openPopup("air", i);

  const popupOpen = () => popup && !$("climate").hidden;
  function closePopup() {
    popup = null;
    Panel.closeOverlay($("climate"));
  }
  $("climClose").innerHTML = icon("close");
  $("climClose").addEventListener("click", closePopup);
  $("climate").addEventListener("click", (e) => e.target === $("climate") && closePopup());
  $("sensors").addEventListener("click", (e) => {
    const col = e.target.closest("[data-sensor]");
    const air = e.target.closest("[data-air]");
    const vac = e.target.closest("[data-vachdr]");
    if (col) Panel.openClimate(+col.dataset.sensor);
    else if (air) Panel.openAir(+air.dataset.air);
    else if (vac) Panel.setSection(cfg.sections.findIndex((s) => s.kind === "vacuum"), true);
  });
  window.addEventListener("resize", () => popupOpen() && draw(1));

  /* ---- Keep the screen on (wall tablet) ---------------------------------------- */
  /* While the app is open the display stays on, like the panel. In the
   * "Scherm uit" screensaver mode the lock is released so the tablet's own
   * auto-lock can switch the display off. The browser drops the lock whenever
   * the page is hidden, so it is taken again on return and on the next touch. */
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && "wakeLock" in navigator && document.visibilityState === "visible") {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => (wakeLock = null));
      } else if (!on && wakeLock) {
        const l = wakeLock;
        wakeLock = null;
        await l.release();
      }
    } catch (e) {
      wakeLock = null; /* not supported, or refused (e.g. low power mode) */
    }
  }
  const wantAwake = () => $("saver").hidden || Panel.prefs.saverMode !== 0;
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && keepAwake(wantAwake()));
  window.addEventListener("pointerdown", () => keepAwake(wantAwake()), { passive: true, capture: true });
  Panel.keepAwake = keepAwake;

  /* ---- Screensaver --------------------------------------------------------------- */
  let lastActivity = Date.now();
  let flickerTimer = 0;
  ["pointerdown", "keydown", "wheel"].forEach((ev) =>
    window.addEventListener(ev, () => (lastActivity = Date.now()), { capture: true, passive: true })
  );
  /* ms since the last touch, key or wheel; update.js waits for a quiet panel. */
  Panel.idleFor = () => Date.now() - lastActivity;

  function renderSaverTemps() {
    const temps = cfg.sensors.map((s) => {
      const t = Panel.num(s.temp);
      return `<span>${s.abbr}</span><span class="v">${Number.isFinite(t) ? t.toFixed(1) + "°" : "-.-°"}</span>`;
    });
    const air = cfg.air.map((a) => {
      const v = Panel.num(a.co2);
      return `<span>${a.abbr}</span><span class="v">${Number.isFinite(v) ? Math.round(v) : "---"}</span>`;
    });
    $("eyeTemps").innerHTML = temps.concat(air).join("");
  }

  function renderSaverMedia() {
    const box = $("eyeMedia");
    const strip = (v) => (v || "").split(" •")[0];
    for (const m of cfg.media) {
      const s = Panel.st(m.id);
      if (!s || s.state !== "playing") continue;
      const title = strip(s.attributes.media_title);
      const artist = strip(s.attributes.media_artist);
      box.querySelector(".where").innerHTML = `${icon("music")}<span>${m.label}</span>`;
      box.querySelector(".what").textContent = artist && title ? `${artist}  -  ${title}` : title;
      box.hidden = false;
      return;
    }
    box.hidden = true;
  }

  function scheduleFlicker() {
    clearTimeout(flickerTimer);
    flickerTimer = setTimeout(() => {
      const glow = document.querySelector(".eye-glow");
      const times = Math.random() < 0.3 ? 2 : 1;
      let n = 0;
      const once = () => {
        glow.classList.remove("flicker");
        void glow.offsetWidth; /* restart the animation */
        glow.classList.add("flicker");
        if (++n < times) setTimeout(once, 260);
      };
      once();
      scheduleFlicker();
    }, 4000 + Math.random() * 5000);
  }

  Panel.showSaver = function () {
    const saver = $("saver");
    if (!saver.hidden) return;
    saver.classList.toggle("off", Panel.prefs.saverMode === 0);
    renderSaverTemps();
    renderSaverMedia();
    ["popup", "climate", "settings"].forEach((id) => ($(id).hidden = true));
    popup = null;
    Panel.closeDrawer();
    saver.hidden = false;
    if (Panel.prefs.saverMode === 1) scheduleFlicker();
    keepAwake(Panel.prefs.saverMode !== 0);
  };
  function hideSaver() {
    $("saver").hidden = true;
    clearTimeout(flickerTimer);
    lastActivity = Date.now();
    keepAwake(true);
  }
  $("saver").addEventListener("click", hideSaver);
  setInterval(() => {
    const limit = Panel.SAVER_TIMES[Panel.prefs.saverIdx] || 300e3;
    /* Not while the splash is still up: the app hasn't been seen yet. */
    if ($("saver").hidden && !$("splash") && Date.now() - lastActivity > limit) Panel.showSaver();
  }, 1000);

  Panel.onMinute = () => !$("saver").hidden && renderSaverTemps();
  Panel.onMedia = () => !$("saver").hidden && renderSaverMedia();
  Panel.onSensor = () => {
    if (popupOpen()) {
      renderText();
      draw(1);
    }
  };
  Panel.onHistory = () => popupOpen() && draw(1);

  /* ---- Settings ------------------------------------------------------------------ */
  function renderSettings() {
    $("themeList").innerHTML = cfg.themes
      .map(
        (t, i) =>
          `<button class="theme-card${i === Panel.prefs.theme ? " selected" : ""}" data-theme="${i}" style="background:${t.bg};color:${t.text}">` +
          `<span class="tc-dots"><i style="background:${t.tile}"></i><i style="background:${t.tile_on}"></i><i style="background:${t.scene_on}"></i><i style="background:${t.accent}"></i></span>` +
          `<span class="tc-name">${t.name}</span></button>`
      )
      .join("");
    const seg = (el, labels, sel, key) =>
      ($(el).innerHTML = labels.map((l, i) => `<button class="${i === sel ? "selected" : ""}" data-${key}="${i}">${l}</button>`).join(""));
    seg("saverMode", ["Scherm uit", "AI oog"], Panel.prefs.saverMode, "mode");
    seg("saverTime", Panel.SAVER_LABELS, Panel.prefs.saverIdx, "time");
    const c = Panel.client;
    const connected = $("status").classList.contains("connected");
    $("connInfo").textContent = c.demo
      ? "Demo-modus: nepdata, er gaan geen echte lampen aan of uit"
      : `${connected ? "Verbonden met" : "Niet verbonden met"} ${c.hassUrl()}`;
    $("connInfo").style.color = c.demo ? "var(--text_dim)" : connected ? "var(--ok)" : "var(--warn)";
    $("logout").innerHTML = icon("logout") + (c.demo ? "Demo verlaten" : "Uitloggen");
  }
  $("gear").addEventListener("click", () => {
    renderSettings();
    Panel.openOverlay($("settings"));
  });
  $("settingsClose").innerHTML = icon("close");
  $("settingsClose").addEventListener("click", () => Panel.closeOverlay($("settings")));
  $("settings").addEventListener("click", (e) => {
    if (e.target === $("settings")) return Panel.closeOverlay($("settings"));
    const th = e.target.closest("[data-theme]");
    const md = e.target.closest("[data-mode]");
    const tm = e.target.closest("[data-time]");
    if (th) {
      Panel.setPref("theme", +th.dataset.theme);
      Panel.applyTheme(+th.dataset.theme);
    }
    if (md) Panel.setPref("saverMode", +md.dataset.mode);
    if (tm) Panel.setPref("saverIdx", +tm.dataset.time);
    if (th || md || tm) renderSettings();
  });
  $("logout").addEventListener("click", () => Panel.client.logout());

  /* ---- Splash -------------------------------------------------------------------- */
  const bootAt = performance.now();
  const splashText = {
    connecting: "Verbinden met Home Assistant",
    connected: "Lampen en sensoren laden",
    disconnected: "Geen verbinding, opnieuw proberen",
    "auth-error": "Opnieuw inloggen",
  };
  const splashPct = { connecting: 40, connected: 80 };
  Panel.onStatus = (s) => {
    if (!$("splash")) return; /* removed after the first successful load */
    $("splashStatus").textContent = splashText[s] || "";
    if (splashPct[s]) $("splashFill").style.width = splashPct[s] + "%";
  };
  Panel.onReady = () => {
    const splash = $("splash");
    if (!splash) return;
    $("splashFill").style.width = "100%";
    /* Short minimum so the loader reads as intentional, not a flash. */
    setTimeout(() => {
      splash.classList.add("gone");
      setTimeout(() => splash.remove(), 520);
      lastActivity = Date.now();
      keepAwake(true);
    }, Math.max(350, 1100 - (performance.now() - bootAt)));
  };

  Panel.initExtras = function () {
    $("splashFill").style.width = "15%";
  };

  Panel.boot();
})();
