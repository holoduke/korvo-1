/* Schoonmaak: Tuya robot vacuums (Tuya Local; the ILIFE V30 upstairs), a panel
 * per PANEL_TUYA_VACUUMS entry on its floor's place in cleaning.js. Left the
 * robot's state and battery, a fault, this run, its totals and recent runs;
 * right the actions, suction, mopping and thoroughness, and the brushes and
 * filter with their resets. Such a robot has no rooms and no stop: "Naar dock"
 * ends a run. It resets its area and time counters when a run starts, which is
 * how its runs are read from Home Assistant's history. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const { esc, fmt, ago } = Util;

  const STATE_NL = { cleaning: "Zuigt", paused: "Gepauzeerd", returning: "Terug naar dock", docked: "In dock", idle: "Staat stil", error: "Storing" };
  /* The robot's own status (the vacuum's "status" attribute), more precise than its state. */
  const STATUS_NL = {
    standby: "Stand-by", smart: "Zuigt", zone: "Zuigt een zone", partial: "Zuigt een deel", cleaning: "Zuigt", paused: "Gepauzeerd",
    seeking_spot: "Naar een plek", "located spot": "Op de plek", left_spot: "Plek verlaten", returning: "Terug naar dock",
    charging: "Laadt op", charged: "Opgeladen", sleep: "Slaapt", edge_cleaning: "Zuigt de randen",
    mapping: "Maakt een kaart", cleaning_and_mapping: "Zuigt, maakt een kaart",
  };
  const FAN_NL = { Off: "Uit", Low: "Laag", Medium: "Normaal", High: "Hoog", Max: "Max" };
  const MOP_NL = { off: "Uit", low: "Laag", medium: "Midden", high: "Hoog" };
  const EFFICIENCY_NL = { Careful: "Grondig", Normal: "Normaal", Fast: "Snel" };
  const PARTS = [["edge", "Zijborstel"], ["roll", "Hoofdborstel"], ["filter", "Filter"]];
  const JOB = ["cleaning", "returning", "paused"];
  const JOB_MS = 20000; /* a start or return takes the robot a while to report */
  const CHOICE_MS = 8000;
  const RUNS_SHOWN = 5;
  const HISTORY_DAYS = 14;

  const st = (id) => Panel.st(id);
  const stateOf = (id) => (st(id) || {}).state;

  const views = (cfg.tuyaVacuums || []).map((robot) => {
    const view = { robot, root: null, runs: null, loadedAt: 0, loading: false };
    view.queue = Panel.commandQueue(robot.label, () => render(view));
    view.twoTap = Util.confirmer(3000, () => render(view));
    return view;
  });

  /* Runs from the robot's area and time counters: a counter going down is a new
   * run; each run keeps the most it reached and when it last grew. Newest first. */
  function runsFrom(areaRows, timeRows) {
    const points = [
      ...areaRows.map((r) => ({ t: r.t, key: "area", v: parseFloat(r.s) })),
      ...timeRows.map((r) => ({ t: r.t, key: "minutes", v: parseFloat(r.s) })),
    ]
      .filter((p) => Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t);
    const runs = [];
    let run = null;
    const commit = () => run && (run.area > 0 || run.minutes > 0) && runs.push(run);
    for (const p of points) {
      if (run && p.v < run[p.key]) {
        commit();
        run = null;
      }
      if (!run) run = { area: 0, minutes: 0, end: p.t };
      run[p.key] = Math.max(run[p.key], p.v);
      if (p.v > 0) run.end = p.t;
    }
    commit();
    return runs.reverse();
  }

  /* "many": a row that may wrap on a phone. */
  const chips = (kind, labels) =>
    `<div class="vs-chips${Object.keys(labels).length > 4 ? " many" : ""}" style="--n:${Object.keys(labels).length}">` +
    Object.entries(labels).map(([opt, l]) => `<button class="vchip" data-tuyavac="${kind}" data-opt="${opt}">${l}</button>`).join("") +
    `</div>`;

  const html = (view) =>
    `<div class="vp tv" data-tuya-robot="${views.indexOf(view)}"><div class="vs-body">` +
    `<section class="vs-map">` +
    `<div class="tv-hero"><div class="tv-head"><b class="tv-status"></b><span class="tv-sub"></span></div>` +
    `<div class="tv-batt">${icon("battery")}<span></span><i><b></b></i></div>` +
    `<div class="vs-alert" hidden>${icon("warning")}<span></span></div></div>` +
    `<div class="tv-stats">` +
    `<div class="tv-stat"><span data-label="run"></span><b data-stat="run"></b></div>` +
    `<div class="tv-stat"><span>Totaal</span><b data-stat="area"></b></div>` +
    `<div class="tv-stat"><span>Rondes</span><b data-stat="runs"></b></div></div>` +
    `<div class="vs-section-title">Laatste rondes</div><div class="vs-rec-list"></div>` +
    `</section>` +
    `<section class="vs-side"><div class="tv-actions">` +
    `<button class="vbtn primary" data-tuyavac="start">${icon("play")}<span>Start</span></button>` +
    `<button class="vbtn primary" data-tuyavac="resume">${icon("play")}<span>Verder</span></button>` +
    `<button class="vbtn" data-tuyavac="pause">${icon("pause")}<span>Pauze</span></button>` +
    `<button class="vbtn" data-tuyavac="dock">${icon("dock")}<span>Naar dock</span></button>` +
    `<button class="vbtn" data-tuyavac="locate">${icon("locate")}<span>Zoek robot</span></button>` +
    `</div>` +
    `<div class="vs-group"><span class="vlabel">Zuigkracht</span>${chips("fan", FAN_NL)}</div>` +
    `<div class="vs-group"><span class="vlabel">Dweilen</span>${chips("mop", MOP_NL)}</div>` +
    `<div class="vs-group"><span class="vlabel">Grondigheid</span>${chips("efficiency", EFFICIENCY_NL)}</div>` +
    `<div class="vs-section-title">Onderhoud</div>` +
    PARTS.map(([part, label]) => `<div class="tv-cons" data-part="${part}"><span>${label}</span><em></em><button class="tv-reset" data-tuyavac="reset" data-part="${part}">Reset</button></div>`).join("") +
    `</section></div></div>`;

  function render(view) {
    const { robot, root } = view;
    if (!root) return;
    const e = robot.entities;
    const q = (sel) => root.querySelector(sel);
    const v = st(e.vacuum);
    const offline = Panel.unavailable(v);
    const state = v ? v.state : "unavailable";
    const attrs = (v && v.attributes) || {};
    const job = JOB.includes(state);
    view.queue.settle();
    root.classList.toggle("offline", offline);

    const status = offline ? "Offline" : state === "error" ? "Storing" : STATUS_NL[attrs.status] || STATE_NL[state] || state;
    q(".tv-status").textContent = status;
    q(".tv-sub").textContent = !offline && STATE_NL[state] && STATE_NL[state] !== status ? STATE_NL[state] : "";
    const battery = Panel.num(e.battery);
    q(".tv-batt span").textContent = Number.isFinite(battery) ? `${fmt(battery)}%` : "--";
    const bar = q(".tv-batt i b");
    bar.style.width = (Number.isFinite(battery) ? Util.clamp(battery, 0, 100) : 0) + "%";
    bar.style.background = Util.batteryColour(battery);
    /* Out of reach, or a fault the robot reports: say so. Out of reach, nothing to tap. */
    const unreachable = offline && Panel.isLoaded();
    const fault = stateOf(e.problem) === "on";
    const code = ((st(e.problem) || {}).attributes || {}).fault_code;
    q(".vs-alert").hidden = !(unreachable || fault);
    q(".vs-alert span").textContent = unreachable ? Panel.unreachableText(v) : `Storing${code ? ` (code ${code})` : ""}: kijk even bij de robot`;
    root.querySelectorAll(".tv-actions .vbtn, .vchip, .tv-reset").forEach((b) => (b.disabled = unreachable));

    const area = Panel.num(e.area);
    const minutes = Panel.num(e.time);
    q('[data-label="run"]').textContent = job ? "Deze ronde" : "Laatste ronde";
    q('[data-stat="run"]').textContent = Number.isFinite(area) ? `${fmt(area)} m² · ${fmt(minutes)} min` : "--";
    const totalArea = Panel.num(e.totalArea);
    const totalRuns = Panel.num(e.totalRuns);
    const totalMinutes = Panel.num(e.totalTime);
    q('[data-stat="area"]').textContent = Number.isFinite(totalArea) ? `${fmt(totalArea)} m²` : "--";
    q('[data-stat="runs"]').textContent = Number.isFinite(totalRuns)
      ? `${fmt(totalRuns)}${Number.isFinite(totalMinutes) ? ` · ${Util.duration(totalMinutes * 60).join(" ")}` : ""}`
      : "--";

    /* Two or three tiles: a start, or pause and resume, plus dock and locate. */
    const tile = (act, visible) => {
      const btn = q(`[data-tuyavac="${act}"]`);
      btn.hidden = !visible;
      btn.classList.toggle("pending", view.queue.has(`job|${act}`));
    };
    tile("start", !offline && !job);
    tile("resume", state === "paused");
    tile("pause", state === "cleaning" || state === "returning");
    tile("dock", !offline && state !== "docked" && state !== "returning");
    q('[data-tuyavac="locate"]').hidden = offline;

    const current = { fan: attrs.fan_speed, mop: stateOf(e.mopping), efficiency: stateOf(e.efficiency) };
    root.querySelectorAll(".vchip").forEach((c) => {
      const kind = c.dataset.tuyavac;
      c.classList.toggle("active", c.dataset.opt === current[kind]);
      c.classList.toggle("pending", view.queue.has(`${kind}|${c.dataset.opt}`));
    });

    PARTS.forEach(([part]) => {
      const row = q(`.tv-cons[data-part="${part}"]`);
      const left = Panel.num(e[`${part}Life`]);
      const dirty = stateOf(e[`${part}Dirty`]) === "on";
      const life = Number.isFinite(left) ? (left >= 60 ? `nog ${fmt(left / 60)} uur` : `nog ${fmt(left)} min`) : "";
      row.classList.toggle("dirty", dirty);
      row.querySelector("em").textContent = [dirty && "schoonmaken", life].filter(Boolean).join(" · ") || "--";
      const reset = row.querySelector(".tv-reset");
      reset.classList.toggle("armed", view.twoTap.armed(part));
      reset.textContent = view.twoTap.armed(part) ? "Nogmaals" : "Reset";
    });

    q(".vs-rec-list").innerHTML =
      view.runs === null
        ? `<div class="vs-empty">Laden...</div>`
        : view.runs.length
          ? view.runs
              .slice(0, RUNS_SHOWN)
              .map((r, i) => `<div class="vs-rec"><span>${esc(i === 0 && job ? "nu bezig" : ago(r.end))}</span><b>${fmt(r.area)} m²</b><em>${fmt(r.minutes)} min</em></div>`)
              .join("")
          : `<div class="vs-empty">Nog geen rondes</div>`;
  }

  async function load(view, force) {
    if (view.loading || (!force && Date.now() - view.loadedAt < 60e3)) return;
    view.loading = true;
    view.loadedAt = Date.now();
    const e = view.robot.entities;
    try {
      const hist = await Panel.client.history([e.area, e.time], new Date(Date.now() - HISTORY_DAYS * 86400e3));
      view.runs = runsFrom(hist[e.area] || [], hist[e.time] || []);
    } catch (err) {
      view.runs = view.runs || [];
    }
    view.loading = false;
    render(view);
  }

  views.forEach((view) =>
    Panel.defineRobot({
      floor: view.robot.floor,
      className: "tuya-robot",
      html: () => html(view),
      build(panel) {
        view.root = panel.querySelector(".tv");
        render(view);
      },
    })
  );

  Panel.defineAction("tuyavac", (el) => {
    const view = views[+el.closest("[data-tuya-robot]").dataset.tuyaRobot];
    const e = view.robot.entities;
    const kind = el.dataset.tuyavac;
    const option = el.dataset.opt;
    const vacuum = { entity_id: e.vacuum };
    const call = (domain, service, data, target) => () => Panel.client.callService(domain, service, data, target);
    const reaches = (...states) => () => states.includes(stateOf(e.vacuum));
    const job = (act, service, landed, failed) => view.queue.send(`job|${act}`, { send: call("vacuum", service, null, vacuum), landed, wait: JOB_MS, failed });

    if (kind === "start") job("start", "start", reaches("cleaning"), "de ronde is niet gestart");
    else if (kind === "resume") job("resume", "start", reaches("cleaning"), "de ronde gaat niet verder");
    else if (kind === "pause") job("pause", "pause", reaches("paused", "docked", "idle"), "hij is niet gepauzeerd");
    else if (kind === "dock") job("dock", "return_to_base", reaches("returning", "docked"), "hij gaat niet naar het dock");
    else if (kind === "locate") Panel.client.callService("vacuum", "locate", null, vacuum).catch(Panel.commandFailed(view.robot.label));
    else if (kind === "fan") {
      const fanSpeed = () => ((st(e.vacuum) || {}).attributes || {}).fan_speed;
      if (fanSpeed() === option) return;
      view.queue.send(`fan|${option}`, {
        send: call("vacuum", "set_fan_speed", { fan_speed: option }, vacuum),
        landed: () => fanSpeed() === option,
        wait: CHOICE_MS,
        failed: "zuigkracht is niet aangepast",
      });
    } else if (kind === "mop" || kind === "efficiency") {
      const id = kind === "mop" ? e.mopping : e.efficiency;
      if (stateOf(id) === option) return;
      view.queue.send(`${kind}|${option}`, {
        send: call("select", "select_option", { option }, { entity_id: id }),
        landed: () => stateOf(id) === option,
        wait: CHOICE_MS,
        failed: kind === "mop" ? "dweilen is niet aangepast" : "grondigheid is niet aangepast",
      });
    } else if (kind === "reset") {
      /* A second tap confirms: the part's counter starts over. */
      const part = el.dataset.part;
      if (!view.twoTap.tap(part, true)) return;
      Panel.client.callService("button", "press", null, { entity_id: e[`${part}Reset`] }).catch(Panel.commandFailed(view.robot.label));
    }
    render(view);
  });

  /* Runs are read when the robot is shown, and again when a job ends. */
  views.forEach((view) => {
    let wasJob = false;
    Panel.track(Object.values(view.robot.entities), () => {
      const job = JOB.includes(stateOf(view.robot.entities.vacuum));
      if (wasJob && !job && Panel.isLoaded()) load(view, true);
      wasJob = job;
      render(view);
      if (Panel.robotOnScreen(view.robot.floor)) load(view, false);
    });
  });
  const shownNow = () => views.forEach((view) => Panel.isLoaded() && Panel.robotOnScreen(view.robot.floor) && load(view, false));
  Panel.on("section", shownNow);
  Panel.on("robot", shownNow);
})();
