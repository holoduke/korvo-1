/* On the house (Start section): the readout — the connection, and only what
 * is wrong (a fault, script errors), with the clock while the screensaver
 * hides the header; the robots at work — the rooms they are cleaning lit on
 * the floor, and a badge in the other corner; and the layers — the rooms'
 * floors coloured by temperature, humidity or the lamps that are on, each
 * room with its reading floating over it. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const esc = Util.esc;

  let root = null;
  let loadedOnce = false; /* the first render after the state dump notes no events */
  let badge = null;
  let labels = null;
  let status = "connecting";
  let timer = 0;

  const LAYERS = [
    ["none", "Huis"],
    ["climate", "Klimaat"],
    ["lights", "Lampen"],
  ];
  const html = () =>
    `<div class="hud" data-hud><div class="hud-clock" data-hud-clock></div><div class="hud-watch" data-hud-watch></div><div class="hud-rows" data-hud-rows></div><div class="hud-events" data-hud-events></div></div>` +
    `<div class="house-robot" data-robot hidden><span class="hr-icon">${icon("vacuum")}</span><span class="hr-text"><b data-robot-label></b><span data-robot-where></span></span></div>` +
    `<div class="house-labels" data-labels></div>` +
    `<div class="house-layers">${LAYERS.map(([k, l]) => `<button class="hl-btn" data-layer="${k}">${l}</button>`).join("")}</div>` +
    `<div class="house-walls"><button class="hl-btn" data-walls>${icon("home")}<span>Binnenmuren</span></button></div>`;

  /* ---- What is wrong ------------------------------------------------------------ */
  const state = (id) => (Panel.st(id) || {}).state;
  const tones = () => (Panel.applianceTones ? Panel.applianceTones() : []);
  const ERRORS_WINDOW_MS = 3600e3; /* older script errors are on the health page, not on the wall */

  function connection() {
    if (Panel.client && Panel.client.demo) return { tone: "ok", text: "Demo" };
    if (status === "connected") return { tone: "ok", text: "Home Assistant online" };
    if (status === "connecting") return { tone: "warn", text: "Verbinden met Home Assistant…" };
    return { tone: "bad", text: "Geen verbinding met Home Assistant" };
  }
  function problems() {
    const out = [];
    const faulty = tones().filter((t) => t.tone === "error");
    if (faulty.length) out.push({ tone: "bad", text: `Storing: ${faulty.map((t) => t.label).join(", ")}` });
    const stuck = robots.filter((r) => state(r.vacuum) === "error" || state(r.problem) === "on");
    if (stuck.length) out.push({ tone: "bad", text: `Storing: ${stuck.map((r) => r.label).join(", ")}` });
    const errors = window.Diag ? window.Diag.errorCount(ERRORS_WINDOW_MS) : 0;
    if (errors) out.push({ tone: "bad", text: `${errors} scriptfout${errors === 1 ? "" : "en"} in het laatste uur` });
    /* The network: the Zigbee bridge gone, most lamps out of reach (the Zigbee
     * network itself), the internet gone. A few lamps off at the wall are not news. */
    const h = cfg.health || {};
    if (h.zigbee && state(h.zigbee) === "off") out.push({ tone: "bad", text: "Zigbee-bridge offline" });
    const allLamps = [...new Set(rooms.flatMap((r) => r.lights))];
    const gone = allLamps.filter((id) => state(id) === "unavailable").length;
    if (allLamps.length && gone > allLamps.length * 0.4) out.push({ tone: "bad", text: `${gone} van ${allLamps.length} lampen niet bereikbaar: Zigbee?` });
    if (h.internet && state(h.internet) === "off") out.push({ tone: "warn", text: "Internet weg" });
    return out;
  }

  /* ---- What just happened ------------------------------------------------------------- */
  /* The last few things worth a line: a door or window opening or closing, an
   * appliance finishing or failing, a robot starting or docking. Only after
   * the first state dump. */
  const EVENTS_KEPT = 4;
  const events = []; /* {t, text, tone} newest first */
  const contacts = (cfg.sensorCards || []).filter((c) => (c.kind === "door" || c.kind === "window") && c.entities.contact);
  const seen = new Map(); /* entity or key -> last state */
  function event(text, tone = "dim") {
    events.unshift({ t: new Date(), text, tone });
    events.splice(EVENTS_KEPT);
  }
  function noteChanges(first) {
    contacts.forEach((c) => {
      const s = state(c.entities.contact);
      const was = seen.get(c.entities.contact);
      seen.set(c.entities.contact, s);
      if (first || was === undefined || was === s || !["on", "off"].includes(s)) return;
      event(`${c.label} ${s === "on" ? "open" : "dicht"}`, s === "on" ? "warn" : "dim");
    });
    tones().forEach((t) => {
      const was = seen.get(`appl:${t.label}`);
      seen.set(`appl:${t.label}`, t.tone);
      if (first || was === undefined || was === t.tone) return;
      if (t.tone === "done") event(`${t.label} klaar`, "ok");
      else if (t.tone === "error") event(`${t.label}: storing`, "bad");
      else if (t.tone === "run" && was !== "paused") event(`${t.label} gestart`);
    });
    robots.forEach((r) => {
      const s = state(r.vacuum);
      const was = seen.get(r.vacuum);
      seen.set(r.vacuum, s);
      if (first || was === undefined || was === s) return;
      if (s === "cleaning" && was !== "paused") event(`${r.label} gestart`);
      else if (s === "docked" && was !== "docked") event(`${r.label} terug op het station`);
      else if (s === "error") event(`${r.label}: storing`, "bad");
    });
  }
  function renderEvents() {
    const box = root.querySelector("[data-hud-events]");
    box.innerHTML = events
      .map((e) => `<div class="hud-ev ${e.tone}"><span class="hud-t">${Util.hm(e.t)}</span><span>${esc(e.text)}</span></div>`)
      .join("");
  }

  /* ---- The rooms of the plan, with their sensor and their lamps ------------------- */
  const plan = window.HOUSE_PLAN || { rooms: {} };
  const climateCards = (cfg.sensorCards || []).filter((c) => c.kind === "climate");
  const plantCards = (cfg.sensorCards || []).filter((c) => c.kind === "plant");
  const areasOf = (floor) => {
    const f = (cfg.floors || []).find((x) => x.label === floor);
    return f ? cfg.tabs[f.tab].areas || [] : [];
  };
  const tabLights = (name) => {
    const t = (cfg.tabs || []).find((x) => x.name === name);
    return t ? [...t.lights, ...t.devices].map((d) => d.id).filter((id) => id.startsWith("light.")) : [];
  };
  /* Every room: its floor and name, the climate card that reads in it (or
   * whose reading it shares), and the lamps and scenes in it (its PANEL_AREAS rooms). */
  const rooms = Object.entries(plan.rooms || {}).flatMap(([floor, list]) =>
    list.map((r) => {
      const card = r.climate ? climateCards.find((c) => c.label === r.climate) : null;
      const areas = r.areas || [r.name];
      const lights = [
        ...new Set([
          ...areasOf(floor).filter((a) => areas.includes(a.label)).flatMap((a) => a.lights.map((l) => (typeof l === "string" ? l : l.id))),
          ...(r.tab ? tabLights(r.tab) : []),
        ]),
      ].filter((id) => id.startsWith("light."));
      const presenceCard = r.presence ? (cfg.sensorCards || []).find((c) => c.label === r.presence) : null;
      const presence = presenceCard ? presenceCard.entities.presence || presenceCard.entities.occupancy : null;
      const tabIndex = r.tab ? (cfg.tabs || []).findIndex((t) => t.name === r.tab) : -1;
      const cover = tabIndex >= 0 && Panel.coverOfTab ? Panel.coverOfTab(tabIndex) : -1;
      /* the scenes of its rooms (PANEL_AREA_SCENES), as [tab, index] */
      const f = (cfg.floors || []).find((x) => x.label === floor);
      const scenes = f ? cfg.tabs[f.tab].scenes.flatMap((sc, i) => (sc.area && areas.includes(sc.area) ? [[f.tab, i]] : [])) : [];
      return { floor, name: r.name, card, presence, centre: [r.x + r.w / 2, 0, r.z + r.d / 2], lights, scenes, cover: cover >= 0 ? cover : null };
    })
  );
  rooms.forEach((r) => {
    const lv = (plan.levels || []).find((l) => l.floor === r.floor);
    r.centre[1] = (lv ? lv.y : 0) + 0.05;
  });
  /* A card's label sits on the first room that reads it. */
  const labelRoom = new Map();
  rooms.forEach((r) => r.card && !labelRoom.has(r.card.label) && labelRoom.set(r.card.label, r));

  /* ---- The sun and the weather on the house -------------------------------------------- */
  const SUN = "sun.sun";
  const night = () => {
    const el = Number(((Panel.st(SUN) || {}).attributes || {}).elevation);
    return Number.isFinite(el) && el < -6;
  };
  function renderSky() {
    const house = Panel.house;
    if (!house) return;
    const el = Number(((Panel.st(SUN) || {}).attributes || {}).elevation);
    if (!Number.isFinite(el)) house.setMood([1, 1, 1], 0);
    else if (el < -6) house.setMood([0.55, 0.7, 1.0], 0.35); /* night: cool */
    else if (el < 8) house.setMood([1.0, 0.62, 0.3], 0.5 * (1 - Math.max(0, el) / 8)); /* golden hour: warm */
    else house.setMood([1, 1, 1], 0);
    /* Rain: the radar over the house (mm/h, the next minutes) when there is
     * such a sensor; the weather entity's condition (a station's) only without it. */
    const mm = Panel.num((cfg.health || {}).rain);
    house.setRain(Number.isFinite(mm) ? mm >= 0.25 : /rainy|pouring|hail|snowy/.test(state(cfg.weather) || ""));
  }

  /* ---- Layers -------------------------------------------------------------------- */
  const TONE_RGB = { cold: [0.4, 0.62, 1.0], ok: [0.3, 0.9, 0.5], warn: [1.0, 0.65, 0.25], bad: [1.0, 0.35, 0.3], lamp: [1.0, 0.78, 0.3] };
  let layer = ["none", "climate", "lights"].includes(Panel.prefs.houseLayer) ? Panel.prefs.houseLayer : "climate";
  /* The inner walls (and the rooms' outlines) can go, for a clear view of the
   * shell with its windows and doors; a choice kept per tablet. */
  let innerWalls = Panel.prefs.houseWalls !== false;
  function renderWalls() {
    const b = document.querySelector("[data-walls]");
    if (b) b.classList.toggle("active", innerWalls);
    if (Panel.house) Panel.house.setInnerWalls(innerWalls);
  }
  Panel.defineAction("walls", () => {
    innerWalls = !innerWalls;
    Panel.setPref("houseWalls", innerWalls);
    renderWalls();
  });
  let raf = 0;

  /* A climate card's temperature and humidity as label markup (indoors each
   * in the colour of its comfort band; outdoors there is no comfort to judge,
   * so plain), and the temperature's tone; null without a reading. */
  function climateOf(card, indoor = true) {
    const t = Panel.num(card.entities.temperature);
    const h = Panel.num(card.entities.humidity);
    if (!Number.isFinite(t) && !Number.isFinite(h)) return null;
    const tone = indoor && Number.isFinite(t) ? Panel.bandTone(Panel.bands.temp, t) : "ok";
    const html =
      `<span class="hl-vals">` +
      (Number.isFinite(t) ? `<b class="${indoor ? tone : "plain"}">${Util.fmt(t, 1)}°</b>` : "") +
      (Number.isFinite(h) ? `<i class="${indoor ? Panel.bandTone(Panel.bands.hum, h) : "hum"}">${Math.round(h)}%</i>` : "") +
      `</span><span class="hl-name">${esc(card.label)}</span>`;
    return { tone, html };
  }
  /* The room's reading for the layer, or null when it has none. */
  function reading(r) {
    if (layer === "climate") {
      const c = r.card && climateOf(r.card);
      return c && { tone: c.tone, html: c.html, alpha: 0.13 };
    }
    if (layer === "lights") {
      const on = r.lights.filter((id) => state(id) === "on").length;
      if (!on) return null;
      return { tone: "lamp", html: `<span class="hl-vals"><b class="lamp">${on} aan</b></span><span class="hl-name">${esc(r.name)}</span>`, alpha: 0.07 + 0.2 * Math.min(1, on / Math.max(3, r.lights.length)) };
    }
    return null;
  }
  function renderLayer() {
    const house = Panel.house;
    if (house) house.clearTints();
    labels.innerHTML = "";
    document.querySelectorAll(".house-layers .hl-btn").forEach((b) => b.classList.toggle("active", b.dataset.layer === layer));
    /* The room opened beside the house: its floor in the accent colour. */
    const sel = Panel.currentRoom && Panel.currentRoom();
    if (house && sel) house.tintRoom(sel.floor, sel.name, [1, 0.72, 0.3], 0.16);
    /* Someone in a room: its floor shows a faint white, whatever the layer. */
    if (house) rooms.forEach((r) => r.presence && state(r.presence) === "on" && house.tintRoom(r.floor, r.name, [0.85, 0.92, 1.0], 0.09));
    /* At night the lamps that are on light their rooms, whatever the layer shows. */
    if (house && night() && layer !== "lights") {
      rooms.forEach((r) => {
        const on = r.lights.filter((id) => state(id) === "on").length;
        if (on) house.tintRoom(r.floor, r.name, TONE_RGB.lamp, 0.05 + 0.12 * Math.min(1, on / Math.max(3, r.lights.length)));
      });
    }
    if (layer === "none") return;
    rooms.forEach((r) => {
      const v = reading(r);
      if (!v) return;
      if (house) house.tintRoom(r.floor, r.name, TONE_RGB[v.tone], v.alpha);
      /* the label: on the room that owns the reading (a shared reading only tints) */
      if ((layer !== "lights" && labelRoom.get(r.card.label) !== r)) return;
      const el = document.createElement("div");
      el.className = "house-label";
      el.innerHTML = v.html;
      el.dataset.at = JSON.stringify(r.centre);
      labels.appendChild(el);
    });
    /* The sensors outside the rooms (the outside temperature on the front wall). */
    if (layer === "climate") {
      (plan.sensors || []).forEach((s) => {
        const card = climateCards.find((c) => c.label === s.climate);
        const c = card && climateOf(card, false);
        if (!c) return;
        const el = document.createElement("div");
        el.className = "house-label out";
        el.innerHTML = c.html;
        el.dataset.at = JSON.stringify(s.at);
        labels.appendChild(el);
      });
      /* The plants: their soil moisture where they stand, the leaf amber when dry. */
      (plan.plants || []).forEach((pl) => {
        const card = plantCards.find((c) => c.label === pl.card);
        if (!card) return;
        const p = Panel.plantState(card.entities);
        const el = document.createElement("div");
        el.className = `house-label plant ${p.tone}`;
        el.innerHTML =
          `<span class="hl-vals">${icon("leaf")}<b class="${p.tone}">${Number.isFinite(p.moisture) ? `${Math.round(p.moisture)}%` : "--"}</b></span>` +
          `<span class="hl-name">${p.dry ? "water geven" : "plant"}</span>`;
        el.dataset.at = JSON.stringify(pl.at);
        labels.appendChild(el);
      });
    }
    place();
  }
  /* The labels follow their places while the house turns; where two would
   * overlap, the nearer one shows and the farther one waits its turn. */
  const LABEL_W = 96, LABEL_H = 30;
  function place() {
    const house = Panel.house;
    if (!house) return;
    const placed = [...labels.children]
      .map((el) => ({ el, p: house.project(JSON.parse(el.dataset.at)) }))
      .sort((a, b) => (a.p ? a.p.depth : Infinity) - (b.p ? b.p.depth : Infinity));
    const kept = [];
    for (const { el, p } of placed) {
      const clash = p && kept.some((k) => Math.abs(k.x - p.x) < LABEL_W && Math.abs(k.y - p.y) < LABEL_H);
      el.hidden = !p || clash;
      if (p && !clash) {
        kept.push(p);
        el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      }
    }
  }
  function follow() {
    raf = 0;
    if (layer === "none" || !labels.children.length || !Panel.onScreen("start") || document.visibilityState !== "visible" || Panel.sleeping()) return;
    place();
    raf = requestAnimationFrame(follow);
  }
  const startFollowing = () => !raf && (raf = requestAnimationFrame(follow));
  function setLayer(k) {
    layer = k;
    Panel.setPref("houseLayer", k);
    renderLayer();
    startFollowing();
  }
  Panel.defineAction("layer", (el) => setLayer(el.dataset.layer));
  /* A tap on the house opens the room under it: the room whose floor
   * rectangle (projected) holds the tap, the nearest floor when several do.
   * A tap on a reading of the Klimaat layer opens that climate popup instead. */
  /* The depth at which a room's floor quad lies under the tap, or null when it does not. */
  function roomDepth(r, x, y) {
    const house = Panel.house;
    const box = (plan.rooms[r.floor] || []).find((q) => q.name === r.name);
    const lv = (plan.levels || []).find((l) => l.floor === r.floor);
    if (!box || !lv) return null;
    const y0 = lv.y + 0.02;
    return hitQuad([[box.x, y0, box.z], [box.x + box.w, y0, box.z], [box.x + box.w, y0, box.z + box.d], [box.x, y0, box.z + box.d]].map(house.project), x, y);
  }
  function roomAt(x, y) {
    if (!Panel.house) return null;
    let best = null;
    for (const r of rooms) {
      const depth = roomDepth(r, x, y);
      if (depth != null && (!best || depth < best.depth)) best = { r, depth };
    }
    return best && best.r;
  }
  /* Even-odd test of a point against a projected quad; null when any corner is off screen. */
  function hitQuad(pts, x, y) {
    if (pts.some((p) => !p)) return null;
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const a = pts[i], b = pts[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside ? pts.reduce((s, p) => s + p.depth, 0) / 4 : null;
  }
  /* A door the panel drives, under the tap: as a room of its own with the
   * door's controls, tied to the door's middle. */
  function doorAt(x, y) {
    const house = Panel.house;
    let best = null;
    (cfg.covers || []).forEach((c, i) => {
      const corners = house.opening(c.opening);
      if (!corners) return;
      const depth = hitQuad(corners.map(house.project), x, y);
      if (depth == null || (best && depth >= best.depth)) return;
      const centre = [0, 1, 2].map((k) => corners.reduce((s, p) => s + p[k], 0) / 4);
      best = { depth, room: { floor: "0", name: c.label, card: null, presence: null, centre, lights: [], cover: i, door: true } };
    });
    return best;
  }
  function tapped({ x, y }) {
    /* a room under the tap opens beside the house (its climate is in there);
     * a door in front of it opens its own controls */
    const room = roomAt(x, y);
    const door = doorAt(x, y);
    if (door && (!room || door.depth <= roomDepth(room, x, y))) return Panel.openRoom(door.room);
    if (room) return Panel.openRoom(room);
    if (Panel.currentRoom && Panel.currentRoom()) return Panel.closeRoom(); /* a tap on nothing closes it */
    if (layer !== "climate") return;
    /* a reading outside the rooms (the outside sensor) opens its climate popup */
    let best = null;
    for (const el of labels.children) {
      if (el.hidden) continue;
      const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(el.style.transform);
      if (!m) continue;
      const d = Math.hypot(+m[1] - x, +m[2] - y);
      if (d < 44 && (!best || d < best.d)) best = { el, d };
    }
    if (!best) return;
    const card = climateCards.find((c) => (plan.sensors || []).some((s) => s.climate === c.label && JSON.stringify(s.at) === best.el.dataset.at));
    if (card) Panel.openClimateFor(card.entities.temperature);
  }

  /* ---- The robots at work ----------------------------------------------------------- */
  const robots = [
    ...(cfg.vacuum ? [{ label: cfg.vacuum.label, floor: cfg.vacuum.floor, vacuum: cfg.vacuum.vacuum, rooms: cfg.vacuum.rooms || [] }] : []),
    ...(cfg.tuyaVacuums || []).map((r) => ({ label: r.label, floor: r.floor, vacuum: r.entities.vacuum, problem: r.entities.problem, rooms: [] })),
  ];
  /* The plan's room for a robot's room label (a room may name its robotRoom). */
  const planRoom = (floor, label) => ((plan.rooms || {})[floor] || []).find((r) => r.name === label || r.robotRoom === label);
  const BUSY = { cleaning: "aan het werk", returning: "op weg naar het station", paused: "gepauzeerd" };
  /* The robot's rooms this run (Xiaomi lists their ids), or its whole floor. */
  function roomsOf(r) {
    let ids = [];
    try {
      ids = JSON.parse(((Panel.st(r.vacuum) || {}).attributes || {})["robotic_vacuum.clean_values"] || "[]");
    } catch (e) {
      ids = [];
    }
    const found = ids.map((id) => (r.rooms.find((x) => x.id === Number(id)) || {}).label).filter(Boolean);
    const named = found.map((l) => planRoom(r.floor, l)).filter(Boolean);
    if (named.length) return { rooms: named.map((x) => x.name), text: found.join(", ") };
    return { rooms: ((plan.rooms || {})[r.floor] || []).map((x) => x.name), text: "hele verdieping" };
  }
  function renderRobots() {
    const house = Panel.house;
    const busy = robots.map((r) => ({ r, doing: BUSY[state(r.vacuum)] })).filter((x) => x.doing);
    if (house) house.clearRooms();
    if (!busy.length) {
      badge.hidden = true;
      return;
    }
    busy.forEach(({ r, doing }) => {
      if (house && doing !== BUSY.returning) roomsOf(r).rooms.forEach((name) => house.highlightRoom(r.floor, name));
    });
    const first = busy[0];
    badge.querySelector("[data-robot-label]").textContent = busy.length > 1 ? `${busy.length} robots` : first.r.label;
    badge.querySelector("[data-robot-where]").textContent = first.doing === BUSY.cleaning ? roomsOf(first.r).text : first.doing;
    badge.hidden = false;
  }

  /* ---- Render ------------------------------------------------------------------------ */
  function render() {
    if (!root) return;
    noteChanges(!loadedOnce);
    loadedOnce = Panel.isLoaded();
    renderEvents();
    renderSky();
    /* The watch: what a glance at night should tell — what is open, what is on, who is in. */
    const open = contacts.filter((c) => state(c.entities.contact) === "on").map((c) => c.label);
    const lampsOn = rooms.flatMap((r) => r.lights).filter((id, i, all) => all.indexOf(id) === i && state(id) === "on").length;
    const here = rooms.filter((r) => r.presence && state(r.presence) === "on").map((r) => r.name);
    root.querySelector("[data-hud-watch]").innerHTML =
      `<span class="${open.length ? "warn" : "ok"}">${esc(open.length ? `Open: ${open.join(", ")}` : "Alles dicht")}</span>` +
      `<span>${lampsOn ? `${lampsOn} lamp${lampsOn === 1 ? "" : "en"} aan` : "Alle lampen uit"}</span>` +
      (here.length ? `<span>Iemand in ${esc(here.join(", "))}</span>` : "");
    const lines = [connection(), ...problems()];
    root.querySelector("[data-hud-rows]").innerHTML = lines
      .map((v) => `<div class="hud-row"><i class="hud-dot ${v.tone}"></i><span class="hud-v">${esc(v.text)}</span></div>`)
      .join("");
    renderRobots();
    renderLayer();
    startFollowing();
  }
  /* Many entities change at once (the first dump, a reconnect): one render. */
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      render();
    }, 120);
  };
  function clock() {
    if (!root) return;
    const d = new Date();
    root.querySelector("[data-hud-clock]").textContent = `${Util.hm(d)}  ·  ${d.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "short" }).replace(".", "")}`;
  }

  Panel.on("start", () => {
    const house = document.querySelector(".start-page .house");
    if (!house) return;
    house.insertAdjacentHTML("beforeend", html());
    root = house.querySelector("[data-hud]");
    badge = house.querySelector("[data-robot]");
    labels = house.querySelector("[data-labels]");
    if (Panel.house) Panel.house.onTap(tapped);
    clock();
    renderWalls();
    render();
  });
  Panel.on("status", (s) => {
    /* no event line for the connection going or returning: the readout's
     * first row says it, and the health page keeps the log (user's wish) */
    status = s;
    schedule();
  });
  Panel.on("loaded", schedule);
  Panel.on("section", startFollowing);
  Panel.on("sleep", (on) => !on && startFollowing());
  Panel.on("room", () => renderLayer()); /* the chosen room's floor lights up (or goes out) */
  document.addEventListener("visibilitychange", startFollowing);
  Panel.on("minute", () => {
    clock();
    schedule(); /* the error count moves on its own */
  });
  Panel.track(
    [
      ...rooms.flatMap((r) => r.lights),
      ...climateCards.flatMap((c) => [c.entities.temperature, c.entities.humidity]),
      ...(cfg.appliances || []).flatMap((a) => Object.values(a.entities)),
      ...robots.flatMap((r) => [r.vacuum, r.problem]),
      ...contacts.map((c) => c.entities.contact),
      ...plantCards.flatMap((c) => [c.entities.moisture, c.entities.dry, c.entities.warning]),
      ...rooms.map((r) => r.presence),
      (cfg.health || {}).zigbee,
      (cfg.health || {}).internet,
      (cfg.health || {}).rain,
      SUN,
      cfg.weather,
    ].filter(Boolean),
    schedule
  );
})();
