/* The house on the Start page: a glowing wireframe, drawn with WebGL and our
 * own shaders from the plan in js/house-plan.js.
 *
 * Every edge is a quad the vertex shader widens on screen (a line the GPU can
 * anti-alias, with round ends), lit by how near it is and by a band of light
 * that sweeps up through the house. The lines render to a texture, a copy of
 * that is blurred in two passes at half size (the bloom), and the last pass
 * lays both over the page's own colour. Translucent floor and roof planes give
 * the wireframe its body.
 *
 * The camera orbits the house on its own and follows two fingers: pinch to
 * zoom, turn or drag sideways to rotate, drag up or down to tilt (one finger
 * still swipes between the sections). With a mouse: drag and wheel.
 *
 *   Panel.house3d(canvas, plan, {onInteract}) -> {setActive(on), camera(), setCamera(), frames}
 */
(function () {
  "use strict";
  const Panel = window.Panel;

  const AUTO_SPEED = 0.16; /* rad/s of the orbit at rest */
  const IDLE_MS = 4000; /* after a touch, before the orbit resumes */
  const FOV = (36 * Math.PI) / 180;
  const PITCH_MIN = (4 * Math.PI) / 180;
  const PITCH_MAX = (72 * Math.PI) / 180;
  const ZOOM_MIN = 0.5; /* share of the fitted distance; keeps the ground grid in front of the camera */
  /* Turning on its own (no finger for IDLE_MS, or as the screensaver) the house
   * draws at half the frame rate and at 1x resolution: the bloom hides the
   * difference, and a wall tablet runs it all day. */
  const IDLE_FRAME_MS = 32;
  const ZOOM_MAX = 2.2;
  const MAX_DPR = 2;
  const LINE_PX = 1.5; /* core width of an edge, css px */
  const BLOOM = 1.15;
  const SWEEP_PERIOD_S = 14;
  /* How bright each kind of edge is. */
  const L = { wall: 1.0, inner: 0.7, rafter: 0.7, room: 0.48, opening: 0.42, grid: 0.26 };

  const LINE_VS = `
    attribute vec3 aA; attribute vec3 aB; attribute vec2 aP; attribute float aL;
    uniform mat4 uVP; uniform vec2 uRes; uniform float uWidth;
    varying float vAcross; varying float vAlong; varying float vLen; varying float vL; varying float vDepth; varying vec3 vWorld;
    void main() {
      vec4 ca = uVP * vec4(aA, 1.0);
      vec4 cb = uVP * vec4(aB, 1.0);
      vec2 sa = ca.xy / ca.w * uRes * 0.5;
      vec2 sb = cb.xy / cb.w * uRes * 0.5;
      vec2 dir = sb - sa;
      float len = length(dir);
      dir = len > 0.0001 ? dir / len : vec2(1.0, 0.0);
      vec2 nrm = vec2(-dir.y, dir.x);
      float hw = uWidth * 0.5 + 1.5;
      vec4 c = mix(ca, cb, aP.y);
      vec2 s = mix(sa, sb, aP.y);
      float ext = (aP.y * 2.0 - 1.0) * hw;
      vec2 p = s + nrm * aP.x * hw + dir * ext;
      gl_Position = vec4(p / (uRes * 0.5) * c.w, c.z, c.w);
      vAcross = aP.x * hw;
      vAlong = aP.y * len + ext;
      vLen = len;
      vL = aL;
      vDepth = c.w;
      vWorld = mix(aA, aB, aP.y);
    }`;
  const LINE_FS = `
    precision highp float;
    uniform float uWidth; uniform vec3 uColor; uniform float uSweepY; uniform float uNear; uniform float uFar; uniform float uRadial; uniform vec2 uMid;
    varying float vAcross; varying float vAlong; varying float vLen; varying float vL; varying float vDepth; varying vec3 vWorld;
    void main() {
      float dx = max(max(-vAlong, vAlong - vLen), 0.0);
      float d = length(vec2(dx, vAcross));
      float a = 1.0 - smoothstep(uWidth * 0.5 - 0.7, uWidth * 0.5 + 0.7, d);
      float depth = mix(0.32, 1.0, smoothstep(uFar, uNear, vDepth));
      float radial = mix(1.0, 1.0 - smoothstep(8.0, 17.0, length(vWorld.xz - uMid)), uRadial);
      float sweep = exp(-pow((vWorld.y - uSweepY) * 1.7, 2.0));
      float i = vL * depth * radial;
      vec3 col = uColor * i * (1.0 + 1.6 * sweep) + vec3(0.35) * sweep * i;
      gl_FragColor = vec4(col * a, a * i);
    }`;
  const FACE_VS = `
    attribute vec3 aPos; attribute vec4 aCol; uniform mat4 uVP; varying vec4 vCol;
    void main() { gl_Position = uVP * vec4(aPos, 1.0); vCol = aCol; }`;
  const FACE_FS = `
    precision mediump float; uniform vec4 uTint; varying vec4 vCol;
    void main() { vec4 c = vCol * uTint; gl_FragColor = vec4(c.rgb * c.a, c.a); }`;
  const QUAD_VS = `
    attribute vec2 aPos; varying vec2 vUv;
    void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const BLUR_FS = `
    precision highp float; uniform sampler2D uTex; uniform vec2 uDir; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(uTex, vUv) * 0.227027;
      c += (texture2D(uTex, vUv + uDir) + texture2D(uTex, vUv - uDir)) * 0.1945946;
      c += (texture2D(uTex, vUv + uDir * 2.0) + texture2D(uTex, vUv - uDir * 2.0)) * 0.1216216;
      c += (texture2D(uTex, vUv + uDir * 3.0) + texture2D(uTex, vUv - uDir * 3.0)) * 0.054054;
      c += (texture2D(uTex, vUv + uDir * 4.0) + texture2D(uTex, vUv - uDir * 4.0)) * 0.016216;
      gl_FragColor = c;
    }`;
  const COMPOSITE_FS = `
    precision highp float;
    uniform sampler2D uScene; uniform sampler2D uBloom; uniform vec3 uBg; uniform vec3 uColor; uniform float uBloomK; uniform float uAspect;
    varying vec2 vUv;
    void main() {
      vec4 s = texture2D(uScene, vUv);
      vec4 b = texture2D(uBloom, vUv);
      vec2 p = (vUv - vec2(0.5, 0.42)) * vec2(uAspect, 1.0);
      vec3 bg = uBg + uColor * 0.06 * (1.0 - smoothstep(0.0, 0.75, length(p)));
      vec3 light = s.rgb + b.rgb * uBloomK;
      light = 1.0 - exp(-light * 1.25);
      gl_FragColor = vec4(bg + light, 1.0);
    }`;

  /* ---- Small matrix helpers (column major, as WebGL takes them) ---------------- */
  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function lookAt(eye, at, up) {
    const z = norm([eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]]);
    const x = norm(cross(up, z));
    const y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  }
  function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  }
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };

  /* ---- The plan as edges and faces ------------------------------------------------ */
  /* Edges, one per pair of points; an edge drawn twice (a room's wall that is
   * also the outer wall) is kept once, at its brightest. */
  function collect() {
    const segs = new Map();
    const key = (p) => p.map((v) => Math.round(v * 100)).join(",");
    return {
      add(a, b, level) {
        const k = [key(a), key(b)].sort().join("|");
        const had = segs.get(k);
        if (!had || had.level < level) segs.set(k, { a, b, level });
      },
      rect(corners, level) {
        for (let i = 0; i < corners.length; i++) this.add(corners[i], corners[(i + 1) % corners.length], level);
      },
      box(x0, y0, z0, x1, y1, z1, level) {
        const c = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]];
        const t = c.map(([x, , z]) => [x, y1, z]);
        this.rect(c, level);
        this.rect(t, level);
        c.forEach((p, i) => this.add(p, t[i], level));
      },
      /* Takes the span [a0, a1] out of every floor edge (y = 0) that runs along
       * the wall plane ("z": at = z, "x": at = x): an open passage. */
      cutFloor(plane, at, a0, a1) {
        const near = (p, q) => Math.abs(p - q) < 0.01;
        const along = plane === "z" ? 0 : 2;
        const across = plane === "z" ? 2 : 0;
        for (const [k, seg] of [...segs]) {
          const { a, b, level } = seg;
          if (!(near(a[1], 0) && near(b[1], 0) && near(a[across], at) && near(b[across], at))) continue;
          const [lo, hi] = [Math.min(a[along], b[along]), Math.max(a[along], b[along])];
          if (hi <= a0 + 0.01 || lo >= a1 - 0.01) continue;
          segs.delete(k);
          const point = (v) => (plane === "z" ? [v, 0, at] : [at, 0, v]);
          if (a0 - lo > 0.01) this.add(point(lo), point(a0), level);
          if (hi - a1 > 0.01) this.add(point(a1), point(hi), level);
        }
      },
      /* Drops the edges pred is true for; moves the others through fn. */
      prune(pred) {
        for (const [k, seg] of segs) if (pred(seg)) segs.delete(k);
      },
      adjust(fn) {
        for (const [k, seg] of segs) segs.set(k, fn(seg));
      },
      list: () => [...segs.values()],
    };
  }

  function buildGeometry(plan) {
    const e = collect();
    const faces = [];
    const quad = (a, b, c, dd, col) => faces.push([a, b, c, col], [a, c, dd, col]);
    const floorCol = [0.35, 0.8, 1.0, 0.05];
    const roofCol = [0.35, 0.8, 1.0, 0.07];
    const m = plan.main;
    const [x0, z0, x1, z1] = [m.x, m.z, m.x + m.w, m.z + m.d];
    const roof = plan.roof;
    const zm = (z0 + z1) / 2;
    const slope = (roof.ridgeY - roof.eavesY) / (m.d / 2);
    const roofY = (z) => roof.ridgeY - Math.abs(z - zm) * slope;
    const ring = (ax, az, bx, bz, y) => [[ax, y, az], [bx, y, az], [bx, y, bz], [ax, y, bz]];

    /* The main block: its floors as rings (and translucent slabs), the corners
     * up to the eaves, the gable ends up to the ridge. */
    plan.levels.forEach((lv) => {
      e.rect(ring(x0, z0, x1, z1, lv.y), L.wall);
      quad(...ring(x0, z0, x1, z1, lv.y), floorCol);
    });
    [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].forEach(([x, z]) => e.add([x, 0, z], [x, roof.eavesY, z], L.wall));
    [x0, x1].forEach((x) => {
      e.add([x, roof.eavesY, z0], [x, roof.ridgeY, zm], L.wall);
      e.add([x, roof.eavesY, z1], [x, roof.ridgeY, zm], L.wall);
    });
    /* The roof with its overhang: ridge, eaves and the outer rafters. */
    const ov = roof.overhang;
    const ey = roof.eavesY - ov * slope;
    e.add([x0 - ov, roof.ridgeY, zm], [x1 + ov, roof.ridgeY, zm], L.wall);
    e.add([x0 - ov, ey, z0 - ov], [x1 + ov, ey, z0 - ov], L.wall);
    e.add([x0 - ov, ey, z1 + ov], [x1 + ov, ey, z1 + ov], L.wall);
    [x0 - ov, x1 + ov].forEach((x) => {
      e.add([x, ey, z0 - ov], [x, roof.ridgeY, zm], L.rafter);
      e.add([x, ey, z1 + ov], [x, roof.ridgeY, zm], L.rafter);
    });
    quad([x0 - ov, ey, z0 - ov], [x1 + ov, ey, z0 - ov], [x1 + ov, roof.ridgeY, zm], [x0 - ov, roof.ridgeY, zm], roofCol);
    quad([x0 - ov, ey, z1 + ov], [x1 + ov, ey, z1 + ov], [x1 + ov, roof.ridgeY, zm], [x0 - ov, roof.ridgeY, zm], roofCol);
    /* Dormers: a flat top from the face back to where it meets the slope, the
     * face down to the roof, side walls along the slope, a window in the face. */
    (plan.dormers || []).forEach((d) => {
      const front = d.side === "front";
      const fz = front ? z0 + d.setback : z1 - d.setback;
      const fy = roofY(fz);
      const bz = zm + (front ? -1 : 1) * ((roof.ridgeY - d.topY) / slope);
      const [dx0, dx1] = [d.x, d.x + d.w];
      e.rect([[dx0, d.topY, bz], [dx1, d.topY, bz], [dx1, d.topY, fz], [dx0, d.topY, fz]], L.wall);
      e.rect([[dx0, fy, fz], [dx1, fy, fz], [dx1, d.topY, fz], [dx0, d.topY, fz]], L.wall);
      [dx0, dx1].forEach((x) => e.add([x, fy, fz], [x, d.topY, bz], L.wall));
      e.rect([[dx0 + 0.4, fy + 0.3, fz], [dx1 - 0.4, fy + 0.3, fz], [dx1 - 0.4, d.topY - 0.3, fz], [dx0 + 0.4, d.topY - 0.3, fz]], L.opening);
    });
    /* Single-storey blocks with flat roofs. */
    (plan.flat || []).forEach((b) => {
      e.box(b.x, 0, b.z, b.x + b.w, b.h, b.z + b.d, L.wall);
      quad(...ring(b.x, b.z, b.x + b.w, b.z + b.d, b.h), floorCol);
    });
    /* A block joined to the main block's back (or front) wall is one space
     * with the room there: no floor line or side lines where the two meet
     * (the line where the block's roof meets the wall stays), and the main
     * block's corners there start above that roof. */
    const near = (a, b) => Math.abs(a - b) < 0.01;
    (plan.flat || []).filter((b) => b.joined).forEach((b) => {
      const seam = b.joined === "front" ? z0 : z1; /* the main wall the block sits against */
      const onSeam = (p) => near(p[2], seam) && p[0] >= b.x - 0.01 && p[0] <= b.x + b.w + 0.01 && p[1] <= b.h + 0.01;
      e.prune((seg) => onSeam(seg.a) && onSeam(seg.b) && !(near(seg.a[1], b.h) && near(seg.b[1], b.h)));
      e.adjust((seg) => {
        const vertical = near(seg.a[0], seg.b[0]) && near(seg.a[2], seg.b[2]) && near(seg.a[2], seam);
        if (!vertical || !(seg.a[0] >= b.x - 0.01 && seg.a[0] <= b.x + b.w + 0.01)) return seg;
        const lift = (p) => (p[1] < b.h ? [p[0], b.h, p[2]] : p);
        return { ...seg, a: lift(seg.a), b: lift(seg.b) };
      });
    });
    /* Rooms, as their outline on their floor. */
    Object.entries(plan.rooms).forEach(([floor, rooms]) => {
      const lv = plan.levels.find((l) => l.floor === floor);
      if (!lv) return;
      rooms.filter((r) => r.outline !== false).forEach((r) => e.rect(ring(r.x, r.z, r.x + r.w, r.z + r.d, lv.y), L.room));
    });
    /* Inner walls: their outline in their vertical plane. */
    (plan.walls || []).forEach((wl) => {
      const p = (a, y) => (wl.plane === "z" ? [a, y, wl.at] : [wl.at, y, a]);
      const y0 = wl.y || 0; /* the floor it stands on (0 = the ground floor) */
      e.rect([p(wl.a, y0), p(wl.a + wl.w, y0), p(wl.a + wl.w, y0 + wl.h), p(wl.a, y0 + wl.h)], L.inner);
    });
    /* Windows and doors on the walls; a keyed one can be lit up later. */
    const openings = {};
    plan.openings.forEach((o) => {
      const p = (a, y) => (o.plane === "z" ? [a, y, o.at] : [o.at, y, a]);
      const corners = [p(o.a, o.y), p(o.a + o.w, o.y), p(o.a + o.w, o.y + o.h), p(o.a, o.y + o.h)];
      if (o.floor === false) {
        /* An open passage: its sides and top, nothing on the floor. */
        e.add(corners[1], corners[2], L.opening);
        e.add(corners[2], corners[3], L.opening);
        e.add(corners[3], corners[0], L.opening);
        e.cutFloor(o.plane, o.at, o.a, o.a + o.w);
      } else e.rect(corners, L.opening);
      if (o.key) openings[o.key] = corners;
    });
    const house = e.list();

    /* The ground: a metre grid, fading away from the house (see uRadial). */
    const grid = [];
    const R = 14; /* within the nearest the camera can come (ZOOM_MIN), so no line passes it */
    const gx = (x0 + Math.max(x1, ...(plan.flat || []).map((b) => b.x + b.w))) / 2;
    const gz = (z0 + Math.max(z1, ...(plan.flat || []).map((b) => b.z + b.d))) / 2;
    for (let i = -R; i <= R; i++) {
      grid.push({ a: [gx + i, -0.02, gz - R], b: [gx + i, -0.02, gz + R], level: L.grid });
      grid.push({ a: [gx - R, -0.02, gz + i], b: [gx + R, -0.02, gz + i], level: L.grid });
    }

    /* Where the camera looks, and how far away it fits the whole house. */
    const xs = [x0 - ov, x1 + ov, ...(plan.flat || []).flatMap((b) => [b.x, b.x + b.w])];
    const zs = [z0 - ov, z1 + ov, ...(plan.flat || []).flatMap((b) => [b.z, b.z + b.d])];
    const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    const centre = [(minX + maxX) / 2, roof.ridgeY * 0.42, (minZ + maxZ) / 2];
    const radius = Math.hypot((maxX - minX) / 2, roof.ridgeY / 2, (maxZ - minZ) / 2);
    return { house, grid, faces, centre, radius, openings };
  }

  /* Edge list -> the quad vertices the line shader widens. */
  function lineBuffers(segs) {
    const v = new Float32Array(segs.length * 4 * 9);
    const idx = new Uint16Array(segs.length * 6);
    segs.forEach((s, i) => {
      for (let k = 0; k < 4; k++) {
        const o = (i * 4 + k) * 9;
        v.set(s.a, o);
        v.set(s.b, o + 3);
        v[o + 6] = k % 2 ? 1 : -1;
        v[o + 7] = k < 2 ? 0 : 1;
        v[o + 8] = s.level;
      }
      idx.set([0, 1, 2, 2, 1, 3].map((n) => i * 4 + n), i * 6);
    });
    return { v, idx, count: segs.length * 6 };
  }
  function faceBuffers(tris) {
    const v = new Float32Array(tris.length * 3 * 7);
    tris.forEach(([a, b, c, col], i) => {
      [a, b, c].forEach((p, k) => {
        const o = (i * 3 + k) * 7;
        v.set(p, o);
        v.set(col, o + 3);
      });
    });
    return { v, count: tris.length * 3 };
  }

  /* "#rgb", "#rrggbb" or "rgb(r, g, b)" -> [0..1, 0..1, 0..1]. */
  function colour(css, fallback) {
    const s = (css || "").trim();
    let m = s.match(/^#([0-9a-f]{3})$/i);
    if (m) return m[1].split("").map((h) => parseInt(h + h, 16) / 255);
    m = s.match(/^#([0-9a-f]{6})/i);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
    m = s.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/);
    if (m) return [m[1], m[2], m[3]].map((n) => Number(n) / 255);
    return fallback;
  }

  Panel.house3d = function (canvas, plan, opts) {
    const onInteract = (opts && opts.onInteract) || (() => {});
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, premultipliedAlpha: true, powerPreference: "default" });
    if (!gl) return null;
    const geo = buildGeometry(plan);

    function program(vs, fs) {
      const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(sh));
        return sh;
      };
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("program: " + gl.getProgramInfoLog(p));
      const u = {};
      for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
        const name = gl.getActiveUniform(p, i).name;
        u[name] = gl.getUniformLocation(p, name);
      }
      const a = {};
      for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); i++) {
        const name = gl.getActiveAttrib(p, i).name;
        a[name] = gl.getAttribLocation(p, name);
      }
      return { p, u, a };
    }
    let lineP, faceP, blurP, compP;
    try {
      lineP = program(LINE_VS, LINE_FS);
      faceP = program(FACE_VS, FACE_FS);
      blurP = program(QUAD_VS, BLUR_FS);
      compP = program(QUAD_VS, COMPOSITE_FS);
    } catch (e) {
      console.warn("house3d:", e.message);
      return null;
    }

    const buffer = (target, data) => {
      const b = gl.createBuffer();
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      return b;
    };
    const lines = [geo.house, geo.grid].map((segs) => {
      const lb = lineBuffers(segs);
      return { vbo: buffer(gl.ARRAY_BUFFER, lb.v), ibo: buffer(gl.ELEMENT_ARRAY_BUFFER, lb.idx), count: lb.count };
    });
    const fb = faceBuffers(geo.faces);
    const faces = { vbo: buffer(gl.ARRAY_BUFFER, fb.v), count: fb.count };
    const quad = buffer(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));

    /* Render targets: the scene at full size, two half-size ones for the bloom. */
    function target(w, h) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fbo, w, h };
    }
    let scene = null, bloomA = null, bloomB = null;
    let W = 0, H = 0, dpr = 1;
    let seen = ""; /* the size the last frame reported: targets follow a size once it holds still */
    function resize(idle) {
      dpr = idle ? 1 : Math.min(MAX_DPR, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (w === W && h === H) return;
      /* While the header slides away the canvas grows every frame: wait for a
       * size that repeats, rather than allocate three render targets a frame. */
      const key = `${w}x${h}`;
      if (key !== seen && W) {
        seen = key;
        return;
      }
      seen = key;
      W = canvas.width = w;
      H = canvas.height = h;
      [scene, bloomA, bloomB].forEach((t) => t && (gl.deleteTexture(t.tex), gl.deleteFramebuffer(t.fbo)));
      scene = target(W, H);
      bloomA = target(Math.ceil(W / 2), Math.ceil(H / 2));
      bloomB = target(Math.ceil(W / 2), Math.ceil(H / 2));
    }
    new ResizeObserver(() => active && resize(idleNow())).observe(canvas);

    /* ---- Camera ------------------------------------------------------------------- */
    const cam = { yaw: -0.65, pitch: (24 * Math.PI) / 180, zoom: 0.82 };
    let yawVel = 0;
    let lastTouch = -Infinity;
    let pinch = null; /* two fingers: where they started and the camera then */
    let drag = null; /* a mouse drag */
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fitDistance = () => (geo.radius / Math.sin(FOV / 2)) * 1.05 * Math.max(1, 1.15 / (W / H || 1));
    const clampCam = () => {
      cam.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, cam.pitch));
      cam.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.zoom));
    };
    const touched = () => {
      lastTouch = performance.now();
      onInteract();
    };
    const idleNow = () => !pinch && !drag && performance.now() - lastTouch > IDLE_MS;
    const finger = (t) => [t.clientX, t.clientY];
    const between = (a, b) => ({ d: Math.hypot(b[0] - a[0], b[1] - a[1]), ang: Math.atan2(b[1] - a[1], b[0] - a[0]), mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 });
    function pinchStart(e) {
      if (e.touches.length < 2) return;
      Panel.cancelSwipe();
      const p = between(finger(e.touches[0]), finger(e.touches[1]));
      pinch = { ...p, yaw: cam.yaw, pitch: cam.pitch, zoom: cam.zoom, lastYaw: cam.yaw, lastT: performance.now() };
      yawVel = 0;
      touched();
      e.preventDefault();
    }
    function pinchMove(e) {
      if (!pinch || e.touches.length < 2) return;
      const p = between(finger(e.touches[0]), finger(e.touches[1]));
      let turn = p.ang - pinch.ang;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      const size = Math.max(200, canvas.clientWidth);
      cam.yaw = pinch.yaw + turn + ((p.mx - pinch.mx) / size) * 2.6;
      cam.pitch = pinch.pitch + ((p.my - pinch.my) / size) * 2.2;
      cam.zoom = pinch.zoom * (pinch.d / Math.max(20, p.d));
      clampCam();
      const now = performance.now();
      if (now > pinch.lastT) yawVel = ((cam.yaw - pinch.lastYaw) / (now - pinch.lastT)) * 1000;
      pinch.lastYaw = cam.yaw;
      pinch.lastT = now;
      touched();
      e.preventDefault();
    }
    function pinchEnd(e) {
      if (!pinch) return;
      if (e.touches.length >= 2) return pinchStart(e); /* a third finger lifted: go on with the two left */
      pinch = null;
      touched();
    }
    canvas.addEventListener("touchstart", pinchStart, { passive: false });
    canvas.addEventListener("touchmove", pinchMove, { passive: false });
    canvas.addEventListener("touchend", pinchEnd);
    canvas.addEventListener("touchcancel", pinchEnd);
    /* Safari's own pinch gesture would zoom the page. */
    ["gesturestart", "gesturechange", "gestureend"].forEach((n) => canvas.addEventListener(n, (e) => e.preventDefault()));
    /* A mouse: drag turns and tilts, the wheel zooms; the section swipe stays
     * with the tabs on a desktop. */
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      e.stopPropagation();
      drag = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch, lastYaw: cam.yaw, lastT: performance.now() };
      yawVel = 0;
      touched();
    });
    window.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const size = Math.max(200, canvas.clientWidth);
      cam.yaw = drag.yaw + ((e.clientX - drag.x) / size) * 3.0;
      cam.pitch = drag.pitch + ((e.clientY - drag.y) / size) * 2.2;
      clampCam();
      const now = performance.now();
      if (now > drag.lastT) yawVel = ((cam.yaw - drag.lastYaw) / (now - drag.lastT)) * 1000;
      drag.lastYaw = cam.yaw;
      drag.lastT = now;
      touched();
    });
    window.addEventListener("pointerup", () => (drag = null));
    canvas.addEventListener(
      "wheel",
      (e) => {
        cam.zoom *= Math.exp(e.deltaY * 0.0012);
        clampCam();
        touched();
        e.preventDefault();
      },
      { passive: false }
    );

    /* ---- Frames --------------------------------------------------------------------- */
    let active = false;
    let raf = 0;
    let lastFrame = 0;
    let frames = 0;
    let accent = [0.3, 0.85, 1.0];
    let bg = [0.06, 0.07, 0.1];
    const readColours = () => {
      accent = colour(Panel.cssVar("--accent"), accent);
      bg = colour(Panel.cssVar("--bg"), bg);
    };
    readColours();

    function drawLines(vp, set, radial, colour) {
      gl.useProgram(lineP.p);
      gl.bindBuffer(gl.ARRAY_BUFFER, set.vbo);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, set.ibo);
      const stride = 9 * 4;
      gl.enableVertexAttribArray(lineP.a.aA);
      gl.vertexAttribPointer(lineP.a.aA, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(lineP.a.aB);
      gl.vertexAttribPointer(lineP.a.aB, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(lineP.a.aP);
      gl.vertexAttribPointer(lineP.a.aP, 2, gl.FLOAT, false, stride, 24);
      gl.enableVertexAttribArray(lineP.a.aL);
      gl.vertexAttribPointer(lineP.a.aL, 1, gl.FLOAT, false, stride, 32);
      gl.uniform3fv(lineP.u.uColor, colour || accent);
      gl.uniform1f(lineP.u.uRadial, radial);
      gl.drawElements(gl.TRIANGLES, set.count, gl.UNSIGNED_SHORT, 0);
    }
    function drawQuad(prog) {
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(prog.a.aPos);
      gl.vertexAttribPointer(prog.a.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    function blur(from, to, dir) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, to.fbo);
      gl.viewport(0, 0, to.w, to.h);
      gl.useProgram(blurP.p);
      gl.bindTexture(gl.TEXTURE_2D, from.tex);
      gl.uniform1i(blurP.u.uTex, 0);
      gl.uniform2f(blurP.u.uDir, dir[0] / to.w, dir[1] / to.h);
      drawQuad(blurP);
    }

    let sampleReq = null; /* resolve() of a pending sample() */
    function frame(now) {
      raf = active ? requestAnimationFrame(frame) : 0;
      if (!active || lost || Panel.overlayOpen()) return;
      const idle = idleNow();
      if (idle && now - lastFrame < IDLE_FRAME_MS) return; /* half rate on its own */
      if (!canvas.clientWidth) return;
      resize(idle);
      const dt = Math.min(0.05, (now - lastFrame) / 1000 || 0);
      lastFrame = now;
      if (++frames % 90 === 0) readColours();

      /* The orbit: the finger's momentum, then the slow turn on its own. */
      if (!pinch && !drag) {
        cam.yaw += yawVel * dt;
        yawVel *= Math.exp(-dt * 3.5);
        if (Math.abs(yawVel) < 0.02) yawVel = 0;
        if (!reduced && now - lastTouch > IDLE_MS) cam.yaw += AUTO_SPEED * dt;
      }
      const dist = fitDistance() * cam.zoom;
      const c = geo.centre;
      const eye = [c[0] + dist * Math.cos(cam.pitch) * Math.sin(cam.yaw), c[1] + dist * Math.sin(cam.pitch), c[2] + dist * Math.cos(cam.pitch) * Math.cos(cam.yaw)];
      const vp = mul(perspective(FOV, W / H, 1, dist + geo.radius * 4), lookAt(eye, c, [0, 1, 0]));
      const sweepY = ((now / 1000) % SWEEP_PERIOD_S) / SWEEP_PERIOD_S * 13 - 2;

      /* The scene: faces, then the ground grid, then the house. */
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(faceP.p);
      gl.bindBuffer(gl.ARRAY_BUFFER, faces.vbo);
      gl.enableVertexAttribArray(faceP.a.aPos);
      gl.vertexAttribPointer(faceP.a.aPos, 3, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(faceP.a.aCol);
      gl.vertexAttribPointer(faceP.a.aCol, 4, gl.FLOAT, false, 28, 12);
      gl.uniformMatrix4fv(faceP.u.uVP, false, vp);
      gl.uniform4f(faceP.u.uTint, 1, 1, 1, 1);
      gl.drawArrays(gl.TRIANGLES, 0, faces.count);
      gl.useProgram(lineP.p);
      gl.uniformMatrix4fv(lineP.u.uVP, false, vp);
      gl.uniform2f(lineP.u.uRes, W, H);
      gl.uniform1f(lineP.u.uWidth, LINE_PX * dpr);
      gl.uniform2f(lineP.u.uMid, geo.centre[0], geo.centre[2]);
      gl.uniform1f(lineP.u.uSweepY, sweepY);
      gl.uniform1f(lineP.u.uNear, dist - geo.radius);
      gl.uniform1f(lineP.u.uFar, dist + geo.radius * 1.4);
      drawLines(vp, lines[1], 1);
      drawLines(vp, lines[0], 0);
      /* Lit openings: their face filled in their colour, pulsing when asked,
       * and their edges in that colour over the house's. */
      for (const m of marks.values()) {
        const p = m.pulse ? 0.5 + 0.5 * Math.sin((now / 1000) * ((2 * Math.PI) / PULSE_S)) : 1;
        gl.useProgram(faceP.p);
        gl.bindBuffer(gl.ARRAY_BUFFER, m.faces.vbo);
        gl.vertexAttribPointer(faceP.a.aPos, 3, gl.FLOAT, false, 28, 0);
        gl.vertexAttribPointer(faceP.a.aCol, 4, gl.FLOAT, false, 28, 12);
        gl.uniform4f(faceP.u.uTint, m.colour[0], m.colour[1], m.colour[2], 0.3 + 0.35 * p);
        gl.drawArrays(gl.TRIANGLES, 0, m.faces.count);
        gl.useProgram(lineP.p);
        drawLines(vp, m.lines, 0, m.colour.map((c) => c * (0.9 + 0.9 * p)));
      }

      /* The bloom: the scene at half size, blurred twice over, wider the second time. */
      gl.disable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0);
      blur(scene, bloomB, [1, 0]); /* the half-size target's linear filter does the downsample */
      blur(bloomB, bloomA, [0, 1]);
      blur(bloomA, bloomB, [2.5, 0]);
      blur(bloomB, bloomA, [0, 2.5]);

      /* Onto the page. */
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.useProgram(compP.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, scene.tex);
      gl.uniform1i(compP.u.uScene, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
      gl.uniform1i(compP.u.uBloom, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform3fv(compP.u.uBg, bg);
      gl.uniform3fv(compP.u.uColor, accent);
      gl.uniform1f(compP.u.uBloomK, BLOOM);
      gl.uniform1f(compP.u.uAspect, W / H);
      drawQuad(compP);
      if (sampleReq) {
        /* Every 8th pixel: how many are lit well above the page colour. */
        const px = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let lit = 0, total = 0;
        const base = (bg[0] + bg[1] + bg[2]) * 255;
        for (let y = 0; y < H; y += 8) for (let x = 0; x < W; x += 8) {
          const o = (y * W + x) * 4;
          total++;
          if (px[o] + px[o + 1] + px[o + 2] > base + 90) lit++;
        }
        const res = sampleReq;
        sampleReq = null;
        res({ lit, total, share: lit / total });
      }
    }

    /* ---- Lit openings --------------------------------------------------------------- */
    const PULSE_S = 1.4;
    const marks = new Map(); /* opening key -> {colour, pulse, lines, faces} */
    function highlight(key, { colour = [1, 0.3, 0.25], pulse = true } = {}) {
      const corners = geo.openings[key];
      if (!corners) return false;
      clearHighlight(key);
      const [a, b, c, d] = corners;
      const segs = corners.map((p, i) => ({ a: p, b: corners[(i + 1) % 4], level: 1.0 }));
      const lb = lineBuffers(segs);
      const fb = faceBuffers([[a, b, c, [1, 1, 1, 1]], [a, c, d, [1, 1, 1, 1]]]);
      marks.set(key, {
        colour, pulse,
        lines: { vbo: buffer(gl.ARRAY_BUFFER, lb.v), ibo: buffer(gl.ELEMENT_ARRAY_BUFFER, lb.idx), count: lb.count },
        faces: { vbo: buffer(gl.ARRAY_BUFFER, fb.v), count: fb.count },
      });
      return true;
    }
    function clearHighlight(key) {
      const m = marks.get(key);
      if (!m) return;
      [m.lines.vbo, m.lines.ibo, m.faces.vbo].forEach((b) => gl.deleteBuffer(b));
      marks.delete(key);
    }

    let lost = false;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      lost = true; /* nothing more is drawn until the page reloads on restore */
      cancelAnimationFrame(raf);
      raf = 0;
    });
    canvas.addEventListener("webglcontextrestored", () => location.reload());

    return {
      /* Draws while the page is in view; nothing runs when it is not. */
      setActive(on) {
        active = !!on;
        if (active && !raf) {
          lastFrame = performance.now();
          raf = requestAnimationFrame(frame);
        }
        if (!active && raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      },
      /* Share of the next frame's pixels that the house lights up (the tests'
       * check that it draws; a readPixels, so not for every frame). */
      sample: () => new Promise((res) => (sampleReq = res)),
      camera: () => ({ yaw: cam.yaw, pitch: cam.pitch, zoom: cam.zoom, orbiting: !reduced && performance.now() - lastTouch > IDLE_MS }),
      setCamera(c) {
        Object.assign(cam, c);
        clampCam();
      },
      get frames() {
        return frames;
      },
      get running() {
        return !!raf;
      },
      edges: geo.house.length,
      /* Lights an opening (a keyed one in the plan) up in a colour, pulsing or steady. */
      highlight,
      clearHighlight,
      highlights: () => [...marks.keys()],
    };
  };
})();
