/* Gestures and navigation: sections (top tabs, horizontal finger-following
 * swipe), floors (vertical lift-style buttons plus a vertical swipe), tap vs
 * long-press on tiles, the "Alle lampen" drawer (swipe right to close), the
 * area brightness slider and the popup sliders. Timings follow the panel:
 * 16 px drag threshold, commit past 1/5 of the size or on a flick, ~160 ms snap. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;

  const DRAG_START = 16;      /* px before a press becomes a drag */
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
  const OVERLAYS = ["popup", "climate", "settings", "saver"];
  const overlayOpen = () => OVERLAYS.some((id) => !$(id).hidden);

  /* ---- Sections (top tabs) ----------------------------------------------------- */
  const stage = $("stage");
  const track = $("track");
  const ind = $("tabind");
  const tabs = () => [...document.querySelectorAll(".tab")];
  const sectionKind = () => cfg.sections[Panel.section].kind;

  function setIndicator(pos, animate) {
    const t = tabs();
    const i = Math.max(0, Math.min(t.length - 1, Math.floor(pos)));
    const f = Math.max(0, Math.min(1, pos - i));
    const a = t[i];
    const b = t[Math.min(t.length - 1, i + 1)];
    const inset = 0.18;
    const left = (el) => el.offsetLeft + el.offsetWidth * inset;
    const width = (el) => el.offsetWidth * (1 - 2 * inset);
    ind.style.transition = animate ? "transform .16s cubic-bezier(.22,.61,.36,1), width .16s" : "none";
    ind.style.width = width(a) + (width(b) - width(a)) * f + "px";
    ind.style.transform = `translate3d(${left(a) + (left(b) - left(a)) * f}px,0,0)`;
  }

  function setTrack(offsetPx, animate) {
    track.classList.toggle("snapping", !!animate);
    track.style.transform = `translate3d(calc(${-Panel.section * 100}% + ${offsetPx}px),0,0)`;
  }

  Panel.setSection = function (i, animate) {
    i = Math.max(0, Math.min(cfg.sections.length - 1, i));
    const changed = i !== Panel.section;
    Panel.section = i;
    tabs().forEach((el, k) => el.classList.toggle("active", k === i));
    setTrack(0, animate);
    setIndicator(i, animate);
    if (changed) {
      closeDrawer();
      syncSlider();
      if (Panel.onSection) Panel.onSection(i);
    }
    writeHash();
  };

  /* ---- Floors (inside Verlichting) --------------------------------------------- */
  /* Found in initInteract: app.js builds the pages at boot, after this script loads. */
  let floorsPage = null;
  let floorView = null;
  let floorTrack = null;
  let railInd = null;
  const railBtns = () => (floorsPage ? [...floorsPage.querySelectorAll(".rail-btn")] : []); /* display order */

  function setFloorTrack(posFloat, animate) {
    if (!floorTrack) return;
    floorTrack.classList.toggle("snapping", !!animate);
    floorTrack.style.transform = `translate3d(0,${-posFloat * 100}%,0)`;
  }
  function setFloorTrackPx(pos, offPx) {
    floorTrack.classList.remove("snapping");
    floorTrack.style.transform = `translate3d(0,calc(${-pos * 100}% + ${offPx}px),0)`;
  }
  function setRailInd(posFloat, animate) {
    const btns = railBtns();
    if (!btns.length) return;
    const i = Math.max(0, Math.min(btns.length - 1, Math.floor(posFloat)));
    const f = Math.max(0, Math.min(1, posFloat - i));
    const a = btns[i];
    const b = btns[Math.min(btns.length - 1, i + 1)];
    railInd.style.transition = animate ? "transform .24s cubic-bezier(.22,.61,.36,1), height .24s" : "none";
    railInd.style.height = a.offsetHeight + (b.offsetHeight - a.offsetHeight) * f + "px";
    railInd.style.transform = `translate3d(0,${a.offsetTop + (b.offsetTop - a.offsetTop) * f}px,0)`;
  }

  Panel.setFloor = function (fi, animate) {
    if (!floorsPage) return;
    fi = Math.max(0, Math.min(cfg.floors.length - 1, fi));
    const changed = fi !== Panel.floor;
    Panel.floor = fi;
    const pos = Panel.floorPos(fi);
    railBtns().forEach((el) => el.classList.toggle("active", +el.dataset.floor === fi));
    floorsPage.querySelectorAll(".floor-row").forEach((el) => el.classList.toggle("active", +el.dataset.floorRow === fi));
    setFloorTrack(pos, animate);
    setRailInd(pos, animate);
    if (changed) {
      closeDrawer();
      syncSlider();
    }
    writeHash();
  };

  /* Jump to wherever a PANEL_TABS entry lives (a floor, or its own section). */
  Panel.showTab = function (ti, animate) {
    const fi = cfg.floors.findIndex((f) => f.tab === ti);
    if (fi >= 0) {
      Panel.setSection(cfg.sections.findIndex((s) => s.kind === "floors"), animate);
      Panel.setFloor(fi, animate);
      return;
    }
    const si = cfg.sections.findIndex((s) => s.kind === "tab" && s.tab === ti);
    if (si >= 0) Panel.setSection(si, animate);
  };

  /* ---- URL ---------------------------------------------------------------------- */
  /* The place in the app lives in the hash (#verlichting/1, #schoonmaak, #garage),
   * so a reload or a bookmark lands on the same section and floor. replaceState
   * keeps swipes out of the browser history; editing the hash by hand works too. */
  let urlReady = false; /* false until the hash has been read at start-up */
  const slug = (name) => name.toLowerCase().trim().replace(/\s+/g, "-");
  function hashFor() {
    const s = cfg.sections[Panel.section];
    return "#" + slug(s.name) + (s.kind === "floors" ? "/" + cfg.floors[Panel.floor].label : "");
  }
  function writeHash() {
    if (!urlReady) return;
    const h = hashFor();
    if (location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h);
  }
  function applyHash(animate) {
    let raw = "";
    try {
      raw = decodeURIComponent(location.hash.slice(1));
    } catch (e) {
      /* malformed escape: treat as no hash */
    }
    const [sec, floor] = raw.toLowerCase().split("/");
    const si = cfg.sections.findIndex((s) => slug(s.name) === sec);
    const fi = cfg.floors.findIndex((f) => f.label.toLowerCase() === floor);
    if (si >= 0) Panel.setSection(si, animate);
    if (fi >= 0) Panel.setFloor(fi, animate);
    writeHash(); /* normalise an unknown or partial hash */
  }
  window.addEventListener("hashchange", () => applyHash(true));

  $("tabbar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) Panel.setSection(+b.dataset.tab, true);
  });
  window.addEventListener("resize", () => {
    setIndicator(Panel.section, false);
    if (floorsPage) setRailInd(Panel.floorPos(Panel.floor), false);
    if (drawer.classList.contains("open")) placeDrawer();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      ["popup", "climate", "settings"].forEach((id) => Panel.closeOverlay($(id)));
      closeDrawer();
    }
    if (overlayOpen()) return;
    if (e.key === "ArrowRight") Panel.setSection(Panel.section + 1, true);
    if (e.key === "ArrowLeft") Panel.setSection(Panel.section - 1, true);
    if (sectionKind() === "floors" && e.key === "ArrowUp") Panel.setFloor(Panel.floor + 1, true);
    if (sectionKind() === "floors" && e.key === "ArrowDown") Panel.setFloor(Panel.floor - 1, true);
  });

  /* ---- Press / long-press / swipe ------------------------------------------------ */
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
    return el.closest("[data-light],[data-scene],[data-all],[data-floor],[data-vac],[data-car]");
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
      axis: null,
      cancelled: false,
      inFloorView: !!e.target.closest(".floor-view"),
      samples: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }],
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
    g.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    if (g.samples.length > 8) g.samples.shift();
    if (!g.drag) {
      if (Math.hypot(dx, dy) > MOVE_CANCEL) {
        clearTimeout(g.lpTimer);
        if (g.target) g.target.classList.remove("pressed");
      }
      if (g.cancelled) return;
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      if (ax < DRAG_START && ay < DRAG_START) return;
      if (ay > ax) {
        /* Vertical: switches floors over the floor view; elsewhere the content
         * (drawer, Schoonmaak columns) scrolls natively. */
        if (g.surface !== "stage" || !g.inFloorView || sectionKind() !== "floors") {
          g.cancelled = true;
          return;
        }
        g.axis = "y";
        g.d0 = dy;
        g.height = floorView.clientHeight;
      } else {
        if (g.surface === "drawer" && dx < 0) return; /* the drawer only swipes closed */
        g.axis = "x";
        g.d0 = dx;
        if (g.surface === "stage") $("bright").classList.add("dim");
        else drawer.classList.add("dragging");
      }
      g.drag = true;
      (g.surface === "stage" ? stage : drawer).setPointerCapture(g.id);
    }
    if (g.axis === "y") {
      const raw = dy - Math.sign(g.d0) * DRAG_START;
      const pos = Panel.floorPos(Panel.floor);
      const last = cfg.floors.length - 1;
      const atEdge = (raw > 0 && pos === 0) || (raw < 0 && pos === last);
      const off = atEdge ? raw * 0.3 : Math.max(-g.height, Math.min(g.height, raw));
      g.off = off;
      setFloorTrackPx(pos, off);
      setRailInd(Math.max(0, Math.min(last, pos - off / g.height)), false);
    } else {
      const raw = dx - Math.sign(g.d0) * DRAG_START;
      if (g.surface === "stage") {
        const atEdge = (raw > 0 && Panel.section === 0) || (raw < 0 && Panel.section === cfg.sections.length - 1);
        const off = atEdge ? raw * 0.3 : Math.max(-g.width, Math.min(g.width, raw));
        g.off = off;
        setTrack(off, false);
        setIndicator(Panel.section - off / g.width, false);
      } else {
        g.off = Math.max(0, raw);
        drawer.style.transform = `translate3d(${g.off}px,0,0)`;
      }
    }
    e.preventDefault();
  }

  function velocity(gest, key) {
    const s = gest.samples;
    const a = s.find((p) => s[s.length - 1].t - p.t < 110) || s[0];
    const b = s[s.length - 1];
    return b.t > a.t ? (b[key] - a[key]) / (b.t - a.t) : 0;
  }

  function onUp(e) {
    if (!g || e.pointerId !== g.id) return;
    const gest = g;
    g = null;
    clearTimeout(gest.lpTimer);
    if (gest.target) gest.target.classList.remove("pressed");
    if (gest.drag) {
      if (gest.axis === "y") {
        const v = velocity(gest, "y");
        const dir = gest.off < 0 ? 1 : -1; /* +1 = the panel below (a lower floor) */
        const pos = Panel.floorPos(Panel.floor);
        const to = pos + dir;
        const far = Math.abs(gest.off) > gest.height / 5;
        const flick = -dir * v > FLICK_VEL && Math.abs(gest.off) > 24;
        if ((far || flick) && to >= 0 && to < cfg.floors.length) Panel.setFloor(Panel.floorOrder[to], true);
        else Panel.setFloor(Panel.floor, true);
      } else if (gest.surface === "stage") {
        const v = velocity(gest, "x");
        const dir = gest.off < 0 ? 1 : -1;
        const to = Panel.section + dir;
        const far = Math.abs(gest.off) > gest.width / 5;
        const flick = -dir * v > FLICK_VEL && Math.abs(gest.off) > 24;
        $("bright").classList.remove("dim");
        if ((far || flick) && to >= 0 && to < cfg.sections.length) Panel.setSection(to, true);
        else Panel.setSection(Panel.section, true);
      } else {
        const v = velocity(gest, "x");
        drawer.classList.remove("dragging");
        drawer.style.transform = "";
        if (gest.off > gest.width / 4 || (v > FLICK_VEL && gest.off > 24)) closeDrawer();
      }
      return;
    }
    if (gest.cancelled || e.type === "pointercancel" || !gest.target) return;
    if (Math.hypot(e.clientX - gest.x0, e.clientY - gest.y0) > MOVE_CANCEL) return;
    const t = gest.target;
    if (t.disabled) return;
    if (t.dataset.light) Panel.toggleLight(t.dataset.light);
    else if (t.dataset.scene) {
      const [tab, idx] = t.dataset.scene.split(":").map(Number);
      Panel.activateScene(tab, idx);
    } else if (t.dataset.all) toggleDrawer();
    else if (t.dataset.floor) Panel.setFloor(+t.dataset.floor, true);
    else if (t.dataset.vac && Panel.vacTap) Panel.vacTap(t);
    else if (t.dataset.car && Panel.carTap) Panel.carTap(t);
  }

  const drawer = $("drawer");
  for (const [node, name] of [
    [stage, "stage"],
    [drawer, "drawer"],
  ]) {
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

  /* ---- Drawer ------------------------------------------------------------------ */
  let drawerTab = -1;
  const rowOf = (ti) => {
    const btn = document.querySelector(`[data-all="${ti}"]`);
    return btn && btn.closest(".row");
  };

  function placeDrawer() {
    const top = $("tabbar").getBoundingClientRect().top;
    const row = rowOf(Panel.activeTab());
    const bottom = row ? window.innerHeight - row.getBoundingClientRect().top : 0;
    drawer.style.top = top + "px";
    drawer.style.bottom = bottom + "px";
  }

  function openDrawer() {
    const ti = Panel.activeTab();
    if (ti < 0) return;
    const t = cfg.tabs[ti];
    if (drawerTab !== ti) {
      $("drawerGrid").innerHTML = t.devices.map((d) => Panel.lightTile(d)).join("");
      t.devices.forEach((d) => Panel.renderLight(d.id));
      drawerTab = ti;
    }
    drawer.scrollTop = 0;
    placeDrawer();
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    document.querySelectorAll("[data-all]").forEach((b) => b.classList.toggle("open", +b.dataset.all === ti));
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
  const KNOB = 46;
  let vDrag = null;
  let vReleasedAt = 0;

  function setSlider(v, showLabel) {
    const h = vTrack.clientHeight || 1;
    const y = (v / 100) * (h - KNOB) + KNOB / 2; /* knob centre from the bottom */
    bright.querySelector(".vs-fill").style.height = y + "px";
    bright.querySelector(".vs-knob").style.bottom = y + "px";
    bright.dataset.value = v;
    $("brightLabel").textContent = showLabel ? v + "%" : "";
  }

  /* The slider belongs to the active section's lights; hidden where there are none. */
  function syncSlider() {
    const ti = Panel.activeTab();
    bright.hidden = ti < 0;
    if (ti < 0) return;
    const v = Panel.tabBrightness[ti];
    setSlider(v >= 0 ? v : 50, v >= 0);
  }

  function sliderValue(clientY) {
    const r = vTrack.getBoundingClientRect();
    const f = 1 - (clientY - r.top - KNOB / 2) / Math.max(1, r.height - KNOB);
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
    const ti = Panel.activeTab();
    if (ti < 0) return;
    const v = +bright.dataset.value;
    vReleasedAt = Date.now();
    Panel.tabBrightness[ti] = v;
    Panel.setBrightness(cfg.tabs[ti].lights.map((l) => l.id), v);
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
    floorsPage = document.querySelector(".floors-page");
    if (floorsPage) {
      floorView = floorsPage.querySelector(".floor-view");
      floorTrack = floorsPage.querySelector(".floor-track");
      railInd = floorsPage.querySelector(".rail-ind");
    }
    Panel.setSection(0, false);
    Panel.setFloor(0, false);
    urlReady = true;
    applyHash(false);
    syncSlider();
    requestAnimationFrame(() => {
      setIndicator(Panel.section, false);
      if (floorsPage) setRailInd(Panel.floorPos(Panel.floor), false);
    });
    /* Geometry-dependent pieces redraw whenever the layout changes. */
    new ResizeObserver(() => setSlider(+bright.dataset.value || 0, $("brightLabel").textContent !== "")).observe(vTrack);
    if (floorsPage) new ResizeObserver(() => setRailInd(Panel.floorPos(Panel.floor), false)).observe(floorsPage.querySelector(".rail-track"));
  };
})();
