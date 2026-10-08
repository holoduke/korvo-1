/* The drawing kit of the "Terminator vision" look, shared by the boot splash
 * (splash.js) and the Vision screensaver (saver-vision.js): the red palette,
 * six wireframe meshes, a 3D rotation, corner brackets, HUD text, the turning
 * reticle and a glowing wireframe. Plain 2D canvas, no state of its own. */
(function () {
  "use strict";
  const Panel = window.Panel;

  const RED = "255, 42, 34", HOT = "255, 123, 98", PALE = "255, 217, 207", AMBER = "255, 179, 71";
  const rgba = (c, a) => `rgba(${c}, ${a})`;

  /* ---- Meshes (vertices normalised to radius 1, edges as index pairs) ------------ */
  function mesh(verts, edges) {
    const r = Math.max(...verts.map((v) => Math.hypot(v[0], v[1], v[2])));
    return { verts: verts.map((v) => v.map((c) => c / r)), edges };
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  function byLength(verts, len) {
    const edges = [];
    for (let i = 0; i < verts.length; i++) for (let j = i + 1; j < verts.length; j++) if (Math.abs(dist(verts[i], verts[j]) - len) < 0.01) edges.push([i, j]);
    return edges;
  }
  function shortest(vs) {
    let min = Infinity;
    for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) min = Math.min(min, dist(vs[i], vs[j]));
    return min;
  }
  function icosahedron() {
    const p = (1 + Math.sqrt(5)) / 2;
    const v = [];
    for (const a of [-1, 1]) for (const b of [-p, p]) v.push([0, a, b], [a, b, 0], [b, 0, a]);
    return mesh(v, byLength(v, 2));
  }
  function nestedCubes() {
    const v = [];
    for (const s of [1, 0.5]) for (const x of [-s, s]) for (const y of [-s, s]) for (const z of [-s, s]) v.push([x, y, z]);
    const e = byLength(v.slice(0, 8), 2).concat(byLength(v.slice(8), 1).map(([a, b]) => [a + 8, b + 8]));
    for (let i = 0; i < 8; i++) e.push([i, i + 8]);
    return mesh(v, e);
  }
  function torus(nu = 18, nv = 8, R = 1, r = 0.4) {
    const v = [], e = [];
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) {
        const u = (i / nu) * Math.PI * 2, w = (j / nv) * Math.PI * 2;
        v.push([(R + r * Math.cos(w)) * Math.cos(u), (R + r * Math.cos(w)) * Math.sin(u), r * Math.sin(w)]);
        const k = i * nv + j;
        e.push([k, i * nv + ((j + 1) % nv)], [k, ((i + 1) % nu) * nv + j]);
      }
    return mesh(v, e);
  }
  function sphere(lat = 7, lon = 14) {
    const v = [], e = [];
    for (let i = 1; i < lat; i++)
      for (let j = 0; j < lon; j++) {
        const t = (i / lat) * Math.PI, f = (j / lon) * Math.PI * 2;
        v.push([Math.sin(t) * Math.cos(f), Math.cos(t), Math.sin(t) * Math.sin(f)]);
        const k = (i - 1) * lon + j;
        e.push([k, (i - 1) * lon + ((j + 1) % lon)]);
        if (i < lat - 1) e.push([k, i * lon + j]);
      }
    const top = v.push([0, 1, 0]) - 1, bot = v.push([0, -1, 0]) - 1;
    for (let j = 0; j < lon; j++) e.push([top, j], [bot, (lat - 2) * lon + j]);
    return mesh(v, e);
  }
  function octaStar() {
    const v = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const e = byLength(v, Math.SQRT2);
    const n = v.length;
    /* an inner octahedron, turned: a star in the middle */
    v.push(...v.slice(0, 6).map(([x, y, z]) => [0.45 * (x + z), 0.45 * y * 1.4, 0.45 * (z - x)]));
    byLength(v.slice(n), shortest(v.slice(n))).forEach(([a, b]) => e.push([a + n, b + n]));
    return mesh(v, e);
  }
  function helix(steps = 44, turns = 2.2) {
    const v = [], e = [];
    for (let s = 0; s < 2; s++)
      for (let i = 0; i < steps; i++) {
        const t = (i / (steps - 1)) * turns * Math.PI * 2 + s * Math.PI;
        v.push([0.55 * Math.cos(t), -1.15 + (2.3 * i) / (steps - 1), 0.55 * Math.sin(t)]);
        if (i) e.push([s * steps + i - 1, s * steps + i]);
      }
    for (let i = 0; i < steps; i += 4) e.push([i, steps + i]);
    return mesh(v, e);
  }

  function rotate([x, y, z], [a, b, c]) {
    let t;
    t = y * Math.cos(a) - z * Math.sin(a); z = y * Math.sin(a) + z * Math.cos(a); y = t;
    t = x * Math.cos(b) + z * Math.sin(b); z = -x * Math.sin(b) + z * Math.cos(b); x = t;
    t = x * Math.cos(c) - y * Math.sin(c); y = x * Math.sin(c) + y * Math.cos(c); x = t;
    return [x, y, z];
  }

  /* ---- Drawing ------------------------------------------------------------------- */
  function brackets(ctx, x, y, w, h, len, a) {
    ctx.strokeStyle = rgba(HOT, a);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
      ctx.moveTo(cx + dx * len, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * len);
    }
    ctx.stroke();
  }
  function text(ctx, str, x, y, size, color, align = "left") {
    ctx.font = `700 ${size}px "Space Mono", ui-monospace, Menlo, monospace`;
    ctx.textAlign = align;
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }
  function reticle(ctx, x, y, r, t) {
    ctx.save();
    ctx.translate(x, y);
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(RED, 0.13);
    for (const k of [1, 0.72, 0.4]) {
      ctx.beginPath();
      ctx.arc(0, 0, r * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    /* rotating dashed arcs, the outer one against the inner */
    ctx.lineWidth = 3;
    for (const [k, speed, segs] of [[0.86, 0.25, 6], [0.56, -0.4, 4]]) {
      ctx.strokeStyle = rgba(RED, 0.22);
      for (let i = 0; i < segs; i++) {
        const a = t * speed + (i / segs) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(0, 0, r * k, a, a + (Math.PI * 2) / segs / 2.2);
        ctx.stroke();
      }
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(RED, 0.2);
    ctx.beginPath();
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2 + t * 0.05, l = i % 6 ? 6 : 14;
      ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      ctx.lineTo(Math.cos(a) * (r - l), Math.sin(a) * (r - l));
    }
    ctx.moveTo(-r * 1.08, 0); ctx.lineTo(-r * 0.3, 0);
    ctx.moveTo(r * 0.3, 0); ctx.lineTo(r * 1.08, 0);
    ctx.moveTo(0, -r * 1.08); ctx.lineTo(0, -r * 0.3);
    ctx.moveTo(0, r * 0.3); ctx.lineTo(0, r * 1.08);
    ctx.stroke();
    ctx.restore();
  }
  /* A mesh at (ox, oy), radius size, turned by rot: two passes, a wide faint
   * stroke for the glow and a thin one, nearer edges brighter; lit = the near
   * side pale instead of red. */
  function wire(ctx, m, ox, oy, size, rot, lit) {
    const pts = m.verts.map((v) => {
      const [px, py, pz] = rotate(v, rot);
      const s = 3 / (3 + pz);
      return [ox + px * size * s, oy + py * size * s, pz];
    });
    for (const [width, alpha] of [[4, 0.16], [1.2, 0.95]]) {
      ctx.lineWidth = width;
      for (const near of [false, true]) {
        ctx.beginPath();
        for (const [a, b] of m.edges) {
          if ((pts[a][2] + pts[b][2] < 0) !== near) continue;
          ctx.moveTo(pts[a][0], pts[a][1]);
          ctx.lineTo(pts[b][0], pts[b][1]);
        }
        ctx.strokeStyle = rgba(lit && near ? PALE : RED, alpha * (near ? 1 : 0.45));
        ctx.stroke();
      }
    }
  }

  Panel.Vision = {
    RED, HOT, PALE, AMBER, rgba,
    meshes: { icosahedron, nestedCubes, torus, sphere, octaStar, helix },
    rotate, brackets, text, reticle, wire,
  };
})();
