/* Web panel core: the Panel namespace, per-browser preferences and theme, the
 * Home Assistant connection with its entity registry, overlays and the boot
 * sequence. Everything else is a module that registers itself before boot:
 *
 *   Panel.track(ids, fn)   follow these entities; fn(changedIds, first) gets
 *                          its own ids that changed (all of them, first = true,
 *                          on the first state dump)
 *   Panel.on(event, fn)    events, emitted with Panel.emit:
 *     build                create the page's markup (the app is still hidden)
 *     start                the app is visible: measure, bind, animate
 *     status (s)           connection status: connecting, connected, ...
 *     loaded               the first state dump has been handled
 *     section (i), floor (fi), area (fi), robot (floor label)   navigation changed
 *     reading (id)         a climate or air reading changed (readings.js)
 *     history              sensor history arrived (readings.js)
 *     minute               the clock turned a minute
 *     escape               Escape was pressed
 *
 * main.js calls Panel.boot() once every module has loaded. */
(function () {
  "use strict";

  const cfg = window.PANEL_CONFIG;
  const $ = (id) => document.getElementById(id);
  const bus = Util.emitter();
  const Panel = (window.Panel = { cfg, $, on: bus.on, emit: bus.emit });

  /* ---- Preferences (per browser) ------------------------------------------ */
  function pref(key, def) {
    try {
      const v = localStorage.getItem("panel." + key);
      return v === null ? def : JSON.parse(v);
    } catch (e) {
      return def;
    }
  }
  Panel.prefs = {
    theme: pref("theme", 0),
    saverMode: pref("saverMode", 2), /* 0 = scherm uit, 1 = AI oog, 2 = het huis */
    saverIdx: pref("saverIdx", 1),
    houseLayer: pref("houseLayer", undefined),
    houseWalls: pref("houseWalls", undefined),
    houseTouched: pref("houseTouched", 0),
    sound: pref("sound", false),
  };
  Panel.setPref = (key, v) => {
    Panel.prefs[key] = v;
    try {
      localStorage.setItem("panel." + key, JSON.stringify(v));
    } catch (e) {
      /* private mode: keep it for this session only */
    }
  };
  /* The house took over from the AI eye as the screensaver (September 2026). A
   * browser still on the eye had the old default, not a choice: it follows, once. */
  if (pref("saverGen", 1) < 2) {
    if (Panel.prefs.saverMode === 1) Panel.setPref("saverMode", 2);
    Panel.setPref("saverGen", 2);
  }

  /* ---- Theme ---------------------------------------------------------------- */
  Panel.applyTheme = function (idx) {
    const t = cfg.themes[idx] || cfg.themes[0];
    const root = document.documentElement.style;
    /* Beyond colour: the typefaces, corner roundness and edge line, with the
     * stylesheet's own defaults when a theme leaves them out. */
    const LOOK = { font: "--font-ui", display: "--font-display", round: "--round", edge: "--edge", glow: "--glow" };
    Object.values(LOOK).forEach((v) => root.removeProperty(v));
    for (const [k, v] of Object.entries(t)) {
      if (k === "name") continue;
      if (k === "font" || k === "display") root.setProperty(LOOK[k], `"${v}"`);
      else if (k === "round") root.setProperty(LOOK[k], String(v / 100));
      else if (k === "glow") root.setProperty(LOOK[k], String(v));
      else root.setProperty(k === "edge" ? LOOK.edge : "--" + k, v);
    }
    document.querySelector('meta[name="theme-color"]').setAttribute("content", t.toolbar);
    /* Light or dark form controls and scrollbars follow the background's brightness. */
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(t.bg.slice(i, i + 2), 16) / 255);
    document.documentElement.style.colorScheme = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? "light" : "dark";
  };
  Panel.applyTheme(Panel.prefs.theme);

  /* ---- Entities ------------------------------------------------------------------ */
  const handlers = new Map(); /* entity id -> [fn] */
  const order = []; /* every fn, in registration order */
  const validators = new Map(); /* entity id -> (number) => usable */
  let client = null;
  let loaded = false;
  let connected = false;
  /* Whether the socket to Home Assistant is up right now (timers skip their work otherwise). */
  Panel.connected = () => connected;

  Panel.track = function (ids, fn) {
    if (!order.includes(fn)) order.push(fn);
    const fresh = [];
    for (const id of ids) {
      if (!id) continue;
      if (!handlers.has(id)) {
        handlers.set(id, []);
        fresh.push(id);
      }
      if (!handlers.get(id).includes(fn)) handlers.get(id).push(fn);
    }
    if (client && fresh.length) client.addEntities(fresh);
  };
  Panel.isLoaded = () => loaded;

  function dispatch(changed) {
    const first = !loaded;
    loaded = true;
    const idsOf = new Map();
    for (const id of first ? handlers.keys() : changed) {
      for (const fn of handlers.get(id) || []) {
        if (!idsOf.has(fn)) idsOf.set(fn, []);
        idsOf.get(fn).push(id);
      }
    }
    /* One module's handler throwing must not stop the others, nor the "loaded"
     * that lets the rest of the app start (diag.js records the error). */
    order.forEach((fn) => {
      if (!idsOf.has(fn)) return;
      try {
        fn(idsOf.get(fn), first);
      } catch (e) {
        window.dispatchEvent(new ErrorEvent("error", { message: `state handler: ${e.message}`, filename: "core.js" }));
      }
    });
    if (first) bus.emit("loaded");
  }

  const st = (id) => client.states.get(id);
  Panel.st = st;
  Panel.unavailable = (s) => !s || s.state === "unavailable" || s.state === "unknown" || s.state === "none";
  /* A readout that is only meaningful in a range (a CO2 sensor warming up reads
   * too low) registers a check; Panel.num then reports NaN outside it. */
  Panel.validate = (id, usable) => validators.set(id, usable);
  Panel.num = function (id) {
    const s = id ? st(id) : null;
    const v = s ? parseFloat(s.state) : NaN;
    return Number.isFinite(v) && (!validators.has(id) || validators.get(id)(v)) ? v : NaN;
  };

  /* ---- Overlays ------------------------------------------------------------------- */
  const OVERLAYS = ["popup", "room", "climate", "settings", "plan", "saver"];
  const DIALOGS = ["popup", "room", "climate", "settings", "plan"]; /* the overlays a tap or Escape closes */
  Panel.overlayOpen = () => OVERLAYS.some((id) => !$(id).hidden);
  const closeTimers = new Map(); /* overlay -> the timer that hides it after its closing animation */
  Panel.openOverlay = function (el) {
    clearTimeout(closeTimers.get(el)); /* reopened during its closing animation: stay open */
    closeTimers.delete(el);
    el.classList.remove("closing");
    el.hidden = false;
  };
  Panel.closeOverlay = function (el) {
    if (el.hidden || el.classList.contains("closing")) return;
    el.classList.add("closing");
    closeTimers.set(
      el,
      setTimeout(() => {
        closeTimers.delete(el);
        el.hidden = true;
        el.classList.remove("closing");
      }, 160)
    );
  };
  /* Every dialog at once, without animation (the screensaver, a hard reset). */
  Panel.closeDialogs = () => DIALOGS.forEach((id) => {
    const el = $(id);
    clearTimeout(closeTimers.get(el));
    closeTimers.delete(el);
    el.classList.remove("closing");
    el.hidden = true;
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    DIALOGS.forEach((id) => Panel.closeOverlay($(id)));
    bus.emit("escape");
  });

  /* ---- Boot ------------------------------------------------------------------ */
  Panel.boot = function () {
    const demo = new URLSearchParams(location.search).has("demo");
    client = Panel.client = demo ? HA.createDemo(cfg) : HA.createClient([...handlers.keys()]);
    bus.emit("build");
    $("app").hidden = false; /* before anything measures the layout */
    bus.emit("start");
    client.on("status", (s) => {
      connected = s === "connected";
      $("status").className = "status " + (s === "connected" ? "connected" : s === "connecting" ? "connecting" : "");
      $("connbar").hidden = s === "connected" || !loaded; /* only a connection that was there and went */
      document.body.classList.toggle("offline", s !== "connected" && loaded);
      bus.emit("status", s);
    });
    client.on("states", dispatch);
    client.on("registry", (data) => bus.emit("registry", data));
    client.start();
  };
})();
