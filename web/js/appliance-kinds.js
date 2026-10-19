/* Household appliances in the Apparaten section: washer and dryer
 * (SmartThings), dishwasher, oven and hob (Home Connect via hcpy), the cooker
 * hood's plasma filter (ATAG over MQTT), the fridge (Liebherr) and the pc (a
 * template switch: on wakes it over the network, off puts it to sleep). */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { hm, fmt, known, duration } = Util;
  const { raw, low, num, on, attrs, offline, s, btn, chip, stepper, stat, note, offlineView } = Panel.applianceUi;

  const OP_NL = {
    inactive: "Uit", ready: "Gereed", delayedstart: "Uitgestelde start", run: "Bezig", pause: "Gepauzeerd",
    actionrequired: "Actie nodig", finished: "Klaar", error: "Storing", aborting: "Stoppen", unknown: "Onbekend",
  };
  const JOB_NL = {
    pre_wash: "Voorwas", wash: "Wassen", ai_wash: "Wassen", rinse: "Spoelen", ai_rinse: "Spoelen", spin: "Centrifugeren",
    ai_spin: "Centrifugeren", drying: "Drogen", ai_drying: "Drogen", cooling: "Afkoelen", finish: "Klaar", finished: "Klaar",
    delay_wash: "Uitgesteld", air_wash: "Opfrissen", refreshing: "Opfrissen", weight_sensing: "Wegen",
    wrinkle_prevent: "Kreukbescherming", dehumidifying: "Ontvochtigen", continuous_dehumidifying: "Ontvochtigen",
    sanitizing: "Hygiëne", internal_care: "Onderhoud", freeze_protection: "Vorstbeveiliging", thawing_frozen_inside: "Ontdooien",
  };
  const PHASE_NL = { prerinse: "Voorspoelen", mainwash: "Hoofdwas", finalrinse: "Naspoelen", drying: "Drogen" };
  const PROGRAM_NL = {
    Eco50: "Eco 50°", Auto1: "Auto 35–45°", Auto2: "Auto 45–65°", Auto3: "Auto 65–75°", Kurz60: "Kort 60°",
    PreRinse: "Voorspoelen", MachineCare: "Reiniging", LearningDishwasher: "Leerprogramma", "001": "Favoriet",
  };
  const HIDDEN_PROGRAMS = new Set(["001", "LearningDishwasher"]);

  /* Actions shared by several kinds. */
  /* The oven's chosen temperature and time, sent again once it runs (see start). */
  let ovenWant = { temp: NaN, time: NaN };
  let ovenStartTimer = 0;
  const toggle = (a, [key], call) => call("switch", on(a.entities[key]) ? "turn_off" : "turn_on", null, a.entities[key]);
  const press = (key) => (a, args, call) => call("button", "press", null, a.entities[key]);
  const selectOption = (key) => (a, [option], call) => call("select", "select_option", { option }, a.entities[key]);

  /* ---- Solar panels (SolaX inverter over Modbus TCP) ----------------------------- */
  /* What the panels make, per string, today and in total, and how the inverter
   * itself is (grid side, temperature, firmware). Read only: its power limit
   * and on/off are installer matters. After dark the inverter and its network
   * stick are off, which is not a fault. */
  const solarNum = (id, unit, digits = 0) => (known(num(id)) ? `${fmt(num(id), digits)}${unit}` : "--");
  const solarKwh = (v) => (known(v) ? `${fmt(v, v < 10 ? 2 : v < 100 ? 1 : 0)} kWh` : "--");
  Panel.defineAppliance("solar", {
    icon: "sun",
    view(a) {
      const e = a.entities;
      const E = Panel.energy;
      const awake = !offline(e.power);
      const w = awake ? num(e.power) : 0;
      const today = awake && known(num(e.today)) ? num(e.today) : E ? E.today(e.total) : NaN;
      const total = offline(e.total) ? NaN : num(e.total);
      const mode = E ? E.solarMode() : awake ? "Levert" : "Slaapt";
      const strings = [1, 2].filter((n) => awake && num(e[`pv${n}Volts`]) > 0);
      return {
        tone: w > 5 ? "run" : "off",
        pill: mode,
        big: known(w) ? fmt(w) : "--",
        unit: "W opwek",
        sub: `vandaag ${solarKwh(today)}${known(total) ? ` · totaal ${solarKwh(total)}` : ""}`,
        progress: null,
        stats: awake
          ? [
              stat("Panelen", solarNum(e.pv, " W")),
              ...strings.map((n) => stat(`String ${n}`, `${solarNum(e[`pv${n}Volts`], " V", 1)} · ${solarNum(e[`pv${n}Amps`], " A", 1)}`)),
              stat("Net", known(num(e.acVolts)) ? `${solarNum(e.acVolts, " V", 1)} · ${solarNum(e.acFreq, " Hz", 2)}` : solarNum(e.acAmps, " A", 1)),
              stat("Temperatuur", solarNum(e.temp, "°")),
              stat("Firmware", s(e.firmware) ? raw(e.firmware) : "--"),
            ]
          : [stat("Vandaag", solarKwh(today)), stat("Totaal", solarKwh(total))],
        controls: awake
          ? low(e.mode).includes("fault")
            ? `<p class="ap-note warn">${Util.esc("De omvormer meldt een storing: kijk op zijn display of in de SolaXCloud-app.")}</p>`
            : ""
          : note("De omvormer staat uit zolang er geen zon is; zijn netwerkstick krijgt stroom van de omvormer, dus ’s nachts zijn er geen metingen."),
      };
    },
    actions: {},
  });

  /* ---- Heat pump (NIBE F1253: ground source, passive cooling) ----------------------- */
  /* Everything the pump reports and everything it lets us set. It has no
   * electricity meter of its own: its kWh counters are the heat it delivered
   * (the Energie section shows those), and the three phase-current inputs are
   * the load-monitor clamps on the house supply, which are not fitted here. */
  const HP_NL = {
    off: "Uit", starting: "Starten", operating: "In bedrijf", stopping: "Stoppen", initiating: "Opstarten",
    "hot water": "Warm water", heating: "Verwarmen", cooling: "Koelen", pool: "Zwembad", "pool 2": "Zwembad 2",
    defrosting: "Ontdooien", blocked: "Geblokkeerd", "acc. block.": "Geblokkeerd", "ext control": "Externe sturing",
    preheat: "Voorverwarmen", "trans\u00adfer": "Overdracht", "internal electrical addition": "Bijverwarming",
  };
  const HP_ADD_NL = { active: "Actief", off: "Uit", blocked: "Geblokkeerd", alarm: "Alarm" };
  const HP_MODE_NL = { Auto: "Auto", Manual: "Handmatig", "Add. heat only": "Alleen bijverwarming" };
  const HP_DEMAND_NL = { Economy: "Zuinig", Normal: "Normaal", Lux: "Luxe" };
  const HP_BOOST_NL = { Off: "Uit", "One-time incr.": "Eenmalig", "3 hr": "3 uur", "6 hr": "6 uur", "12 hr": "12 uur" };
  const hpNum = (id, unit, digits = 0) => (known(num(id)) ? `${fmt(num(id), digits)}${unit}` : "--");
  const hpDeg = (id) => hpNum(id, "\u00b0", 1);
  const hpPair = (a, b, unit = "\u00b0", digits = 1) =>
    known(num(a)) && known(num(b)) ? `${fmt(num(a), digits)} / ${fmt(num(b), digits)}${unit}` : hpNum(a, unit, digits);
  const hpHours = (id) => (known(num(id)) ? `${fmt(num(id))} u` : "--");
  const hpOptions = (id) => attrs(id).options || [];
  /* A row of chips for a select, with the option names in Dutch. */
  const hpChips = (i, key, e, names) =>
    !s(e[key])
      ? ""
      : `<div class="ap-chips">` +
        hpOptions(e[key]).map((o) => chip(i, `pick|${key}|${o}`, names[o] || o, raw(e[key]) === o)).join("") +
        `</div>`;
  /* A stepper for a number setting, with its own unit and range. */
  const hpStep = (i, key, e, label, unit, digits) => {
    if (!s(e[key])) return "";
    const at = attrs(e[key]);
    /* the room setpoint goes through the heating (heating.js): one write for a run of taps */
    const v = key === "roomHeat" && Panel.heating ? Panel.heating.target() : num(e[key]);
    return field(label, stepper(i, `num|${key}`, known(v) ? `${fmt(v, digits)}${unit}` : "--", {
      canDown: known(v) && v > (at.min ?? -100),
      canUp: known(v) && v < (at.max ?? 100),
      down: "Lager",
      up: "Hoger",
    }));
  };

  Panel.defineAppliance("heatpump", {
    icon: "heatpump",
    pendingMs: 90000, /* read through myUplink (NIBE's cloud), polled: a change shows up late */
    view(a, i) {
      const e = a.entities;
      if (offline(e.status)) return offlineView("De warmtepomp is niet bereikbaar");
      const status = low(e.status);
      const compressor = low(e.compressor);
      const running = compressor === "operating" || compressor === "starting";
      const alarm = on(e.alarm);
      const freq = num(e.freq);
      const statusText = HP_NL[status] || raw(e.status);
      const doing = alarm ? "Storing" : status === "off" && !running ? "In rust" : statusText;
      const parts = [
        doing,
        running && known(freq) ? `compressor ${fmt(freq)} Hz` : null,
        known(num(e.outdoor)) ? `buiten ${hpDeg(e.outdoor)}` : null,
      ].filter(Boolean);
      /* The readings that do not fit in the four tiles, under the settings. */
      const details = [
        ["Berekende aanvoer", hpDeg(e.calcSupply)],
        ["Warm water laden", hpDeg(e.hotWaterCharge)],
        ["Warm water over", known(num(e.hotWaterAmount)) ? `${fmt(num(e.hotWaterAmount))} min` : "--"],
        ["Condensor", hpDeg(e.condenser)],
        ["Persgas", hpDeg(e.discharge)],
        ["Zuiggas", hpDeg(e.suction)],
        ["Vloeistoflijn", hpDeg(e.liquid)],
        ["Omvormer", hpDeg(e.inverter)],
        ["Compressor", known(freq) ? `${fmt(freq)} Hz` : "--"],
        ["Compressor grens", hpPair(e.freqMin, e.freqMax, " Hz", 0)],
        ["Graadminuten", hpNum(e.degreeMinutes, "")],
        ["Debiet", hpNum(e.flow, " l/min", 1)],
        ["Pomp verwarming", hpNum(e.pumpHeat, "%")],
        ["Pomp bron", hpNum(e.pumpBrine, "%")],
        ["Bijverwarming", HP_ADD_NL[low(e.add)] || raw(e.add) || "--"],
        ["Bedrijfsuren", hpHours(e.operTime)],
        ["Waarvan warm water", hpHours(e.operHotWater)],
        ["Compressorstarts", hpNum(e.starts, "")],
        ["Gem. buiten", hpDeg(e.outdoorAvg)],
      ];
      const controls =
        `<span class="vlabel">Bedrijfsstand</span>` +
        hpChips(i, "opMode", e, HP_MODE_NL) +
        `<span class="vlabel">Warm water</span>` +
        hpChips(i, "demand", e, HP_DEMAND_NL) +
        hpChips(i, "boost", e, HP_BOOST_NL) +
        `<div class="ap-row ap-toggles">` +
        [["lux", "Tijdelijk luxe"], ["smart", "Slimme sturing"]]
          .filter(([k]) => s(e[k]))
          .map(([k, label]) => btn(i, `toggle|${k}`, label, { active: on(e[k]) }))
          .join("") +
        `</div>` +
        `<span class="vlabel">Verwarming</span>` +
        `<div class="ap-row ap-split">` +
        hpStep(i, "offset", e, "Stooklijn", "", 0) +
        hpStep(i, "roomHeat", e, "Kamer verwarmen", "\u00b0", 1) +
        `</div>` +
        `<span class="vlabel">Koeling</span>` +
        `<div class="ap-row ap-split">` +
        hpStep(i, "roomCool", e, "Kamer koelen", "\u00b0", 1) +
        hpStep(i, "coolStart", e, "Koelen vanaf", "\u00b0", 0) +
        hpStep(i, "coolOffset", e, "Koelcurve", "", 0) +
        `</div>` +
        (s(e.maxAdd) ? `<span class="vlabel">Maximale bijverwarming</span>${hpChips(i, "maxAdd", e, {})}` : "") +
        `<span class="vlabel">Metingen</span>` +
        `<div class="ap-stats">${details.map(([label, value]) => stat(label, value)).join("")}</div>` +
        (alarm ? note("De warmtepomp meldt een storing. Kijk op het display van de pomp welke.") : "");
      return {
        tone: alarm ? "error" : running ? "run" : status === "off" ? "off" : "ready",
        pill: doing,
        big: known(num(e.hotWaterTop)) ? fmt(num(e.hotWaterTop), 1) : "--",
        unit: "\u00b0 warm water",
        sub: parts.join(" \u00b7 "),
        stats: [
          stat("Buiten", hpDeg(e.outdoor)),
          stat("Binnen", hpDeg(e.room)),
          stat("Aanvoer / retour", hpPair(e.supply, e.ret)),
          stat("Bron in / uit", hpPair(e.brineIn, e.brineOut)),
        ],
        controls,
      };
    },
    actions: {
      toggle,
      pick: (a, [key, ...option], call) => call("select", "select_option", { option: option.join("|") }, a.entities[key]),
      num: (a, [key, dir], call) => {
        if (key === "roomHeat" && Panel.heating) return Panel.heating.step(Number(dir));
        const id = a.entities[key];
        const at = attrs(id);
        const cur = Panel.applianceTarget(id);
        if (!known(cur)) return;
        const step = at.step || 1;
        const v = Util.clamp(cur + Number(dir) * step, at.min ?? -100, at.max ?? 100);
        call("number", "set_value", { value: Math.round(v * 100) / 100 }, id);
      },
    },
  });

  /* ---- Washer and dryer ------------------------------------------------------------ */
  /* Its power: the sensor stays at 0 W over SmartThings, so while it runs the
   * Energie section's estimate from the kWh counter stands in (≈). */
  const wattsText = (running, e) => {
    const { w, estimated } = running && Panel.energy ? Panel.energy.machineWatts(e) : { w: num(e.power), estimated: false };
    return Number.isFinite(w) ? `${estimated ? "≈ " : ""}${fmt(Math.round(w))} W` : estimated ? "wordt berekend" : "--";
  };
  const laundry = {
    view(a, i) {
      const e = a.entities;
      const noun = a.kind === "dryer" ? "De droger" : "De wasmachine";
      if (offline(e.machine)) return offlineView(`${noun} is niet bereikbaar`);
      const machine = low(e.machine);
      const job = low(e.job);
      const done = Util.dateOf(raw(e.done));
      const paused = machine === "pause";
      /* Samsung's machine_state is unreliable (it can stay "stop" while the
       * machine runs), so a machine that is on with a completion time still
       * ahead counts as running too, unless it reports a pause. */
      const running = !paused && (machine === "run" || (on(e.on) && !!done && done.getTime() > Date.now()));
      const [big, unit] = duration(done ? Math.max(0, (done - Date.now()) / 1000) : NaN);
      const remote = on(e.remote);
      const finished = job === "finish" || job === "finished";
      const view = {
        tone: running ? "run" : paused ? "paused" : finished ? "done" : "off",
        pill: running ? JOB_NL[job] || "Bezig" : paused ? "Gepauzeerd" : finished ? "Klaar" : on(e.on) ? "Aan" : "Uit",
        progress: running ? "busy" : null,
        stats: [
          stat("Vermogen", wattsText(running, e)),
          stat("Energie", Number.isFinite(num(e.energy)) ? `${fmt(num(e.energy), 1)} kWh` : "--"),
          s(e.water) ? stat("Water", Number.isFinite(num(e.water)) ? `${fmt(num(e.water) / 1000, 1)} m³` : "--") : stat("Kinderslot", on(e.lock) ? "Aan" : "Uit"),
          stat("Op afstand", remote ? "Aan" : "Uit"),
        ],
      };
      if (running || paused) Object.assign(view, { big, unit, sub: done ? `klaar om ${hm(done)}` : "" });
      else Object.assign(view, { big: finished ? "Klaar" : "Uit", word: true, sub: done && finished ? `klaar sinds ${hm(done)}` : "" });
      view.controls =
        `<div class="ap-row">` +
        (running
          ? btn(i, "select|pause", "Pauze", { ic: "pause", disabled: !remote })
          : btn(i, "select|run", paused ? "Hervat" : "Start", { primary: true, ic: "play", disabled: !remote })) +
        (running || paused ? btn(i, "select|stop", "Stop", { confirm: true, ic: "stop", disabled: !remote }) : "") +
        `</div>` +
        (!remote ? note("Zet ‘Bediening op afstand’ aan op de machine om hier te bedienen.") : "");
      return view;
    },
    actions: { select: selectOption("state") },
  };
  Panel.defineAppliance("washer", { icon: "washer", ...laundry });
  Panel.defineAppliance("dryer", { icon: "dryer", ...laundry });

  /* ---- Dishwasher -------------------------------------------------------------------- */
  Panel.defineAppliance("dishwasher", {
    icon: "dishwasher",
    /* "Alle apparaten uit": a running program is stopped. */
    off: { active: (a) => ["run", "delayedstart", "pause"].includes(low(a.entities.op)), run: (a, call) => call("button", "press", null, a.entities.abort) },
    view(a, i) {
      const e = a.entities;
      if (offline(e.op)) return offlineView("De vaatwasser is niet bereikbaar");
      const op = low(e.op);
      const running = op === "run" || op === "delayedstart";
      const paused = op === "pause";
      const idle = !running && !paused;
      const program = raw(e.selected);
      const [big, unit] = duration(num(e.remaining));
      const end = Number.isFinite(num(e.remaining)) ? new Date(Date.now() + num(e.remaining) * 1000) : null;
      const startAllowed = on(e.startAllowed);
      const programs = (attrs(e.selected).options || []).filter((p) => !HIDDEN_PROGRAMS.has(p));
      const view = {
        tone: running ? "run" : paused ? "paused" : op === "finished" ? "done" : op === "error" || op === "actionrequired" ? "error" : op === "ready" ? "ready" : "off",
        pill: OP_NL[op] || raw(e.op),
        progress: idle ? null : num(e.progress),
        stats: [
          stat("Deur", { open: "Open", closed: "Dicht", locked: "Vergrendeld" }[low(e.door)] || "--"),
          stat("Onderhoud", Number.isFinite(num(e.care)) ? `over ${fmt(num(e.care))}×` : "--"),
          stat("Energie", Number.isFinite(num(e.energy)) ? `${fmt(num(e.energy))}%` : "--"),
          stat("Water", Number.isFinite(num(e.water)) ? `${fmt(num(e.water))}%` : "--"),
        ],
      };
      if (idle) {
        Object.assign(view, { big: PROGRAM_NL[program] || (known(program) ? program : "Kies een programma"), word: true, sub: op === "finished" ? "Programma klaar" : "Programma" });
      } else {
        Object.assign(view, { big, unit, sub: [PHASE_NL[low(e.phase)], PROGRAM_NL[program] || program, end && `klaar om ${hm(end)}`].filter(Boolean).join(" · ") });
      }
      view.controls =
        `<div class="ap-chips">${programs.map((p) => chip(i, `program|${p}`, PROGRAM_NL[p] || p, p === program, !idle)).join("")}</div>` +
        `<div class="ap-row">` +
        (idle
          ? btn(i, "start", "Start", { primary: true, ic: "play", disabled: !startAllowed || op !== "ready" || !known(program) })
          : btn(i, "stop", "Stop", { confirm: true, ic: "stop" })) +
        `</div>` +
        `<div class="ap-row ap-toggles">` +
        [["extradry", "Extra droog"], ["hygiene", "Hygiëne+"], ["speed", "VarioSpeed"], ["silence", "Stil"]]
          .filter(([k]) => s(e[k]))
          .map(([k, label]) => btn(i, `toggle|${k}`, label, { active: on(e[k]), disabled: !idle && k !== "silence" }))
          .join("") +
        `</div>` +
        (idle && !startAllowed ? note("Druk op de vaatwasser op ‘Start op afstand’ om hier te starten.") : "");
      return view;
    },
    actions: {
      program: selectOption("selected"),
      start: (a, args, call) => call("select", "select_option", { option: raw(a.entities.selected) }, a.entities.active),
      stop: press("abort"),
      toggle,
    },
  });

  /* ---- Oven ------------------------------------------------------------------------- */
  /* Heating modes and microwave powers offered for remote start, most used first. */
  const OVEN_PROGRAMS = [
    ["HotAir", "Hete lucht"], ["TopBottomHeating", "Boven- en onderwarmte"], ["HotAirGrilling", "Grill + hete lucht"],
    ["GrillLargeArea", "Grill"], ["PizzaSetting", "Pizza"], ["AirFry", "Airfry"], ["BottomHeating", "Onderwarmte"],
    ["HotAirGentle", "Hete lucht zacht"], ["TopBottomHeatingEco", "Boven/onder eco"], ["GrillSmallArea", "Grill klein"],
    ["SlowCook", "Langzaam garen"], ["KeepWarm", "Warmhouden"], ["PreHeating", "Voorverwarmen"], ["PreheatOvenware", "Servies warmen"],
    ["FrozenHeatupSpecial", "Diepvries"], ["600Watt", "Magnetron 600 W"], ["Max", "Magnetron max"], ["360Watt", "Magnetron 360 W"],
    ["180Watt", "Magnetron 180 W"], ["90Watt", "Magnetron 90 W"],
  ];
  const OVEN_NL = Object.fromEntries(OVEN_PROGRAMS);
  const isMicrowave = (program) => /Watt$/.test(program) || program === "Max";
  const TEMP_STEP = 5;
  const MIN_TEMP = 30;
  const field = (label, html) => `<div class="ap-field"><span>${label}</span>${html}</div>`;

  Panel.defineAppliance("oven", {
    icon: "oven",
    /* "Alle apparaten uit": a running program is stopped, then standby. */
    off: {
      active: (a) => ["run", "delayedstart", "pause"].includes(low(a.entities.op)) || low(a.entities.powerstate) === "on",
      run(a, call) {
        const e = a.entities;
        if (["run", "delayedstart", "pause"].includes(low(e.op))) call("button", "press", null, e.abort);
        if (s(e.powerstate) && low(e.powerstate) !== "standby") call("select", "select_option", { option: "Standby" }, e.powerstate);
      },
    },
    view(a, i) {
      const e = a.entities;
      if (offline(e.op)) return offlineView("De oven is niet bereikbaar");
      const op = low(e.op);
      const running = op === "run" || op === "delayedstart";
      const paused = op === "pause";
      const busy = running || paused;
      const standby = op === "inactive" || low(e.powerstate) === "standby";
      const temp = num(e.temp);
      const program = raw(e.selected);
      const programLabel = OVEN_NL[program] || (known(program) ? program : "Geen programma");
      const microwave = isMicrowave(program);
      const target = busy && Number.isFinite(num(e.setpoint)) ? num(e.setpoint) : Panel.applianceTarget(e.setpointSet);
      const timer = Panel.applianceTarget(e.duration);
      const tempText = Number.isFinite(target) ? `${fmt(target)}°` : "--";
      const timerText = Number.isFinite(timer) ? duration(timer).join(" ") : "--";
      const [left, leftUnit] = duration(num(e.remaining));

      const range = attrs(e.setpointSet);
      const tempField = microwave || !s(e.setpointSet) ? "" : field("Temperatuur", stepper(i, "temp", tempText, {
        canDown: target > Math.max(MIN_TEMP, range.min ?? MIN_TEMP), canUp: target < (range.max ?? 300), down: "Kouder", up: "Warmer",
      }));
      const timerField = busy || !s(e.duration) ? "" : field("Tijd", stepper(i, "time", timerText, {
        canDown: timer > 300, canUp: timer < (attrs(e.duration).max ?? 86400), down: "Korter", up: "Langer",
      }));
      const settings = tempField || timerField ? `<div class="ap-row ap-split">${tempField}${timerField}</div>` : "";
      const toggles =
        `<div class="ap-row ap-toggles">` +
        [["fastpreheat", "Snel opwarmen"], ["lamp", "Lamp"], ["childlock", "Kinderslot"]]
          .filter(([k]) => s(e[k]))
          .map(([k, label]) => btn(i, `toggle|${k}`, label, { active: on(e[k]), disabled: k === "fastpreheat" && (busy || microwave) }))
          .join("") +
        `</div>`;
      const programs = (attrs(e.selected).options || []);

      let controls;
      if (busy) {
        controls =
          `<div class="ap-row">` +
          (running ? btn(i, "pause", "Pauze", { ic: "pause" }) : btn(i, "resume", "Hervat", { primary: true, ic: "play" })) +
          btn(i, "stop", "Stop", { confirm: true, ic: "stop" }) +
          `</div>` + settings + toggles;
      } else if (standby) {
        controls = s(e.powerstate)
          ? `<div class="ap-row">${btn(i, "power|On", "Aanzetten", { primary: true, ic: "power" })}</div>`
          : note("De oven staat uit; zet hem aan op de oven zelf.");
      } else {
        const startAllowed = on(e.startAllowed);
        controls =
          `<div class="ap-chips">${OVEN_PROGRAMS.filter(([p]) => programs.includes(p)).map(([p, label]) => chip(i, `program|${p}`, label, p === program)).join("")}</div>` +
          settings +
          toggles +
          `<div class="ap-row ap-split">` +
          btn(i, "start", "Start", { primary: true, confirm: true, ic: "play", disabled: !startAllowed || op !== "ready" || !OVEN_NL[program] }) +
          (s(e.powerstate) ? btn(i, "power|Standby", "Stand-by", { ic: "power" }) : "") +
          `</div>` +
          (!startAllowed ? note("Zet ‘Start op afstand’ aan op de oven om hier te starten.") : "");
      }

      return {
        tone: running ? "run" : paused ? "paused" : op === "finished" ? "done" : op === "error" ? "error" : standby ? "off" : "ready",
        pill: OP_NL[op] || raw(e.op),
        big: Number.isFinite(temp) ? fmt(temp) : "--",
        unit: "°C",
        sub: busy
          ? [programLabel, !microwave && `naar ${tempText}`, Number.isFinite(num(e.remaining)) && `nog ${left} ${leftUnit}`].filter(Boolean).join(" · ")
          : standby ? "Stand-by" : [programLabel, !microwave && tempText, Number.isFinite(timer) && timerText].filter(Boolean).join(" · "),
        progress: busy ? num(e.progress) : null,
        stats: [
          stat("Deur", { open: "Open", closed: "Dicht", locked: "Vergrendeld" }[low(e.door)] || "--"),
          stat("Lamp", on(e.light) || on(e.lamp) ? "Aan" : "Uit"),
          ...(busy
            ? [stat("Doel", microwave ? "--" : tempText), stat("Verstreken", Number.isFinite(num(e.elapsed)) ? duration(num(e.elapsed)).join(" ") : "--")]
            : []),
        ],
        controls,
      };
    },
    actions: {
      program: selectOption("selected"),
      /* The oven drops a temperature set before the start back to the
       * program's default (180°), so what was chosen here is sent again once
       * it runs; the time likewise, should it have been reset. */
      start(a, args, call) {
        const e = a.entities;
        ovenWant = { temp: Panel.applianceTarget(e.setpointSet), time: Panel.applianceTarget(e.duration) };
        call("select", "select_option", { option: raw(a.entities.selected) }, e.active);
        clearInterval(ovenStartTimer); /* a second Start: one wait, not two */
        let tries = 0;
        const timer = (ovenStartTimer = setInterval(() => {
          const running = low(e.op) === "run";
          if (!running && ++tries < 30) return;
          clearInterval(timer);
          if (!running) return;
          const resend = (id, value) =>
            Number.isFinite(value) && s(id) && num(id) !== value &&
            Panel.client.callService("number", "set_value", { value }, { entity_id: id }).catch(Panel.commandFailed(a.label));
          /* what was chosen last, also a step tapped after Start */
          resend(e.setpointSet, ovenWant.temp);
          resend(e.duration, ovenWant.time);
        }, 1000));
      },
      temp(a, [dir], call) {
        const e = a.entities;
        const range = attrs(e.setpointSet);
        const current = Panel.applianceTarget(e.setpointSet); /* on from what was tapped, not the old reading */
        if (!Number.isFinite(current)) return;
        const next = Util.clamp(Math.round((current + Number(dir) * TEMP_STEP) / TEMP_STEP) * TEMP_STEP, Math.max(MIN_TEMP, range.min ?? MIN_TEMP), range.max ?? 300);
        ovenWant.temp = next;
        call("number", "set_value", { value: next }, e.setpointSet);
      },
      /* 5-minute steps up to an hour, quarters above it. */
      time(a, [dir], call) {
        const e = a.entities;
        const current = Panel.applianceTarget(e.duration);
        if (!Number.isFinite(current)) return;
        const up = Number(dir) > 0;
        const step = (up ? current >= 3600 : current > 3600) ? 900 : 300;
        const next = Util.clamp(Math.round((current + (up ? step : -step)) / step) * step, 300, attrs(e.duration).max ?? 86400);
        ovenWant.time = next;
        call("number", "set_value", { value: next }, e.duration);
      },
      power: selectOption("powerstate"),
      pause: press("pause"),
      resume: press("resume"),
      stop: press("abort"),
      toggle,
    },
  });

  /* ---- Hob and cooker hood ------------------------------------------------------------ */
  const ventLevels = (a) => (attrs(a.entities.vent).options || []).filter((o) => /^Level\d+$/.test(o));
  Panel.defineAppliance("hob", {
    icon: "hob",
    view(a, i) {
      const e = a.entities;
      if (offline(e.op)) return offlineView("De kookplaat is niet bereikbaar");
      const powered = low(e.power) === "on";
      const zones = ["zone1", "zone2", "zone3", "zone4"].map((k) => raw(e[k]));
      const isOn = (z) => known(z) && z !== "Off";
      const active = zones.filter(isOn).length;
      const vent = raw(e.vent);
      const levels = ventLevels(a);
      const levelIdx = levels.indexOf(vent);
      const ventLabel =
        vent === "Off" ? "Uit" : vent === "Automatic" ? "Auto" : /^Level/.test(vent) ? `Stand ${parseInt(vent.slice(5), 10)}` : /^Boost/.test(vent) ? "Boost" : vent === "AfterRun" ? "Nadraaien" : vent;
      const zoneLabel = (z) => (!isOn(z) ? "–" : z === "KeepWarm" ? "W" : /^Boost/.test(z) ? "B" : String(Math.round(parseInt(z, 10) / 10)));
      return {
        tone: active ? "hot" : powered ? "ready" : "off",
        pill: powered || active ? "Aan" : "Uit",
        /* The number of zones in use; a hob that is off says so instead of "0". */
        big: powered || active ? String(active) : "Uit",
        word: !powered && !active,
        unit: powered || active ? (active === 1 ? "zone aan" : "zones aan") : "",
        sub: vent && vent !== "Off" ? `Afzuiging ${ventLabel.toLowerCase()}` : "Afzuiging uit",
        extra: `<div class="ap-zones">${zones.map((z, n) => `<div class="ap-zone${isOn(z) ? " on" : ""}" title="Zone ${n + 1}">${zoneLabel(z)}</div>`).join("")}</div>`,
        stats: [
          stat("Afzuiging", ventLabel || "--"),
          stat("Lucht", low(e.airmode) === "extraction" ? "Afvoer" : "Recirculatie"),
          stat("Koolstoffilter", Number.isFinite(num(e.filter)) ? `niveau ${fmt(num(e.filter))}` : "--"),
          stat("Kinderslot", on(e.childlock) ? "Aan" : "Uit"),
        ],
        controls:
          `<div class="ap-row">` +
          chip(i, "vent|Off", "Uit", vent === "Off") +
          chip(i, "vent|Automatic", "Auto", vent === "Automatic") +
          stepper(i, "ventstep", levelIdx >= 0 ? String(levelIdx + 1) : "–", { canDown: levelIdx > 0, canUp: levelIdx < levels.length - 1, down: "Zachter", up: "Harder" }) +
          `</div>` +
          (s(e.filterReset) ? `<div class="ap-row">${btn(i, "filterreset", "Koolstoffilter vervangen", { confirm: true, ic: "filter" })}</div>` : ""),
      };
    },
    actions: {
      vent: selectOption("vent"),
      ventstep(a, [dir], call) {
        const levels = ventLevels(a);
        const idx = levels.indexOf(raw(a.entities.vent));
        const next = levels[Util.clamp((idx < 0 ? -1 : idx) + Number(dir), 0, levels.length - 1)];
        if (next) call("select", "select_option", { option: next }, a.entities.vent);
      },
      filterreset: press("filterReset"),
    },
  });

  /* ---- Cooker hood plasma filter ---------------------------------------------------------- */
  Panel.defineAppliance("filter", {
    icon: "filter",
    view(a) {
      const e = a.entities;
      if (offline(e.mode)) {
        const v = offlineView("Het filterpaneel is niet bereikbaar");
        v.stats = [stat("Plasmacel 1", "--"), stat("Plasmacel 2", "--")];
        return v;
      }
      const hours = (id) => (Number.isFinite(num(id)) ? `${fmt(num(id))} u` : "--");
      return {
        tone: on(e.active) ? "run" : "off",
        pill: on(e.active) ? "Actief" : "Stand-by",
        big: known(raw(e.mode)) ? raw(e.mode) : "--",
        word: true,
        sub: known(raw(e.airflow)) ? `Luchtstroom ${raw(e.airflow)}` : "Modus",
        stats: [
          stat("Plasmacel 1", hours(e.cell1)),
          stat("Plasmacel 2", hours(e.cell2)),
          stat("Spanning", Number.isFinite(num(e.voltage)) ? `${fmt(num(e.voltage))} V` : "--"),
          stat("Stroom", Number.isFinite(num(e.current)) ? `${fmt(num(e.current))} mA` : "--"),
        ],
        controls: "",
      };
    },
  });

  /* ---- WTW (DucoBox Energy Comfort, through its ESPHome board) ----------------------- */
  /* The balanced ventilation with heat recovery: its stand (automatic, a level
   * for a while, a level continuously, away), the airflow, and the four air
   * temperatures around the heat exchanger as a small diagram — outside air
   * in and on to the house, the house's air out and away — with how much warmth
   * it recovers. The board's own stand names: AUTO, MAN1-3 (a level for 15
   * minutes, x2/x3 for 30/45), CNT1-3 (continuously), EMPT (away). */
  const WTW_LEVEL = { 1: "I", 2: "II", 3: "III" };
  function wtwStand(code) {
    const c = String(code || "");
    if (c === "AUTO") return { pill: "Automatisch", sub: "op de sensoren en het schema" };
    if (c === "EMPT") return { pill: "Afwezig", sub: "minimale ventilatie" };
    const level = WTW_LEVEL[c[3]];
    if (c.startsWith("CNT") && level) return { pill: `Continu ${level}`, sub: "blijft aan tot je iets anders kiest" };
    if (c.startsWith("MAN") && level) {
      const mins = c.endsWith("x2") ? 30 : c.endsWith("x3") ? 45 : 15;
      return { pill: c[3] === "3" && mins > 15 ? `Boost ${mins} min` : `Stand ${level}`, sub: "" };
    }
    return { pill: known(c) ? c : "--", sub: "" };
  }
  const deg1 = (id) => (Number.isFinite(num(id)) ? `${fmt(num(id), 1)}°` : "--");
  /* The exchanger: two streams crossing in its core, the efficiency in the middle. */
  function wtwDiagram(e) {
    const eff = num(e.efficiency);
    return (
      `<div class="wtw-x" role="img" aria-label="Warmtewisselaar">` +
      `<svg viewBox="0 0 240 132" aria-hidden="true">` +
      `<path class="cold" d="M52 26 L188 106"/><path class="warm" d="M188 26 L52 106"/>` +
      `<circle cx="120" cy="66" r="29"/></svg>` +
      `<span class="wtw-t tl"><small>Buiten in</small><b class="cold">${deg1(e.outside)}</b></span>` +
      `<span class="wtw-t tr"><small>Uit huis</small><b class="warm">${deg1(e.extract)}</b></span>` +
      `<span class="wtw-t bl"><small>Afvoer</small><b class="dim">${deg1(e.exhaust)}</b></span>` +
      `<span class="wtw-t br"><small>Naar huis</small><b class="cold">${deg1(e.supply)}</b></span>` +
      `<span class="wtw-eff"><b>${Number.isFinite(eff) ? `${fmt(eff)}%` : "--"}</b><small>rendement</small></span>` +
      `</div>`
    );
  }
  /* What the box's error log says, in words; 43.23.01 is the one this box has had
   * from the start: it was never commissioned, so the fans run alike in every stand. */
  function wtwErrors(codes) {
    const c = String(codes || "");
    if (!known(c) || c === "Geen") return "";
    const text = c.includes("43.23.01")
      ? `Storing ${c}: de WTW is nooit ingeregeld, dus de ventilatoren draaien in elke stand even hard. De installateur moet de inregeling nog doen.`
      : `Storing ${c}: zie de foutenlijst op het display van de WTW.`;
    return `<p class="ap-note warn">${Util.esc(text)}</p>`;
  }
  const WTW_BYPASS = [["Automatisch", "Auto"], ["Dicht", "Dicht"], ["Open", "Open"]];
  const WTW_LEVELS = [["level1", "I"], ["level2", "II"], ["level3", "III"]];
  Panel.defineAppliance("ventilation", {
    icon: "fan",
    view(a, i) {
      const e = a.entities;
      if (offline(e.stand) && offline(e.flow)) return offlineView("Het bordje van de WTW is niet bereikbaar");
      const code = raw(e.stand);
      const st = wtwStand(code);
      const flow = num(e.flow);
      const left = num(e.left);
      const timed = code.startsWith("MAN") && Number.isFinite(left) && left > 0;
      const comfort = num(e.comfort);
      const cAttr = attrs(e.comfort);
      const filterDays = num(e.filter);
      const chipFor = (label, opt) => chip(i, `stand|${opt}`, label, code === opt);
      const fanSup = num(e.fanSup);
      const fanEha = num(e.fanEha);
      const fanLevel = num(e.fanLevel);
      const fans = Number.isFinite(fanSup) && Number.isFinite(fanEha) ? `${fmt(fanSup)} / ${fmt(fanEha)} rpm` : "--";
      const nbTemp = num(e.nightboostTemp);
      const nbAttr = attrs(e.nightboostTemp);
      const bypassMode = raw(e.bypassMode);
      const interval = raw(e.filterInterval);
      /* the settings, each only where the board reports it */
      const settings =
        (s(e.bypassMode)
          ? `<div class="ap-label">Bypass: automatisch, dicht (altijd warmte terugwinnen) of open (nooit)</div>` +
            `<div class="ap-chips">${WTW_BYPASS.map(([opt, label]) => chip(i, `bypassmode|${opt}`, label, bypassMode === opt)).join("")}</div>`
          : "") +
        `<div class="ap-row ap-toggles">` +
        [["adaptive", "Bypass adaptief"], ["nightboost", "NightBoost"]]
          .filter(([k]) => s(e[k]))
          .map(([k, label]) => btn(i, `toggle|${k}`, label, { active: on(e[k]) }))
          .join("") +
        `</div>` +
        (on(e.nightboost) && Number.isFinite(nbTemp)
          ? `<div class="ap-label">NightBoost koelt 's nachts vanaf deze binnentemperatuur</div>` +
            stepper(i, "nightboosttemp", `${fmt(nbTemp)}°`, {
              canDown: nbTemp > (nbAttr.min ?? 0),
              canUp: nbTemp < (nbAttr.max ?? 60),
              down: "Lager",
              up: "Hoger",
              wide: true,
            })
          : "") +
        (WTW_LEVELS.some(([k]) => Number.isFinite(num(e[k])))
          ? `<div class="ap-label">Debiet per stand</div>` +
            `<div class="ap-row ap-split">` +
            WTW_LEVELS.map(([k, label]) => {
              const v = num(e[k]);
              const at = attrs(e[k]);
              return field(
                `Stand ${label}`,
                stepper(i, `level|${k}`, Number.isFinite(v) ? `${fmt(v)}%` : "--", {
                  canDown: Number.isFinite(v) && v > (at.min ?? 0),
                  canUp: Number.isFinite(v) && v < (at.max ?? 100),
                }),
              );
            }).join("") +
            `</div>`
          : "") +
        (s(e.filterInterval)
          ? `<div class="ap-label">Filter vervangen na</div>` +
            `<div class="ap-chips">${["90", "180", "270", "360"].map((d) => chip(i, `filterinterval|${d}`, `${d} d`, interval === d)).join("")}</div>`
          : "");
      return {
        tone: Number.isFinite(flow) && flow > 0 ? "run" : "off",
        pill: st.pill,
        big: Number.isFinite(flow) ? fmt(flow) : "--",
        unit: "% debiet",
        sub: timed ? `nog ${duration(left).join(" ")}, dan weer automatisch` : st.sub,
        progress: Number.isFinite(flow) ? flow : null,
        stats: [
          stat("Bypass", Number.isFinite(num(e.bypass)) ? `${fmt(num(e.bypass))}%` : "--"),
          stat("Filter nog", Number.isFinite(filterDays) ? `${fmt(filterDays)} dagen` : "--"),
          /* the comfort temperature only where the Duco reports it (not every model does) */
          Number.isFinite(comfort) ? stat("Comforttemperatuur", `${fmt(comfort, 1)}°`) : stat("Tijd resterend", timed ? duration(left).join(" ") : "--"),
          stat("Rendement", Number.isFinite(num(e.efficiency)) ? `${fmt(num(e.efficiency))}%` : "--"),
          /* what the fans really do, next to the airflow the stand asks for */
          ...(s(e.fanSup) ? [stat("Ventilatoren", Number.isFinite(fanLevel) ? `${fans} · ${fmt(fanLevel)}%` : fans)] : []),
        ],
        controls:
          wtwErrors(raw(e.errors)) +
          wtwDiagram(e) +
          `<div class="ap-chips">${chipFor("Auto", "AUTO")}${chipFor("I", "MAN1")}${chipFor("II", "MAN2")}${chipFor("III", "MAN3")}</div>` +
          `<div class="ap-label">Continu</div>` +
          `<div class="ap-chips">${chipFor("I", "CNT1")}${chipFor("II", "CNT2")}${chipFor("III", "CNT3")}${chipFor("Afwezig", "EMPT")}</div>` +
          `<div class="ap-label">Boost, stand III en dan weer automatisch</div>` +
          `<div class="ap-chips">${chipFor("15 min", "MAN3")}${chipFor("30 min", "MAN3x2")}${chipFor("45 min", "MAN3x3")}</div>` +
          (Number.isFinite(comfort)
            ? `<div class="ap-label">Comforttemperatuur: daarboven gaat de bypass open</div>` +
              stepper(i, "comfort", Number.isFinite(comfort) ? `${fmt(comfort, 1)}°` : "--", {
                canDown: Number.isFinite(comfort) && comfort > (cAttr.min ?? 10),
                canUp: Number.isFinite(comfort) && comfort < (cAttr.max ?? 25.5),
                down: "Kouder",
                up: "Warmer",
                wide: true,
              })
            : "") +
          (Number.isFinite(filterDays) && filterDays <= 14 ? note("Het filter is bijna aan vervanging toe.") : "") +
          settings,
      };
    },
    actions: {
      stand: (a, [option], call) => call("select", "select_option", { option }, a.entities.stand),
      bypassmode: selectOption("bypassMode"),
      filterinterval: selectOption("filterInterval"),
      toggle,
      nightboosttemp(a, [dir], call) {
        const id = a.entities.nightboostTemp;
        const at = attrs(id);
        const cur = Panel.applianceTarget(id);
        if (!known(cur)) return;
        call("number", "set_value", { value: Util.clamp(cur + Number(dir) * (at.step || 1), at.min ?? 0, at.max ?? 60) }, id);
      },
      level(a, [key, dir], call) {
        const id = a.entities[key];
        const at = attrs(id);
        const cur = Panel.applianceTarget(id);
        if (!known(cur)) return;
        call("number", "set_value", { value: Util.clamp(cur + Number(dir) * (at.step || 5), at.min ?? 0, at.max ?? 100) }, id);
      },
      comfort(a, [dir], call) {
        const id = a.entities.comfort;
        const at = attrs(id);
        const cur = Panel.applianceTarget(id);
        if (!known(cur)) return;
        const v = Util.clamp(Math.round((cur + Number(dir) * 0.5) * 10) / 10, at.min ?? 10, at.max ?? 25.5);
        call("number", "set_value", { value: v }, id);
      },
    },
  });

  /* ---- PC ------------------------------------------------------------------------ */
  Panel.defineAppliance("pc", {
    icon: "pc",
    /* "Alle apparaten uit": to sleep. */
    off: { active: (a) => on(a.entities.on), run: (a, call) => call("switch", "turn_off", null, a.entities.on) },
    view(a, i) {
      const e = a.entities;
      if (offline(e.on)) return offlineView("De pc-schakelaar is niet bereikbaar in Home Assistant");
      const awake = on(e.on);
      const online = s(e.online) ? on(e.online) : awake;
      return {
        tone: awake ? "ready" : "off",
        pill: awake ? "Aan" : "Uit",
        big: awake ? "Aan" : "Uit",
        word: true,
        sub: awake ? (online ? "Aan en bereikbaar op het netwerk" : "Aangezet, nog niet bereikbaar") : online ? "Nog bereikbaar, gaat slapen" : "Uit of in slaapstand",
        stats: [],
        controls:
          `<div class="ap-row">` +
          (awake ? btn(i, "sleep", "Slaapstand", { ic: "power", confirm: true }) : btn(i, "wake", "Aanzetten", { primary: true, ic: "power" })) +
          `</div>` +
          note(awake ? "Slaapstand zet de pc in de slaapstand; aanzetten kan daarna weer vanaf hier." : "Aanzetten gaat via Wake-on-LAN over het netwerk."),
      };
    },
    actions: {
      wake: (a, args, call) => call("switch", "turn_on", null, a.entities.on),
      sleep: (a, args, call) => call("switch", "turn_off", null, a.entities.on),
    },
  });

  Panel.defineAppliance("fridge", {
    icon: "fridge",
    view(a, i) {
      const e = a.entities;
      if (offline(e.temp)) return offlineView("De koelkast is niet bereikbaar");
      const temp = num(e.temp);
      const set = num(e.setpoint);
      const sp = attrs(e.setpoint);
      return {
        tone: on(e.supercool) ? "cold" : "ready",
        pill: on(e.supercool) ? "SuperCool" : on(e.party) ? "Party" : on(e.night) ? "Nacht" : "Koelt",
        big: Number.isFinite(temp) ? fmt(temp) : "--",
        unit: "°C",
        sub: Number.isFinite(set) ? `ingesteld op ${fmt(set)}°` : "",
        stats: [],
        controls:
          `<div class="ap-row">` +
          stepper(i, "setpoint", Number.isFinite(set) ? `${fmt(set)}°` : "--", {
            canDown: set > (sp.min ?? 1),
            canUp: set < (sp.max ?? 9),
            down: "Kouder",
            up: "Warmer",
            wide: true,
          }) +
          `</div>` +
          `<div class="ap-row ap-toggles">` +
          [["supercool", "SuperCool"], ["party", "Party"], ["night", "Nacht"]]
            .filter(([k]) => s(e[k]))
            .map(([k, label]) => btn(i, `toggle|${k}`, label, { active: on(e[k]) }))
            .join("") +
          `</div>`,
      };
    },
    actions: {
      setpoint(a, [dir], call) {
        const sp = attrs(a.entities.setpoint);
        const next = Util.clamp(Panel.applianceTarget(a.entities.setpoint) + Number(dir) * (sp.step || 1), sp.min ?? 1, sp.max ?? 9);
        if (Number.isFinite(next)) call("number", "set_value", { value: next }, a.entities.setpoint);
      },
      toggle,
    },
  });
})();
