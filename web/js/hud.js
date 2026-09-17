/* The readout on the house (Start section): the connection, and only what is
 * wrong — an appliance or robot in fault, devices out of reach, script
 * errors — with the clock while the screensaver hides the header. And the
 * robots at work: the rooms they are cleaning lit on the floor of the house,
 * and a badge in the other corner. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const esc = Util.esc;

  let root = null;
  let badge = null;
  let status = "connecting";
  let timer = 0;

  const html = () =>
    `<div class="hud" data-hud><div class="hud-clock" data-hud-clock></div><div class="hud-rows" data-hud-rows></div></div>` +
    `<div class="house-robot" data-robot hidden><span class="hr-icon">${icon("vacuum")}</span><span class="hr-text"><b data-robot-label></b><span data-robot-where></span></span></div>`;

  /* ---- What is wrong ------------------------------------------------------------ */
  const contacts = (cfg.sensorCards || []).filter((c) => (c.kind === "door" || c.kind === "window") && c.entities.contact);
  const state = (id) => (Panel.st(id) || {}).state;
  const tones = () => (Panel.applianceTones ? Panel.applianceTones() : []);

  function connection() {
    if (Panel.client && Panel.client.demo) return { tone: "ok", text: "Demo" };
    if (status === "connected") return { tone: "ok", text: "Home Assistant online" };
    if (status === "connecting") return { tone: "warn", text: "Verbinden met Home Assistant…" };
    return { tone: "bad", text: "Geen verbinding met Home Assistant" };
  }
  /* Devices out of reach, counted as things (a lamp, a sensor), not as the
   * entities an integration makes of them (one filter has seven). */
  const lamps = [...new Set((cfg.tabs || []).flatMap((t) => [...t.devices, ...t.lights].map((d) => d.id).filter((id) => id.startsWith("light."))))];
  const sensors = [
    ...contacts.map((c) => c.entities.contact),
    ...(cfg.sensors || []).map((s) => s.temp),
    ...(cfg.air || []).map((a) => a.co2),
  ].filter(Boolean);
  function problems() {
    const out = [];
    const faulty = tones().filter((t) => t.tone === "error");
    if (faulty.length) out.push({ tone: "bad", text: `Storing: ${faulty.map((t) => t.label).join(", ")}` });
    const stuck = robots.filter((r) => state(r.vacuum) === "error" || state(r.problem) === "on");
    if (stuck.length) out.push({ tone: "bad", text: `Storing: ${stuck.map((r) => r.label).join(", ")}` });
    const gone = (ids) => ids.filter((id) => state(id) === "unavailable").length;
    const parts = [
      [gone(lamps), "lamp", "lampen"],
      [gone(sensors), "sensor", "sensoren"],
      [tones().filter((t) => t.tone === "offline").length, "apparaat", "apparaten"],
    ].filter(([n]) => n);
    if (parts.length) out.push({ tone: "warn", text: `${parts.map(([n, one, many]) => `${n} ${n === 1 ? one : many}`).join(", ")} niet bereikbaar` });
    const errors = window.Diag ? window.Diag.errorCount() : 0;
    if (errors) out.push({ tone: "bad", text: `${errors} scriptfout${errors === 1 ? "" : "en"}` });
    return out;
  }

  /* ---- The robots at work ----------------------------------------------------------- */
  const robots = [
    ...(cfg.vacuum ? [{ label: cfg.vacuum.label, floor: cfg.vacuum.floor, vacuum: cfg.vacuum.vacuum, rooms: cfg.vacuum.rooms || [] }] : []),
    ...(cfg.tuyaVacuums || []).map((r) => ({ label: r.label, floor: r.floor, vacuum: r.entities.vacuum, problem: r.entities.problem, rooms: [] })),
  ];
  const plan = window.HOUSE_PLAN || { rooms: {} };
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
    const labels = ids.map((id) => (r.rooms.find((x) => x.id === Number(id)) || {}).label).filter(Boolean);
    const named = labels.map((l) => planRoom(r.floor, l)).filter(Boolean);
    if (named.length) return { rooms: named.map((x) => x.name), text: labels.join(", ") };
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
    const lit = new Set();
    busy.forEach(({ r, doing }) => {
      const where = roomsOf(r);
      if (house && doing !== BUSY.returning) where.rooms.forEach((name) => house.highlightRoom(r.floor, name) && lit.add(name));
    });
    const first = busy[0];
    const where = roomsOf(first.r);
    badge.querySelector("[data-robot-label]").textContent = busy.length > 1 ? `${busy.length} robots` : first.r.label;
    badge.querySelector("[data-robot-where]").textContent = first.doing === BUSY.cleaning ? where.text : first.doing;
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
    clock();
    render();
  });
  Panel.on("status", (s) => {
    status = s;
    schedule();
  });
  Panel.on("loaded", schedule);
  Panel.on("minute", () => {
    clock();
    schedule(); /* the reach and error counts move on their own */
  });
  Panel.track(
    [
      ...lamps,
      ...sensors,
      ...(cfg.appliances || []).flatMap((a) => Object.values(a.entities)),
      ...robots.flatMap((r) => [r.vacuum, r.problem]),
    ].filter(Boolean),
    schedule
  );
})();
