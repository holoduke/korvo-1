/* Energie section: what the house uses now, today and over the last week, a
 * 24 h power chart and a card per device. The smart meter (P1) has its own
 * card; until it exists in Home Assistant that card says what it will show,
 * and the devices with a meter add up to the totals. Once it is there it leads
 * "nu", "vandaag" and the week, with what the devices don't explain as
 * "Overig". Live power comes from the states, daily use from Home Assistant's
 * statistics, the chart from its history.
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
    devices.flatMap((d) => (d === grid ? ["import", "export"] : kinds[d.kind].stats).map((k) => d.entities[k])).filter(exists);

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

  /* ---- Rendering ---------------------------------------------------------------------- */
  let root = null;
  const q = (sel) => root.querySelector(sel);
  const gridLive = () => !!grid && exists(grid.entities.power);
  const legendItem = (label, c, value, idle) => `<span class="${idle ? "idle" : ""}"><i style="background:${c}"></i>${esc(label)} <b>${value}</b></span>`;

  function renderNow() {
    const rows = users().filter((d) => kinds[d.kind].chart).map((d) => ({ d, w: kinds[d.kind].power(d.entities) }));
    const measured = rows.reduce((s, r) => s + (r.w > 0 ? r.w : 0), 0);
    const gw = gridLive() ? scaled(grid.entities.power) : NaN;
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

  function renderGrid() {
    if (!grid) return;
    const box = q(".en-grid");
    const e = grid.entities;
    const live = gridLive();
    box.classList.toggle("missing", !live);
    const title = `<h2 class="dc-title">${esc(grid.label)}</h2>`;
    if (!live) {
      box.innerHTML =
        title +
        `<div class="en-empty"><span class="en-empty-icon">${icon("plug")}</span><div><b>Nog niet gekoppeld</b>` +
        `<p>Zodra de P1-meter in Home Assistant staat, verschijnen hier stroom van en naar het net, per fase en per dag.</p></div></div>`;
      return;
    }
    const gw = scaled(e.power);
    const phases = [1, 2, 3].filter((p) => exists(e[`power${p}`]));
    const top = Math.max(1000, ...phases.map((p) => Math.abs(scaled(e[`power${p}`])) || 0));
    const phase = (p) => {
      const w = scaled(e[`power${p}`]);
      const volts = Panel.num(e[`voltage${p}`]);
      const amps = Panel.num(e[`current${p}`]);
      const detail = [Number.isFinite(volts) && `${fmt(volts)} V`, Number.isFinite(amps) && `${fmt(amps, 1)} A`].filter(Boolean).join(" · ");
      return (
        `<div class="en-phase"><b>L${p}</b><span class="en-bar"><i style="width:${(Math.abs(w) / top) * 100 || 0}%"></i></span>` +
        `<span>${power(w).join(" ")}${detail ? `<small>${detail}</small>` : ""}</span></div>`
      );
    };
    box.innerHTML =
      title +
      `<div class="en-flow ${gw < 0 ? "export" : "import"}">${icon(gw < 0 ? "arrow-up" : "arrow-down")}<b>${power(Math.abs(gw)).join(" ")}</b>` +
      `<span>${gw < 0 ? "terug aan het net" : "van het net"}</span></div>` +
      (phases.length ? `<div class="en-phases">${phases.map(phase).join("")}</div>` : "") +
      `<div class="en-meter"><span>Vandaag van net <b>${kwhText(useOn(e.import, 0))}</b></span><span>terug <b>${kwhText(useOn(e.export, 0))}</b></span></div>` +
      `<div class="en-meter"><span>Meterstand <b>${kwhText(scaled(e.import))}</b></span><span>terug <b>${kwhText(scaled(e.export))}</b></span></div>`;
  }

  function renderToday() {
    const rows = users().filter((d) => kinds[d.kind].meter).map((d) => [d, useOn(d.entities[kinds[d.kind].meter], 0)]);
    const known = rows.filter(([, v]) => Number.isFinite(v));
    const sum = known.reduce((s, [, v]) => s + v, 0);
    const fromGrid = gridLive() ? useOn(grid.entities.import, 0) : NaN;
    const big = Number.isFinite(fromGrid) ? fromGrid : known.length ? sum : NaN;
    q(".en-today").innerHTML =
      `<h2 class="dc-title">Vandaag</h2>` +
      `<div class="en-big"><b>${kwhNum(big)}</b><span>kWh</span></div>` +
      `<div class="en-sub">${Number.isFinite(fromGrid) ? `van het net, ${kwhText(sum)} gemeten per apparaat` : "Samen, van de apparaten met een meter"}</div>` +
      `<ul class="en-list">${rows.map(([d, v]) => `<li><i style="background:${colour.get(d)}"></i><span>${esc(d.label)}</span><b>${kwhText(v)}</b></li>`).join("")}</ul>`;
  }

  function renderCard(d) {
    Panel.fillCard(q(`[data-energy-card="${devices.indexOf(d)}"]`), kinds[d.kind].card(d.entities), false);
  }

  /* ---- Charts --------------------------------------------------------------------------- */
  const chartId = (d) => (d === grid ? d.entities.power : kinds[d.kind].chart ? d.entities[kinds[d.kind].chart] : null);
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
      ? `<span>Nu <b>${power(scaled(id)).join(" ")}</b></span><span>Piek <b>${power(Math.max(...vals) * (SCALE[unit] ?? 1)).join(" ")}</b></span>`
      : "Nog geen geschiedenis (wordt opgehaald)";
  }

  function drawWeek() {
    const meters = users().filter((d) => kinds[d.kind].meter).map((d) => [d, d.entities[kinds[d.kind].meter]]);
    const days = [6, 5, 4, 3, 2, 1, 0];
    const rest = (back, parts) => (gridLive() ? Math.max(0, useOn(grid.entities.import, back) - parts.reduce((s, p) => s + p.v, 0)) || 0 : 0);
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
    renderGrid();
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
      `<div class="en-row${grid ? "" : " no-grid"}"><section class="dc-panel en-now"></section>` +
      (grid ? `<section class="dc-panel en-grid"></section>` : "") +
      `<section class="dc-panel en-today"></section></div>` +
      `<div class="en-row charts">` +
      `<section class="dc-panel en-power"><header class="en-head"><h2 class="dc-title">Vermogen</h2><div class="en-pick"></div></header>` +
      `<div class="en-chart"><canvas></canvas></div><footer class="en-power-foot"></footer></section>` +
      `<section class="dc-panel en-week"><h2 class="dc-title">Laatste 7 dagen</h2><div class="en-chart"><canvas></canvas></div><div class="en-legend"></div></section>` +
      `</div>` +
      `<section class="dc-group"><h2 class="dc-title">Per apparaat</h2><div class="dc-grid">` +
      others.map((d) => Panel.cardHtml(`data-energy-card="${devices.indexOf(d)}" style="--dc-icon:${colour.get(d)}"`, kinds[d.kind].icon, d.label)).join("") +
      `</div></section>`;

    others.forEach((d) =>
      Panel.track(Object.values(d.entities), () => {
        renderCard(d);
        if (kinds[d.kind].use) renderNow();
        if (Panel.isLoaded()) renderPick(); /* a power reading may have come or gone */
      })
    );
    let wasLive = false;
    if (grid) {
      Panel.track(Object.values(grid.entities), () => {
        const live = gridLive();
        renderGrid();
        renderNow();
        if (live === wasLive) return;
        wasLive = live;
        renderToday();
        renderPick();
        drawCharts();
        if (live && Panel.isLoaded()) loadStats(); /* the meter just appeared */
      });
    }
    Panel.keepHistory(devices.map(chartId).filter(Boolean));

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
  });
  Panel.on("history", drawCharts);
  Panel.on("reading", (id) => {
    const d = root && chartDevice();
    if (d && chartId(d) === id) drawPower();
  });
  Panel.on("section", (i) => {
    if (cfg.sections[i].kind !== "energy") return;
    reveal(["power", "week"]);
    if (Panel.isLoaded() && Date.now() - statsAt > 60e3) loadStats();
  });
  setInterval(() => Panel.isLoaded() && loadStats(), 5 * 60e3);
})();
