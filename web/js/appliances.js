/* Apparaten section: the appliances in a list on the left (icon, name and
 * what each is doing) and the chosen one's card on the right: its state, one
 * large value, progress where it reports it, a few figures and its own
 * controls. The chosen appliance is part of the URL (#apparaten/wasmachine).
 *
 * A kind of appliance is defined with Panel.defineAppliance(kind, {icon,
 * view(appliance, index), actions}) in appliance-kinds.js and media-kinds.js,
 * using the controls in Panel.applianceUi. view returns {tone, pill, big, word,
 * unit, sub, progress, extra, stats, controls}; a control marked
 * data-appl="<index>|<action>|<args>" runs actions[action](appliance, args, call).
 * Controls marked for confirmation ask for a second tap. A kind that can be
 * switched off gives off: {active(a), run(a, call)} for the bottom row's
 * "Alle apparaten uit".
 *
 * Product photos come from photos.js (Home Assistant's www folder, not this
 * repository); an appliance without a photo keeps its icon. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const { esc } = Util;
  const list = cfg.appliances || [];
  const CONFIRM_MS = 3000;
  const PENDING_MS = 10000;

  const kinds = {};
  Panel.defineAppliance = (kind, def) => (kinds[kind] = def);

  const twoTap = Util.confirmer(CONFIRM_MS, () => render());
  const pending = Util.pendingSet(PENDING_MS, () => render());
  let root = null;
  /* After a rotation the two-column layout stacks (or the list flips scroll axis):
   * snap the card and list back to the top so nothing is left half-scrolled. */
  Util.onOrientationFlip(() => root && root.querySelectorAll(".ap-detail, .ap-list").forEach((el) => (el.scrollLeft = el.scrollTop = 0)));
  let selected = 0;

  /* An appliance's product photo, once photos.js has the picture for its name. */
  const photoOf = (a) => Panel.photoUrl(a.label);
  Panel.on("photos", () => render());

  /* ---- Controls and state values for the kinds ---------------------------------------- */
  const s = (id) => (id ? Panel.st(id) : undefined);
  const raw = (id) => (s(id) || {}).state || "";
  const ui = {
    s,
    raw,
    low: (id) => raw(id).toLowerCase(),
    num: (id) => Panel.num(id),
    on: (id) => raw(id) === "on",
    attrs: (id) => (s(id) || {}).attributes || {},
    offline: (id) => !s(id) || raw(id) === "unavailable",
    btn(i, action, label, { primary = false, active = false, disabled = false, confirm = false, ic = null } = {}) {
      const key = `${i}|${action}`;
      const armed = twoTap.armed(key);
      const cls = ["ap-btn", primary && "primary", active && "on", armed && "armed", pending.has(key) && "pending"].filter(Boolean).join(" ");
      return (
        `<button class="${cls}" data-appl="${esc(key)}"${confirm ? " data-confirm" : ""}${disabled ? " disabled" : ""}>` +
        `${ic ? icon(ic) : ""}<span>${armed ? "Nogmaals tikken" : esc(label)}</span></button>`
      );
    },
    chip(i, action, label, active, disabled) {
      const key = `${i}|${action}`;
      return `<button class="ap-chip${active ? " active" : ""}${pending.has(key) ? " pending" : ""}" data-appl="${esc(key)}"${disabled ? " disabled" : ""}>${esc(label)}</button>`;
    },
    /* -, a value, + for stepping a number up or down. */
    stepper(i, action, text, { canDown, canUp, down = "Lager", up = "Hoger", wide = false }) {
      return (
        `<div class="ap-stepper${wide ? " wide" : ""}">` +
        `<button class="ap-btn" data-appl="${esc(`${i}|${action}|-1`)}" aria-label="${down}"${canDown ? "" : " disabled"}>${icon("minus")}</button>` +
        `<b>${esc(text)}</b>` +
        `<button class="ap-btn" data-appl="${esc(`${i}|${action}|1`)}" aria-label="${up}"${canUp ? "" : " disabled"}>${icon("plus")}</button>` +
        `</div>`
      );
    },
    stat: (label, value) => `<div class="ap-stat"><span>${label}</span><b>${esc(value)}</b></div>`,
    note: (text) => `<p class="ap-note">${esc(text)}</p>`,
    offlineView: (text) => ({ tone: "offline", pill: "Offline", big: "Offline", word: true, sub: "", stats: [], controls: ui.note(text) }),
  };
  Panel.applianceUi = ui;

  const UNKNOWN = { icon: "power", view: () => ui.offlineView("Onbekend soort apparaat") };
  const kindOf = (a) => kinds[a.kind] || UNKNOWN;
  /* Every appliance's label and tone (run, paused, error, off, ...) for the readout on the house. */
  Panel.applianceTones = () => list.map((a, i) => ({ label: a.label, tone: kindOf(a).view(a, i).tone }));

  /* ---- Build and render ------------------------------------------------------------ */
  function build(page) {
    root = page.querySelector(".ap");
    root.innerHTML =
      `<nav class="ap-list" aria-label="Apparaten">` +
      list
        .map(
          (a, i) =>
            `<button class="ap-item" data-pick="${i}"><span class="ap-badge"></span>` +
            `<span class="ap-item-text"><b>${esc(a.label)}</b><small></small></span></button>`
        )
        .join("") +
      `</nav>` +
      `<div class="ap-detail"><article class="ap-card">` +
      `<div class="ap-top"><div class="ap-main">` +
      `<header class="ap-head"><span class="ap-badge"></span><div class="ap-title"><b></b></div><span class="ap-pill"></span></header>` +
      `<div class="ap-body"><div class="ap-hero"><div class="ap-value"><b class="ap-big"></b><span class="ap-unit"></span></div><span class="ap-sub"></span></div>` +
      `<div class="ap-extra"></div></div>` +
      `</div><figure class="ap-figure" hidden><img alt=""></figure></div>` +
      `<div class="ap-bar"><b></b></div><div class="ap-stats"></div><div class="ap-controls"></div>` +
      `</article></div>`;
    render();
  }

  /* A badge shows the appliance's photo when there is one, else its icon. */
  function renderBadge(badge, a) {
    const photo = photoOf(a);
    const want = photo || `icon:${a.kind}`;
    if (badge.dataset.show === want) return;
    badge.dataset.show = want;
    badge.classList.toggle("photo", !!photo);
    badge.innerHTML = photo ? `<img src="${photo}" alt="">` : icon(kindOf(a).icon);
  }

  function render() {
    if (!root) return;
    /* A command whose entity never answered: say so, like the robots do. */
    pending.settle().forEach((key) => Panel.toast(`${list[+key.split("|")[0]].label}: geen reactie van het apparaat`));
    renderRow();
    list.forEach((a, i) => {
      const view = kindOf(a).view(a, i);
      const item = root.querySelector(`[data-pick="${i}"]`);
      item.className = `ap-item tone-${view.tone}${i === selected ? " active" : ""}`;
      item.querySelector("small").textContent = view.pill || "";
      renderBadge(item.querySelector(".ap-badge"), a);
      if (i === selected) renderCard(a, i, view);
    });
  }

  function renderCard(a, i, view) {
    const card = root.querySelector(".ap-card");
    card.className = `ap-card tone-${view.tone}`;
    card.dataset.applCard = i; /* which appliance the card shows (the tests read it) */
    card.dataset.kind = a.kind;
    /* With a photo, the photo stands beside the header; otherwise the icon leads the title. */
    const photo = photoOf(a);
    const figure = card.querySelector(".ap-figure");
    figure.hidden = !photo;
    if (photo && figure.dataset.src !== photo) {
      figure.dataset.src = photo;
      figure.querySelector("img").src = photo;
    }
    const badge = card.querySelector(".ap-head .ap-badge");
    badge.hidden = !!photo;
    renderBadge(badge, a);
    card.querySelector(".ap-title b").textContent = a.label;
    card.querySelector(".ap-pill").textContent = view.pill || "";
    const bigEl = card.querySelector(".ap-big");
    bigEl.textContent = view.big ?? "";
    bigEl.classList.toggle("word", !!view.word);
    card.querySelector(".ap-unit").textContent = view.unit || "";
    card.querySelector(".ap-sub").textContent = view.sub || "";
    card.querySelector(".ap-extra").innerHTML = view.extra || "";
    const bar = card.querySelector(".ap-bar");
    bar.hidden = view.progress == null || (view.progress !== "busy" && !Number.isFinite(view.progress));
    bar.classList.toggle("busy", view.progress === "busy");
    bar.querySelector("b").style.width = Number.isFinite(view.progress) ? `${Util.clamp(view.progress, 2, 100)}%` : "";
    const stats = card.querySelector(".ap-stats");
    stats.innerHTML = (view.stats || []).join("");
    stats.hidden = !(view.stats || []).length;
    card.querySelector(".ap-controls").innerHTML = view.controls || "";
  }

  function select(i) {
    if (i === selected || !list[i]) return;
    selected = i;
    root.querySelector(".ap-detail").scrollTop = 0;
    render();
    Panel.emit("route");
  }

  /* ---- Actions --------------------------------------------------------------------- */
  Panel.defineAction("pick", (el) => select(+el.dataset.pick));
  /* A service call for an appliance, marked pending under key until the entity
   * it addresses reports something new (not any of the appliance's entities:
   * a washer's power meter ticks whether or not the command landed). */
  function callFor(a, key) {
    return (domain, service, data, entity) => {
      if (!entity) return;
      const snapshot = () => {
        const s = Panel.st(entity);
        return s ? JSON.stringify([s.state, s.attributes]) : "";
      };
      pending.mark(key, snapshot);
      Panel.client.callService(domain, service, data || null, { entity_id: entity }).catch((err) => {
        pending.drop(key);
        render();
        Panel.commandFailed(a.label)(err);
      });
    };
  }
  Panel.defineAction("appl", (el) => {
    const key = el.dataset.appl;
    const [index, action, ...args] = key.split("|");
    const a = list[+index];
    const act = a && (kindOf(a).actions || {})[action];
    if (!act || !twoTap.tap(key, el.hasAttribute("data-confirm"))) return;
    act(a, args, callFor(a, key));
    render();
  });

  /* ---- "Alle apparaten uit" (the bottom row) ---------------------------------------- */
  /* A kind that can be switched off says so with off: {active(a), run(a, call)}:
   * the tv and speakers off or silent, a pc to sleep, a running oven or
   * dishwasher program stopped, a cleaning robot home. Laundry keeps running
   * and the fridge and hob are left alone. A second tap confirms. */
  const ALL_OFF = "alloff";
  const switchable = () => list.filter((a) => kindOf(a).off && kindOf(a).off.active(a));
  Panel.defineAction(ALL_OFF, () => {
    if (!twoTap.tap(ALL_OFF, true)) return;
    const todo = switchable();
    todo.forEach((a) => kindOf(a).off.run(a, callFor(a, `${list.indexOf(a)}|off`)));
    Panel.toast(todo.length ? `${todo.length === 1 ? "1 apparaat" : `${todo.length} apparaten`} uitgezet` : "Alles staat al uit");
    render();
  });
  function renderRow() {
    const row = document.querySelector(".ap-bottom");
    if (!row) return;
    const n = switchable().length;
    row.querySelector(".pill b").textContent = n ? `${n} ${n === 1 ? "apparaat" : "apparaten"}` : "niets";
    const btn = row.querySelector("[data-alloff]");
    btn.classList.toggle("armed", twoTap.armed(ALL_OFF));
    btn.querySelector(".txt").textContent = twoTap.armed(ALL_OFF) ? "Nogmaals tikken" : "Alle apparaten uit";
  }

  Panel.definePage("appliances", {
    className: "appl-page",
    html: () =>
      `<div id="applPage" class="ap"></div>` +
      `<div class="row ap-bottom"><div class="pill"><span><span class="lbl">Aan:</span><b>-</b></span></div>` +
      `<button class="allbtn ap-alloff" data-alloff>${icon("power")}<span class="txt">Alle apparaten uit</span></button></div>`,
    build,
    route: {
      path: () => Util.slug(list[selected].label),
      go([slug]) {
        const i = list.findIndex((a) => Util.slug(a.label) === slug);
        if (i >= 0) select(i);
      },
    },
  });
  /* Not while another section is shown: the page is rebuilt once it comes back. */
  const shown = Panel.whenShown("appliances", render);
  Panel.track(
    list.flatMap((a) => Object.values(a.entities)),
    shown
  );
  /* Time left moves on its own (the washer reports a finish time). */
  setInterval(shown, 30000);
})();
