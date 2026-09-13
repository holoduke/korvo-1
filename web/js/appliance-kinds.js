/* Household appliances in the Apparaten section: washer and dryer
 * (SmartThings), dishwasher, oven and hob (Home Connect via hcpy), the cooker
 * hood's plasma filter (ATAG over MQTT) and the fridge (Liebherr). */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { hm, fmt, known, duration } = Util;
  const { raw, low, num, on, attrs, offline, s, btn, chip, stepper, stat, note, offlineView } = Panel.applianceUi;

  const OP_NL = {
    inactive: "Uit", ready: "Gereed", delayedstart: "Uitgestelde start", run: "Bezig", pause: "Gepauzeerd",
    actionrequired: "Actie nodig", finished: "Klaar", error: "Storing", aborting: "Stoppen",
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
  const toggle = (a, [key], call) => call("switch", on(a.entities[key]) ? "turn_off" : "turn_on", null, a.entities[key]);
  const press = (key) => (a, args, call) => call("button", "press", null, a.entities[key]);
  const selectOption = (key) => (a, [option], call) => call("select", "select_option", { option }, a.entities[key]);

  /* ---- Washer and dryer ------------------------------------------------------------ */
  const laundry = {
    view(a, i) {
      const e = a.entities;
      const noun = a.kind === "dryer" ? "De droger" : "De wasmachine";
      if (offline(e.machine)) return offlineView(`${noun} is niet bereikbaar`);
      const machine = low(e.machine);
      const job = low(e.job);
      const running = machine === "run";
      const paused = machine === "pause";
      const done = Util.dateOf(raw(e.done));
      const [big, unit] = duration(done ? Math.max(0, (done - Date.now()) / 1000) : NaN);
      const remote = on(e.remote);
      const finished = job === "finish" || job === "finished";
      const view = {
        tone: running ? "run" : paused ? "paused" : finished ? "done" : "off",
        pill: running ? JOB_NL[job] || "Bezig" : paused ? "Gepauzeerd" : finished ? "Klaar" : on(e.on) ? "Aan" : "Uit",
        progress: running ? "busy" : null,
        stats: [
          stat("Vermogen", Number.isFinite(num(e.power)) ? `${fmt(num(e.power))} W` : "--"),
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
          stat("Deur", low(e.door) === "open" ? "Open" : "Dicht"),
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
          ? btn(i, "start", "Start", { primary: true, ic: "play", disabled: !startAllowed || op !== "ready" })
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
      const target = busy && Number.isFinite(num(e.setpoint)) ? num(e.setpoint) : num(e.setpointSet);
      const timer = num(e.duration);
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
          : standby ? "Stand-by" : [programLabel, !microwave && tempText, timerText].filter(Boolean).join(" · "),
        progress: busy ? num(e.progress) : null,
        stats: [
          stat("Deur", { open: "Open", locked: "Vergrendeld" }[low(e.door)] || "Dicht"),
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
      start: (a, args, call) => call("select", "select_option", { option: raw(a.entities.selected) }, a.entities.active),
      temp(a, [dir], call) {
        const e = a.entities;
        const range = attrs(e.setpointSet);
        const current = num(e.setpointSet);
        if (!Number.isFinite(current)) return;
        const next = Util.clamp(Math.round((current + Number(dir) * TEMP_STEP) / TEMP_STEP) * TEMP_STEP, Math.max(MIN_TEMP, range.min ?? MIN_TEMP), range.max ?? 300);
        call("number", "set_value", { value: next }, e.setpointSet);
      },
      /* 5-minute steps up to an hour, quarters above it. */
      time(a, [dir], call) {
        const e = a.entities;
        const current = num(e.duration);
        if (!Number.isFinite(current)) return;
        const up = Number(dir) > 0;
        const step = (up ? current >= 3600 : current > 3600) ? 900 : 300;
        const next = Util.clamp(Math.round((current + (up ? step : -step)) / step) * step, 300, attrs(e.duration).max ?? 86400);
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

  /* ---- Fridge ----------------------------------------------------------------------- */
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
        const next = Util.clamp(num(a.entities.setpoint) + Number(dir) * (sp.step || 1), sp.min ?? 1, sp.max ?? 9);
        if (Number.isFinite(next)) call("number", "set_value", { value: next }, a.entities.setpoint);
      },
      toggle,
    },
  });
})();
