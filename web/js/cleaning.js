/* Schoonmaak section: a panel per robot vacuum, one per floor, picked with a
 * floor rail like Verlichting's (only when there is more than one robot). The
 * chosen floor is the URL part (#schoonmaak/1); the robot on the PANEL_VACUUM
 * floor is the default. Robot modules register with
 *   Panel.defineRobot({floor, className, html(), build(panelElement)})
 * where floor is the PANEL_FLOORS label of the floor it cleans. Emits "robot"
 * (floor) when the robot shown changes; Panel.robotOnScreen(floor) says whether
 * that robot is what the user sees now. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;

  const robots = [];
  Panel.defineRobot = (def) => robots.push(def);

  const floorIndex = (label) => cfg.floors.findIndex((f) => f.label === label);
  /* The highest floor on top, as on Verlichting's rail. */
  const ordered = () => [...robots].sort((a, b) => floorIndex(b.floor) - floorIndex(a.floor));
  const home = () => (cfg.vacuum && robots.some((r) => r.floor === cfg.vacuum.floor) ? cfg.vacuum.floor : ordered()[0].floor);

  let page = null;
  let shown = null; /* floor label of the robot shown */
  let placeInd = null;

  Panel.robotOnScreen = (floor) => cfg.sections[Panel.section].kind === "vacuum" && shown === floor;
  /* The status block both robot panels open with: what the robot is doing now,
   * a line of detail under it and its battery, with the robot's picture beside
   * them at the height of that block (label is the name the photo is filed
   * under). Its module fills .vs-status, .vs-substatus and .vs-batt. */
  Panel.robotHeroHtml = (entity, label) =>
    `<div class="vs-hero"><div class="vs-hero-top"><div class="vs-hero-text">` +
    `<div class="vs-head"><b class="vs-status"></b><span class="vs-substatus"></span></div>` +
    `<div class="vs-batt">${icon("battery")}<span></span><i><b></b></i></div></div>` +
    `<figure class="vs-photo" data-photo="${Util.esc(label || "")}" hidden><img alt=""></figure></div>` +
    `<div class="vs-alert" hidden>${icon("warning")}<span></span>${Panel.reconnectHtml(entity)}</div></div>`;
  /* The pictures arrive from Home Assistant after the page is built (photos.js). */
  function fillPhotos() {
    if (!page) return;
    page.querySelectorAll(".vs-photo").forEach((fig) => {
      const url = Panel.photoUrl(fig.dataset.photo);
      fig.hidden = !url;
      if (url && fig.dataset.src !== url) {
        fig.dataset.src = url;
        fig.querySelector("img").src = url;
      }
    });
  }
  Panel.on("photos", fillPhotos);
  /* A setting with an on/off switch; attrs make it an action (its module sets "on"). */
  Panel.settingHtml = (attrs, label) => `<button class="vs-setting" ${attrs}><span>${label}</span><i class="toggle-pill"></i></button>`;
  /* For a robot Home Assistant cannot reach, or whose connection went quiet: reload
   * its integration (as "Opnieuw laden" in Home Assistant does). Starts hidden. */
  Panel.reconnectHtml = (entity) => `<button class="vs-alert-btn" data-reconnect="${entity}" hidden>Opnieuw verbinden</button>`;
  const RECONNECT_BUSY_MS = 20000;
  Panel.defineAction("reconnect", (el) => {
    el.disabled = true;
    el.textContent = "Bezig met verbinden";
    setTimeout(() => {
      el.disabled = false;
      el.textContent = "Opnieuw verbinden";
    }, RECONNECT_BUSY_MS);
    Panel.client
      .callService("homeassistant", "reload_config_entry", null, { entity_id: el.dataset.reconnect })
      .catch(Panel.commandFailed("Opnieuw verbinden"));
  });
  /* What a robot's panel says when Home Assistant cannot reach it (its vacuum state). */
  Panel.unreachableText = (s) =>
    `Niet bereikbaar${s && s.lastChanged ? ` sinds ${Util.stamp(s.lastChanged)}` : ""}: Home Assistant krijgt geen verbinding met de robot. Staat hij aan en binnen bereik van de wifi?`;

  function show(floor, animate) {
    const i = ordered().findIndex((r) => r.floor === floor);
    if (!page || i < 0) return;
    const changed = floor !== shown;
    shown = floor;
    page.querySelectorAll("[data-robot-panel]").forEach((el) => (el.hidden = el.dataset.robotPanel !== floor));
    page.querySelectorAll("[data-robot]").forEach((el) => el.classList.toggle("active", el.dataset.robot === floor));
    if (placeInd) placeInd(i, animate);
    if (changed) {
      Panel.emit("robot", floor);
      Panel.emit("route");
    }
  }

  Panel.definePage("vacuum", {
    className: "vac-page",
    html: () => {
      const list = ordered();
      const rail =
        list.length > 1
          ? Panel.railHtml(list.map((r) => ({ key: r.floor, label: r.floor, name: cfg.floors[floorIndex(r.floor)].name })), "data-robot")
          : "";
      return rail + `<div class="robots">${list.map((r) => `<div class="robot ${r.className}" data-robot-panel="${r.floor}" hidden>${r.html()}</div>`).join("")}</div>`;
    },
    build(el) {
      page = el;
      el.classList.toggle("with-rail", robots.length > 1);
      robots.forEach((r) => r.build(el.querySelector(`[data-robot-panel="${r.floor}"]`)));
      fillPhotos();
      const nav = el.querySelector(".rail");
      placeInd = nav ? Panel.railIndicator(nav) : null;
      show(home(), false);
    },
    route: {
      path: () => (shown === home() ? "" : shown),
      go: ([floor], animate) => show(robots.some((r) => r.floor === floor) ? floor : home(), animate),
    },
  });

  Panel.defineAction("robot", (el) => show(el.dataset.robot, true));

  Panel.on("start", () => {
    if (!placeInd) return;
    const place = () => placeInd(ordered().findIndex((r) => r.floor === shown), false);
    requestAnimationFrame(place);
    new ResizeObserver(place).observe(page.querySelector(".rail-track"));
  });
})();
