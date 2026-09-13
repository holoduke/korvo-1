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
  Panel.defineAppliance("oven", {
    icon: "oven",
    view(a, i) {
      const e = a.entities;
      if (offline(e.op)) return offlineView("De oven is niet bereikbaar");
      const op = low(e.op);
      const running = op === "run" || op === "delayedstart";
      const paused = op === "pause";
      const temp = num(e.temp);
      const target = num(e.setpoint);
      const [left, leftUnit] = duration(num(e.remaining));
      const program = raw(e.program);
      return {
        tone: running ? "run" : paused ? "paused" : op === "finished" ? "done" : op === "error" ? "error" : "off",
        pill: OP_NL[op] || raw(e.op),
        big: Number.isFinite(temp) ? fmt(temp) : "--",
        unit: "°C",
        sub:
          running || paused
            ? [known(program) ? program : "Bezig", Number.isFinite(target) && `naar ${fmt(target)}°`, Number.isFinite(num(e.remaining)) && `nog ${left} ${leftUnit}`].filter(Boolean).join(" · ")
            : "Temperatuur binnen",
        progress: running || paused ? num(e.progress) : null,
        stats: [
          stat("Deur", { open: "Open", locked: "Vergrendeld" }[low(e.door)] || "Dicht"),
          stat("Doel", Number.isFinite(target) ? `${fmt(target)}°` : "--"),
          stat("Verstreken", Number.isFinite(num(e.elapsed)) ? duration(num(e.elapsed)).join(" ") : "--"),
          stat("Lamp", on(e.light) ? "Aan" : "Uit"),
        ],
        controls:
          `<div class="ap-row">` +
          (running ? btn(i, "pause", "Pauze", { ic: "pause" }) : "") +
          (paused ? btn(i, "resume", "Hervat", { primary: true, ic: "play" }) : "") +
          (running || paused ? btn(i, "stop", "Stop", { confirm: true, ic: "stop" }) : "") +
          btn(i, "toggle|childlock", "Kinderslot", { active: on(e.childlock), ic: "lock" }) +
          `</div>` +
          (!running && !paused ? note("Starten gaat op de oven zelf; hier zie en stop je het programma.") : ""),
      };
    },
    actions: { pause: press("pause"), resume: press("resume"), stop: press("abort"), toggle },
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
