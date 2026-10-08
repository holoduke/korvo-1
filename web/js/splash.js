/* The boot splash: a Terminator's vision coming on (styles in splash.css).
 *
 * The power-on (a dot, a line, the whole screen) is CSS. This script types
 * the boot log, draws the HUD on #splashCanvas - live graphs, six rotating
 * wireframe objects in their own frames and a turning reticle - keeps the
 * connection status and loader up to date, and ends it all once the first
 * states are in: a short "system online" flash, then the app.
 *
 * The show has a minimum length in real use; in demo mode (the tests, the
 * development server) it stays as short as the old splash. Once loaded, a tap
 * skips the rest. Nothing is drawn any more after the splash is gone. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { $ } = Panel;
  const bootAt = performance.now();
  const demo = new URLSearchParams(location.search).has("demo");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const MIN_SHOW = demo ? 1100 : 3600; /* ms from boot before the app may show */
  const READY_FLASH = demo ? 0 : 600; /* ms of "system online" before the fade */
  const HUD_AT = reduced ? 0 : 1100; /* the power-on in splash.css takes this long */

  const TEXT = {
    connecting: "Verbinden met Home Assistant",
    connected: "Lampen en sensoren laden",
    disconnected: "Geen verbinding, opnieuw proberen",
    "auth-error": "Opnieuw inloggen",
  };
  const PROGRESS = { connecting: 40, connected: 80 };

  /* ---- The boot log ------------------------------------------------------------- */
  const stamp = (document.querySelector('meta[name="panel-version"]') || {}).content || "";
  const version = !stamp || stamp.startsWith("__") ? "dev" : stamp;
  /* A label with dot leaders up to its ending; the leaders are filled out when
   * the line is typed, so the ending stands at the right edge of the column. */
  const dots = (label) => ({ lead: label });
  /* [text, ending, class of the ending] */
  const BOOT = [
    ["CYBERDYNE SYSTEMS CORP. (C) 2029", "", ""],
    ["T-1000 AUTOMATION OS  BUILD " + version.toUpperCase(), "", "dim"],
    ["", "", ""],
    [dots("MEMORY CHECK"), "32768K OK", "ok"],
    [dots("POWER CELL"), "98.7%", "ok"],
    [dots("NEURAL NET PROCESSOR"), "ONLINE", "ok"],
    [dots("LEARNING MODE"), "WRITE-ENABLED", "warn"],
    [dots("MIMETIC POLYALLOY"), "STABLE", "ok"],
    [dots("THERMAL OPTICS"), "CALIBRATED", "ok"],
    [dots("INFRARED OVERLAY"), "ACTIVE", "ok"],
    [dots("AUDIO ANALYSIS"), "ACTIVE", "ok"],
    [dots("VOICE PRINT DATABASE"), "LOADED", "ok"],
    [dots("ZIGBEE MESH"), "LINKED", "ok"],
    [dots("THREAD BORDER ROUTER"), "OK", "ok"],
    [dots("MATTER FABRIC"), "COMMISSIONED", "ok"],
    [dots("WIFI 6E ACCESS POINTS"), "4 ONLINE", "ok"],
    [dots("PERIMETER SENSORS"), "ARMED", "ok"],
    [dots("GARAGE DOOR TELEMETRY"), "OK", "ok"],
    [dots("CLIMATE CONTROL"), "NOMINAL", "ok"],
    [dots("GRID POWER  3 PHASE"), "NOMINAL", "ok"],
    [dots("THREAT MATRIX"), "LOADED", "ok"],
    [dots("TARGET DATABASE"), "0 HOSTILES", "ok"],
    /* its ending shows once the connection is really there (see "status") */
    [dots("HOME ASSISTANT @ " + location.hostname.toUpperCase()), "LINK ESTABLISHED", "ok pending"],
  ];
  const AFTER = [
    [dots("SCANNING ENVIRONMENT"), "COMPLETE", "ok"],
    [dots("OBJECT RECOGNITION"), "6/6 MATCH", "ok"],
    [dots("HUMAN OCCUPANTS"), "FRIENDLY", "ok"],
    ["", "", ""],
    ["MISSION: KEEP THE HOUSE COMFORTABLE", "", "warn"],
  ];
  const log = $("splashLog");
  const queue = BOOT.slice();
  let typing = null; /* {el, text, end, cls, i} */

  /* How many characters fit across the log column, measured on its own font
   * (again for every line: the web font may arrive later, the screen may turn). */
  function columns() {
    const probe = document.createElement("span");
    probe.style.visibility = "hidden";
    probe.textContent = "0".repeat(40);
    log.appendChild(probe);
    const charW = probe.getBoundingClientRect().width / 40;
    probe.remove();
    return charW > 0 ? Math.floor(log.clientWidth / charW) - 1 : 40;
  }
  function leaders(label, end) {
    const n = columns() - label.length - end.length - 2; /* label, space, dots, space, ending */
    return label + " " + ".".repeat(Math.max(3, n)) + " ";
  }
  function nextLine() {
    if (!queue.length || !log) return null;
    const [raw, end, cls] = queue.shift();
    const text = typeof raw === "object" ? leaders(raw.lead, end) : raw;
    const el = document.createElement("div");
    log.appendChild(el);
    /* the oldest lines go once the column is full */
    while (log.children.length > 1 && log.scrollHeight > log.clientHeight + 2) log.firstChild.remove();
    return { el, text, end, cls, i: 0 };
  }
  let linked = false; /* Home Assistant answered: the reserved ending may show */
  function finishLine(line) {
    line.el.textContent = line.text;
    if (line.end) {
      const s = document.createElement("span");
      s.className = linked ? line.cls.replace("pending", "").trim() : line.cls;
      s.textContent = line.end;
      line.el.appendChild(s);
    }
  }
  /* Typed by the clock, not per frame, so a slow device still fills the
   * column by the end of the show: CPS characters a second. */
  const CPS = 560;
  let lastType = 0, budget = 0;
  function typeStep(now) {
    if (!log) return;
    if (reduced) {
      while (queue.length) finishLine(nextLine());
      return;
    }
    budget += lastType ? ((now - lastType) / 1000) * CPS : 0;
    lastType = now;
    while (budget >= 1) {
      if (!typing) {
        typing = nextLine();
        if (!typing) {
          budget = 0;
          return;
        }
      }
      const take = Math.min(Math.floor(budget), typing.text.length - typing.i);
      typing.i += take;
      budget -= Math.max(1, take);
      if (typing.i >= typing.text.length) {
        finishLine(typing);
        typing = null;
      }
    }
    if (typing) {
      typing.el.textContent = typing.text.slice(0, typing.i);
      const c = document.createElement("span");
      c.className = "cur";
      c.textContent = " ";
      typing.el.appendChild(c);
    }
  }
  /* A status from the connection lands in the log as well. */
  function logStatus(text, cls) {
    queue.push(["> " + text.toUpperCase(), "", cls || ""]);
  }

  /* ---- Wireframes (the shapes and the drawing come from vision.js) ---- */
  const V = Panel.Vision;
  const M = V.meshes;
  const OBJECTS = [
    { name: "ICOSAHEDRON", mesh: M.icosahedron(), spin: [0.5, 0.8, 0.2] },
    { name: "HYPERCUBE", mesh: M.nestedCubes(), spin: [0.7, 0.4, 0.3] },
    { name: "TORUS", mesh: M.torus(), spin: [0.9, 0.25, 0.5] },
    { name: "GEOSPHERE", mesh: M.sphere(), spin: [0.15, 0.6, 0.1] },
    { name: "OCTA STAR", mesh: M.octaStar(), spin: [0.6, 0.9, 0.4] },
    { name: "DNA HELIX", mesh: M.helix(), spin: [0.1, 1.1, 0.05] },
  ];
  OBJECTS.forEach((o, i) => {
    o.rot = [i * 0.7, i * 1.3, i * 0.4];
    o.matchAt = 900 + i * 380 + Math.random() * 300; /* ms into the HUD: SCANNING -> MATCH */
    o.match = 82 + Math.random() * 17;
  });

  /* ---- Drawing ------------------------------------------------------------------- */
  const canvas = $("splashCanvas");
  const ctx = canvas && canvas.getContext("2d");
  let W = 0, H = 0, dpr = 1, layout = null;
  const { RED, HOT, PALE, rgba } = V;

  function resize() {
    if (!canvas) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const portrait = H > W * 1.05;
    const short = !portrait && H <= 440;
    const bottomUi = portrait ? H * 0.08 + 112 : short ? H * 0.06 + 92 : H * 0.08 + 128;
    if (portrait) {
      const m = 16;
      layout = { graph: { x: m, y: H * 0.075, w: W - 2 * m, h: H * 0.17 }, grid: { x: m, y: H * 0.27, w: W - 2 * m, h: H * 0.29 }, cols: 3 };
    } else {
      const x = W * 0.37, w = W * 0.61;
      const top = short ? H * 0.13 : H * 0.085;
      const avail = H - bottomUi - top;
      layout = { graph: { x, y: top, w, h: avail * 0.4 }, grid: { x, y: top + avail * 0.45, w, h: avail * 0.55 }, cols: 3 };
    }
    layout.reticle = { x: W / 2, y: H * 0.46, r: Math.min(W, H) * 0.44 };
  }

  const brackets = (x, y, w, h, len, a) => V.brackets(ctx, x, y, w, h, len, a);
  const text = (str, x, y, size, color, align) => V.text(ctx, str, x, y, size, color, align);
  function drawReticle(t) {
    const { x, y, r } = layout.reticle;
    V.reticle(ctx, x, y, r, t);
  }

  const bars = Array.from({ length: 28 }, () => Math.random());
  const readouts = [0, 0, 0];
  function drawGraph(t) {
    const { x, y, w, h } = layout.graph;
    const top = y + 18, gh = h - 18;
    brackets(x, y, w, h, 14, 0.8);
    text("SIGNAL ANALYSIS", x + 10, y + 13, 11, rgba(PALE, 0.95));
    text("CH 3 · 48 kHz · LIVE", x + w - 10, y + 13, 10, rgba(HOT, 0.75), "right");
    /* the grid */
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(RED, 0.16);
    ctx.beginPath();
    for (let i = 1; i < 10; i++) { ctx.moveTo(x + (w * i) / 10, top); ctx.lineTo(x + (w * i) / 10, y + h); }
    for (let i = 1; i < 4; i++) { ctx.moveTo(x, top + (gh * i) / 4); ctx.lineTo(x + w, top + (gh * i) / 4); }
    ctx.stroke();
    /* three traces, each a sum of waves that scrolls to the left */
    const plotW = w * 0.72;
    const traces = [
      { c: RED, a: 0.95, f: [2.1, 5.3, 11], s: [1.6, 2.4, 4], amp: 0.32 },
      { c: HOT, a: 0.75, f: [1.3, 3.7, 8.2], s: [-1.1, 1.9, 3.3], amp: 0.22 },
      { c: PALE, a: 0.55, f: [3.4, 7.7, 13], s: [2.6, -3.1, 5.5], amp: 0.12 },
    ];
    traces.forEach((tr, k) => {
      const mid = top + gh * (0.3 + k * 0.22);
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const u = i / 120;
        const v = Math.sin(u * tr.f[0] * 6.28 + t * tr.s[0]) * 0.6 + Math.sin(u * tr.f[1] * 6.28 + t * tr.s[1]) * 0.3 + Math.sin(u * tr.f[2] * 6.28 + t * tr.s[2]) * 0.1;
        const px = x + 6 + u * plotW, py = mid + v * tr.amp * gh;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        if (i === 120) readouts[k] = v;
      }
      ctx.strokeStyle = rgba(tr.c, tr.a * 0.25);
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = rgba(tr.c, tr.a);
      ctx.lineWidth = 1.4;
      ctx.stroke();
    });
    /* the bars, on the right, a random walk */
    const bx = x + plotW + 18, bw = w - plotW - 28;
    const n = bars.length, step = bw / n;
    for (let i = 0; i < n; i++) {
      bars[i] = Math.min(1, Math.max(0.05, bars[i] + (Math.random() - 0.5) * 0.12));
      const bh = bars[i] * (gh - 26);
      ctx.fillStyle = rgba(i % 7 === 0 ? PALE : RED, i % 7 === 0 ? 0.85 : 0.55);
      ctx.fillRect(bx + i * step, y + h - 4 - bh, Math.max(1, step - 2), bh);
    }
    /* readouts */
    const labels = bw < 170 ? ["NRL", "THM", "SNR"] : ["NEURAL LOAD", "THERMAL", "MESH SNR"];
    labels.forEach((l, k) => {
      const yy = top + 14 + k * 14;
      if (gh < 70 && k) return;
      text(l, bx, yy, 9, rgba(HOT, 0.75));
      text((50 + readouts[k] * 45).toFixed(1), bx + bw, yy, 9, rgba(PALE, 0.95), "right");
    });
  }

  function drawObjects(t, hudMs, dt) {
    const { x, y, w, h } = layout.grid;
    const cols = layout.cols, rows = Math.ceil(OBJECTS.length / cols), gap = 10;
    const cw = (w - gap * (cols - 1)) / cols, ch = (h - gap * (rows - 1)) / rows;
    const small = cw < 140;
    OBJECTS.forEach((o, i) => {
      const cx0 = x + (i % cols) * (cw + gap), cy0 = y + Math.floor(i / cols) * (ch + gap);
      ctx.fillStyle = rgba(RED, 0.05);
      ctx.fillRect(cx0, cy0, cw, ch);
      brackets(cx0, cy0, cw, ch, 10, 0.7);
      const head = small ? 14 : 18, foot = small ? 12 : 16;
      text(`0${i + 1} ${small ? o.name.split(" ")[0] : o.name}`, cx0 + 7, cy0 + (small ? 11 : 13), small ? 8 : 10, rgba(PALE, 0.9));
      const matched = hudMs > o.matchAt;
      const blink = Math.floor(t * 4) % 2 === 0;
      text(matched ? `MATCH ${o.match.toFixed(1)}%` : blink ? "SCANNING" : "", cx0 + cw - 7, cy0 + ch - 5, small ? 7.5 : 9, rgba(matched ? PALE : HOT, matched ? 0.95 : 0.8), "right");
      if (!small) text(`ROT ${(((o.rot[1] * 180) / Math.PI) % 360).toFixed(1).padStart(5, "0")}°`, cx0 + 7, cy0 + ch - 5, 9, rgba(HOT, 0.7));
      /* the wireframe */
      const speed = reduced ? 0.15 : 1;
      o.rot = o.rot.map((r, k) => r + o.spin[k] * dt * speed);
      const size = Math.min(cw, ch - head - foot) * 0.36;
      const ox = cx0 + cw / 2, oy = cy0 + head + (ch - head - foot) / 2;
      V.wire(ctx, o.mesh, ox, oy, size, o.rot, matched);
      /* a lock frame that closes in when it matches */
      if (matched) {
        const k = Math.min(1, (hudMs - o.matchAt) / 300);
        const half = size * (1.6 - 0.35 * k);
        brackets(ox - half, oy - half, half * 2, half * 2, 6, 0.85 * k);
      }
    });
  }

  /* ---- The loop --------------------------------------------------------------------- */
  let raf = 0, last = 0, running = false;
  function frame(now) {
    raf = 0;
    if (!running || !$("splash")) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    const hudMs = now - bootAt - HUD_AT;
    if (hudMs > 150) typeStep(now);
    const clock = $("splashClock");
    if (clock) {
      const d = new Date();
      clock.textContent = d.toTimeString().slice(0, 8) + "." + String(Math.floor(d.getMilliseconds() / 10)).padStart(2, "0");
    }
    if (ctx && layout && hudMs > -200) {
      const t = now / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      drawReticle(t);
      drawGraph(t);
      drawObjects(t, hudMs, dt);
    }
    raf = requestAnimationFrame(frame);
  }
  function startLoop() {
    if (running || !canvas) return;
    running = true;
    resize();
    raf = requestAnimationFrame(frame);
  }
  function stopLoop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  /* ---- Status and the end --------------------------------------------------------- */
  let loaded = false, ending = false;
  Panel.on("status", (s) => {
    if (!$("splash")) return; /* removed after the first successful load */
    $("splashStatus").textContent = TEXT[s] || "";
    if (PROGRESS[s]) $("splashFill").style.width = PROGRESS[s] + "%";
    if (s === "connected") {
      linked = true;
      log && log.querySelectorAll(".pending").forEach((el) => el.classList.remove("pending"));
    }
    else if (s === "disconnected") logStatus("NO CARRIER - RETRYING", "warn");
    else if (s === "auth-error") logStatus("ACCESS DENIED - LOGIN REQUIRED", "warn");
  });

  function finish() {
    const splash = $("splash");
    if (!splash || ending) return;
    ending = true;
    document.removeEventListener("pointerdown", skip, { capture: true });
    splash.classList.add("ready");
    $("splashStatus").textContent = "System online";
    $("splashFill").style.width = "100%";
    setTimeout(() => {
      splash.classList.add("gone");
      Panel.wake();
      setTimeout(() => {
        stopLoop();
        splash.remove();
      }, 520);
    }, READY_FLASH);
  }
  Panel.on("loaded", () => {
    const splash = $("splash");
    if (!splash || loaded) return;
    loaded = true;
    $("splashFill").style.width = "100%";
    AFTER.forEach((l) => queue.push(l));
    setTimeout(finish, Math.max(350, MIN_SHOW - (performance.now() - bootAt)));
  });
  /* Once the app is there, a tap needn't wait for the rest of the show. */
  function skip() {
    if (loaded) finish();
  }
  document.addEventListener("pointerdown", skip, { capture: true });

  /* The title spans the width: its size comes from its measured width at a
   * reference size. If that would make it taller than MAX_H of the screen, it
   * keeps that height and wider letter spacing fills the rest. Again once the
   * web font has loaded (its metrics differ) and on resize or rotation. */
  const SPACING = 0.32; /* em, as in splash.css */
  const MAX_H = 0.07; /* of the viewport height */
  function fitTitle() {
    const title = $("splashTitle");
    if (!title || !$("splash")) return;
    const target = title.parentElement.clientWidth - parseFloat(getComputedStyle(title.parentElement).paddingLeft) * 2;
    const chars = title.textContent.length;
    title.style.fontSize = "100px";
    title.style.letterSpacing = "0";
    title.style.marginRight = "0";
    const perPx = title.getBoundingClientRect().width / 100; /* glyph width per px of font size */
    let size = target / (perPx + chars * SPACING);
    let spacing = SPACING;
    const cap = window.innerHeight * MAX_H;
    if (size > cap) {
      size = cap;
      spacing = Math.max(SPACING, (target / size - perPx) / chars);
    }
    title.style.fontSize = size.toFixed(2) + "px";
    title.style.letterSpacing = spacing.toFixed(4) + "em";
    title.style.marginRight = (-spacing).toFixed(4) + "em";
  }
  window.addEventListener("resize", () => {
    fitTitle();
    if (running) resize();
  });

  Panel.on("start", () => {
    $("splashFill").style.width = "15%";
    fitTitle();
    startLoop();
    /* The display face arrives on its own time (the font sheet loads without
     * blocking the page): fit again whenever a font finishes loading. */
    if (document.fonts) {
      document.fonts.ready.then(fitTitle);
      document.fonts.addEventListener("loadingdone", fitTitle);
    }
  });
})();
