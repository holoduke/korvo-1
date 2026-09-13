/* Gestures: finger-following tab swipe, tap vs long-press on tiles, the
 * slide-out "Alle lampen" drawer (also swipe-to-close), the vertical area
 * brightness slider and the per-light popup sliders. Timings and thresholds
 * follow main/panel_ui.c (16 px drag threshold, commit past 1/5 width or on a
 * flick, 160 ms snap, 240/220 ms drawer). */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;

  const DRAG_START = 16;      /* px before a press becomes a horizontal drag */
  const MOVE_CANCEL = 10;     /* px of movement that cancels a long-press */
  const LONG_PRESS_MS = 450;
  const FLICK_VEL = 0.45;     /* px/ms toward the target counts as a flick */
  const SYNC_HOLDOFF = 2500;  /* ms after a slider release before HA may move it */

  /* ---- Overlay helpers -------------------------------------------------------- */
  Panel.openOverlay = function (el) {
    el.classList.remove("closing");
    el.hidden = false;
  };
  Panel.closeOverlay = function (el) {
    if (el.hidden || el.classList.contains("closing")) return;
    el.classList.add("closing");
    setTimeout(() => {
      el.hidden = true;
      el.classList.remove("closing");
    }, 160);
  };
  const overlayOpen = () => ["popup", "climate", "settings", "saver"].some((id) => !$(id).hidden);

  /* ---- Tabs ------------------------------------------------------------------ */
  const stage = $("stage");
  const track = $("track");
  const ind = $("tabind");
  const tabs = () => [...document.querySelectorAll(".tab")];

  function setIndicator(pos, animate) {
    const t = tabs();
    const i = Math.max(0, Math.min(t.length - 1, Math.floor(pos)));
    const f = Math.max(0, Math.min(1, pos - i));
    const a = t[i];
    const b = t[Math.min(t.length - 1, i + 1)];
    const inset = 0.18; /* underline spans the middle of the tab label area */
    const left = (el) => el.offsetLeft + el.offsetWidth * inset;
    const width = (el) => el.offsetWidth * (1 - 2 * inset);
    ind.style.transition = animate ? "transform .16s cubic-bezier(.22,.61,.36,1), width .16s" : "none";
    ind.style.width = width(a) + (width(b) - width(a)) * f + "px";
    ind.style.transform = `translate3d(${left(a) + (left(b) - left(a)) * f}px,0,0)`;
  }

  function setTrack(offsetPx, animate) {
    track.classList.toggle("snapping", !!animate);
    track.style.transform = `translate3d(calc(${-Panel.tab * 100}% + ${offsetPx}px),0,0)`;
  }

  Panel.setTab = function (i, animate) {
    i = Math.max(0, Math.min(cfg.tabs.length - 1, i));
    const changed = i !== Panel.tab;
    Panel.tab = i;
    tabs().forEach((el, k) => el.classList.toggle("active", k === i));
    setTrack(0, animate);
    setIndicator(i, animate);
    if (changed) {
      closeDrawer(false);
      const v = Panel.tabBrightness[i];
      setSlider(v >= 0 ? v : 50, v >= 0);
    }
  };

  $("tabbar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) Panel.setTab(+b.dataset.tab, true);
  });
  window.addEventListener("resize", () => {
    setIndicator(Panel.tab, false);
    if (drawer.classList.contains("open")) placeDrawer();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      ["popup", "climate", "settings"].forEach((id) => Panel.closeOverlay($(id)));
      closeDrawer(true);
    }
    if (overlayOpen()) return;
    if (e.key === "ArrowRight") Panel.setTab(Panel.tab + 1, true);
    if (e.key === "ArrowLeft") Panel.setTab(Panel.tab - 1, true);
  });

  /* ---- Press / long-press / swipe over the pages and the drawer --------------- */
  let g = null; /* active gesture */
  let swallowClick = false; /* the click synthesized from a long-press's lift */
  window.addEventListener(
    "click",
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    },
    { capture: true }
  );
  /* A mouse long-press produces no click; the next real press starts clean. */
  window.addEventListener("pointerdown", () => (swallowClick = false), { capture: true });

  function actionTarget(el) {
    return el.closest("[data-light],[data-scene],[data-all],[data-vac]");
  }

  function onDown(e, surface) {
    if (g || e.button > 0 || overlayOpen()) return;
    if (e.target.closest(".vslider")) return;
    const target = actionTarget(e.target);
    g = {
      id: e.pointerId,
      surface,
      x0: e.clientX,
      y0: e.clientY,
      target,
      drag: false,
      cancelled: false,
      long: false,
      samples: [{ x: e.clientX, t: e.timeStamp }],
      width: surface === "stage" ? stage.clientWidth : drawer.clientWidth,
    };
    if (target) target.classList.add("pressed");
    if (target && target.dataset.light) {
      g.lpTimer = setTimeout(() => {
        if (!g || g.drag || g.cancelled) return;
        target.classList.remove("pressed");
        /* The popup now owns the finger: end this gesture here, because its
         * pointerup will land on the popup, not on the surface we listen to.
         * On touch the browser also turns the lift into a click on whatever is
         * under the finger by then (the popup backdrop, which would close the
         * popup at once), so that one click is swallowed. */
        g = null;
        swallowClick = true;
        if (navigator.vibrate) navigator.vibrate(12);
        Panel.openLightPopup(target.dataset.light);
      }, LONG_PRESS_MS);
    }
  }

  function onMove(e) {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    g.samples.push({ x: e.clientX, t: e.timeStamp });
    if (g.samples.length > 8) g.samples.shift();
    if (!g.drag) {
      if (Math.hypot(dx, dy) > MOVE_CANCEL) {
        clearTimeout(g.lpTimer);
        if (g.target) g.target.classList.remove("pressed");
      }
      if (Math.abs(dy) > MOVE_CANCEL && Math.abs(dy) > Math.abs(dx)) {
        g.cancelled = true; /* vertical: let the drawer scroll natively */
        return;
      }
      if (g.cancelled || Math.abs(dx) < DRAG_START || g.long) return;
      if (g.surface === "drawer" && dx < 0) return; /* the drawer only swipes closed */
      g.drag = true;
      g.dx0 = dx; /* start from the finger without a 16 px jump */
      (g.surface === "stage" ? stage : drawer).setPointerCapture(g.id);
      if (g.surface === "stage") $("bright").classList.add("dim");
      else drawer.classList.add("dragging");
    }
    const raw = dx - Math.sign(g.dx0) * DRAG_START;
    if (g.surface === "stage") {
      const atEdge = (raw > 0 && Panel.tab === 0) || (raw < 0 && Panel.tab === cfg.tabs.length - 1);
      const off = atEdge ? raw * 0.3 : Math.max(-g.width, Math.min(g.width, raw));
      g.off = off;
      setTrack(off, false);
      setIndicator(Panel.tab - off / g.width, false);
    } else {
      g.off = Math.max(0, raw);
      drawer.style.transform = `translate3d(${g.off}px,0,0)`;
    }
    e.preventDefault();
  }

  function velocity(gest) {
    const s = gest.samples;
    const a = s.find((p) => s[s.length - 1].t - p.t < 110) || s[0];
    const b = s[s.length - 1];
    return b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0;
  }

  function onUp(e) {
    if (!g || e.pointerId !== g.id) return;
    const gest = g;
    g = null;
    clearTimeout(gest.lpTimer);
    if (gest.target) gest.target.classList.remove("pressed");
    if (gest.drag) {
      const v = velocity(gest);
      if (gest.surface === "stage") {
        const dir = gest.off < 0 ? 1 : -1; /* +1 = next tab */
        const to = Panel.tab + dir;
        const far = Math.abs(gest.off) > gest.width / 5;
        const flick = -dir * v > FLICK_VEL && Math.abs(gest.off) > 24;
        $("bright").classList.remove("dim");
        if ((far || flick) && to >= 0 && to < cfg.tabs.length) Panel.setTab(to, true);
        else Panel.setTab(Panel.tab, true);
      } else {
        drawer.classList.remove("dragging");
        drawer.style.transform = "";
        if (gest.off > gest.width / 4 || (v > FLICK_VEL && gest.off > 24)) closeDrawer(true);
      }
      return;
    }
    if (gest.cancelled || gest.long || e.type === "pointercancel" || !gest.target) return;
    if (Math.hypot(e.clientX - gest.x0, e.clientY - gest.y0) > MOVE_CANCEL) return;
    const t = gest.target;
    if (t.dataset.light) Panel.toggleLight(t.dataset.light);
    else if (t.dataset.scene) {
      const [tab, idx] = t.dataset.scene.split(":").map(Number);
      Panel.activateScene(tab, idx);
    } else if (t.dataset.all) toggleDrawer();
    else if (t.dataset.vac && !t.disabled) Panel.vacTap(t);
  }

  for (const [el, name] of [
    [stage, "stage"],
    [null, "drawer"],
  ]) {
    const node = el || $("drawer");
    node.addEventListener("pointerdown", (e) => onDown(e, name));
    node.addEventListener("pointermove", onMove, { passive: false });
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onUp);
    node.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  /* A release outside the surface (finger slid off, or onto an overlay) must
   * still end the gesture, or the next press would be ignored. */
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);

  /* ---- Drawer ----------------------------------------------------------------- */
  const drawer = $("drawer");
  let drawerTab = -1;

  function placeDrawer() {
    const top = $("tabbar").getBoundingClientRect().top;
    const page = document.querySelector(`[data-page="${Panel.tab}"] .row`);
    const bottom = page ? window.innerHeight - page.getBoundingClientRect().top : 0;
    drawer.style.top = top + "px";
    drawer.style.bottom = bottom + "px";
  }

  function openDrawer() {
    const t = cfg.tabs[Panel.tab];
    if (drawerTab !== Panel.tab) {
      $("drawerGrid").innerHTML = t.devices.map((d) => Panel.lightTile(d)).join("");
      t.devices.forEach((d) => Panel.renderLight(d.id));
      drawerTab = Panel.tab;
    }
    drawer.scrollTop = 0;
    placeDrawer();
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    document.querySelectorAll("[data-all]").forEach((b) => b.classList.toggle("open", +b.dataset.all === Panel.tab));
  }

  function closeDrawer() {
    if (!drawer.classList.contains("open")) return;
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    document.querySelectorAll("[data-all]").forEach((b) => b.classList.remove("open"));
  }
  Panel.closeDrawer = closeDrawer;

  function toggleDrawer() {
    if (drawer.classList.contains("open")) closeDrawer();
    else openDrawer();
  }

  /* ---- Vertical area-brightness slider ---------------------------------------- */
  const bright = $("bright");
  const vTrack = bright.querySelector(".vs-track");
  let vDrag = null;
  let vReleasedAt = 0;

  function setSlider(v, showLabel) {
    bright.hidden = false;
    const h = vTrack.clientHeight || 1;
    const knob = 46;
    const y = (v / 100) * (h - knob) + knob / 2; /* knob centre from the bottom */
    bright.querySelector(".vs-fill").style.height = y + "px";
    bright.querySelector(".vs-knob").style.bottom = y + "px";
    bright.dataset.value = v;
    $("brightLabel").textContent = showLabel ? v + "%" : "";
  }

  function sliderValue(clientY) {
    const r = vTrack.getBoundingClientRect();
    const knob = 46;
    const f = 1 - (clientY - r.top - knob / 2) / Math.max(1, r.height - knob);
    return Math.round(Math.max(0, Math.min(1, f)) * 100);
  }

  vTrack.addEventListener("pointerdown", (e) => {
    vDrag = e.pointerId;
    vTrack.setPointerCapture(e.pointerId);
    bright.classList.add("dragging");
    setSlider(sliderValue(e.clientY), true);
  });
  vTrack.addEventListener("pointermove", (e) => {
    if (vDrag === e.pointerId) setSlider(sliderValue(e.clientY), true);
  });
  const vEnd = (e) => {
    if (vDrag !== e.pointerId) return;
    vDrag = null;
    bright.classList.remove("dragging");
    const v = +bright.dataset.value;
    vReleasedAt = Date.now();
    Panel.tabBrightness[Panel.tab] = v;
    Panel.setBrightness(cfg.tabs[Panel.tab].lights.map((l) => l.id), v);
  };
  vTrack.addEventListener("pointerup", vEnd);
  vTrack.addEventListener("pointercancel", vEnd);

  Panel.onTabBrightness = function (v) {
    if (vDrag !== null || Date.now() - vReleasedAt < SYNC_HOLDOFF) return; /* don't fight the finger */
    setSlider(v, true);
  };

  /* ---- Horizontal popup sliders -------------------------------------------- */
  function bindH(el, opts) {
    const state = { ...opts };
    const knob = el.querySelector(".hs-knob");
    const fill = el.querySelector(".hs-fill");
    function show(v) {
      state.value = v;
      const f = (v - state.min) / Math.max(1, state.max - state.min);
      const pad = 20; /* keep the knob inside the rounded ends */
      const x = pad + f * (el.clientWidth - 2 * pad);
      knob.style.left = x + "px";
      if (fill) fill.style.width = x + pad + "px";
      if (state.tint) knob.style.background = state.tint(v);
    }
    function fromX(clientX) {
      const r = el.getBoundingClientRect();
      const pad = 20;
      const f = Math.max(0, Math.min(1, (clientX - r.left - pad) / Math.max(1, r.width - 2 * pad)));
      return Math.round(state.min + f * (state.max - state.min));
    }
    let id = null;
    el.addEventListener("pointerdown", (e) => {
      id = e.pointerId;
      el.setPointerCapture(id);
      show(fromX(e.clientX));
    });
    el.addEventListener("pointermove", (e) => id === e.pointerId && show(fromX(e.clientX)));
    const end = (e) => {
      if (id !== e.pointerId) return;
      id = null;
      state.onCommit && state.onCommit(state.value);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    return {
      set(o) {
        Object.assign(state, o);
        requestAnimationFrame(() => show(state.value));
      },
    };
  }

  const popupEntity = { id: null };
  const hBright = bindH($("popupBright"), { min: 0, max: 100, value: 50, onCommit: (v) => Panel.setBrightness([popupEntity.id], v) });
  const hHue = bindH($("popupColor"), {
    min: 0,
    max: 359,
    value: 40,
    tint: (v) => `hsl(${v} 100% 50%)`,
    onCommit: (v) => Panel.setHue(popupEntity.id, v),
  });
  const hWarm = bindH($("popupWarm"), {
    min: 2200,
    max: 6500,
    value: 4000,
    onCommit: (v) => Panel.setKelvin(popupEntity.id, v),
  });

  function labelFor(id) {
    for (const t of cfg.tabs) {
      const e = [...t.devices, ...t.lights].find((x) => x.id === id);
      if (e) return e.label;
    }
    return id;
  }

  Panel.openLightPopup = function (id) {
    const s = Panel.st(id);
    if (!s || s.state === "unavailable") return;
    popupEntity.id = id;
    $("popupTitle").textContent = labelFor(id);
    const b = Panel.brightnessPct(id);
    const caps = Panel.caps(id);
    $("popupColorWrap").hidden = !caps.color;
    $("popupWarmWrap").hidden = !caps.warmth;
    Panel.openOverlay($("popup"));
    hBright.set({ value: b > 0 ? b : 50 });
    if (caps.color) {
      const hs = s.attributes.hs_color;
      hHue.set({ value: hs ? Math.round(hs[0]) : 40 });
    }
    if (caps.warmth) {
      const span = caps.maxK - caps.minK;
      const k = s.attributes.color_temp_kelvin || Math.round(caps.minK + span / 2);
      hWarm.set({
        min: caps.minK,
        max: caps.maxK,
        value: k,
        tint: (v) => {
          const t = ((v - caps.minK) * 255) / Math.max(1, span);
          return `rgb(255 ${180 + t / 4} ${110 + t / 2})`;
        },
      });
    }
  };

  $("popup").addEventListener("click", (e) => {
    if (e.target === $("popup")) Panel.closeOverlay($("popup"));
  });

  /* ---- Init ------------------------------------------------------------------ */
  Panel.initInteract = function () {
    Panel.setTab(0, false);
    setSlider(50, false);
    requestAnimationFrame(() => setIndicator(0, false));
    /* The knob position depends on the track height: redraw whenever the
     * layout changes (rotation, window resize, header wrapping). */
    new ResizeObserver(() => setSlider(+bright.dataset.value || 0, $("brightLabel").textContent !== "")).observe(vTrack);
  };
})();
