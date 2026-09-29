/* The ground floor's heating: the heat pump (NIBE) heats downstairs only, to
 * the setpoint of its room sensor (BT50). Every control that changes it goes
 * through here — the thermostat beside the house on the Start screen, the
 * heating row of a ground-floor room's panel, the heat pump's card — so the
 * pump gets one write for a run of taps: the figure follows each tap at
 * once, and when the taps stop (SETTLE_MS) the setpoint is sent; until the
 * pump confirms it, the target shows as pending, and if it never does, the
 * old value comes back with a message.
 */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const pump = (cfg.appliances || []).find((a) => a.kind === "heatpump");
  const E = pump ? pump.entities : {};
  const SETTLE_MS = 1200;
  /* the pump is read through myUplink (NIBE's cloud), polled: its confirmation can take a while */
  const CONFIRM_MS = 90000;
  const fmt = Util.fmt;

  const num = (id) => Panel.num(id);
  const attrs = (id) => ((id && Panel.st(id)) || {}).attributes || {};
  const low = (id) => String(((id && Panel.st(id)) || {}).state || "").toLowerCase();

  let pending = null; /* {value, timer (send), confirm (timer)} */
  const changed = new Set();
  const emit = () => {
    changed.forEach((fn) => fn());
    Panel.emit("heating"); /* the heat pump's card follows a pending setpoint too */
  };

  function target() {
    return pending ? pending.value : num(E.roomHeat);
  }
  function step(dir) {
    const cur = target();
    if (!Number.isFinite(cur)) return;
    const a = attrs(E.roomHeat);
    const st = a.step || 0.5;
    const value = Math.round(Util.clamp(cur + dir * st, a.min ?? 5, a.max ?? 35) * 100) / 100;
    if (pending) {
      clearTimeout(pending.timer);
      clearTimeout(pending.confirm);
    }
    pending = { value, sent: false, timer: setTimeout(send, SETTLE_MS), confirm: 0 };
    Panel.sound && Panel.sound.tap && Panel.sound.tap();
    emit();
  }
  function send() {
    if (!pending) return;
    const p = pending;
    p.sent = true;
    emit();
    if (num(E.roomHeat) === p.value) return settle();
    Panel.client.callService("number", "set_value", { value: p.value }, { entity_id: E.roomHeat }).catch((err) => {
      if (pending === p) pending = null;
      emit();
      Panel.commandFailed("Verwarming")(err);
    });
    p.confirm = setTimeout(() => {
      if (pending !== p) return;
      pending = null;
      emit();
      Panel.toast("De warmtepomp neemt de temperatuur niet over", "warn");
    }, CONFIRM_MS);
  }
  function settle() {
    if (!pending) return;
    clearTimeout(pending.timer);
    clearTimeout(pending.confirm);
    pending = null;
    emit();
  }
  if (pump) {
    Panel.track([E.roomHeat, E.room, E.status, E.compressor].filter(Boolean), () => {
      if (pending && pending.sent && num(E.roomHeat) === pending.value) settle();
      else emit();
    });
  }

  /* What it is doing: heating the house, making hot water, or resting. */
  function doing() {
    const status = low(E.status);
    const running = ["operating", "starting"].includes(low(E.compressor));
    if (status === "heating" || (running && status !== "hot water" && status !== "cooling")) return { text: "verwarmt", tone: "warm" };
    if (status === "hot water") return { text: "maakt warm water", tone: "" };
    if (status === "cooling") return { text: "koelt", tone: "cold" };
    return { text: "in rust", tone: "" };
  }

  const deg = (v, d = 1) => (Number.isFinite(v) ? `${fmt(v, d)}°` : "--");
  const range = () => attrs(E.roomHeat);
  const canDown = () => Number.isFinite(target()) && target() > (range().min ?? 5);
  const canUp = () => Number.isFinite(target()) && target() < (range().max ?? 35);

  /* ---- The thermostat beside the house ------------------------------------------ */
  function widgetHtml() {
    return (
      `<div class="house-heat" data-house-heat>` +
      `<div class="hh-title">${icon("flame")}<span>Verwarming</span></div>` +
      `<div class="hh-now"><b data-hh-room>--</b><span>binnen</span></div>` +
      `<div class="hh-set"><button class="hh-btn" data-heat-step="-1" aria-label="Kouder">${icon("minus")}</button>` +
      `<span class="hh-target"><b data-hh-target>--</b><span data-hh-label>doel</span></span>` +
      `<button class="hh-btn" data-heat-step="1" aria-label="Warmer">${icon("plus")}</button></div>` +
      `<div class="hh-state" data-hh-state></div>` +
      `</div>`
    );
  }
  function renderWidget(el) {
    if (!el) return;
    const t = target();
    const d = doing();
    el.classList.toggle("pending", !!pending);
    el.classList.toggle("warm", d.tone === "warm");
    el.querySelector("[data-hh-room]").textContent = deg(num(E.room));
    el.querySelector("[data-hh-target]").textContent = deg(t);
    el.querySelector("[data-hh-label]").textContent = pending ? (pending.sent ? "instellen…" : "doel") : "doel";
    el.querySelector("[data-hh-state]").textContent = d.text;
    el.querySelector('[data-heat-step="-1"]').disabled = !canDown();
    el.querySelector('[data-heat-step="1"]').disabled = !canUp();
  }

  /* ---- The row in a ground-floor room's panel --------------------------------------- */
  const roomRowHtml = () =>
    `<div class="hi-heat-row">${icon("flame")}<span class="hi-heat-text"><b>Verwarming</b><span data-hh-state></span></span>` +
    `<button class="hh-btn" data-heat-step="-1" aria-label="Kouder">${icon("minus")}</button>` +
    `<span class="hh-target"><b data-hh-target>--</b><span data-hh-label>doel</span></span>` +
    `<button class="hh-btn" data-heat-step="1" aria-label="Warmer">${icon("plus")}</button></div>`;
  function renderRow(el) {
    if (!el) return;
    const d = doing();
    el.classList.toggle("pending", !!pending);
    el.querySelector("[data-hh-target]").textContent = deg(target());
    el.querySelector("[data-hh-label]").textContent = pending && pending.sent ? "instellen…" : "doel";
    el.querySelector("[data-hh-state]").textContent = `${deg(num(E.room))} binnen · ${d.text}`;
    el.querySelector('[data-heat-step="-1"]').disabled = !canDown();
    el.querySelector('[data-heat-step="1"]').disabled = !canUp();
  }

  let widget = null;
  Panel.on("start", () => {
    const house = document.querySelector(".start-page .house");
    if (!house || !pump || !E.roomHeat) return;
    house.insertAdjacentHTML("beforeend", widgetHtml());
    widget = house.querySelector("[data-house-heat]");
    widget.addEventListener("click", (e) => {
      const b = e.target.closest("[data-heat-step]");
      if (b && !b.disabled) step(+b.dataset.heatStep);
    });
    /* touches on the widget stay with it: no section swipe, no house orbit */
    ["pointerdown", "touchstart"].forEach((ev) => widget.addEventListener(ev, (e) => e.stopPropagation(), { passive: true }));
    renderWidget(widget);
    /* Just above the middle (clear of the ask bar), and below the lines of the
     * readout at the top left, however many of them there are. */
    const hud = house.querySelector("[data-hud]");
    const place = () => {
      if (!widget.offsetParent) return;
      const box = house.getBoundingClientRect();
      const h = widget.offsetHeight;
      const wanted = box.height / 2 - 36 - h / 2;
      const below = hud ? hud.getBoundingClientRect().bottom - box.top + 12 : 0;
      const lowest = box.height - h - 64; /* above the layer buttons along the bottom */
      widget.style.top = `${Math.round(Math.max(0, Math.min(Math.max(wanted, below), lowest)))}px`;
    };
    const ro = new ResizeObserver(place);
    ro.observe(house);
    if (hud) ro.observe(hud);
    ro.observe(widget);
  });
  /* it steps aside while a room's panel is open (that panel has the row itself) */
  Panel.on("room", (room) => widget && (widget.hidden = !!room));
  changed.add(() => {
    renderWidget(widget);
    document.querySelectorAll("[data-heat-row]").forEach(renderRow);
  });
  Panel.on("loaded", emit);

  Panel.heating = {
    available: () => !!(pump && E.roomHeat && Panel.st(E.roomHeat) && !Panel.unavailable(Panel.st(E.roomHeat))),
    target,
    step,
    pending: () => !!pending,
    /* The heating row for a room's panel (room.js), filled and kept current here. */
    rowHtml: () => `<div class="hi-heat" data-heat-row>${roomRowHtml()}</div>`,
    fill: (root) => root && root.querySelectorAll("[data-heat-row]").forEach(renderRow),
    /* whether a room of the plan is heated: the ground floor, not the garage */
    heats: (room) => !!room && room.floor === "0" && !room.door && room.cover == null,
  };
})();
