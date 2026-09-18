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
    `<div class="hud" data-hud><div class="hud-clock" data-hud-clock></div><div class="hud-rows" data-hud-rows></div></div>` +
    `<div class="house-robot" data-robot hidden><span class="hr-icon">${icon("vacuum")}</span><span class="hr-text"><b data-robot-label></b><span data-robot-where></span></span></div>` +
    `<div class="house-labels" data-labels></div>` +
    `<div class="house-layers">${LAYERS.map(([k, l]) => `<button class="hl-btn" data-layer="${k}">${l}</button>`).join("")}</div>` +
    `<div class="house-walls"><button class="hl-btn" data-walls>${icon("home")}<span>Binnenmuren</span></button></div>`;

  /* ---- What is wrong ------------------------------------------------------------ */
  const state = (id) => (Panel.st(id) || {}).state;
  const tones = () => (Panel.applianceTones ? Panel.applianceTones() : []);

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
    const errors = window.Diag ? window.Diag.errorCount() : 0;
    if (errors) out.push({ tone: "bad", text: `${errors} scriptfout${errors === 1 ? "" : "en"}` });
    return out;
  }

  /* ---- The rooms of the plan, with their sensor and their lamps ------------------- */
  const plan = window.HOUSE_PLAN || { rooms: {} };
  const climateCards = (cfg.sensorCards || []).filter((c) => c.kind === "climate");
  const areasOf = (floor) => {
    const f = (cfg.floors || []).find((x) => x.label === floor);
    return f ? cfg.tabs[f.tab].areas || [] : [];
  };
  const tabLights = (name) => {
    const t = (cfg.tabs || []).find((x) => x.name === name);
    return t ? [...t.lights, ...t.devices].map((d) => d.id).filter((id) => id.startsWith("light.")) : [];
  };
  /* Every room: its floor and name, the climate card that reads in it (or
   * whose reading it shares), and the lamps in it (its PANEL_AREAS rooms). */
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
      return { floor, name: r.name, card, centre: [r.x + r.w / 2, 0, r.z + r.d / 2], lights };
    })
  );
  rooms.forEach((r) => {
    const lv = (plan.levels || []).find((l) => l.floor === r.floor);
    r.centre[1] = (lv ? lv.y : 0) + 0.05;
  });
  /* A card's label sits on the first room that reads it. */
  const labelRoom = new Map();
  rooms.forEach((r) => r.card && !labelRoom.has(r.card.label) && labelRoom.set(r.card.label, r));

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
    if (layer === "none" || !labels.children.length || !Panel.onScreen("start") || document.visibilityState !== "visible") return;
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
    clock();
    renderWalls();
    render();
  });
  Panel.on("status", (s) => {
    status = s;
    schedule();
  });
  Panel.on("loaded", schedule);
  Panel.on("section", startFollowing);
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
    ].filter(Boolean),
    schedule
  );
})();
