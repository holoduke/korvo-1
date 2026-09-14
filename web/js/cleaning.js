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
