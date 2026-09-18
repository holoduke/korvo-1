/* Brightness controls: the vertical slider in the stage's right lane (the
 * chosen room's lamps, else the active tab's lights; hidden where there are
 * none) and the light popup a long press opens, with brightness, colour and
 * warmth sliders. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;

  const SYNC_HOLDOFF = 2500; /* ms after a slider release before HA may move it */
  const KNOB = 46;

  /* ---- Vertical slider ------------------------------------------------------------- */
  const bright = $("bright");
  const vTrack = bright.querySelector(".vs-track");
  let dragId = null;
  let releasedAt = 0;
  let startY = 0;
  let engaged = false; /* the touch has moved enough to be a real drag, not a tap */
  const ENGAGE = 6; /* px of vertical travel before the slider takes the touch */
  /* The rendered knob is smaller on phones (CSS) than the desktop default, so
   * read it rather than trust the constant, or the ends miss 0/100%. */
  const knobH = () => vTrack.parentElement.querySelector(".vs-knob").offsetHeight || KNOB;

  function setSlider(v, showLabel) {
    const h = vTrack.clientHeight || 1;
    const k = knobH();
    const y = (v / 100) * (h - k) + k / 2; /* knob centre from the bottom */
    bright.querySelector(".vs-fill").style.height = y + "px";
    bright.querySelector(".vs-knob").style.bottom = y + "px";
    bright.dataset.value = v;
    $("brightLabel").textContent = showLabel ? v + "%" : "";
  }

  /* What the slider sets, or null where there is nothing to set. */
  function scope() {
    const ti = Panel.activeTab();
    if (ti < 0) return null;
    const area = Panel.activeArea();
    if (area) return { ids: area.lights.filter((id) => Panel.st(id)), value: Panel.areaBrightness(area), area: true, ti };
    return { ids: cfg.tabs[ti].lights.map((l) => l.id), value: Panel.tabBrightness[ti], area: false, ti };
  }

  function sync() {
    const s = scope();
    bright.hidden = !s;
    if (s) setSlider(s.value >= 0 ? s.value : 50, s.value >= 0);
  }

  /* A new brightness from Home Assistant, unless a finger is (just) on the slider. */
  Panel.showBrightness = function (v) {
    if (dragId !== null || Date.now() - releasedAt < SYNC_HOLDOFF) return;
    setSlider(v, true);
  };

  function valueAt(clientY) {
    const r = vTrack.getBoundingClientRect();
    const k = knobH();
    return Math.round(Util.clamp(1 - (clientY - r.top - k / 2) / Math.max(1, r.height - k), 0, 1) * 100);
  }
  /* The slider fills the whole right lane, so a tap or a stray brush there must
   * not change the lamps: it only engages once the finger has actually slid a
   * few pixels vertically, and a press that never engages leaves the lamps be. */
  vTrack.addEventListener("pointerdown", (e) => {
    dragId = e.pointerId;
    startY = e.clientY;
    engaged = false;
    vTrack.setPointerCapture(e.pointerId);
  });
  vTrack.addEventListener("pointermove", (e) => {
    if (dragId !== e.pointerId) return;
    if (!engaged) {
      if (Math.abs(e.clientY - startY) < ENGAGE) return;
      engaged = true;
      bright.classList.add("dragging");
    }
    setSlider(valueAt(e.clientY), true);
  });
  const release = (e) => {
    if (dragId !== e.pointerId) return;
    dragId = null;
    bright.classList.remove("dragging");
    if (!engaged) return; /* a bare tap or a brush: leave the lamps alone */
    engaged = false;
    const s = scope();
    if (!s || !s.ids.length) return;
    const v = +bright.dataset.value;
    releasedAt = Date.now();
    if (!s.area) Panel.tabBrightness[s.ti] = v;
    Panel.setBrightness(s.ids, v);
  };
  vTrack.addEventListener("pointerup", release);
  vTrack.addEventListener("pointercancel", release);

  Panel.on("section", sync);
  Panel.on("floor", sync);
  Panel.on("area", sync);
  Panel.on("swiping", (on) => bright.classList.toggle("dim", on));
  Panel.on("start", () => {
    sync();
    new ResizeObserver(() => setSlider(+bright.dataset.value || 0, $("brightLabel").textContent !== "")).observe(vTrack);
  });

  /* ---- Light popup ---------------------------------------------------------------- */
  const PAD = 20; /* keeps the knob inside the rounded ends */
  function horizontalSlider(el, opts) {
    const state = { ...opts };
    const knob = el.querySelector(".hs-knob");
    const fill = el.querySelector(".hs-fill");
    function show(v) {
      state.value = v;
      const x = PAD + ((v - state.min) / Math.max(1, state.max - state.min)) * (el.clientWidth - 2 * PAD);
      knob.style.left = x + "px";
      if (fill) fill.style.width = x + PAD + "px";
      if (state.tint) knob.style.background = state.tint(v);
    }
    function valueAtX(clientX) {
      const r = el.getBoundingClientRect();
      const f = Util.clamp((clientX - r.left - PAD) / Math.max(1, r.width - 2 * PAD), 0, 1);
      return Math.round(state.min + f * (state.max - state.min));
    }
    let id = null;
    el.addEventListener("pointerdown", (e) => {
      id = e.pointerId;
      el.setPointerCapture(id);
      show(valueAtX(e.clientX));
    });
    el.addEventListener("pointermove", (e) => id === e.pointerId && show(valueAtX(e.clientX)));
    const end = (e) => {
      if (id !== e.pointerId) return;
      id = null;
      state.onCommit(state.value);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    /* The popup box is width-capped, so it narrows when the phone rotates into
     * portrait: reposition the knob for the new width instead of leaving it at
     * its old pixel offset until the next touch. */
    new ResizeObserver(() => show(state.value)).observe(el);
    return {
      set(o) {
        Object.assign(state, o);
        requestAnimationFrame(() => show(state.value));
      },
    };
  }

  let popupLight = null;
  const hBright = horizontalSlider($("popupBright"), { min: 0, max: 100, value: 50, onCommit: (v) => Panel.setBrightness([popupLight], v) });
  const hHue = horizontalSlider($("popupColor"), {
    min: 0,
    max: 359,
    value: 40,
    tint: (v) => `hsl(${v} 100% 50%)`,
    onCommit: (v) => Panel.setHue(popupLight, v),
  });
  const hWarm = horizontalSlider($("popupWarm"), { min: 2200, max: 6500, value: 4000, onCommit: (v) => Panel.setKelvin(popupLight, v) });

  Panel.openLightPopup = function (id) {
    const s = Panel.st(id);
    if (!s || s.state === "unavailable") return;
    popupLight = id;
    $("popupTitle").textContent = Panel.lightLabel(id);
    $("popupName").value = Panel.lightLabel(id);
    $("popupRename").disabled = true;
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
      hWarm.set({
        min: caps.minK,
        max: caps.maxK,
        value: s.attributes.color_temp_kelvin || Math.round(caps.minK + span / 2),
        tint: (v) => {
          const t = ((v - caps.minK) * 255) / Math.max(1, span);
          return `rgb(255 ${180 + t / 4} ${110 + t / 2})`;
        },
      });
    }
  };

  $("popup").addEventListener("click", (e) => e.target === $("popup") && Panel.closeOverlay($("popup")));
  $("popupClose").innerHTML = icon("close");
  $("popupClose").addEventListener("click", () => Panel.closeOverlay($("popup")));

  /* The lamp's name: saved to Home Assistant, so every panel shows it. */
  $("popupName").addEventListener("input", () => ($("popupRename").disabled = $("popupName").value.trim() === Panel.lightLabel(popupLight)));
  $("popupName").addEventListener("keydown", (e) => e.key === "Enter" && !$("popupRename").disabled && $("popupRename").click());
  $("popupRename").addEventListener("click", async () => {
    const id = popupLight;
    const name = $("popupName").value.trim();
    if (!name) return;
    $("popupRename").disabled = true;
    try {
      await Panel.renameLight(id, name);
      $("popupTitle").textContent = Panel.lightLabel(id);
      $("popupName").blur();
      Panel.toast(`Lamp heet nu ${name}`, "ok");
    } catch (err) {
      $("popupRename").disabled = false;
      Panel.toast(`Naam opslaan lukte niet: ${(err && err.message) || err}`);
    }
  });
})();
