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
  /* The robot's switches: entity key -> label. */
  const TOGGLES = [["dnd", "Niet storen"], ["breakClean", "Verder na opladen"], ["autoBoost", "Extra zuigkracht op tapijt"], ["yMopping", "Y-dweilen"]];
  /* Minutes of life a new part has (the V30's Tuya spec), for "x% over". */
  const LIFE_MAX = { edge: 900, roll: 1800, filter: 900 };
  /* The fault code is a bitmap (Tuya DP 28), bit 0 first: [what, what to do]. */
  const FAULTS = [
    ["bumper", "controleer of de bumper vrij beweegt"], ["obstakelsensor", "maak de sensoren schoon"], ["muursensor", "maak de sensoren schoon"],
    ["valsensor", "maak de sensoren aan de onderkant schoon"], ["opgetild", "zet de robot plat op de vloer"], ["zwenkwiel", "haal haren en vuil uit het voorwiel"],
    ["linker zijborstel", "haal haren uit de zijborstel"], ["rechter zijborstel", "haal haren uit de zijborstel"], ["zijborstel", "haal haren uit de zijborstel"],
    ["linkerwiel", "haal vuil uit het wiel"], ["rechterwiel", "haal vuil uit het wiel"], ["hoofdborstel", "haal haren uit de hoofdborstel"],
    ["ventilator", null], ["waterpomp", null], ["luchtpomp", null], ["stofbak", "plaats of leeg de stofbak"],
    ["watertank", "plaats of vul de watertank"], ["filter", "maak het filter schoon of plaats het terug"], ["accu", null],
    ["gyroscoop", null], ["radar", null], ["camera", null], ["vastgelopen", "haal de robot los en zet hem vrij neer"],
    ["waterdoorstroming", null], ["overig", null], ["te weinig licht", null], ["water", null], ["water", null], ["verkennen mislukt", null],
  ];
  /* During a run the time counter moves every minute; this long without news
   * means tuya_local stopped receiving (it can, without a sign). */
  const QUIET_MS = 4 * 60e3;
  /* A run that starts this soon after the last one, after a fault and without the
   * robot going home, is that run resumed (the robot restarts its counters). */
  const RESUME_MS = 30 * 60e3;
  /* Faster than this, the counters still held an earlier run's area: no run. */
  const MAX_M2_PER_MIN = 5;
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
   * run; each run keeps the most it reached and when it last grew. A run resumed
   * after a fault (see RESUME_MS) is added to the one before. Newest first. */
  function runsFrom(areaRows, timeRows, stateRows) {
    const points = [
      ...areaRows.map((r) => ({ t: r.t, key: "area", v: parseFloat(r.s) })),
      ...timeRows.map((r) => ({ t: r.t, key: "minutes", v: parseFloat(r.s) })),
    ]
      .filter((p) => Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t);
    const states = [...stateRows].sort((a, b) => a.t - b.t);
    const resumed = (last, next) => {
      if (next.start - last.end > RESUME_MS) return false;
      const between = states.filter((x) => x.t > last.end && x.t <= next.start).map((x) => x.s);
      return between.includes("error") && !between.some((s) => s === "docked" || s === "returning");
    };
    const runs = [];
    let run = null;
    const commit = () => {
      if (!run || !(run.area > 0 || run.minutes > 0)) return;
      if (run.minutes > 0 ? run.area / run.minutes > MAX_M2_PER_MIN : run.area > MAX_M2_PER_MIN) return;
      const last = runs[runs.length - 1];
      if (last && resumed(last, run)) {
        last.area += run.area;
        last.minutes += run.minutes;
        last.end = run.end;
      } else runs.push(run);
    };
    for (const p of points) {
      if (run && p.v < run[p.key]) {
        commit();
        run = null;
      }
      if (!run) run = { area: 0, minutes: 0, start: p.t, end: p.t };
      run[p.key] = Math.max(run[p.key], p.v);
      if (p.v > 0) run.end = p.t;
    }
    commit();
    return runs.reverse();
  }

  /* "many": a row that may wrap on a phone. */
  /* "Storing: vastgelopen, zijborstel. Haal de robot los en zet hem vrij neer." */
  function faultText(code) {
    const faults = Number.isFinite(code) && code > 0 ? FAULTS.filter((_, bit) => Math.floor(code / 2 ** bit) % 2 === 1) : [];
    if (!faults.length) return "Storing: kijk even bij de robot";
    const tip = (faults.find(([, hint]) => hint) || [])[1];
    return `Storing: ${faults.map(([what]) => what).join(", ")}.${tip ? ` ${tip[0].toUpperCase()}${tip.slice(1)}.` : ""}`;
  }

  const chips = (kind, labels) =>
    `<div class="vs-chips${Object.keys(labels).length > 4 ? " many" : ""}" style="--n:${Object.keys(labels).length}">` +
    Object.entries(labels).map(([opt, l]) => `<button class="vchip" data-tuyavac="${kind}" data-opt="${opt}">${l}</button>`).join("") +
    `</div>`;

  const html = (view) =>
    `<div class="vp tv" data-tuya-robot="${views.indexOf(view)}"><div class="vs-body">` +
    `<section class="vs-map">` +
    `<div class="tv-hero"><div class="tv-head"><b class="tv-status"></b><span class="tv-sub"></span></div>` +
    `<div class="tv-batt">${icon("battery")}<span></span><i><b></b></i></div>` +
    `<div class="vs-alert" hidden>${icon("warning")}<span></span>${Panel.reconnectHtml(view.robot.entities.vacuum)}</div></div>` +
    `<div class="tv-stats">` +
    `<div class="tv-stat"><span data-label="run"></span><b data-stat="run"></b></div>` +
    `<div class="tv-stat"><span>Totaal</span><b data-stat="area"></b></div>` +
    `<div class="tv-stat"><span>Rondes</span><b data-stat="runs"></b></div></div>` +
    `<div class="vs-plan"></div>` +
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
    `<div class="vs-group"><span class="vlabel">Andere ronde</span><div class="vs-chips" style="--n:2">` +
    `<button class="vchip" data-tuyavac="spot">Plek</button><button class="vchip" data-tuyavac="edge">Randen</button></div></div>` +
    `<div class="vs-section-title">Instellingen</div><div class="vs-settings">` +
    TOGGLES.map(([key, label]) => Panel.settingHtml(`data-tuyavac="toggle" data-toggle="${key}"`, label)).join("") +
    `</div>` +
    `<div class="vs-section-title">Onderhoud</div>` +
    PARTS.map(
      ([part, label]) =>
        `<div class="tv-cons" data-part="${part}"><span>${label}</span><i class="bar"><b></b></i><em></em>` +
        `<button class="tv-reset" data-tuyavac="reset" data-part="${part}">Reset</button></div>`
    ).join("") +
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
    /* Out of reach, a connection gone quiet during a run, or a fault the robot
     * reports: say so, and offer to reconnect for the first two. Out of reach,
     * nothing else to tap. */
    const unreachable = offline && Panel.isLoaded();
    const heard = Math.max(...[e.vacuum, e.time, e.area].map((id) => (st(id) || {}).lastUpdated || 0));
    const quiet = !unreachable && state === "cleaning" && Panel.isLoaded() && heard > 0 && Date.now() - heard > QUIET_MS;
    const fault = stateOf(e.problem) === "on";
    let alertText = "";
    if (unreachable) alertText = Panel.unreachableText(v);
    else if (quiet) alertText = `Geen nieuwe gegevens sinds ${Util.stamp(heard)}: de verbinding met de robot lijkt stil te liggen.`;
    else if (fault) alertText = faultText(Number(((st(e.problem) || {}).attributes || {}).fault_code));
    q(".vs-alert").hidden = !alertText;
    q(".vs-alert span").textContent = alertText;
    q(".vs-alert [data-reconnect]").hidden = !(unreachable || quiet);
    root.querySelectorAll(".tv-actions .vbtn, .vchip, .tv-reset, .vs-setting").forEach((b) => (b.disabled = unreachable));

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

    /* Spot and edge runs start from rest. */
    ["spot", "edge"].forEach((mode) => {
      const b = q(`[data-tuyavac="${mode}"]`);
      b.disabled = unreachable || job;
      b.classList.toggle("pending", view.queue.has(`job|${mode}`));
    });
    TOGGLES.forEach(([key]) => {
      const el = q(`[data-toggle="${key}"]`);
      el.classList.toggle("on", stateOf(e[key]) === "on");
      el.classList.toggle("pending", view.queue.has(`${key}|on`) || view.queue.has(`${key}|off`));
    });

    PARTS.forEach(([part]) => {
      const row = q(`.tv-cons[data-part="${part}"]`);
      const left = Panel.num(e[`${part}Life`]);
      const dirty = stateOf(e[`${part}Dirty`]) === "on";
      const pct = Number.isFinite(left) ? Util.clamp(Math.round((left / LIFE_MAX[part]) * 100), 0, 100) : NaN;
      const tone = dirty || pct < 10 ? "bad" : pct < 25 ? "warn" : "ok";
      row.classList.toggle("dirty", dirty);
      row.querySelector(".bar").className = `bar ${tone}`;
      row.querySelector(".bar b").style.width = (Number.isFinite(pct) ? pct : 0) + "%";
      row.querySelector("em").textContent = [dirty && "schoonmaken", Number.isFinite(pct) && `${pct}% over`].filter(Boolean).join(" · ") || "--";
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
      const hist = await Panel.client.history([e.area, e.time, e.vacuum], new Date(Date.now() - HISTORY_DAYS * 86400e3));
      view.runs = runsFrom(hist[e.area] || [], hist[e.time] || [], hist[e.vacuum] || []);
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
    } else if (kind === "spot" || kind === "edge") {
      view.queue.send(`job|${kind}`, {
        send: call("vacuum", "send_command", { command: kind === "spot" ? "clean_spot" : "edge" }, vacuum),
        landed: reaches("cleaning"),
        wait: JOB_MS,
        failed: "de ronde is niet gestart",
      });
    } else if (kind === "toggle") {
      const id = e[el.dataset.toggle];
      const next = stateOf(id) === "on" ? "off" : "on";
      view.queue.send(`${el.dataset.toggle}|${next}`, {
        send: call("switch", `turn_${next}`, null, { entity_id: id }),
        landed: () => stateOf(id) === next,
        wait: CHOICE_MS,
        failed: "de instelling is niet aangepast",
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
  /* "Geen nieuwe gegevens" needs time to pass, not a state change. */
  Panel.on("minute", () => views.forEach(render));
})();
