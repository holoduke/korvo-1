/* Quick looks beside the house on the Start screen. On the left, above the
 * thermostat: the ventilation (its airflow and stand, Auto and Boost; a tap
 * opens its card in Apparaten) and above that the energy (what the house uses
 * now, the sun and the grid, what today cost; a tap opens Energie). On the
 * right, above the garage door, the lights (how many burn, a switch per floor,
 * all off). start.js stands them in their columns; where a column has no room
 * they step aside, and a phone has no room for them at all (its CSS). */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const { esc } = Util;

  const stop = (el) => ["pointerdown", "touchstart"].forEach((ev) => el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true }));
  const hideOnRoom = (el) => Panel.on("room", (room) => (el.hidden = !!room));

  /* ---- Energy ----------------------------------------------------------------------- */
  const E = Panel.energy;
  const hasEnergy = !!E && (cfg.energy || []).some((d) => d.kind === "grid" || d.kind === "solar");
  let energyEl = null;
  const watts = (w) => (Number.isFinite(w) ? E.power(w).join(" ") : "--");

  function renderEnergy() {
    if (!energyEl) return;
    const s = E.summary();
    const back = s.grid < 0;
    energyEl.classList.toggle("sunny", s.sun > 0);
    energyEl.classList.toggle("export", back);
    const [v, unit] = E.power(s.house);
    energyEl.querySelector("[data-qe-now]").innerHTML = `<b>${v}</b><span>${unit} huis</span>`;
    const flow = [];
    if (Number.isFinite(s.sun)) flow.push(`<span class="qe-sun">${icon("sun")}${watts(s.sun)}<small>zon</small></span>`);
    if (Number.isFinite(s.grid)) flow.push(`<span class="qe-grid">${icon(back ? "arrow-up" : "arrow-down")}${watts(Math.abs(s.grid))}<small>${back ? "terug" : "net"}</small></span>`);
    energyEl.querySelector("[data-qe-flow]").innerHTML = flow.join("");
    const today = [Number.isFinite(s.cost) ? E.eur(s.cost) : "", Number.isFinite(s.houseToday) ? E.kwhText(s.houseToday) : ""].filter(Boolean);
    energyEl.querySelector("[data-qe-today]").innerHTML = today.length ? `<span>Vandaag</span><b>${today.join(" · ")}</b>` : "";
  }

  /* ---- Ventilation ------------------------------------------------------------------ */
  const wtw = (cfg.appliances || []).find((a) => a.kind === "ventilation");
  const WTW_MODES = [["AUTO", "Auto"], ["MAN3x2", "Boost"]]; /* boost: 30 minutes on III, then automatic again */
  const WTW_BUSY_MS = 8000;
  let wtwEl = null;
  let wtwBusy = null; /* {option, timer}: asked, not yet answered */

  function renderWtw() {
    if (!wtwEl || !Panel.wtwStand) return;
    const e = wtw.entities;
    const code = (Panel.st(e.stand) || {}).state || "";
    const flow = Panel.num(e.flow);
    const left = Panel.num(e.left);
    const st = Panel.wtwStand(code);
    if (wtwBusy && code === wtwBusy.option) settleWtw();
    const timed = code.startsWith("MAN") && Number.isFinite(left) && left > 0;
    wtwEl.classList.toggle("hard", Number.isFinite(flow) && flow >= 60);
    wtwEl.querySelector("[data-qw-now]").innerHTML = `<b>${Number.isFinite(flow) ? Math.round(flow) : "--"}</b><span>% debiet</span>`;
    wtwEl.querySelector("[data-qw-stand]").textContent = timed ? `${st.pill} · nog ${Math.max(1, Math.round(left / 60))} min` : st.pill;
    WTW_MODES.forEach(([option]) => {
      const b = wtwEl.querySelector(`[data-qw-mode="${option}"]`);
      /* Boost lights for any timed stand III, whatever its length */
      const active = option === "AUTO" ? code === "AUTO" : code.startsWith("MAN3");
      b.classList.toggle("active", active);
      b.classList.toggle("pending", !!wtwBusy && wtwBusy.option === option);
      b.setAttribute("aria-pressed", String(active));
    });
  }
  function settleWtw() {
    if (wtwBusy) clearTimeout(wtwBusy.timer);
    wtwBusy = null;
  }
  function setWtw(option) {
    settleWtw();
    wtwBusy = { option, timer: setTimeout(() => (settleWtw(), renderWtw()), WTW_BUSY_MS) };
    Panel.sound && Panel.sound.tap && Panel.sound.tap();
    renderWtw();
    Panel.client.callService("select", "select_option", { option }, { entity_id: wtw.entities.stand }).catch((err) => {
      settleWtw();
      renderWtw();
      Panel.commandFailed(wtw.label)(err);
    });
  }
  /* its card in Apparaten, through the hash the page routes on */
  function openWtw() {
    const sec = cfg.sections.find((x) => x.kind === "appliances");
    if (sec) location.hash = `${Util.slug(sec.name)}/${Util.slug(wtw.label)}`;
  }

  /* ---- Lights ----------------------------------------------------------------------- */
  const floors = cfg.floors || [];
  const lampsOf = (fi) => (Panel.lampsOfTab ? Panel.lampsOfTab(floors[fi].tab) : []);
  const isOn = (id) => (Panel.st(id) || {}).state === "on";
  const reachable = (id) => !Panel.unavailable(Panel.st(id));
  const busy = new Map(); /* floor index -> timer: asked, not yet answered */
  const BUSY_MS = 5000;
  let lightsEl = null;

  function renderLights() {
    if (!lightsEl) return;
    const all = floors.flatMap((_, fi) => lampsOf(fi));
    const known = all.length > 0;
    const lit = all.filter(isOn).length;
    lightsEl.querySelector("[data-ql-count]").textContent = !known ? "…" : lit ? `${lit} aan` : "alles uit";
    lightsEl.classList.toggle("lit", lit > 0);
    const off = lightsEl.querySelector("[data-ql-off]");
    off.disabled = !lit;
    floors.forEach((f, fi) => {
      const b = lightsEl.querySelector(`[data-ql-floor="${fi}"]`);
      const lamps = lampsOf(fi);
      const n = lamps.filter(isOn).length;
      b.disabled = !lamps.some(reachable);
      b.classList.toggle("on", n > 0);
      b.classList.toggle("pending", busy.has(fi));
      b.querySelector("[data-ql-n]").textContent = !known ? "…" : n ? `${n} aan` : "uit";
      b.setAttribute("aria-label", `${f.name}: ${n ? `${n} aan, uitzetten` : "uit, aanzetten"}`);
    });
  }
  function settle(fi) {
    clearTimeout(busy.get(fi));
    busy.delete(fi);
  }
  function call(service, ids, fi, label) {
    if (!ids.length) return;
    if (fi != null) {
      settle(fi);
      busy.set(fi, setTimeout(() => (busy.delete(fi), renderLights()), BUSY_MS));
    }
    Panel.sound && Panel.sound.tap && Panel.sound.tap();
    renderLights();
    Panel.client.callService("light", service, null, { entity_id: ids }).catch((err) => {
      if (fi != null) settle(fi);
      renderLights();
      Panel.commandFailed(label)(err);
    });
  }
  /* a floor with a lamp on goes off; a dark one comes on as its lamps last were */
  function toggleFloor(fi) {
    const lamps = lampsOf(fi).filter(reachable);
    const lit = lamps.filter(isOn);
    if (lit.length) call("turn_off", lit, fi, floors[fi].name);
    else call("turn_on", lamps, fi, floors[fi].name);
  }
  function allOff() {
    const lit = floors.flatMap((_, fi) => lampsOf(fi)).filter(isOn);
    floors.forEach((_, fi) => lampsOf(fi).some(isOn) && settle(fi));
    call("turn_off", lit, null, "Verlichting");
  }

  Panel.on("start", () => {
    const house = document.querySelector(".start-page .house");
    if (!house) return;
    if (hasEnergy) {
      house.insertAdjacentHTML(
        "beforeend",
        `<button class="house-quick house-energy" data-house-energy aria-label="Energie openen">` +
          `<span class="hq-title">${icon("bolt")}<span>Energie</span></span>` +
          `<span class="qe-now" data-qe-now></span>` +
          `<span class="qe-flow" data-qe-flow></span>` +
          `<span class="hq-foot" data-qe-today></span>` +
          `</button>`
      );
      energyEl = house.querySelector("[data-house-energy]");
      energyEl.addEventListener("click", () => Panel.showSection("energy"));
      stop(energyEl);
      hideOnRoom(energyEl);
      renderEnergy();
    }
    if (wtw) {
      house.insertAdjacentHTML(
        "beforeend",
        `<div class="house-quick house-wtw" data-house-wtw>` +
          `<button class="qw-open" data-qw-open aria-label="${esc(wtw.label)} openen in Apparaten">` +
          `<span class="hq-title">${icon("fan")}<span>Ventilatie</span></span>` +
          `<span class="qw-now" data-qw-now></span>` +
          `<span class="qw-stand" data-qw-stand></span>` +
          `</button>` +
          `<div class="qw-modes">` +
          WTW_MODES.map(([option, label]) => `<button class="qw-mode" data-qw-mode="${option}" aria-pressed="false">${label}</button>`).join("") +
          `</div>` +
          `</div>`
      );
      wtwEl = house.querySelector("[data-house-wtw]");
      wtwEl.addEventListener("click", (e) => {
        const m = e.target.closest("[data-qw-mode]");
        if (m) {
          if (!m.classList.contains("active")) setWtw(m.dataset.qwMode);
        } else if (e.target.closest("[data-qw-open]")) openWtw();
      });
      stop(wtwEl);
      hideOnRoom(wtwEl);
      renderWtw();
    }
    if (floors.length) {
      house.insertAdjacentHTML(
        "beforeend",
        `<div class="house-quick house-lights" data-house-lights>` +
          `<span class="hq-title">${icon("lights")}<span>Verlichting</span></span>` +
          `<div class="ql-floors">` +
          floors.map((f, fi) => `<button class="ql-floor" data-ql-floor="${fi}"><span class="ql-name">${esc(cfg.tabs[f.tab].name || f.name)}</span><span class="ql-n" data-ql-n>…</span></button>`).join("") +
          `</div>` +
          `<div class="ql-foot"><b class="ql-count" data-ql-count>…</b>` +
          `<button class="ap-btn ql-off" data-ql-off>${icon("power")}<span>Alles uit</span></button></div>` +
          `</div>`
      );
      lightsEl = house.querySelector("[data-house-lights]");
      lightsEl.addEventListener("click", (e) => {
        const f = e.target.closest("[data-ql-floor]");
        if (f && !f.disabled) toggleFloor(+f.dataset.qlFloor);
        else if (e.target.closest("[data-ql-off]:not(:disabled)")) allOff();
      });
      stop(lightsEl);
      hideOnRoom(lightsEl);
      renderLights();
    }
  });

  if (hasEnergy) {
    const later = Panel.whenShown("start", renderEnergy);
    Panel.track(E.liveIds(), () => later());
    Panel.on("energy", () => later());
    Panel.on("loaded", () => later());
  }
  if (wtw) {
    const later = Panel.whenShown("start", renderWtw);
    Panel.track([wtw.entities.stand, wtw.entities.flow, wtw.entities.left].filter(Boolean), () => later());
    Panel.on("loaded", () => later());
  }
  if (floors.length) {
    let frame = 0;
    const soon = () => frame || (frame = requestAnimationFrame(() => ((frame = 0), renderLights())));
    /* a lamp that answered: its floor is no longer waiting */
    Panel.on("light", (id) => {
      floors.forEach((_, fi) => busy.has(fi) && lampsOf(fi).includes(id) && settle(fi));
      soon();
    });
    Panel.on("lamps", soon);
    Panel.on("loaded", soon);
  }
})();
