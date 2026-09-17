/* Charts on a canvas. drawChart: 24 h line charts, one reading on the left axis
 * (with a soft area fill and optional threshold lines), optionally a second on
 * the right, drawn as steps (a sensor reports on change) and revealed left to
 * right. drawBars: stacked bars per day. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  Panel.cssVar = css;
  const HOLD = 2 * 3600e3; /* a silence longer than this breaks the line */

  /* Readings over [start, now] as polyline segments: a value holds until the
   * next one, but not past `hold` (same carry-forward rule as the panel). */
  function segments(id, start, now, hold) {
    const pts = (Panel.hist[id] || []).filter((p) => p.t <= now);
    const segs = [];
    let cur = null;
    let prev = null;
    for (const p of pts) {
      if (p.t < start) {
        prev = p;
        continue;
      }
      if (prev && !cur) cur = p.t - prev.t <= hold ? [{ t: start, v: prev.v }] : [];
      if (!cur) cur = [];
      const last = cur.length ? cur[cur.length - 1] : prev;
      if (last && p.t - last.t > hold) {
        if (cur.length) cur.push({ t: last.t + hold, v: last.v });
        if (cur.length) segs.push(cur);
        cur = [];
      } else if (last) {
        cur.push({ t: p.t, v: last.v }); /* step: hold, then jump */
      }
      cur.push(p);
      prev = p;
    }
    if (!cur && prev && now - prev.t <= hold) cur = [{ t: start, v: prev.v }];
    if (cur && cur.length) {
      const last = cur[cur.length - 1];
      cur.push({ t: Math.min(now, last.t + hold), v: last.v });
      segs.push(cur);
    }
    return segs;
  }

  /* The smallest 1, 2, 2.5 or 5 x 10^n at or above v: a round axis maximum. */
  Panel.niceCeil = function (v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    return [1, 2, 2.5, 5, 10].map((m) => m * p).find((n) => n >= v * (1 - 1e-9));
  };

  /* Axis range rules per quantity: values -> [min, max]. */
  Panel.chartRanges = {
    temp: (v) => {
      if (!v.length) return [15, 30];
      const [min, max] = Util.minMax(v);
      const lo = Math.trunc(min) - 1;
      const hi = Math.trunc(max) + 2;
      return [lo, Math.max(hi, lo + 4)];
    },
    hum: (v) =>
      v.length ? [Math.max(0, (Math.trunc(Util.minMax(v)[0] / 10) - 1) * 10), Math.min(100, (Math.trunc(Util.minMax(v)[1] / 10) + 2) * 10)] : [30, 70],
    co2: (v) => {
      if (!v.length) return [400, 1000];
      const [min, max] = Util.minMax(v);
      const lo = Math.max(300, Math.floor(min / 100) * 100 - 100);
      const hi = Math.ceil(max / 100) * 100 + 100;
      return [lo, Math.max(hi, lo + 400)];
    },
    pm: (v) => [0, v.length ? Math.max(20, Math.ceil(Util.minMax(v)[1] / 5) * 5 + 5) : 20],
  };

  /* A crisp canvas at the device's pixel ratio: {c, W, H} in CSS pixels. */
  function surface(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    return { c, W, H };
  }

  /* The plot area's rounded background with 3 horizontal grid lines, and
   * `columns` - 1 vertical ones. */
  function plotArea(c, L, T, pw, ph, columns) {
    c.fillStyle = css("--tile_off");
    c.beginPath();
    c.roundRect(L, T, pw, ph, 12);
    c.fill();
    c.strokeStyle = css("--grid");
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 1; i <= 3; i++) {
      const y = Math.round(T + (ph * i) / 4) + 0.5;
      c.moveTo(L + 8, y);
      c.lineTo(L + pw - 8, y);
    }
    for (let i = 1; i < columns; i++) {
      const x = Math.round(L + (pw * i) / columns) + 0.5;
      c.moveTo(x, T + 8);
      c.lineTo(x, T + ph - 8);
    }
    c.stroke();
  }

  /* spec: {left: series, right: series | null, thresholds: [{v, colour}] on the left axis}
   * where a series is {id, colour, range, fmt, bands, dashed, hold}: colour names
   * the series (axis labels, and the line when it has no bands); bands (see
   * readings.js) colour the line by how good its value is; dashed tells the
   * second line apart; hold (ms) is how long a value carries on without a new
   * reading (default 2 h; longer for a reading that only reports changes, like
   * power). progress 0..1 reveals the lines. Returns the series (with their
   * values) and spanH, the hours shown. */
  Panel.drawChart = function (canvas, spec, progress) {
    const { c, W, H } = surface(canvas);

    const now = Date.now();
    /* The last 24 h, or less for a sensor that has not been around that long
     * (a newly added device), in whole hours and at least 3. */
    const firstT = Math.min(...[spec.left, spec.right].filter(Boolean).map((s) => ((Panel.hist[s.id] || [])[0] || { t: now }).t));
    const spanH = Math.max(3, Math.min(24, Math.ceil((now - firstT) / 3600e3)));
    const start = now - spanH * 3600e3;
    const series = [spec.left, spec.right].filter(Boolean).map((s) => {
      const segs = segments(s.id, start, now, s.hold || HOLD);
      const vals = segs.flat().map((p) => p.v);
      return { ...s, segs, vals, range: s.range(vals) };
    });

    const L = 50, R = 50, T = 4, B = 26;
    const pw = W - L - R, ph = H - T - B;
    const xOf = (t) => L + ((t - start) / (now - start)) * pw;
    const yOf = (s) => (v) => T + ph - ((v - s.range[0]) / (s.range[1] - s.range[0])) * ph;
    plotArea(c, L, T, pw, ph, 6);

    /* Threshold lines (e.g. CO2 800/1200 ppm), faint, in the status colours. */
    const left = series[0];
    (spec.thresholds || []).forEach((band) => {
      if (band.v <= left.range[0] || band.v >= left.range[1]) return;
      const y = Math.round(yOf(left)(band.v)) + 0.5;
      c.save();
      c.strokeStyle = band.colour;
      c.globalAlpha = 0.3;
      c.beginPath();
      c.moveTo(L + 8, y);
      c.lineTo(L + pw - 8, y);
      c.stroke();
      c.restore();
    });

    c.font = "600 14px Montserrat, system-ui, sans-serif";
    series.forEach((s, k) => {
      c.textAlign = k === 0 ? "right" : "left";
      c.fillStyle = s.colour;
      const x = k === 0 ? L - 6 : L + pw + 6;
      c.textBaseline = "top";
      c.fillText(s.fmt(s.range[1]), x, T + 2);
      c.textBaseline = "bottom";
      c.fillText(s.fmt(s.range[0]), x, T + ph - 2);
    });

    /* Time axis: whole hours back from the last full hour (every 6 h on a full
     * day, closer together on a shorter window), at their true position. */
    c.textAlign = "center";
    c.textBaseline = "top";
    c.fillStyle = css("--text_dim");
    const stepH = spanH <= 4 ? 1 : spanH <= 8 ? 2 : spanH <= 12 ? 3 : 6;
    const mark = new Date(now);
    mark.setMinutes(0, 0, 0);
    for (let m = mark.getTime(); m >= start; m -= stepH * 3600e3) {
      if (xOf(m) < L + 18) break; /* would collide with the axis labels */
      c.fillText(String(new Date(m).getHours()).padStart(2, "0") + ":00", xOf(m), T + ph + 6);
    }

    /* Lines, revealed left to right; the left series is drawn last (on top). */
    c.save();
    c.beginPath();
    c.rect(L, 0, pw * progress, H);
    c.clip();
    c.lineJoin = "round";
    c.lineCap = "round";
    const path = (seg, y) => seg.forEach((p, i) => (i ? c.lineTo(xOf(p.t), y(p.v)) : c.moveTo(xOf(p.t), y(p.v))));
    /* A vertical gradient with hard edges at the band limits, so the line turns
     * orange or red exactly where its value does. alpha: a hex suffix. */
    const paint = (s, alpha) => {
      if (!s.bands) return s.colour + alpha;
      const [lo, hi] = s.range;
      const at = (v) => Util.clamp((v - lo) / (hi - lo), 0, 1);
      const grad = c.createLinearGradient(0, T + ph, 0, T);
      let from = -Infinity;
      for (const [limit, tone] of s.bands) {
        const colour = css(`--${tone}`) + alpha;
        grad.addColorStop(at(from), colour);
        grad.addColorStop(at(limit), colour);
        from = limit;
      }
      return grad;
    };
    [...series].reverse().forEach((s) => {
      const y = yOf(s);
      /* The area fills down to zero when the range spans it (power can go negative). */
      const base = Math.min(T + ph, Math.max(T, y(Math.max(s.range[0], Math.min(0, s.range[1])))));
      for (const seg of s.segs) {
        if (!seg.length) continue;
        if (s === left) {
          c.beginPath();
          path(seg, y);
          c.lineTo(xOf(seg[seg.length - 1].t), s.range[0] < 0 ? base : T + ph);
          c.lineTo(xOf(seg[0].t), s.range[0] < 0 ? base : T + ph);
          c.closePath();
          c.fillStyle = paint(s, "26");
          c.fill();
        }
        c.beginPath();
        path(seg, y);
        c.setLineDash(s.dashed ? [9, 7] : []);
        c.strokeStyle = paint(s, "");
        c.lineWidth = s.dashed ? 2.5 : 3;
        c.stroke();
      }
    });
    c.setLineDash([]);
    c.restore();
    return { series, spanH };
  };

  /* spec: {bars: [{label, parts: [{v, colour}], strong}], fmt} - one stacked bar
   * per slot, bottom to top in part order, its total above it and its label
   * below (in the accent colour when strong, e.g. today). progress 0..1 grows
   * the bars. */
  Panel.drawBars = function (canvas, spec, progress) {
    const { c, W, H } = surface(canvas);
    const L = 8, R = 8, T = 24, B = 26;
    const pw = W - L - R, ph = H - T - B;
    const totals = spec.bars.map((b) => b.parts.reduce((s, p) => s + Math.max(0, p.v), 0));
    const max = Panel.niceCeil(Math.max(...totals, 0));
    plotArea(c, L, T, pw, ph, 1);

    const slot = pw / spec.bars.length;
    const bw = Math.min(44, slot * 0.58);
    c.font = "600 13px Montserrat, system-ui, sans-serif";
    c.textAlign = "center";
    spec.bars.forEach((b, i) => {
      const x = L + slot * i + (slot - bw) / 2;
      const shown = b.parts.filter((p) => p.v > 0);
      let y = T + ph;
      shown.forEach((p, k) => {
        const h = (p.v / max) * ph * progress;
        c.fillStyle = p.colour;
        c.beginPath();
        c.roundRect(x, y - h, bw, h, k === shown.length - 1 ? [6, 6, 0, 0] : 0);
        c.fill();
        y -= h;
      });
      c.textBaseline = "bottom";
      c.fillStyle = css("--text");
      c.globalAlpha = progress;
      if (totals[i] > 0) c.fillText(spec.fmt(totals[i]), x + bw / 2, y - 4);
      c.globalAlpha = 1;
      c.textBaseline = "top";
      c.fillStyle = b.strong ? css("--accent") : css("--text_dim");
      c.fillText(b.label, x + bw / 2, T + ph + 7);
    });
  };
})();
