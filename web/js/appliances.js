/* Apparaten section: a card per appliance (washer, dryer, dishwasher, oven,
 * cooker hood filter, hob, fridge), each with its state, one large value
 * (time left, a temperature), progress where the appliance reports it, a few
 * figures and its own controls. Entity ids come from the config; the kind
 * decides what a card shows. Stopping a programme and resetting a filter ask
 * for a second tap. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const list = cfg.appliances || [];
  if (!list.length) return;
  const { esc, hm, fmt, known, duration } = Util;
  const CONFIRM_MS = 3000;
  const PENDING_MS = 10000;

  const ICON = { washer: "washer", dryer: "dryer", dishwasher: "dishwasher", oven: "oven", hob: "hob", filter: "filter", fridge: "fridge" };
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

  /* Controls are known as "<appliance index>|<action>[|<argument>]". */
  const twoTap = Util.confirmer(CONFIRM_MS, () => render());
  const pending = Util.pendingSet(PENDING_MS, () => render());
  let root = null;

  /* ---- State values ----------------------------------------------------------------- */
  const s = (id) => (id ? Panel.st(id) : undefined);
  const raw = (id) => ((s(id) || {}).state || "");
  const low = (id) => raw(id).toLowerCase();
  const num = (id) => Panel.num(id);
  const on = (id) => raw(id) === "on";
  const attrs = (id) => (s(id) || {}).attributes || {};
  const offline = (id) => !s(id) || raw(id) === "unavailable";

  /* ---- Controls --------------------------------------------------------------------- */
  function btn(i, action, label, { primary = false, active = false, disabled = false, confirm = false, ic = null } = {}) {
    const key = `${i}|${action}`;
    const isArmed = twoTap.armed(key);
    const cls = ["ap-btn", primary && "primary", active && "on", isArmed && "armed", pending.has(key) && "pending"].filter(Boolean).join(" ");
    return (
      `<button class="${cls}" data-appl="${key}"${confirm ? " data-confirm" : ""}${disabled ? " disabled" : ""}>` +
      `${ic ? icon(ic) : ""}<span>${isArmed ? "Nogmaals tikken" : esc(label)}</span></button>`
    );
  }
  function chip(i, action, label, activeChip, disabled) {
    const key = `${i}|${action}`;
    return `<button class="ap-chip${activeChip ? " active" : ""}${pending.has(key) ? " pending" : ""}" data-appl="${key}"${disabled ? " disabled" : ""}>${esc(label)}</button>`;
  }
  const stat = (label, value) => `<div class="ap-stat"><span>${label}</span><b>${esc(value)}</b></div>`;
  const note = (text) => `<p class="ap-note">${esc(text)}</p>`;

  /* ---- Per kind: what a card shows ---------------------------------------------- */
  /* Each returns {tone, pill, big, unit, sub, word, progress, stats, controls, extra}. */
  const VIEWS = {
    washer: laundry,
    dryer: laundry,
    dishwasher(a, i) {
      const e = a.entities;
      if (offline(e.op)) return offlineView("De vaatwasser is niet bereikbaar");
      const op = low(e.op);
      const running = op === "run" || op === "delayedstart";
      const paused = op === "pause";
      const program = raw(e.selected);
      const phase = PHASE_NL[low(e.phase)];
      const [big, unit] = duration(num(e.remaining));
      const end = Number.isFinite(num(e.remaining)) ? new Date(Date.now() + num(e.remaining) * 1000) : null;
      const startAllowed = on(e.startAllowed);
      const programs = (attrs(e.selected).options || []).filter((p) => !HIDDEN_PROGRAMS.has(p));
      const view = {
        tone: running ? "run" : paused ? "paused" : op === "finished" ? "done" : op === "error" || op === "actionrequired" ? "error" : op === "ready" ? "ready" : "off",
        pill: OP_NL[op] || raw(e.op),
        progress: running || paused ? num(e.progress) : null,
        stats: [
          stat("Deur", low(e.door) === "open" ? "Open" : "Dicht"),
          stat("Onderhoud", Number.isFinite(num(e.care)) ? `over ${fmt(num(e.care))}×` : "--"),
          stat("Energie", Number.isFinite(num(e.energy)) ? `${fmt(num(e.energy))}%` : "--"),
          stat("Water", Number.isFinite(num(e.water)) ? `${fmt(num(e.water))}%` : "--"),
        ],
      };
      if (running || paused) {
        Object.assign(view, { big, unit, sub: [phase, PROGRAM_NL[program] || program, end && `klaar om ${hm(end)}`].filter(Boolean).join(" · ") });
      } else {
        Object.assign(view, { big: PROGRAM_NL[program] || (known(program) ? program : "Kies een programma"), word: true, sub: op === "finished" ? "Programma klaar" : "Programma" });
      }
      const idle = !running && !paused;
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
    oven(a, i) {
      const e = a.entities;
      if (offline(e.op)) return offlineView("De oven is niet bereikbaar");
      const op = low(e.op);
      const running = op === "run" || op === "delayedstart";
      const paused = op === "pause";
      const temp = num(e.temp);
      const target = num(e.setpoint);
      const [left, leftUnit] = duration(num(e.remaining));
      const program = raw(e.program);
      const view = {
        tone: running ? "run" : paused ? "paused" : op === "finished" ? "done" : op === "error" ? "error" : "off",
        pill: OP_NL[op] || raw(e.op),
        big: Number.isFinite(temp) ? fmt(temp) : "--",
        unit: "°C",
        sub: running || paused
          ? [known(program) ? program : "Bezig", Number.isFinite(target) && `naar ${fmt(target)}°`, Number.isFinite(num(e.remaining)) && `nog ${left} ${leftUnit}`].filter(Boolean).join(" · ")
          : "Temperatuur binnen",
        progress: running || paused ? num(e.progress) : null,
        stats: [
          stat("Deur", { open: "Open", locked: "Vergrendeld" }[low(e.door)] || "Dicht"),
          stat("Doel", Number.isFinite(target) ? `${fmt(target)}°` : "--"),
          stat("Verstreken", Number.isFinite(num(e.elapsed)) ? duration(num(e.elapsed)).join(" ") : "--"),
          stat("Lamp", on(e.light) ? "Aan" : "Uit"),
        ],
      };
      view.controls =
        `<div class="ap-row">` +
        (running ? btn(i, "pause", "Pauze", { ic: "pause" }) : "") +
        (paused ? btn(i, "resume", "Hervat", { primary: true, ic: "play" }) : "") +
        (running || paused ? btn(i, "stop", "Stop", { confirm: true, ic: "stop" }) : "") +
        btn(i, "toggle|childlock", "Kinderslot", { active: on(e.childlock), ic: "lock" }) +
        `</div>` +
        (!running && !paused ? note("Starten gaat op de oven zelf; hier zie en stop je het programma.") : "");
      return view;
    },
    hob(a, i) {
      const e = a.entities;
      if (offline(e.op)) return offlineView("De kookplaat is niet bereikbaar");
      const powered = low(e.power) === "on";
      const zones = ["zone1", "zone2", "zone3", "zone4"].map((k) => raw(e[k]));
      const active = zones.filter((z) => known(z) && z !== "Off").length;
      const vent = raw(e.vent);
      const ventOptions = attrs(e.vent).options || [];
      const levels = ventOptions.filter((o) => /^Level\d+$/.test(o));
      const levelIdx = levels.indexOf(vent);
      const ventLabel = vent === "Off" ? "Uit" : vent === "Automatic" ? "Auto" : /^Level/.test(vent) ? `Stand ${parseInt(vent.slice(5), 10)}` : /^Boost/.test(vent) ? "Boost" : vent === "AfterRun" ? "Nadraaien" : vent;
      const zoneLabel = (z) => (!known(z) || z === "Off" ? "–" : z === "KeepWarm" ? "W" : /^Boost/.test(z) ? "B" : String(Math.round(parseInt(z, 10) / 10)));
      const view = {
        tone: active ? "hot" : powered ? "ready" : "off",
        pill: powered || active ? "Aan" : "Uit",
        /* The number of zones in use; a hob that is off says so instead of "0". */
        big: active ? String(active) : powered ? "0" : "Uit",
        word: !active && !powered,
        unit: active ? (active === 1 ? "zone aan" : "zones aan") : powered ? "zones aan" : "",
        sub: vent && vent !== "Off" ? `Afzuiging ${ventLabel.toLowerCase()}` : "Afzuiging uit",
        extra:
          `<div class="ap-zones">${zones.map((z, n) => `<div class="ap-zone${known(z) && z !== "Off" ? " on" : ""}" title="Zone ${n + 1}">${zoneLabel(z)}</div>`).join("")}</div>`,
        stats: [
          stat("Afzuiging", ventLabel || "--"),
          stat("Lucht", low(e.airmode) === "extraction" ? "Afvoer" : "Recirculatie"),
          stat("Koolstoffilter", Number.isFinite(num(e.filter)) ? `niveau ${fmt(num(e.filter))}` : "--"),
          stat("Kinderslot", on(e.childlock) ? "Aan" : "Uit"),
        ],
      };
      view.controls =
        `<div class="ap-row">` +
        chip(i, "vent|Off", "Uit", vent === "Off") +
        chip(i, "vent|Automatic", "Auto", vent === "Automatic") +
        `<div class="ap-stepper">` +
        `<button class="ap-btn" data-appl="${i}|ventstep|-1" aria-label="Zachter"${levelIdx <= 0 ? " disabled" : ""}>${icon("minus")}</button>` +
        `<b>${levelIdx >= 0 ? levelIdx + 1 : "–"}</b>` +
        `<button class="ap-btn" data-appl="${i}|ventstep|1" aria-label="Harder"${levelIdx >= levels.length - 1 ? " disabled" : ""}>${icon("plus")}</button>` +
        `</div></div>` +
        (s(e.filterReset) ? `<div class="ap-row">${btn(i, "filterreset", "Koolstoffilter vervangen", { confirm: true, ic: "filter" })}</div>` : "");
      return view;
    },
    filter(a) {
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
    fridge(a, i) {
      const e = a.entities;
      if (offline(e.temp)) return offlineView("De koelkast is niet bereikbaar");
      const temp = num(e.temp);
      const set = num(e.setpoint);
      const sp = attrs(e.setpoint);
      const mode = on(e.supercool) ? "SuperCool" : on(e.party) ? "Party" : on(e.night) ? "Nacht" : "Koelt";
      return {
        tone: on(e.supercool) ? "cold" : "ready",
        pill: mode,
        big: Number.isFinite(temp) ? fmt(temp) : "--",
        unit: "°C",
        sub: Number.isFinite(set) ? `ingesteld op ${fmt(set)}°` : "",
        stats: [],
        controls:
          `<div class="ap-row"><div class="ap-stepper wide">` +
          `<button class="ap-btn" data-appl="${i}|setpoint|-1" aria-label="Kouder"${set <= (sp.min ?? 1) ? " disabled" : ""}>${icon("minus")}</button>` +
          `<b>${Number.isFinite(set) ? `${fmt(set)}°` : "--"}</b>` +
          `<button class="ap-btn" data-appl="${i}|setpoint|1" aria-label="Warmer"${set >= (sp.max ?? 9) ? " disabled" : ""}>${icon("plus")}</button>` +
          `</div></div>` +
          `<div class="ap-row ap-toggles">` +
          [["supercool", "SuperCool"], ["party", "Party"], ["night", "Nacht"]].filter(([k]) => s(e[k])).map(([k, label]) => btn(i, `toggle|${k}`, label, { active: on(e[k]) })).join("") +
          `</div>`,
      };
    },
  };

  function laundry(a, i) {
    const e = a.entities;
    const noun = a.kind === "dryer" ? "De droger" : "De wasmachine";
    if (offline(e.machine)) return offlineView(`${noun} is niet bereikbaar`);
    const machine = low(e.machine);
    const job = low(e.job);
    const running = machine === "run";
    const paused = machine === "pause";
    const done = Util.dateOf(raw(e.done));
    const left = done ? Math.max(0, (done - Date.now()) / 1000) : NaN;
    const [big, unit] = duration(left);
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
  }

  function offlineView(text) {
    return { tone: "offline", pill: "Offline", big: "Offline", word: true, sub: "", stats: [], controls: note(text) };
  }

  /* ---- Build and render ------------------------------------------------------------ */
  function build(page) {
    root = page.querySelector(".ap");
    root.innerHTML =
      `<div class="ap-grid">` +
      list
        .map(
          (a, i) =>
            `<article class="ap-card" data-kind="${a.kind}" data-appl-card="${i}">` +
            `<header class="ap-head"><span class="ap-badge">${icon(ICON[a.kind] || "power")}</span>` +
            `<div class="ap-title"><b>${esc(a.label)}</b></div><span class="ap-pill"></span></header>` +
            `<div class="ap-body"><div class="ap-hero"><div class="ap-value"><b class="ap-big"></b><span class="ap-unit"></span></div><span class="ap-sub"></span></div>` +
            `<div class="ap-extra"></div></div>` +
            `<div class="ap-bar"><b></b></div><div class="ap-stats"></div><div class="ap-controls"></div>` +
            `</article>`
        )
        .join("") +
      `</div>`;
    render();
  }
  Panel.definePage("appliances", { className: "appl-page", html: () => `<div id="applPage" class="ap"></div>`, build });

  function render() {
    if (!root) return;
    pending.settle();
    list.forEach((a, i) => {
      const card = root.querySelector(`[data-appl-card="${i}"]`);
      const view = VIEWS[a.kind] ? VIEWS[a.kind](a, i) : offlineView("Onbekend apparaat");
      card.className = `ap-card tone-${view.tone}`;
      card.querySelector(".ap-pill").textContent = view.pill || "";
      const bigEl = card.querySelector(".ap-big");
      bigEl.textContent = view.big ?? "";
      bigEl.classList.toggle("word", !!view.word);
      card.querySelector(".ap-unit").textContent = view.unit || "";
      card.querySelector(".ap-sub").textContent = view.sub || "";
      card.querySelector(".ap-extra").innerHTML = view.extra || "";
      const bar = card.querySelector(".ap-bar");
      bar.hidden = view.progress == null || (view.progress !== "busy" && !Number.isFinite(view.progress));
      bar.classList.toggle("busy", view.progress === "busy");
      bar.querySelector("b").style.width = Number.isFinite(view.progress) ? `${Math.max(2, Math.min(100, view.progress))}%` : "";
      const stats = card.querySelector(".ap-stats");
      stats.innerHTML = (view.stats || []).join("");
      stats.hidden = !(view.stats || []).length;
      card.querySelector(".ap-controls").innerHTML = view.controls || "";
    });
  }

  /* ---- Actions --------------------------------------------------------------------- */
  Panel.defineAction("appl", (el) => {
    const key = el.dataset.appl;
    const [iStr, action, arg] = key.split("|");
    const a = list[+iStr];
    if (!a || !twoTap.tap(key, el.hasAttribute("data-confirm"))) return;
    const e = a.entities;
    /* Settles once any of the appliance's entities reports something new. */
    const snapshot = () => Object.values(e).map((id) => Panel.st(id));
    const call = (domain, service, data, entity) => {
      if (!entity) return;
      pending.mark(key, snapshot);
      Panel.client.callService(domain, service, data || null, { entity_id: entity }).catch(() => {
        pending.drop(key);
        render();
      });
    };
    if (action === "select") call("select", "select_option", { option: arg }, e.state);
    else if (action === "program") call("select", "select_option", { option: arg }, e.selected);
    else if (action === "start") call("select", "select_option", { option: raw(e.selected) }, e.active);
    else if (action === "stop") call("button", "press", null, e.abort);
    else if (action === "pause") call("button", "press", null, e.pause);
    else if (action === "resume") call("button", "press", null, e.resume);
    else if (action === "toggle") call("switch", on(e[arg]) ? "turn_off" : "turn_on", null, e[arg]);
    else if (action === "setpoint") {
      const sp = attrs(e.setpoint);
      const next = Math.min(sp.max ?? 9, Math.max(sp.min ?? 1, num(e.setpoint) + Number(arg) * (sp.step || 1)));
      if (Number.isFinite(next)) call("number", "set_value", { value: next }, e.setpoint);
    } else if (action === "vent") call("select", "select_option", { option: arg }, e.vent);
    else if (action === "ventstep") {
      const levels = (attrs(e.vent).options || []).filter((o) => /^Level\d+$/.test(o));
      const idx = levels.indexOf(raw(e.vent));
      const next = levels[Math.min(levels.length - 1, Math.max(0, (idx < 0 ? -1 : idx) + Number(arg)))];
      if (next) call("select", "select_option", { option: next }, e.vent);
    } else if (action === "filterreset") call("button", "press", null, e.filterReset);
    render();
  });

  Panel.track(
    list.flatMap((a) => Object.values(a.entities)),
    () => render()
  );
  /* Time left moves on its own (the washer reports a finish time). */
  setInterval(render, 30000);
})();
