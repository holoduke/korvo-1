/* Klimaat popup (24 h chart + ventilation advice), the "AI oog" screensaver,
 * settings and the boot splash. Ends by booting the app. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /* ---- Klimaat ----------------------------------------------------------------- */
  /* Magnus formula: saturation vapour pressure (hPa) -> absolute humidity g/m3. */
  function absHumidity(t, rh) {
    const es = 6.112 * Math.exp((17.62 * t) / (243.12 + t));
    return (216.7 * ((es * rh) / 100)) / (273.15 + t);
  }

  let climIdx = -1;
  let climAnim = 0;

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

  function drawClimate(progress) {
    const s = cfg.sensors[climIdx];
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
    const start = now - 24 * 3600e3;
    const tSeg = segments(s.temp, start, now);
    const hSeg = s.humidity ? segments(s.humidity, start, now) : [];
    const tv = tSeg.flat().map((p) => p.v);
    const hv = hSeg.flat().map((p) => p.v);

    let ylo = 15, yhi = 30, hlo = 30, hhi = 70;
    if (tv.length) {
      ylo = Math.trunc(Math.min(...tv)) - 1;
      yhi = Math.trunc(Math.max(...tv)) + 2;
      if (yhi - ylo < 4) yhi = ylo + 4;
    }
    if (hv.length) {
      hlo = Math.max(0, (Math.trunc(Math.min(...hv) / 10) - 1) * 10);
      hhi = Math.min(100, (Math.trunc(Math.max(...hv) / 10) + 2) * 10);
    }

    const L = 50, R = 50, T = 4, B = 26;
    const pw = W - L - R, ph = H - T - B;
    const xOf = (t) => L + ((t - start) / (now - start)) * pw;
    const yT = (v) => T + ph - ((v - ylo) / (yhi - ylo)) * ph;
    const yH = (v) => T + ph - ((v - hlo) / (hhi - hlo)) * ph;

    /* Plot background + division lines (3 horizontal, 5 vertical). */
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

    /* Axis labels: temperature left in the accent colour, humidity right. */
    c.font = "600 14px Montserrat, system-ui, sans-serif";
    c.textBaseline = "top";
    c.textAlign = "right";
    c.fillStyle = css("--accent");
    c.fillText(yhi + "°", L - 6, T + 2);
    c.textBaseline = "bottom";
    c.fillText(ylo + "°", L - 6, T + ph - 2);
    c.textAlign = "left";
    c.fillStyle = css("--hum");
    c.fillText(hlo + "%", L + pw + 6, T + ph - 2);
    c.textBaseline = "top";
    c.fillText(hhi + "%", L + pw + 6, T + 2);

    /* Time axis: whole hours every 6 h back from the last full hour, at their
     * true position on the 24 h span. */
    c.textAlign = "center";
    c.fillStyle = css("--text_dim");
    const mark = new Date(now);
    mark.setMinutes(0, 0, 0);
    for (let m = mark.getTime(), i = 0; i < 5 && m >= start; i++, m -= 6 * 3600e3) {
      c.fillText(String(new Date(m).getHours()).padStart(2, "0") + ":00", xOf(m), T + ph + 6);
    }

    /* Lines, revealed left to right while the popup opens. */
    c.save();
    c.beginPath();
    c.rect(L, 0, pw * progress, H);
    c.clip();
    c.lineJoin = "round";
    c.lineCap = "round";
    const line = (segs, yOf, colour, width, fill) => {
      for (const seg of segs) {
        if (!seg.length) continue;
        c.beginPath();
        seg.forEach((p, i) => (i ? c.lineTo(xOf(p.t), yOf(p.v)) : c.moveTo(xOf(p.t), yOf(p.v))));
        if (fill) {
          const g = c.createLinearGradient(0, T, 0, T + ph);
          g.addColorStop(0, colour + "38");
          g.addColorStop(1, colour + "00");
          c.save();
          c.lineTo(xOf(seg[seg.length - 1].t), T + ph);
          c.lineTo(xOf(seg[0].t), T + ph);
          c.closePath();
          c.fillStyle = g;
          c.fill();
          c.restore();
          c.beginPath();
          seg.forEach((p, i) => (i ? c.lineTo(xOf(p.t), yOf(p.v)) : c.moveTo(xOf(p.t), yOf(p.v))));
        }
        c.strokeStyle = colour;
        c.lineWidth = width;
        c.stroke();
      }
    };
    line(hSeg, yH, css("--hum"), 3, false);
    line(tSeg, yT, css("--accent"), 3, true);
    c.restore();

    /* Readouts below the chart. */
    const tmin = tv.length ? Math.min(...tv) : NaN, tmax = tv.length ? Math.max(...tv) : NaN;
    const range = $("climRange");
    if (tv.length && hv.length) {
      range.innerHTML = `Min ${tmin.toFixed(1)}°&nbsp; Max ${tmax.toFixed(1)}°&emsp;&emsp;${icon("drop")} ${Math.round(Math.min(...hv))}% - ${Math.round(Math.max(...hv))}%`;
    } else if (tv.length) {
      range.textContent = `Min ${tmin.toFixed(1)}°  Max ${tmax.toFixed(1)}°`;
    } else {
      range.textContent = "Nog geen geschiedenis (wordt opgehaald)";
    }
  }

  function renderClimateText() {
    const s = cfg.sensors[climIdx];
    const t = Panel.num(s.temp);
    const h = s.humidity ? Panel.num(s.humidity) : NaN;
    $("climTitle").textContent = `${s.label}  •  laatste 24 uur`;
    $("climNow").innerHTML = Number.isFinite(t)
      ? `${t.toFixed(1)}°` + (Number.isFinite(h) ? `&ensp;${icon("drop")}${Math.round(h)}%` : "")
      : "--";

    const adv = $("climAdvice");
    adv.className = "clim-advice";
    const out = cfg.sensors.find((x) => !x.indoor);
    if (!s.indoor) {
      adv.classList.add("dim");
      adv.textContent = Number.isFinite(t) && Number.isFinite(h) ? `Buitenlucht bevat ${absHumidity(t, h).toFixed(1)} g/m³ vocht` : "";
      return;
    }
    const ot = out ? Panel.num(out.temp) : NaN;
    const oh = out && out.humidity ? Panel.num(out.humidity) : NaN;
    if (![t, h, ot, oh].every(Number.isFinite)) {
      adv.textContent = "";
      return;
    }
    const ahIn = absHumidity(t, h);
    const ahOut = absHumidity(ot, oh);
    const d = ahIn - ahOut;
    const c = cfg.comfort;
    if (h <= c.humMax && h >= c.humMin && d < 1) {
      adv.classList.add("ok");
      adv.textContent = `Vochtigheid is goed (${ahIn.toFixed(1)} g/m³ binnen, ${ahOut.toFixed(1)} buiten)`;
    } else if (d >= 1) {
      adv.classList.add("ok");
      adv.innerHTML = `${icon("check")} Ventileren helpt: buitenlucht is droger (${ahOut.toFixed(1)} vs ${ahIn.toFixed(1)} g/m³)`;
    } else if (d <= -1) {
      adv.classList.add("warn");
      adv.innerHTML = `${icon("warning")} Niet ventileren: buitenlucht is vochtiger (${ahOut.toFixed(1)} vs ${ahIn.toFixed(1)} g/m³)`;
    } else {
      adv.classList.add("dim");
      adv.textContent = "Ventileren maakt nu weinig verschil";
    }
  }

  Panel.openClimate = function (i) {
    climIdx = i;
    Panel.openOverlay($("climate"));
    renderClimateText();
    cancelAnimationFrame(climAnim);
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 520);
      drawClimate(1 - Math.pow(1 - p, 3));
      if (p < 1) climAnim = requestAnimationFrame(step);
    };
    climAnim = requestAnimationFrame(step);
  };
  const climOpen = () => climIdx >= 0 && !$("climate").hidden;
  function closeClimate() {
    climIdx = -1;
    Panel.closeOverlay($("climate"));
  }
  $("climClose").innerHTML = icon("close");
  $("climClose").addEventListener("click", closeClimate);
  $("climate").addEventListener("click", (e) => e.target === $("climate") && closeClimate());
  $("sensors").addEventListener("click", (e) => {
    const col = e.target.closest("[data-sensor]");
    if (col) Panel.openClimate(+col.dataset.sensor);
  });
  window.addEventListener("resize", () => climOpen() && drawClimate(1));

  /* ---- Screensaver --------------------------------------------------------------- */
  let lastActivity = Date.now();
  let flickerTimer = 0;
  ["pointerdown", "keydown", "wheel"].forEach((ev) =>
    window.addEventListener(ev, () => (lastActivity = Date.now()), { capture: true, passive: true })
  );

  function renderSaverTemps() {
    $("eyeTemps").innerHTML = cfg.sensors
      .map((s) => {
        const t = Panel.num(s.temp);
        return `<span>${s.abbr}</span><span class="v">${Number.isFinite(t) ? t.toFixed(1) + "°" : "-.-°"}</span>`;
      })
      .join("");
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
    Panel.closeDrawer();
    saver.hidden = false;
    if (Panel.prefs.saverMode === 1) scheduleFlicker();
  };
  function hideSaver() {
    $("saver").hidden = true;
    clearTimeout(flickerTimer);
    lastActivity = Date.now();
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
    if (climOpen()) {
      renderClimateText();
      drawClimate(1);
    }
  };
  Panel.onHistory = () => climOpen() && drawClimate(1);

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
    }, Math.max(350, 1100 - (performance.now() - bootAt)));
  };

  Panel.initExtras = function () {
    $("splashFill").style.width = "15%";
  };

  Panel.boot();
})();
