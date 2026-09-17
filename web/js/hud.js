/* The readout in the corner of the house (Start section): the state of the
 * system in a few lines — the connection, doors and windows standing open,
 * appliances at work, the robots, devices out of reach, script errors — with
 * one verdict on top, and the clock while the screensaver hides the header. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;
  const esc = Util.esc;
  const NAMES_SHOWN = 3; /* open doors named on the line, the rest counted */

  let root = null;
  let status = "connecting";
  let timer = 0;

  const html = () =>
    `<div class="hud" data-hud>` +
    `<div class="hud-clock" data-hud-clock></div>` +
    `<div class="hud-title">Systeemstatus</div>` +
    `<div class="hud-verdict" data-hud-verdict></div>` +
    `<div class="hud-rows" data-hud-rows></div>` +
    `</div>`;

  /* ---- The lines ------------------------------------------------------------------- */
  const contacts = (cfg.sensorCards || []).filter((c) => (c.kind === "door" || c.kind === "window") && c.entities.contact);
  const robots = [
    ...(cfg.vacuum ? [{ label: cfg.vacuum.label, vacuum: cfg.vacuum.vacuum }] : []),
    ...(cfg.tuyaVacuums || []).map((r) => ({ label: r.label, vacuum: r.entities.vacuum, problem: r.entities.problem })),
  ];
  const state = (id) => (Panel.st(id) || {}).state;

  function connection() {
    if (Panel.client && Panel.client.demo) return { tone: "ok", text: "Demo" };
    if (status === "connected") return { tone: "ok", text: "Home Assistant online" };
    if (status === "connecting") return { tone: "warn", text: "Verbinden…" };
    return { tone: "bad", text: "Geen verbinding" };
  }
  function openings() {
    const open = contacts.filter((c) => state(c.entities.contact) === "on").map((c) => c.label);
    if (!open.length) return { tone: "ok", text: "Alles dicht", count: 0 };
    const more = open.length - NAMES_SHOWN;
    return { tone: "warn", text: `Open: ${open.slice(0, NAMES_SHOWN).join(", ")}${more > 0 ? ` +${more}` : ""}`, count: open.length };
  }
  function appliances() {
    const tones = Panel.applianceTones ? Panel.applianceTones() : [];
    const faulty = tones.filter((t) => t.tone === "error");
    if (faulty.length) return { tone: "bad", text: `Storing: ${faulty.map((t) => t.label).join(", ")}`, faults: faulty.length };
    const busy = tones.filter((t) => ["run", "hot", "paused"].includes(t.tone)).length;
    return { tone: busy ? "ok" : "dim", text: busy ? `${busy} actief` : "Stand-by", faults: 0 };
  }
  function robotsLine() {
    const faulty = robots.filter((r) => state(r.vacuum) === "error" || state(r.problem) === "on");
    if (faulty.length) return { tone: "bad", text: `Storing: ${faulty.map((r) => r.label).join(", ")}`, faults: faulty.length };
    const busy = robots.filter((r) => ["cleaning", "returning", "paused"].includes(state(r.vacuum))).length;
    return { tone: busy ? "ok" : "dim", text: busy ? `${busy} aan het werk` : "Op het station", faults: 0 };
  }
  /* Devices out of reach, counted as things (a lamp, a sensor), not as the
   * entities an integration makes of them (one filter has seven). */
  const lamps = [...new Set((cfg.tabs || []).flatMap((t) => [...t.devices, ...t.lights].map((d) => d.id).filter((id) => id.startsWith("light."))))];
  const sensors = [
    ...contacts.map((c) => c.entities.contact),
    ...(cfg.sensors || []).map((s) => s.temp),
    ...(cfg.air || []).map((a) => a.co2),
  ].filter(Boolean);
  function reach() {
    const gone = (ids) => ids.filter((id) => state(id) === "unavailable").length;
    const parts = [
      [gone(lamps), "lamp", "lampen"],
      [gone(sensors), "sensor", "sensoren"],
      [(Panel.applianceTones ? Panel.applianceTones() : []).filter((t) => t.tone === "offline").length, "apparaat", "apparaten"],
    ].filter(([n]) => n);
    if (!parts.length) return { tone: "ok", text: "Alles bereikbaar" };
    return { tone: "warn", text: `${parts.map(([n, one, many]) => `${n} ${n === 1 ? one : many}`).join(", ")} niet bereikbaar` };
  }
  function scripts() {
    const n = window.Diag ? window.Diag.errorCount() : 0;
    return n ? { tone: "bad", text: `${n} scriptfout${n === 1 ? "" : "en"}`, count: n } : { tone: "ok", text: "Geen", count: 0 };
  }

  function render() {
    if (!root) return;
    const lines = [
      ["Verbinding", connection()],
      ["Deuren & ramen", openings()],
      ["Apparaten", appliances()],
      ["Robots", robotsLine()],
      ["Bereik", reach()],
      ["Fouten", scripts()],
    ];
    root.querySelector("[data-hud-rows]").innerHTML = lines
      .map(([k, v]) => `<div class="hud-row"><i class="hud-dot ${v.tone}"></i><span class="hud-k">${k}</span><span class="hud-v">${esc(v.text)}</span></div>`)
      .join("");
    /* The verdict: the worst of it, in one line. */
    const conn = lines[0][1];
    const bad = lines.filter(([, v]) => v.tone === "bad").length;
    const warn = lines.filter(([, v]) => v.tone === "warn").length;
    const v = root.querySelector("[data-hud-verdict]");
    const verdict =
      conn.tone === "bad" ? ["bad", "Geen verbinding"]
      : !Panel.isLoaded() ? ["warn", "Systemen laden…"]
      : bad ? ["bad", `${bad} storing${bad === 1 ? "" : "en"}`]
      : warn ? ["warn", `${warn} melding${warn === 1 ? "" : "en"}`]
      : ["ok", "Alle systemen online"];
    v.dataset.tone = verdict[0];
    v.textContent = verdict[1];
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
      ...contacts.map((c) => c.entities.contact),
      ...(cfg.appliances || []).flatMap((a) => Object.values(a.entities)),
      ...robots.flatMap((r) => [r.vacuum, r.problem]),
    ].filter(Boolean),
    schedule
  );
})();
