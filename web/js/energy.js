/* Energie section: what the house uses now, today and over the last week, a
 * 24 h power chart and a card per device. The smart meter (P1) has its own
 * card; until it exists in Home Assistant that card says what it will show,
 * and the devices with a meter add up to the totals. Once it is there it leads
 * "nu", "vandaag" and the week, with what the devices don't explain as
 * "Overig". Live power comes from the states, daily use from Home Assistant's
 * statistics, the chart from its history. The smart meter (DSMR) has a wide
 * panel of its own: which way the power flows and at what price, the three
 * phases, today per tariff and in euros, the meter's own readings and the
 * grid's quality. Prices come from Home Assistant's energy settings.
 *
 * Each kind of device (energy-kinds.js) registers with
 *   Panel.defineEnergyKind(kind, {icon, use, chart, meter, stats, power(e), card(e)})
 * use: counts towards the house's use (a battery stores instead); chart: key of
 * its power entity for the chart; meter: key of the kWh counter summed into
 * "vandaag" and the week; stats: every counter key whose daily use it shows;
 * power(e): W now; card(e): the card's view (cards.js). Helpers for the kinds
 * are in Panel.energy. The smart meter ("grid") is this file's own. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const { esc, fmt, slug } = Util;
  const devices = cfg.energy || [];
  const kinds = {};
  Panel.defineEnergyKind = (kind, def) => (kinds[kind] = def);

  const grid = devices.find((d) => d.kind === "grid") || null;
  const IMPORT = ["import1", "import2"]; /* the smart meter's counters, tariff 1 (dal) and 2 (normaal) */
  const EXPORT = ["export1", "export2"];
  const others = devices.filter((d) => d !== grid);
  const users = () => others.filter((d) => kinds[d.kind].use);
  const PALETTE = ["#4fc3f7", "#ffb74d", "#ef7a78", "#8bd17c", "#b48ef0", "#f48fb1", "#4db6ac"];
  const OTHER = "#8a93a6"; /* "Overig": what the smart meter sees beyond the devices */
  const colour = new Map(others.map((d, i) => [d, PALETTE[i % PALETTE.length]]));
  const colourOf = (d) => (d === grid ? Panel.cssVar("--accent") : colour.get(d));

  /* ---- Units ------------------------------------------------------------------------ */
  const exists = (id) => !!(id && Panel.st(id));
  const unitOf = (id) => ((Panel.st(id) || {}).attributes || {}).unit_of_measurement;
  const SCALE = { W: 1, kW: 1e3, MW: 1e6, Wh: 1e-3, kWh: 1, MWh: 1e3 };
  /* A power reading in W or an energy counter in kWh, whatever unit Home Assistant reports. */
  const scaled = (id) => Panel.num(id) * (SCALE[unitOf(id)] ?? 1);
  /* W -> ["380", "W"] or ["1,25", "kW"]. */
  function power(w) {
    if (!Number.isFinite(w)) return ["--", "W"];
    const a = Math.abs(w);
    return a >= 1000 ? [fmt(w / 1000, a >= 10000 ? 1 : 2), "kW"] : [fmt(w), "W"];
  }
  const kwhNum = (v) => (Number.isFinite(v) ? fmt(v, v < 10 ? 2 : v < 100 ? 1 : 0) : "--");
  const kwhText = (v) => `${kwhNum(v)} kWh`;

  /* ---- Daily use (statistics) --------------------------------------------------------- */
  const today = new Map(); /* counter id -> use so far today (kWh; water in L) */
  const daily = new Map(); /* counter id -> Map(date string -> use that day) */
  let statsAt = 0;
  let statsBusy = false;
  const dayStart = (back) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - back);
    return d;
  };
  /* A counter's use on the day `back` days ago (0 = today), or NaN. */
  function useOn(id, back) {
    const v = back === 0 ? today.get(id) : (daily.get(id) || new Map()).get(dayStart(back).toDateString());
    return v == null ? NaN : Math.max(0, v);
  }
  const counterIds = () =>
    devices.flatMap((d) => (d === grid ? [...IMPORT, ...EXPORT] : kinds[d.kind].stats).map((k) => d.entities[k])).filter(exists);

  async function loadStats() {
    const ids = counterIds();
    if (statsBusy || !ids.length) return;
    statsBusy = true;
    try {
      const [days, now] = await Promise.all([Panel.client.dailyUse(ids, dayStart(6)), Panel.client.useToday(ids)]);
      daily.clear();
      for (const [id, rows] of Object.entries(days)) daily.set(id, new Map(rows.map((r) => [new Date(r.t).toDateString(), r.change])));
      today.clear();
      for (const [id, v] of Object.entries(now)) if (v != null) today.set(id, v);
      statsAt = Date.now();
      renderAll();
    } catch (e) {
      /* retried on the next refresh */
    } finally {
      statsBusy = false;
    }
  }

  /* ---- The smart meter --------------------------------------------------------------- */
  /* DSMR reports what the house takes and what it gives back, both positive,
   * and counts each over two tariffs: 1 = dal, 2 = normaal. */
  const G = grid ? grid.entities : {};
  const TARIFFS = [1, 2];
  const TARIFF_NL = { 1: "dal", 2: "normaal" };
  const TARIFF_NAME = { 1: "Daltarief", 2: "Normaal tarief" };
  const DAY_NAMES = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];
  const TARIFF_OF = { low: 1, normal: 2 }; /* the meter's active tariff */
  const V_MIN = 207; /* 230 V ± 10 %: the band the grid operator must keep to (EN 50160) */
  const V_MAX = 253;
  /* Reporting now: present and not unavailable (the P1 cable out, the reader
   * restarting); otherwise the page falls back to the devices' own meters. */
  const gridLive = () => !!grid && exists(G.powerIn) && !Panel.unavailable(Panel.st(G.powerIn));
  const takes = () => scaled(G.powerIn);
  const gives = () => (exists(G.powerOut) ? scaled(G.powerOut) : 0);
  /* W: positive from the grid, negative back to it. */
  const gridW = () => takes() - gives();
  const phaseIn = (p) => scaled(G[`in${p}`]);
  const phaseOut = (p) => (exists(G[`out${p}`]) ? scaled(G[`out${p}`]) : 0);
  /* The sum of some counters' use on a day, NaN when none is known. */
  function sumOn(keys, back) {
    const vals = keys.map((k) => useOn(G[k], back)).filter(Number.isFinite);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : NaN;
  }
  const importOn = (back) => sumOn(IMPORT, back);
  const exportOn = (back) => sumOn(EXPORT, back);
  const activeTariff = () => TARIFF_OF[(Panel.st(G.tariff) || {}).state] || null;

  /* Prices, as Home Assistant's energy dashboard has them: per counter an
   * entity (an input_number) or a fixed number, and a fixed adjustment per
   * day. Read from its settings, so a changed price follows by itself. */
  let prices = null; /* {of: Map(counter id -> {entity, number}), adjust: €/day} */
  async function loadPrices() {
    if (!grid || !Panel.client.energyPrefs) return;
    try {
      const prefs = await Panel.client.energyPrefs();
      const of = new Map();
      let adjust = 0;
      const set = (id, entity, number) => id && of.set(id, { entity: entity || null, number: Number.isFinite(number) ? number : null });
      for (const src of (prefs && prefs.energy_sources) || []) {
        if (src.type !== "grid") continue;
        /* the current settings: one counter per direction on the source */
        set(src.stat_energy_from, src.entity_energy_price, src.number_energy_price);
        set(src.stat_energy_to, src.entity_energy_price_export, src.number_energy_price_export);
        /* older settings: lists of flows */
        (src.flow_from || []).forEach((f) => set(f.stat_energy_from, f.entity_energy_price, f.number_energy_price));
        (src.flow_to || []).forEach((f) => set(f.stat_energy_to, f.entity_energy_price, f.number_energy_price));
        if (Number.isFinite(src.cost_adjustment_day)) adjust += src.cost_adjustment_day;
      }
      prices = { of, adjust };
      const entities = [...of.values()].map((v) => v.entity).filter(Boolean);
      Panel.track(entities, Panel.whenShown("energy", () => (renderMeter(), renderToday())));
      renderMeter();
      renderToday();
    } catch (e) {
      prices = null; /* no energy settings, or not allowed: the panel shows kWh only */
    }
  }
  /* €/kWh for a counter, NaN without a price. */
  function priceOf(id) {
    const p = prices && prices.of.get(id);
    if (!p) return NaN;
    return p.entity ? Panel.num(p.entity) : p.number ?? NaN;
  }
  const priceNow = () => (activeTariff() ? priceOf(G[`import${activeTariff()}`]) : NaN);
  /* What the day cost: taken times its price, minus given back times its price
   * (salderen), plus the fixed adjustment. NaN without prices or use. */
  function costOn(back) {
    if (!prices) return NaN;
    let sum = 0;
    let known = false;
    const add = (key, sign) => {
      const v = useOn(G[key], back);
      const pr = priceOf(G[key]);
      if (Number.isFinite(v) && Number.isFinite(pr)) {
        sum += sign * v * pr;
        known = true;
      }
    };
    IMPORT.forEach((k) => add(k, 1));
    EXPORT.forEach((k) => add(k, -1));
    return known ? sum + prices.adjust : NaN;
  }
  const eur = (v, digits = 2) => (Number.isFinite(v) ? `${v < 0 ? "−" : ""}€ ${fmt(Math.abs(v), digits)}` : "--");

  /* ---- Rendering ---------------------------------------------------------------------- */
  let root = null;
  const q = (sel) => root.querySelector(sel);
  const legendItem = (label, c, value, idle) => `<span class="${idle ? "idle" : ""}"><i style="background:${c}"></i>${esc(label)} <b>${value}</b></span>`;

  function renderNow() {
    const rows = users().filter((d) => kinds[d.kind].chart).map((d) => ({ d, w: kinds[d.kind].power(d.entities) }));
    const measured = rows.reduce((s, r) => s + (r.w > 0 ? r.w : 0), 0);
    const gw = gridLive() ? gridW() : NaN;
    const metered = Number.isFinite(gw);
    const other = metered ? Math.max(0, gw - measured) : 0;
    const [value, unit] = power(metered ? Math.abs(gw) : measured);
    const segs = [...rows.filter((r) => r.w > 0).map((r) => [r.w, colour.get(r.d)]), ...(other > 0 ? [[other, OTHER]] : [])];
    q(".en-now").innerHTML =
      `<h2 class="dc-title">${metered ? (gw < 0 ? "Teruglevering nu" : "Van het net nu") : "Verbruik nu"}</h2>` +
      `<div class="en-big"><b>${value}</b><span>${unit}</span></div>` +
      `<div class="en-sub">${metered ? `${power(measured).join(" ")} gemeten per apparaat` : "Samen, van de apparaten met een meter"}</div>` +
      `<div class="en-share">${segs.map(([w, c]) => `<i style="flex-grow:${w};background:${c}"></i>`).join("")}</div>` +
      `<div class="en-legend">` +
      rows.map((r) => legendItem(r.d.label, colour.get(r.d), power(r.w).join(" "), !(r.w > 0))).join("") +
      (other > 0 ? legendItem("Overig", OTHER, power(other).join(" ")) : "") +
      `</div>`;
  }

  /* The meter's panel: the flow and what it costs, the phases, today and the
   * week, the readings as on its display, and the grid's quality. */
  function renderMeter() {
    if (!grid) return;
    const box = q(".en-meter");
    const live = gridLive();
    /* No meter reporting: no panel, rather than a placeholder. */
    box.hidden = !live;
    if (!live) return;
    const w = gridW();
    const back = w < 0;
    const tariff = activeTariff();
    const price = priceNow();
    const perHour = (Math.abs(w) / 1000) * price;
    const phases = [1, 2, 3].filter((p) => exists(G[`in${p}`]));
    const top = Math.max(500, ...phases.map((p) => Math.max(phaseIn(p) || 0, phaseOut(p) || 0)));
    const phase = (p) => {
      const pin = phaseIn(p);
      const pout = phaseOut(p);
      const volts = Panel.num(G[`voltage${p}`]);
      const amps = Panel.num(G[`current${p}`]);
      const at = Number.isFinite(volts) ? Util.clamp((volts - V_MIN) / (V_MAX - V_MIN), 0, 1) * 100 : null;
      const vTone = !Number.isFinite(volts) ? "" : volts < V_MIN || volts > V_MAX ? "bad" : volts < V_MIN + 5 || volts > V_MAX - 5 ? "warn" : "ok";
      return (
        `<div class="em-phase"><b class="em-l">L${p}</b>` +
        `<span class="em-bar"><i class="in" style="width:${((pin || 0) / top) * 100}%"></i>${pout > 0 ? `<i class="out" style="width:${(pout / top) * 100}%"></i>` : ""}</span>` +
        `<b class="em-w">${power(pin - pout).join(" ")}</b>` +
        `<span class="em-a">${Number.isFinite(amps) ? `${fmt(amps)} A` : "--"}</span>` +
        `<span class="em-v"><span class="em-gauge" title="${V_MIN}–${V_MAX} V">${at != null ? `<i class="${vTone}" style="left:${at}%"></i>` : ""}</span>` +
        `<small class="${vTone}">${Number.isFinite(volts) ? `${fmt(volts, 1)} V` : "--"}</small></span></div>`
      );
    };
    const perTariff = (keys) => TARIFFS.map((t, n) => `${TARIFF_NL[t]} ${kwhNum(useOn(G[keys[n]], 0))}`).join(" · ");
    const imp = importOn(0);
    const exp = exportOn(0);
    const today = costOn(0);
    /* The meter's statistics start the day it was connected: say since when. */
    const known = [0, 1, 2, 3, 4, 5, 6].filter((b) => Number.isFinite(importOn(b)));
    const oldest = known.length ? Math.max(...known) : 0;
    const weekLabel = known.length >= 7 ? "Laatste 7 dagen" : oldest === 0 ? "Sinds vandaag" : oldest === 1 ? "Sinds gisteren" : `Sinds ${DAY_NAMES[dayStart(oldest).getDay()]}`;
    const week = [0, 1, 2, 3, 4, 5, 6].map(costOn);
    const weekCost = week.some(Number.isFinite) ? week.filter(Number.isFinite).reduce((a, b) => a + b, 0) : NaN;
    const weekNet = [0, 1, 2, 3, 4, 5, 6].reduce((s, b) => s + ((importOn(b) || 0) - (exportOn(b) || 0)), 0);
    const reading = (key) => (exists(G[key]) ? fmt(scaled(G[key]), 3) : "--");
    const count = (key) => {
      const v = Panel.num(G[key]);
      return Number.isFinite(v) ? fmt(v) : "–";
    };
    const perPhase = (key) => [1, 2, 3].map((p) => `L${p} ${count(`${key}${p}`)}`).join(" · ");
    box.innerHTML =
      `<header class="em-head"><h2 class="dc-title">${esc(grid.label)}</h2>` +
      (tariff ? `<span class="em-tariff t${tariff}">${TARIFF_NAME[tariff]}${Number.isFinite(price) ? ` · ${eur(price, 3)}/kWh` : ""}</span>` : "") +
      `</header>` +
      `<div class="em-grid">` +
      `<div class="em-flow ${back ? "export" : "import"}">` +
      `<span class="em-arrow">${icon(back ? "arrow-up" : "arrow-down")}</span>` +
      `<div class="em-now"><b>${power(Math.abs(w)).join(" ")}</b><span>${back ? "terug aan het net" : "van het net"}</span></div>` +
      `<div class="em-split"><span>afname <b>${power(takes()).join(" ")}</b></span><span>teruglevering <b>${power(gives()).join(" ")}</b></span></div>` +
      (Number.isFinite(perHour) ? `<div class="em-cost">${back ? "levert nu" : "kost nu"} <b>${eur(perHour)}</b> per uur</div>` : "") +
      `</div>` +
      `<div class="em-phases"><div class="em-phase em-phase-head"><span></span><span></span><span>vermogen</span><span>stroom</span><span>spanning</span></div>` +
      phases.map(phase).join("") +
      `</div>` +
      `<div class="em-day">` +
      `<div class="em-kv"><span>Van het net vandaag</span><b>${kwhText(imp)}</b><small>${perTariff(IMPORT)}</small></div>` +
      `<div class="em-kv"><span>Terug vandaag</span><b>${kwhText(exp)}</b><small>${perTariff(EXPORT)}</small></div>` +
      `<div class="em-kv"><span>Kosten vandaag</span><b>${eur(today)}</b><small>${!prices ? "geen prijzen ingesteld" : prices.adjust < 0 ? `met ${eur(-prices.adjust)} korting per dag` : prices.adjust > 0 ? `met ${eur(prices.adjust)} vaste kosten per dag` : "met salderen"}</small></div>` +
      `<div class="em-kv"><span>${weekLabel}</span><b>${eur(weekCost)}</b><small>${kwhText(weekNet)} netto</small></div>` +
      `</div></div>` +
      `<div class="em-foot">` +
      `<div class="em-readings"><span class="em-label">Meterstanden</span>` +
      `<span>Afname dal <b>${reading("import1")}</b></span><span>normaal <b>${reading("import2")}</b></span>` +
      `<span>Teruglevering dal <b>${reading("export1")}</b></span><span>normaal <b>${reading("export2")}</b> kWh</span></div>` +
      `<div class="em-quality"><span class="em-label">Netkwaliteit</span>` +
      `<span>Onderbrekingen kort <b>${count("failShort")}</b> · lang <b>${count("failLong")}</b></span>` +
      `<span>Spanningsdips <b>${perPhase("sags")}</b></span>` +
      `<span>Spanningspieken <b>${perPhase("swells")}</b></span>` +
      `<small>tellers van de meter sinds plaatsing</small></div>` +
      `</div>`;
  }

  function renderToday() {
    const rows = users().filter((d) => kinds[d.kind].meter).map((d) => [d, useOn(d.entities[kinds[d.kind].meter], 0)]);
    const known = rows.filter(([, v]) => Number.isFinite(v));
    const sum = known.reduce((s, [, v]) => s + v, 0);
    const fromGrid = gridLive() ? importOn(0) : NaN;
    const cost = gridLive() ? costOn(0) : NaN;
    const big = Number.isFinite(fromGrid) ? fromGrid : known.length ? sum : NaN;
    q(".en-today").innerHTML =
      `<h2 class="dc-title">Vandaag</h2>` +
      `<div class="en-big"><b>${kwhNum(big)}</b><span>kWh</span></div>` +
      `<div class="en-sub">${Number.isFinite(fromGrid) ? `van het net${Number.isFinite(cost) ? `, ${eur(cost)}` : ""} · ${kwhText(sum)} gemeten per apparaat` : "Samen, van de apparaten met een meter"}</div>` +
      `<ul class="en-list">${rows.map(([d, v]) => `<li><i style="background:${colour.get(d)}"></i><span>${esc(d.label)}</span><b>${kwhText(v)}</b></li>`).join("")}</ul>`;
  }

  function renderCard(d) {
    Panel.fillCard(q(`[data-energy-card="${devices.indexOf(d)}"]`), kinds[d.kind].card(d.entities), false);
  }

  /* ---- Charts --------------------------------------------------------------------------- */
  const chartId = (d) => (d === grid ? (exists(G.net) ? G.net : G.powerIn) : kinds[d.kind].chart ? d.entities[kinds[d.kind].chart] : null);
  const charted = () => devices.filter((d) => (d === grid ? gridLive() : chartId(d) && !Panel.unavailable(Panel.st(chartId(d)))));
  let picked = null; /* the device chosen for the power chart (null: the first one) */
  const chartDevice = () => (charted().includes(picked) ? picked : charted()[0] || null);
  const shown = { power: 1, week: 1 }; /* reveal progress per chart */
  let frame = 0;

  function renderPick() {
    const cur = chartDevice();
    q(".en-pick").innerHTML = charted()
      .map((d) => `<button class="${d === cur ? "active" : ""}" data-energy-chart="${devices.indexOf(d)}" style="--c:${colourOf(d)}"><i></i>${esc(d.label)}</button>`)
      .join("");
  }

  /* Down to a round negative value too when a battery delivers. */
  const powerRange = (unit) => (vals) => {
    const lowest = Math.min(0, ...vals);
    return [lowest < 0 ? -Panel.niceCeil(-lowest) : 0, Panel.niceCeil(Math.max(unit === "kW" ? 1 : 100, ...vals))];
  };
  /* Axis labels always in kW (the title says so), e.g. "0,25", "2,5", "10". */
  const axisLabel = (unit) => (v) => {
    const kw = Math.round((v * (SCALE[unit] ?? 1)) / 10) / 100;
    return fmt(kw, kw % 1 === 0 ? 0 : Math.abs(kw) < 1 ? 2 : 1);
  };

  function drawPower() {
    const d = chartDevice();
    const foot = q(".en-power-foot");
    const canvas = q(".en-power canvas");
    if (!d) {
      canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
      foot.textContent = Panel.isLoaded() ? "Geen vermogensmeting gevonden" : "";
      return;
    }
    const id = chartId(d);
    const unit = unitOf(id) || "W";
    const { series, spanH } = Panel.drawChart(
      canvas,
      { left: { id, colour: colourOf(d), range: powerRange(unit), fmt: axisLabel(unit), hold: 25 * 3600e3 } },
      shown.power
    );
    q(".en-power .dc-title").textContent = `Vermogen in kW, laatste ${spanH} uur`;
    const vals = series[0].vals;
    foot.innerHTML = vals.length
      ? `<span>Nu <b>${power(scaled(id)).join(" ")}</b></span><span>Piek <b>${power(Util.minMax(vals)[1] * (SCALE[unit] ?? 1)).join(" ")}</b></span>`
      : "Nog geen geschiedenis (wordt opgehaald)";
  }

  function drawWeek() {
    const meters = users().filter((d) => kinds[d.kind].meter).map((d) => [d, d.entities[kinds[d.kind].meter]]);
    const days = [6, 5, 4, 3, 2, 1, 0];
    const rest = (back, parts) => (gridLive() ? Math.max(0, importOn(back) - parts.reduce((s, p) => s + p.v, 0)) || 0 : 0);
    const bars = days.map((back) => {
      const parts = meters.map(([d, id]) => ({ v: useOn(id, back) || 0, colour: colour.get(d) }));
      const other = rest(back, parts);
      return { label: Util.DAYS_SHORT[dayStart(back).getDay()], parts: other > 0 ? [...parts, { v: other, colour: OTHER }] : parts, strong: back === 0 };
    });
    Panel.drawBars(q(".en-week canvas"), { bars, fmt: (v) => fmt(v, v < 10 ? 1 : 0) }, shown.week);
    const weekOf = (id) => days.reduce((s, back) => s + (useOn(id, back) || 0), 0);
    const otherWeek = bars.reduce((s, b) => s + (b.parts.find((p) => p.colour === OTHER) || { v: 0 }).v, 0);
    q(".en-week .en-legend").innerHTML =
      meters.map(([d, id]) => legendItem(d.label, colour.get(d), kwhText(weekOf(id)))).join("") +
      (otherWeek > 0 ? legendItem("Overig", OTHER, kwhText(otherWeek)) : "");
  }

  function drawCharts() {
    if (!root) return;
    drawPower();
    drawWeek();
  }
  /* Draws the charts growing in (keys: "power", "week"). */
  function reveal(keys) {
    cancelAnimationFrame(frame);
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 600);
      keys.forEach((k) => (shown[k] = 1 - Math.pow(1 - p, 3)));
      drawCharts();
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  function renderAll() {
    if (!root) return;
    renderNow();
    renderMeter();
    renderToday();
    renderPick();
    others.forEach(renderCard);
    drawCharts();
  }

  /* ---- Page ------------------------------------------------------------------------------ */
  function build(page) {
    root = page.querySelector(".dc-page");
    others.forEach((d) => {
      if (!kinds[d.kind]) throw new Error(`no energy kind "${d.kind}"`);
    });
    root.innerHTML =
      `<div class="en-row"><section class="dc-panel en-now"></section><section class="dc-panel en-today"></section></div>` +
      (grid ? `<section class="dc-panel en-meter" hidden></section>` : "") +
      `<div class="en-row charts">` +
      `<section class="dc-panel en-power"><header class="en-head"><h2 class="dc-title">Vermogen</h2><div class="en-pick"></div></header>` +
      `<div class="en-chart"><canvas></canvas></div><footer class="en-power-foot"></footer></section>` +
      `<section class="dc-panel en-week"><h2 class="dc-title">Laatste 7 dagen</h2><div class="en-chart"><canvas></canvas></div><div class="en-legend"></div></section>` +
      `</div>` +
      `<section class="dc-group"><h2 class="dc-title">Per apparaat</h2><div class="dc-grid">` +
      others.map((d) => Panel.cardHtml(`data-energy-card="${devices.indexOf(d)}" style="--dc-icon:${colour.get(d)}"`, kinds[d.kind].icon, d.label)).join("") +
      `</div></section>`;

    /* The meters tick every few seconds: while another section is shown the
     * page is not rebuilt for each, but once when it comes back into view. */
    others.forEach((d) =>
      Panel.track(Object.values(d.entities), Panel.whenShown("energy", () => {
        renderCard(d);
        if (kinds[d.kind].use) renderNow();
        if (Panel.isLoaded()) renderPick(); /* a power reading may have come or gone */
      }))
    );
    let wasLive = false;
    if (grid) {
      Panel.track(Object.values(grid.entities), Panel.whenShown("energy", () => {
        const live = gridLive();
        renderMeter();
        renderNow();
        if (live === wasLive) return;
        wasLive = live;
        renderToday();
        renderPick();
        drawCharts();
        if (live && Panel.isLoaded()) {
          loadStats(); /* the meter just appeared */
          if (!prices) loadPrices();
        }
      }));
    }
    /* The meter's chart line is its net power when Home Assistant derives one,
     * else what it takes; which of the two exists is only known once the states
     * are in, so the history of both is kept. */
    Panel.keepHistory([...devices.map(chartId), ...(grid ? [G.net, G.powerIn] : [])].filter(Boolean));

    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-energy-chart]");
      if (!b) return;
      picked = devices[+b.dataset.energyChart];
      renderPick();
      reveal(["power"]);
      Panel.emit("route");
    });
    new ResizeObserver(drawCharts).observe(root.querySelector(".en-row.charts"));
  }

  Panel.definePage("energy", {
    className: "energy-page",
    html: () => `<div id="energyPage" class="dc-page"></div>`,
    build,
    route: {
      path: () => (picked ? slug(picked.label) : ""),
      go(parts) {
        const d = devices.find((x) => slug(x.label) === parts[0] && chartId(x));
        if (!d) return;
        picked = d;
        if (Panel.isLoaded()) {
          renderPick();
          drawCharts();
        }
      },
    },
  });

  Panel.energy = {
    scaled,
    power,
    kwhText,
    today: (id) => useOn(id, 0),
    missing: (id) => Panel.unavailable(Panel.st(id)),
    offline: (text) => ({ tone: "offline", big: text || "Offline" }),
    /* The card footer of a kWh counter: today and its reading. */
    meterFoot: (id) => [[`Vandaag <b>${kwhText(useOn(id, 0))}</b>`], [`Totaal <b>${kwhText(scaled(id))}</b>`]],
  };

  Panel.on("loaded", () => {
    renderAll();
    loadStats();
    loadPrices();
  });
  Panel.on("history", drawCharts);
  Panel.on("reading", (id) => {
    const d = root && Panel.onScreen("energy") && chartDevice();
    if (d && chartId(d) === id) drawPower();
  });
  Panel.on("section", (i) => {
    if (cfg.sections[i].kind !== "energy") return;
    drawCharts(); /* readings came in while another section was shown */
    reveal(["power", "week"]);
    if (Panel.isLoaded() && Date.now() - statsAt > 60e3) loadStats();
  });
  Panel.everyAwake(5 * 60e3, () => Panel.isLoaded() && loadStats());
})();
