/* Tesla section: the car's page (Tesla Fleet integration). Left: battery and
 * range with the charge limit, what the car is doing, charging with its
 * controls, the active navigation and the tyres. Right: climate and heating,
 * locks and openings, quick actions and media. Entity ids come from the
 * config (the integration names them after the car, e.g. "vlm").
 *
 * Actions that unlock, open something or make noise ask for a second tap.
 * A control shows as pending until Home Assistant reports the new state (or
 * a timeout: a sleeping car first has to wake up). */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const car = cfg.car;
  if (!car) return;
  const E = car.entities;
  const st = Panel.st;
  const CONFIRM_MS = 3000;
  const PENDING_MS = 20000;

  const CHARGING_NL = { starting: "Start", charging: "Laadt", stopped: "Gestopt", complete: "Vol", disconnected: "Niet aangesloten", no_power: "Geen stroom" };
  const SHIFT_NL = { p: "Geparkeerd", d: "Rijdt", r: "Achteruit", n: "Neutraal" };
  const PRESET_NL = { off: "Normaal", keep: "Behouden", dog: "Hond", camp: "Kamperen" };
  const LEVEL_NL = { off: "Uit", low: "Laag", medium: "Midden", high: "Hoog" };
  const WHERE_NL = { home: "Thuis", not_home: "Weg" };
  const OPENINGS = [
    ["doorFL", "deur linksvoor"], ["doorFR", "deur rechtsvoor"], ["doorRL", "deur linksachter"], ["doorRR", "deur rechtsachter"],
    ["winFL", "raam linksvoor"], ["winFR", "raam rechtsvoor"], ["winRL", "raam linksachter"], ["winRR", "raam rechtsachter"],
  ];
  const HEATERS = [["seatFL", "Bestuurder"], ["seatFR", "Passagier"], ["seatRL", "Achter links"], ["seatRC", "Midden"], ["seatRR", "Achter rechts"], ["wheel", "Stuur"]];
  const TIRES = [["tireFL", "tireWarnFL", "Linksvoor"], ["tireFR", "tireWarnFR", "Rechtsvoor"], ["tireRL", "tireWarnRL", "Linksachter"], ["tireRR", "tireWarnRR", "Rechtsachter"]];

  let root = null;
  const q = (sel) => root.querySelector(sel);
  const qa = (sel) => [...root.querySelectorAll(sel)];
  const s = (key) => (E[key] ? st(E[key]) : undefined);
  const has = (key) => {
    const x = s(key);
    return !!x && x.state !== "unavailable";
  };
  const val = (key) => (E[key] ? Panel.num(E[key]) : NaN);
  const on = (key) => (s(key) || {}).state === "on";
  const stateOf = (key) => ((s(key) || {}).state || "").toLowerCase();
  const attrs = (key) => (s(key) || {}).attributes || {};
  const unit = (key) => attrs(key).unit_of_measurement || "";
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const hm = (d) => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  const fmt = (n, digits = 0) =>
    Number.isFinite(n) ? n.toLocaleString("nl-NL", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "--";
  const known = (v) => v !== undefined && v !== null && !["", "unknown", "unavailable", "none"].includes(String(v).toLowerCase());
  function timeOf(key) {
    const x = s(key);
    const t = x && known(x.state) ? Date.parse(x.state) : NaN;
    return Number.isFinite(t) ? new Date(t) : null;
  }
  function when(ms) {
    const d = new Date(ms);
    return new Date().toDateString() === d.toDateString() ? hm(d) : `${d.getDate()}-${d.getMonth() + 1} ${hm(d)}`;
  }

  /* ---- Markup ----------------------------------------------------------------------- */
  const tile = (action, ic, label, extra = "") =>
    `<button class="vbtn" data-car="${action}" ${extra}>${icon(ic)}<span class="cp-label"><b>${label}</b><small></small></span></button>`;
  const stat = (id, label) => `<div class="cp-stat" data-stat="${id}"><span>${label}</span><b>--</b></div>`;
  const stepper = (name, step) =>
    `<div class="cp-stepper" data-stepper="${name}">` +
    `<button class="vchip" data-car="${name}" data-step="-${step}" aria-label="Lager">${icon("minus")}</button><b>--</b>` +
    `<button class="vchip" data-car="${name}" data-step="${step}" aria-label="Hoger">${icon("plus")}</button></div>`;

  Panel.buildCar = function (container) {
    root = container;
    root.innerHTML =
      `<div class="cp-banner" hidden>${icon("power")}<span class="cp-banner-text"></span></div>` +
      `<div class="cp-body">` +
      `<section class="cp-col">` +
      `<div class="cp-card cp-hero">` +
      `<div class="cp-hero-top"><div class="cp-soc"><b>--</b><span>%</span></div><div class="cp-range"><b>--</b><small></small></div></div>` +
      `<div class="cp-bar"><b></b><i></i></div>` +
      `<div class="cp-state"></div><div class="cp-meta"></div>` +
      `</div>` +
      `<div class="cp-card"><div class="vs-section-title">Laden</div>` +
      `<div class="cp-stats">${stat("charging", "Status")}${stat("power", "Vermogen")}${stat("rate", "Snelheid")}${stat("added", "Toegevoegd")}${stat("full", "Vol om")}${stat("cable", "Kabel")}</div>` +
      `<div class="cp-tiles">${tile("charge", "bolt", "Laden")}${tile("port", "plug", "Laadklep")}${tile("cablelock", "unlock", "Kabel los", "data-confirm")}</div>` +
      `<div class="cp-row"><span class="vlabel">Laadlimiet</span>${stepper("limit", 5)}</div>` +
      `<div class="vs-chips" style="--n:4">${[70, 80, 90, 100].map((v) => `<button class="vchip" data-car="limit-set" data-value="${v}">${v}%</button>`).join("")}</div>` +
      `<div class="cp-row"><span class="vlabel">Laadstroom</span>${stepper("amps", 1)}</div>` +
      `</div>` +
      `<div class="cp-card cp-trip" hidden><div class="vs-section-title">Navigatie</div><div class="cp-trip-text"></div></div>` +
      `<div class="cp-card"><div class="vs-section-title">Banden</div>` +
      `<div class="cp-tires">${TIRES.map(([k, , label]) => `<div class="cp-stat" data-tire="${k}"><span>${label}</span><b>--</b></div>`).join("")}</div>` +
      `</div>` +
      `</section>` +
      `<section class="cp-col">` +
      `<div class="cp-card"><div class="vs-section-title">Klimaat <em class="cp-temps"></em></div>` +
      `<div class="cp-tiles cp-tiles-2">${tile("climate", "fan", "Klimaat")}${tile("defrost", "flame", "Ontdooien")}</div>` +
      `<div class="cp-row"><span class="vlabel">Temperatuur</span>${stepper("temp", 0.5)}</div>` +
      `<div class="vs-chips" style="--n:4">${Object.entries(PRESET_NL).map(([o, l]) => `<button class="vchip" data-car="preset" data-opt="${o}">${l}</button>`).join("")}</div>` +
      `<span class="vlabel">Verwarming</span>` +
      `<div class="cp-tiles">${HEATERS.map(([k, l]) => `<button class="vbtn" data-car="heat" data-key="${k}">${icon(k === "wheel" ? "wheel" : "seat")}<span class="cp-label"><b>${l}</b><small></small></span><i class="cp-dots"></i></button>`).join("")}</div>` +
      `</div>` +
      `<div class="cp-card"><div class="vs-section-title">Beveiliging</div>` +
      `<div class="cp-tiles">${tile("lock", "lock", "Slot")}${tile("sentry", "shield", "Schildwacht")}${tile("windows", "window", "Ramen")}${tile("frunk", "car", "Frunk", "data-confirm")}${tile("trunk", "car", "Kofferbak")}</div>` +
      `<div class="cp-openings"></div>` +
      `</div>` +
      `<div class="cp-card"><div class="vs-section-title">Acties</div>` +
      `<div class="cp-tiles">${tile("flash", "lights", "Lichten")}${tile("honk", "locate", "Claxon", "data-confirm")}${tile("homelink", "dock", "Homelink")}${tile("wake", "power", "Wekken")}${tile("keyless", "key", "Sleutelloos", "data-confirm")}${tile("fart", "music", "Scheetje")}</div>` +
      `</div>` +
      `<div class="cp-card cp-media" hidden><div class="vs-section-title">Media</div><div class="cp-media-now"></div>` +
      `<div class="vs-chips" style="--n:5">` +
      `<button class="vchip" data-car="media" data-cmd="media_previous_track" aria-label="Vorige">${icon("prev")}</button>` +
      `<button class="vchip" data-car="media" data-cmd="media_play_pause" aria-label="Afspelen of pauze">${icon("play")}</button>` +
      `<button class="vchip" data-car="media" data-cmd="media_next_track" aria-label="Volgende">${icon("next")}</button>` +
      `<button class="vchip" data-car="volume" data-step="-0.1" aria-label="Zachter">${icon("minus")}</button>` +
      `<button class="vchip" data-car="volume" data-step="0.1" aria-label="Harder">${icon("plus")}</button>` +
      `</div></div>` +
      `</section></div>`;
    render();
  };

  /* ---- Pending and confirm --------------------------------------------------------- */
  const armed = new Map(); /* element -> timer */
  const pending = new Map(); /* element -> {key, snap, until} */
  const snap = (x) =>
    x ? JSON.stringify([x.state, x.attributes && x.attributes.temperature, x.attributes && x.attributes.preset_mode, x.attributes && x.attributes.volume_level]) : "";

  function arm(el) {
    el.classList.add("armed");
    const label = el.querySelector(".cp-label b");
    if (label) label.textContent = "Nogmaals tikken";
    armed.set(el, setTimeout(() => disarm(el), CONFIRM_MS));
  }
  function disarm(el) {
    if (!armed.has(el)) return;
    clearTimeout(armed.get(el));
    armed.delete(el);
    el.classList.remove("armed");
    render();
  }
  function mark(el, key) {
    pending.set(el, { key, snap: snap(s(key)), until: Date.now() + PENDING_MS });
    el.classList.add("pending");
    setTimeout(render, PENDING_MS + 50);
  }
  function settle() {
    for (const [el, p] of pending) {
      if (Date.now() > p.until || snap(s(p.key)) !== p.snap) {
        pending.delete(el);
        el.classList.remove("pending");
      }
    }
  }

  /* ---- Render ----------------------------------------------------------------------- */
  function tileState(action, active, label, small, visible = true) {
    const el = q(`[data-car="${action}"]`);
    if (!el) return null;
    el.hidden = !visible;
    el.classList.toggle("on", !!active);
    if (!armed.has(el)) el.querySelector(".cp-label b").textContent = label;
    el.querySelector(".cp-label small").textContent = small;
    return el;
  }
  function setStat(id, text) {
    q(`[data-stat="${id}"] b`).textContent = text;
  }
  function setStepper(name, text, value, lo, hi) {
    q(`[data-stepper="${name}"] b`).textContent = text;
    const [down, up] = qa(`[data-stepper="${name}"] button`);
    down.disabled = !Number.isFinite(value) || value <= lo;
    up.disabled = !Number.isFinite(value) || value >= hi;
  }
  function whereText() {
    const x = s("location");
    return x && known(x.state) ? WHERE_NL[x.state] || x.state : "";
  }
  function lastSeen() {
    return Math.max(0, ...["battery", "range", "inside", "location", "online"].map((k) => (s(k) || {}).lastChanged || 0));
  }

  function render() {
    if (!root) return;
    settle();
    /* "off": the car sleeps and its last values stand. No known state at all
     * (after a Home Assistant restart while the car sleeps): Tesla Fleet has no
     * data yet and reports placeholders, e.g. frunk and trunk as open. */
    const onlineState = (s("online") || {}).state;
    const noData = !!E.online && !known(onlineState);
    const asleep = onlineState === "off";
    root.classList.toggle("asleep", asleep || noData);
    q(".cp-banner").hidden = !(asleep || noData);
    if (noData) {
      q(".cp-banner-text").textContent = "Nog geen gegevens van de auto. Tik op Wekken om ze op te halen.";
    } else if (asleep) {
      const last = lastSeen();
      q(".cp-banner-text").textContent =
        `De auto slaapt${last ? `; gegevens van ${when(last)}` : ""}. Een opdracht maakt hem eerst wakker, dat duurt even.`;
    }

    /* Battery, range, state */
    const batt = val("battery");
    const limit = val("chargeLimit");
    q(".cp-soc b").textContent = Number.isFinite(batt) ? Math.round(batt) : "--";
    q(".cp-soc").style.color = Panel.battColour(batt);
    const range = val("range");
    q(".cp-range b").textContent = Number.isFinite(range) ? `${fmt(range)} km` : "--";
    const est = val("estRange");
    const usable = val("usable");
    q(".cp-range small").textContent = [
      Number.isFinite(est) ? `geschat ${fmt(est)} km` : "",
      Number.isFinite(usable) && Number.isFinite(batt) && Math.round(usable) !== Math.round(batt) ? `bruikbaar ${fmt(usable)}%` : "",
    ].filter(Boolean).join(" · ");
    q(".cp-bar b").style.width = clamp(Number.isFinite(batt) ? batt : 0, 0, 100) + "%";
    q(".cp-bar b").style.background = Panel.battColour(batt);
    const marker = q(".cp-bar i");
    marker.hidden = !Number.isFinite(limit);
    if (Number.isFinite(limit)) marker.style.left = clamp(limit, 0, 100) + "%";

    const charging = stateOf("charging");
    const isCharging = charging === "charging" || charging === "starting";
    const shift = stateOf("shift").charAt(0);
    const speed = val("speed");
    const driving = ["d", "r", "n"].includes(shift) || (Number.isFinite(speed) && speed > 2);
    let line;
    /* Without data, driving and charging states are left over from before. */
    if (noData) line = "Geen actuele gegevens";
    else if (driving) line = `${SHIFT_NL[shift] || "Rijdt"}${Number.isFinite(speed) ? ` · ${fmt(speed)} km/u` : ""}`;
    else if (isCharging) line = `Laadt${Number.isFinite(val("chargerPower")) ? ` · ${fmt(val("chargerPower"), 1)} kW` : ""}`;
    else line = asleep ? "Slaapt" : "Geparkeerd";
    const where = whereText();
    if (where && !driving) line += ` · ${where}`;
    if (on("present")) line += " · iemand in de auto";
    q(".cp-state").textContent = line;

    const meta = [];
    if (Number.isFinite(val("odometer"))) meta.push(`${fmt(val("odometer"))} km gereden`);
    const update = s("update");
    if (update) {
      const a = update.attributes || {};
      if (update.state === "on" && a.latest_version) meta.push(`update ${a.latest_version} beschikbaar`);
      else if (a.installed_version) meta.push(`software ${a.installed_version}`);
    }
    if (on("battHeater")) meta.push("accu wordt verwarmd");
    if (on("precond")) meta.push("voorverwarmen");
    q(".cp-meta").textContent = meta.join(" · ");

    /* Charging */
    setStat("charging", CHARGING_NL[charging] || "--");
    setStat("power", Number.isFinite(val("chargerPower")) ? `${fmt(val("chargerPower"), 1)} kW` : "--");
    setStat("rate", Number.isFinite(val("chargeRate")) ? `${fmt(val("chargeRate"))} km/u` : "--");
    setStat("added", Number.isFinite(val("energyAdded")) ? `${fmt(val("energyAdded"), 1)} kWh` : "--");
    const full = timeOf("timeToFull");
    setStat("full", full && isCharging ? hm(full) : "--");
    setStat("cable", known((s("cable") || {}).state) ? (on("cable") ? "Aangesloten" : "Los") : "--");

    const chargeOn = on("charge");
    tileState("charge", chargeOn, chargeOn ? "Stop laden" : "Start laden", CHARGING_NL[charging] || "", has("charge"));
    const portOpen = stateOf("port") === "open";
    tileState("port", portOpen, portOpen ? "Klep dicht" : "Klep open", portOpen ? "staat open" : "is dicht", has("port"));
    const cableLocked = stateOf("cableLock") === "locked";
    const cable = tileState("cablelock", false, "Kabel los", cableLocked ? "vergrendeld" : "ontgrendeld", has("cableLock"));
    if (cable) cable.disabled = !cableLocked;

    const limAttrs = attrs("chargeLimit");
    setStepper("limit", Number.isFinite(limit) ? `${fmt(limit)}%` : "--", limit, limAttrs.min ?? 50, limAttrs.max ?? 100);
    qa('[data-car="limit-set"]').forEach((c) => c.classList.toggle("active", Number.isFinite(limit) && +c.dataset.value === Math.round(limit)));
    const amps = val("chargeAmps");
    const ampAttrs = attrs("chargeAmps");
    setStepper("amps", Number.isFinite(amps) ? `${fmt(amps)} A` : "--", amps, ampAttrs.min ?? 0, ampAttrs.max ?? 32);

    /* Navigation */
    const dest = (s("destination") || {}).state;
    const dist = val("distToArrival");
    const eta = timeOf("timeToArrival");
    const soc = val("socAtArrival");
    const delay = val("trafficDelay");
    const tripOn = Number.isFinite(dist) || known(dest);
    q(".cp-trip").hidden = !tripOn;
    if (tripOn) {
      q(".cp-trip-text").textContent = [
        known(dest) ? `Naar ${dest}` : "Onderweg",
        Number.isFinite(dist) ? `${fmt(dist, 1)} km` : "",
        eta ? `aankomst ${hm(eta)}` : "",
        Number.isFinite(soc) ? `${fmt(soc)}% bij aankomst` : "",
        Number.isFinite(delay) && delay > 0 ? `+${fmt(delay)} ${unit("trafficDelay") || "min"} vertraging` : "",
      ].filter(Boolean).join(" · ");
    }

    /* Tyres, in bar (Tesla Fleet reports psi) */
    TIRES.forEach(([k, warn]) => {
      const el = q(`[data-tire="${k}"]`);
      const raw = val(k);
      const u = unit(k).toLowerCase();
      const bar = u === "psi" ? raw * 0.0689476 : u === "kpa" ? raw / 100 : raw;
      el.querySelector("b").textContent = Number.isFinite(bar) ? `${fmt(bar, 1)} bar` : "--";
      el.classList.toggle("warn", on(warn));
    });

    /* Climate */
    const cl = s("climate");
    const ca = attrs("climate");
    const climOn = !!cl && !["off", "unavailable", "unknown"].includes(cl.state);
    const preset = ca.preset_mode || "off";
    const climSmall = !cl || !known(cl.state) ? "onbekend" : climOn ? (preset !== "off" ? PRESET_NL[preset] || preset : "aan") : "uit";
    tileState("climate", climOn, climOn ? "Klimaat uit" : "Klimaat aan", climSmall, !!cl);
    tileState("defrost", on("defrost"), "Ontdooien", on("defrost") ? "aan" : "uit", has("defrost"));
    q(".cp-temps").textContent = [
      Number.isFinite(val("inside")) ? `binnen ${fmt(val("inside"), 1)}°` : "",
      Number.isFinite(val("outside")) ? `buiten ${fmt(val("outside"), 1)}°` : "",
    ].filter(Boolean).join(" · ");
    /* null while the car sleeps; Number(null) would read as 0 °C */
    const target = ca.temperature == null ? NaN : Number(ca.temperature);
    setStepper("temp", Number.isFinite(target) ? `${fmt(target, 1)}°` : "--", target, ca.min_temp ?? 15, ca.max_temp ?? 28);
    qa('[data-car="preset"]').forEach((c) => {
      c.classList.toggle("active", c.dataset.opt === preset);
      c.hidden = Array.isArray(ca.preset_modes) && !ca.preset_modes.includes(c.dataset.opt);
    });
    qa('[data-car="heat"]').forEach((el) => {
      const k = el.dataset.key;
      el.hidden = !has(k);
      if (el.hidden) return;
      const level = stateOf(k);
      const options = attrs(k).options || ["off", "low", "medium", "high"];
      el.classList.toggle("on", !!level && level !== "off");
      el.querySelector(".cp-label small").textContent = LEVEL_NL[level] || (known(level) ? level : "--");
      const idx = Math.max(0, options.indexOf(level));
      el.querySelector(".cp-dots").innerHTML = options.slice(1).map((_, i) => `<s class="${i < idx ? "lit" : ""}"></s>`).join("");
    });

    /* Security */
    const lockKnown = known(stateOf("lock"));
    const locked = stateOf("lock") === "locked";
    const lockTile = lockKnown
      ? tileState("lock", locked, locked ? "Vergrendeld" : "Ontgrendeld", locked ? "tik om te openen" : "tik om te sluiten", has("lock"))
      : tileState("lock", false, "Slot", "onbekend, tik om te sluiten", has("lock"));
    if (lockTile) lockTile.toggleAttribute("data-confirm", locked); /* unlocking asks for a second tap */
    tileState("sentry", on("sentry"), "Schildwacht", on("sentry") ? "aan" : "uit", has("sentry"));
    const winOpen = stateOf("windows") === "open";
    const winTile = tileState("windows", winOpen, "Ramen", winOpen ? "op een kier" : known(stateOf("windows")) ? "dicht" : "onbekend", has("windows"));
    if (winTile) winTile.toggleAttribute("data-confirm", !winOpen);
    const frunkOpen = !noData && stateOf("frunk") === "open";
    const frunk = tileState("frunk", frunkOpen, "Frunk", noData ? "onbekend" : frunkOpen ? "open" : "dicht", has("frunk"));
    if (frunk) frunk.disabled = frunkOpen; /* closes by hand only */
    const trunkOpen = !noData && stateOf("trunk") === "open";
    const trunk = tileState("trunk", trunkOpen, "Kofferbak", noData ? "onbekend" : trunkOpen ? "open" : "dicht", has("trunk"));
    if (trunk) trunk.toggleAttribute("data-confirm", !trunkOpen);
    const open = OPENINGS.filter(([k]) => on(k)).map(([, label]) => label);
    if (frunkOpen) open.push("frunk");
    if (trunkOpen) open.push("kofferbak");
    if (winOpen) open.push("ramen op een kier");
    const openings = q(".cp-openings");
    openings.textContent = noData ? "Deuren en ramen: nog geen gegevens" : open.length ? `Open: ${open.join(", ")}` : "Alle deuren en ramen dicht";
    openings.classList.toggle("warn", !noData && open.length > 0);
    openings.classList.toggle("unknown", noData);

    /* Actions */
    [["flash", "Lichten"], ["honk", "Claxon"], ["homelink", "Homelink"], ["wake", "Wekken"], ["keyless", "Sleutelloos"], ["fart", "Scheetje"]].forEach(([k, label]) =>
      tileState(k, false, label, k === "wake" ? (noData ? "geen gegevens" : asleep ? "slaapt" : "wakker") : "", has(k))
    );

    /* Media */
    const media = s("media");
    const playing = !!media && ["playing", "paused"].includes(media.state);
    q(".cp-media").hidden = !playing;
    if (playing) {
      const a = media.attributes || {};
      q(".cp-media-now").textContent =
        [a.media_title, a.media_artist].filter(known).join(" · ") || (a.source ? String(a.source) : media.state === "playing" ? "Speelt" : "Gepauzeerd");
      q('[data-cmd="media_play_pause"]').innerHTML = icon(media.state === "playing" ? "pause" : "play");
    }
  }

  /* ---- Actions ---------------------------------------------------------------------- */
  Panel.carTap = function (el) {
    const action = el.dataset.car;
    if (el.hasAttribute("data-confirm") && !armed.has(el)) {
      arm(el);
      return;
    }
    if (armed.has(el)) {
      clearTimeout(armed.get(el));
      armed.delete(el);
      el.classList.remove("armed");
    }
    const call = (domain, service, data, key) => {
      if (!E[key]) return;
      mark(el, key);
      Panel.client.callService(domain, service, data || null, { entity_id: E[key] }).catch(() => {
        pending.delete(el);
        el.classList.remove("pending");
      });
      render();
    };
    const toggle = (key) => call("switch", on(key) ? "turn_off" : "turn_on", null, key);
    switch (action) {
      case "wake":
      case "flash":
      case "honk":
      case "homelink":
      case "keyless":
      case "fart":
        return call("button", "press", null, action);
      case "charge":
        return toggle("charge");
      case "defrost":
        return toggle("defrost");
      case "sentry":
        return toggle("sentry");
      case "port":
        return call("cover", stateOf("port") === "open" ? "close_cover" : "open_cover", null, "port");
      case "cablelock":
        return call("lock", "unlock", null, "cableLock");
      case "limit":
      case "limit-set": {
        const a = attrs("chargeLimit");
        const next = action === "limit-set" ? +el.dataset.value : val("chargeLimit") + Number(el.dataset.step);
        if (!Number.isFinite(next)) return;
        return call("number", "set_value", { value: clamp(next, a.min ?? 50, a.max ?? 100) }, "chargeLimit");
      }
      case "amps": {
        const a = attrs("chargeAmps");
        const next = val("chargeAmps") + Number(el.dataset.step);
        if (!Number.isFinite(next)) return;
        return call("number", "set_value", { value: clamp(next, a.min ?? 0, a.max ?? 32) }, "chargeAmps");
      }
      case "climate": {
        const cl = s("climate");
        const running = !!cl && !["off", "unavailable", "unknown"].includes(cl.state);
        return call("climate", running ? "turn_off" : "turn_on", null, "climate");
      }
      case "temp": {
        const a = attrs("climate");
        const base = a.temperature != null && Number.isFinite(Number(a.temperature)) ? Number(a.temperature) : 21;
        const next = clamp(Math.round((base + Number(el.dataset.step)) * 2) / 2, a.min_temp ?? 15, a.max_temp ?? 28);
        return call("climate", "set_temperature", { temperature: next }, "climate");
      }
      case "preset":
        return call("climate", "set_preset_mode", { preset_mode: el.dataset.opt }, "climate");
      case "heat": {
        const key = el.dataset.key;
        const options = attrs(key).options || ["off", "low", "medium", "high"];
        const next = options[(options.indexOf(stateOf(key)) + 1) % options.length];
        return call("select", "select_option", { option: next }, key);
      }
      case "lock":
        return call("lock", stateOf("lock") === "locked" ? "unlock" : "lock", null, "lock");
      case "windows":
        return call("cover", stateOf("windows") === "open" ? "close_cover" : "open_cover", null, "windows");
      case "frunk":
        return call("cover", "open_cover", null, "frunk");
      case "trunk":
        return call("cover", stateOf("trunk") === "open" ? "close_cover" : "open_cover", null, "trunk");
      case "media":
        return call("media_player", el.dataset.cmd, null, "media");
      case "volume": {
        const current = Number(attrs("media").volume_level);
        const next = clamp(Math.round(((Number.isFinite(current) ? current : 0.3) + Number(el.dataset.step)) * 10) / 10, 0, 1);
        return call("media_player", "volume_set", { volume_level: next }, "media");
      }
    }
  };

  Panel.onCar = render;
})();
