/* 24 h line charts on a canvas: one reading on the left axis (with a soft area
 * fill and optional threshold lines), optionally a second on the right, drawn
 * as steps (a sensor reports on change) and revealed left to right. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const HOLD = 2 * 3600e3; /* a silence longer than this breaks the line */

  /* Readings over [start, now] as polyline segments: a value holds until the
   * next one, but not past HOLD (same carry-forward rule as the panel). */
  function segments(id, start, now) {
    const pts = (Panel.hist[id] || []).filter((p) => p.t <= now);
    const segs = [];
    let cur = null;
    let prev = null;
    for (const p of pts) {
      if (p.t < start) {
        prev = p;
        continue;
      }
      if (prev && !cur) cur = p.t - prev.t <= HOLD ? [{ t: start, v: prev.v }] : [];
      if (!cur) cur = [];
      const last = cur.length ? cur[cur.length - 1] : prev;
      if (last && p.t - last.t > HOLD) {
        if (cur.length) cur.push({ t: last.t + HOLD, v: last.v });
        segs.push(cur);
        cur = [];
      } else if (last) {
        cur.push({ t: p.t, v: last.v }); /* step: hold, then jump */
      }
      cur.push(p);
      prev = p;
    }
    if (!cur && prev && now - prev.t <= HOLD) cur = [{ t: start, v: prev.v }];
    if (cur && cur.length) {
      const last = cur[cur.length - 1];
      cur.push({ t: Math.min(now, last.t + HOLD), v: last.v });
      segs.push(cur);
    }
    return segs;
  }

  /* Axis range rules per quantity: values -> [min, max]. */
  Panel.chartRanges = {
    temp: (v) => {
      if (!v.length) return [15, 30];
      const lo = Math.trunc(Math.min(...v)) - 1;
      const hi = Math.trunc(Math.max(...v)) + 2;
      return [lo, Math.max(hi, lo + 4)];
    },
    hum: (v) =>
      v.length ? [Math.max(0, (Math.trunc(Math.min(...v) / 10) - 1) * 10), Math.min(100, (Math.trunc(Math.max(...v) / 10) + 2) * 10)] : [30, 70],
    co2: (v) => {
      if (!v.length) return [400, 1000];
      const lo = Math.max(300, Math.floor(Math.min(...v) / 100) * 100 - 100);
      const hi = Math.ceil(Math.max(...v) / 100) * 100 + 100;
      return [lo, Math.max(hi, lo + 400)];
    },
    pm: (v) => [0, v.length ? Math.max(20, Math.ceil(Math.max(...v) / 5) * 5 + 5) : 20],
  };

  /* spec: {left: {id, colour, range, fmt}, right: {...} | null, bands: [{v, colour}] on the
   * left axis}. progress 0..1 reveals the lines. Returns the series (with their
   * values) and spanH, the hours shown. */
  Panel.drawChart = function (canvas, spec, progress) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);

    const now = Date.now();
    /* The last 24 h, or less for a sensor that has not been around that long
     * (a newly added device), in whole hours and at least 3. */
    const firstT = Math.min(...[spec.left, spec.right].filter(Boolean).map((s) => ((Panel.hist[s.id] || [])[0] || { t: now }).t));
    const spanH = Math.max(3, Math.min(24, Math.ceil((now - firstT) / 3600e3)));
    const start = now - spanH * 3600e3;
    const series = [spec.left, spec.right].filter(Boolean).map((s) => {
      const segs = segments(s.id, start, now);
      const vals = segs.flat().map((p) => p.v);
      return { ...s, segs, vals, range: s.range(vals) };
    });

    const L = 50, R = 50, T = 4, B = 26;
    const pw = W - L - R, ph = H - T - B;
    const xOf = (t) => L + ((t - start) / (now - start)) * pw;
    const yOf = (s) => (v) => T + ph - ((v - s.range[0]) / (s.range[1] - s.range[0])) * ph;

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
    for (let i = 1; i <= 5; i++) {
      const x = Math.round(L + (pw * i) / 6) + 0.5;
      c.moveTo(x, T + 8);
      c.lineTo(x, T + ph - 8);
    }
    c.stroke();

    /* Threshold lines (e.g. CO2 800/1200 ppm), dashed, in the status colours. */
    const left = series[0];
    (spec.bands || []).forEach((band) => {
      if (band.v <= left.range[0] || band.v >= left.range[1]) return;
      const y = Math.round(yOf(left)(band.v)) + 0.5;
      c.save();
      c.setLineDash([5, 5]);
      c.strokeStyle = band.colour;
      c.globalAlpha = 0.55;
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
    [...series].reverse().forEach((s) => {
      const y = yOf(s);
      for (const seg of s.segs) {
        if (!seg.length) continue;
        if (s === left) {
          const grad = c.createLinearGradient(0, T, 0, T + ph);
          grad.addColorStop(0, s.colour + "38");
          grad.addColorStop(1, s.colour + "00");
          c.beginPath();
          path(seg, y);
          c.lineTo(xOf(seg[seg.length - 1].t), T + ph);
          c.lineTo(xOf(seg[0].t), T + ph);
          c.closePath();
          c.fillStyle = grad;
          c.fill();
        }
        c.beginPath();
        path(seg, y);
        c.strokeStyle = s.colour;
        c.lineWidth = 3;
        c.stroke();
      }
    });
    c.restore();
    return { series, spanH };
  };
})();
