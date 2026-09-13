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
 *     section (i), floor (fi), area (fi)   navigation changed
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
    saverMode: pref("saverMode", 1), /* 0 = scherm uit, 1 = AI oog */
    saverIdx: pref("saverIdx", 1),
  };
  Panel.setPref = (key, v) => {
    Panel.prefs[key] = v;
    try {
      localStorage.setItem("panel." + key, JSON.stringify(v));
    } catch (e) {
      /* private mode: keep it for this session only */
    }
  };

  /* ---- Theme ---------------------------------------------------------------- */
  Panel.applyTheme = function (idx) {
    const t = cfg.themes[idx] || cfg.themes[0];
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(t)) if (k !== "name") root.setProperty("--" + k, v);
    document.querySelector('meta[name="theme-color"]').setAttribute("content", t.toolbar);
    document.documentElement.style.colorScheme = t.name === "Licht" ? "light" : "dark";
  };
  Panel.applyTheme(Panel.prefs.theme);

  /* ---- Entities ------------------------------------------------------------------ */
  const handlers = new Map(); /* entity id -> [fn] */
  const order = []; /* every fn, in registration order */
  const validators = new Map(); /* entity id -> (number) => usable */
  let client = null;
  let loaded = false;

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
    order.forEach((fn) => idsOf.has(fn) && fn(idsOf.get(fn), first));
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
  const OVERLAYS = ["popup", "climate", "settings", "plan", "saver"];
  Panel.overlayOpen = () => OVERLAYS.some((id) => !$(id).hidden);
  Panel.openOverlay = function (el) {
    el.classList.remove("closing");
    el.hidden = false;
  };
  Panel.closeOverlay = function (el) {
    if (el.hidden || el.classList.contains("closing")) return;
    el.classList.add("closing");
    setTimeout(() => {
      el.hidden = true;
      el.classList.remove("closing");
    }, 160);
  };
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    ["popup", "climate", "settings", "plan"].forEach((id) => Panel.closeOverlay($(id)));
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
      $("status").className = "status " + (s === "connected" ? "connected" : s === "connecting" ? "connecting" : "");
      bus.emit("status", s);
    });
    client.on("states", dispatch);
    client.start();
  };
})();
