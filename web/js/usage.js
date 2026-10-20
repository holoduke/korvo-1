/* Verbruik: what a device used, as bars per hour, day or month, from Home
 * Assistant's statistics. Opened by tapping a device's card on Energie, its
 * line under "Vandaag", the smart meter's "Verbruik", or the button under a
 * device in Apparaten (data-usage="e<index in cfg.energy>").
 *
 * What a device has to show comes from its kWh (or litre) counters: the smart
 * meter what it took and gave back (per tariff), a washer its electricity and
 * water, the car what it charged at home, a battery what went in and out, and
 * the heat pump the heat it delivered — which is not electricity, and says so.
 * Totals cost what the grid charges now (Home Assistant's energy prices), for
 * electricity a device took. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;
  const { esc, fmt } = Util;
  const E = Panel.energy;
  if (!E) return;

  const DAY_SHORT = ["zo", "ma", "di", "wo", "do", "vr", "za"];
  const MONTH_SHORT = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
  const BLUE = "#4fc3f7";
  const accent = () => Panel.cssVar("--accent");

  /* ---- What each device can show ---------------------------------------------------- */
  /* measures: [{label, unit, paid (electricity taken: costs), earned (given back),
   * note, series: [{id, label, colour}]}], the first shown first. */
  function measuresOf(d) {
    const e = d.entities;
    const own = E.describe(d).colour;
    const s = (id, label, colour) => (id ? { id, label, colour } : null);
    const m = (label, unit, series, extra = {}) => ({ label, unit, series: series.filter(Boolean), ...extra });
    switch (d.kind) {
      case "grid":
        return [
          m("Van het net", "kWh", [s(e.import1, "Dal", BLUE), s(e.import2, "Normaal", accent())], { paid: true }),
          m("Teruggeleverd", "kWh", [s(e.export1, "Dal", "#66bb6a"), s(e.export2, "Normaal", "#2e9d55")], { earned: true }),
        ];
      case "washer":
      case "dryer":
        return [m("Stroom", "kWh", [s(e.energy, "Stroom", own)], { paid: true }), e.water && m("Water", "L", [s(e.water, "Water", BLUE)])].filter(Boolean);
      case "car":
        return [
          m("Thuis geladen", "kWh", [s(e.homeEnergy, "Thuis", own)], { paid: true }),
          m("Geladen, ook onderweg", "kWh", [s(e.energyAdded, "Totaal", own)], {
            note: "Alles wat de auto laadde, ook bij een snellader: alleen “thuis geladen” komt op de meter van het huis.",
          }),
        ];
      case "bike":
        return [m("Verbruikt", "kWh", [s(e.energy, "Verbruikt", own)], { note: "Wat de motor gebruikte tijdens het rijden; thuis opladen kost iets meer (laadverlies)." })];
      case "solar":
        return [
          m("Opgewekt", "kWh", [s(e.total, "Opgewekt", own)], {
            earned: true,
            note: "Wat de panelen maakten. Met salderen is elke kWh de stroomprijs waard, ook wat terug het net op gaat.",
          }),
        ];
      case "battery":
        return [m("Geladen", "kWh", [s(e.charged, "Geladen", "#66bb6a")]), m("Ontladen", "kWh", [s(e.discharged, "Ontladen", own)])];
      case "heatpump":
        return [
          m("Geleverde warmte", "kWh", [s(e.heat, "Verwarming", "#ef8a3c"), s(e.water, "Warm water", BLUE)], {
            note: "Warmte die de pomp in huis bracht, geen stroomverbruik: de pomp heeft geen eigen stroommeter. Stroom is ongeveer een vijfde daarvan.",
          }),
          e.cool && m("Koeling", "kWh", [s(e.cool, "Passief koelen", "#5ab0ff")]),
        ].filter(Boolean);
      default:
        return [];
    }
  }
  const sources = new Map(); /* "e<i>" -> {d, measures} */
  (cfg.energy || []).forEach((d, i) => {
    const measures = measuresOf(d).filter((x) => x.series.length);
    if (measures.length) sources.set(`e${i}`, { d, measures });
  });

  /* An appliance (Apparaten) with the same counter as an energy device. */
  Panel.usageFor = (a) => {
    for (const [key, { d }] of sources) {
      if (a.kind === "heatpump" && d.kind === "heatpump") return key;
      if (a.kind === "solar" && d.kind === "solar") return key;
      if (a.entities.energy && a.entities.energy === d.entities.energy) return key;
    }
    return null;
  };
  Panel.usageLabel = (key) => {
    const src = sources.get(key);
    return src && src.d.kind === "heatpump" ? "Geleverde warmte" : src && src.d.kind === "solar" ? "Opbrengst" : "Verbruik";
  };

  /* ---- Ranges --------------------------------------------------------------------- */
  const startOfHour = (t) => {
    const d = new Date(t);
    d.setMinutes(0, 0, 0);
    return d;
  };
  const startOfDay = (back) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - back);
    return d;
  };
  const startOfMonth = (back) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(1);
    d.setMonth(d.getMonth() - back);
    return d;
  };
  /* buckets: [{t (start, ms), label, strong}], oldest first; days: how many days it spans */
  const RANGES = [
    {
      key: "24h",
      label: "24 uur",
      period: "hour",
      per: "per uur",
      buckets() {
        const now = startOfHour(Date.now()).getTime();
        return Array.from({ length: 24 }, (_, i) => {
          const t = now - (23 - i) * 3600e3;
          return { t, label: String(new Date(t).getHours()), strong: i === 23 };
        });
      },
      labelEvery: 3,
      days: 1,
    },
    {
      key: "7d",
      label: "7 dagen",
      period: "day",
      per: "per dag",
      buckets: () => Array.from({ length: 7 }, (_, i) => {
        const d = startOfDay(6 - i);
        return { t: d.getTime(), label: i === 6 ? "vandaag" : DAY_SHORT[d.getDay()], strong: i === 6 };
      }),
      days: 7,
    },
    {
      key: "30d",
      label: "30 dagen",
      period: "day",
      per: "per dag",
      buckets: () => Array.from({ length: 30 }, (_, i) => {
        const d = startOfDay(29 - i);
        return { t: d.getTime(), label: String(d.getDate()), strong: i === 29 };
      }),
      labelEvery: 5,
      days: 30,
    },
    {
      key: "12m",
      label: "12 maanden",
      period: "month",
      per: "per maand",
      buckets: () => Array.from({ length: 12 }, (_, i) => {
        const d = startOfMonth(11 - i);
        return { t: d.getTime(), label: MONTH_SHORT[d.getMonth()], strong: i === 11 };
      }),
      days: 365,
    },
  ];

  /* ---- The overlay ---------------------------------------------------------------- */
  const box = $("usage");
  let open = null; /* {key, measure, range, data: {id: Map(t -> change)}, busy} */
  let anim = 0;
  let seq = 0; /* the latest request: an older answer arriving late is dropped */

  const unitText = (v, unit) => (Number.isFinite(v) ? `${fmt(v, unit === "L" ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0)} ${unit}` : "–");
  const eur = (v) => (Number.isFinite(v) ? `€ ${fmt(v, 2)}` : "");

  async function load() {
    const { key, measure, range } = open;
    const src = sources.get(key);
    const m = src.measures[measure];
    const r = RANGES[range];
    const mine = ++seq;
    open.busy = true;
    open.data = null;
    render();
    try {
      const buckets = r.buckets();
      const ids = m.series.map((x) => x.id);
      /* The long-term statistics end at the last full hour: the bucket under
       * way (this hour, today) comes from the short-term ones, as Energie's
       * "vandaag" does. */
      const last = buckets[buckets.length - 1].t;
      const [res, running] = await Promise.all([
        Panel.client.usePer(ids, new Date(buckets[0].t), r.period),
        r.period === "hour"
          ? Panel.client.usePer(ids, new Date(last), "5minute").then((x) =>
              Object.fromEntries(ids.map((id) => [id, (x[id] || []).reduce((sum, row) => sum + (row.change || 0), 0)]))
            )
          : r.period === "day"
            ? Panel.client.useToday(ids)
            : null,
      ]);
      if (!open || mine !== seq) return;
      open.data = Object.fromEntries(m.series.map((x) => [x.id, new Map((res[x.id] || []).map((row) => [row.t, row.change]))]));
      if (running) ids.forEach((id) => Number.isFinite(running[id]) && open.data[id].set(last, running[id]));
    } catch (e) {
      if (!open || mine !== seq) return;
      open.data = "error";
    }
    open.busy = false;
    render();
    animate();
  }

  function bars() {
    const src = sources.get(open.key);
    const m = src.measures[open.measure];
    const r = RANGES[open.range];
    return r.buckets().map((b) => ({
      label: b.label,
      strong: b.strong,
      parts: m.series.map((x) => {
        const v = open.data && open.data !== "error" ? open.data[x.id].get(b.t) : null;
        return { v: Number.isFinite(v) ? Math.max(0, v) : 0, colour: x.colour, known: Number.isFinite(v) };
      }),
    }));
  }

  function render() {
    if (!open) return;
    const src = sources.get(open.key);
    const { icon: ic, colour } = E.describe(src.d);
    const m = src.measures[open.measure];
    const r = RANGES[open.range];
    $("usageIcon").innerHTML = icon(ic);
    $("usageIcon").style.color = colour;
    $("usageTitle").textContent = src.d.label;
    $("usageMeasures").hidden = src.measures.length < 2;
    $("usageMeasures").innerHTML = src.measures
      .map((x, i) => `<button class="${i === open.measure ? "active" : ""}" data-usage-measure="${i}" style="--c:${x.series[0].colour}"><i></i>${esc(x.label)}</button>`)
      .join("");
    $("usageRanges").innerHTML = RANGES.map(
      (x, i) => `<button class="${i === open.range ? "active" : ""}" data-usage-range="${i}" style="--c:var(--accent)">${x.label}</button>`
    ).join("");

    const rows = bars();
    const total = rows.reduce((s, b) => s + b.parts.reduce((t, p) => t + p.v, 0), 0);
    const anyKnown = rows.some((b) => b.parts.some((p) => p.known));
    /* per series at its own price where Home Assistant has one (the meter's
     * tariffs, its export price), else at the mean import price */
    const priceOf = (id) => (Number.isFinite(E.priceOf(id)) ? E.priceOf(id) : E.importPrice());
    const money =
      m.unit === "kWh" && (m.paid || m.earned) && anyKnown
        ? m.series.reduce((sum, x, n) => sum + rows.reduce((t, b) => t + b.parts[n].v, 0) * priceOf(x.id), 0)
        : NaN;
    const perDay = r.days > 1 && anyKnown ? total / r.days : NaN;
    const sum = $("usageSum");
    if (open.busy) sum.innerHTML = `<span class="usage-dim">Gegevens ophalen…</span>`;
    else if (open.data === "error") sum.innerHTML = `<span class="usage-dim">Home Assistant gaf geen gegevens.</span>`;
    else if (!anyKnown) sum.innerHTML = `<span class="usage-dim">Nog geen metingen in deze periode.</span>`;
    else
      sum.innerHTML =
        `<span class="usage-total"><b>${unitText(total, m.unit)}</b><small>${esc(m.label.toLowerCase())}, ${r.label}</small></span>` +
        (Number.isFinite(perDay) ? `<span><b>${unitText(perDay, m.unit)}</b><small>gemiddeld per dag</small></span>` : "") +
        (Number.isFinite(money) ? `<span><b>${eur(money)}</b><small>${m.earned ? "opgebracht" : "aan stroom"}, tegen de huidige prijs</small></span>` : "");
    $("usageLegend").innerHTML =
      m.series.length > 1
        ? m.series
            .map((x) => {
              const sub = rows.reduce((s, b) => s + b.parts[m.series.indexOf(x)].v, 0);
              return `<span><i style="background:${x.colour}"></i>${esc(x.label)} <b>${anyKnown ? unitText(sub, m.unit) : ""}</b></span>`;
            })
            .join("")
        : "";
    $("usageNote").textContent = m.note || "";
    $("usageNote").hidden = !m.note;
    $("usageChartTitle").textContent = `${m.unit} ${r.per}`;
  }

  function draw(progress) {
    if (!open) return;
    const m = sources.get(open.key).measures[open.measure];
    const r = RANGES[open.range];
    const many = r.buckets().length > 12;
    Panel.drawBars(
      $("usageChart"),
      { bars: bars(), fmt: (v) => fmt(v, m.unit === "L" ? 0 : v < 10 ? 1 : 0), labelEvery: r.labelEvery, values: !many },
      progress
    );
  }
  function animate() {
    cancelAnimationFrame(anim);
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 520);
      draw(1 - Math.pow(1 - p, 3));
      if (p < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  Panel.openUsage = function (key, measure = 0) {
    if (!sources.has(key)) return;
    const keep = open && open.key === key ? open.range : 1; /* 7 days unless it was already open */
    open = { key, measure, range: keep, data: null, busy: false };
    Panel.openOverlay(box);
    load();
  };
  function close() {
    cancelAnimationFrame(anim);
    open = null;
    Panel.closeOverlay(box);
  }

  Panel.defineAction("usage", (el) => Panel.openUsage(el.dataset.usage));
  $("usageClose").innerHTML = icon("close");
  $("usageClose").addEventListener("click", close);
  box.addEventListener("click", (e) => {
    if (e.target === box) return close();
    const mb = e.target.closest("[data-usage-measure]");
    const rb = e.target.closest("[data-usage-range]");
    if (mb && open && +mb.dataset.usageMeasure !== open.measure) {
      open.measure = +mb.dataset.usageMeasure;
      load();
    }
    if (rb && open && +rb.dataset.usageRange !== open.range) {
      open.range = +rb.dataset.usageRange;
      load();
    }
  });
  Panel.on("escape", () => open && close());
  window.addEventListener("resize", () => open && !open.busy && draw(1));
})();
