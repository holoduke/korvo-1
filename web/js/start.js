/* Start section: the house (js/house3d.js, from js/house-plan.js), turning
 * slowly, for two fingers to zoom, turn and tilt. It only draws while it is
 * on screen, and stops as soon as another section or an overlay takes over. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;

  const HINT_MS = 9000; /* the gesture hint goes on its own after this */

  Panel.definePage("start", {
    className: "start-page",
    html: () =>
      `<div class="house"><canvas class="house-canvas"></canvas>` +
      `<div class="house-hint">${icon("expand")}<span>Twee vingers: draaien, kantelen en zoomen</span></div>` +
      `<div class="house-none" hidden>De 3D-weergave heeft WebGL nodig, dat deze browser niet geeft.</div></div>`,
    build(el) {
      const hint = el.querySelector(".house-hint");
      const seen = () => hint.classList.add("seen");
      const house = Panel.house3d(el.querySelector("canvas"), window.HOUSE_PLAN, { onInteract: seen });
      if (!house) {
        el.querySelector(".house-none").hidden = false;
        hint.hidden = true;
        return;
      }
      setTimeout(seen, HINT_MS);
      /* A door or window with a contact sensor (sensor: a PANEL_SENSOR_CARDS
       * label) is lit red, pulsing, while it stands open. */
      const cards = cfg.sensorCards || [];
      const doors = (window.HOUSE_PLAN.openings || [])
        .filter((o) => o.key && o.sensor)
        .map((o) => ({ key: o.key, id: (cards.find((c) => c.label === o.sensor) || { entities: {} }).entities.contact }))
        .filter((d) => d.id || console.warn(`house: no sensor card "${d.key}" for the plan's ${d.key}`));
      const syncDoors = (changed, first) =>
        doors.forEach((d) => {
          const open = (Panel.st(d.id) || {}).state === "on";
          if (open && !house.highlights().includes(d.key)) {
            house.highlight(d.key, { colour: [1, 0.3, 0.25], pulse: true });
            /* a door that just opened: the house turns to show it */
            if (!first && changed.includes(d.id)) house.spotlight(d.key);
          }
          if (!open) house.clearHighlight(d.key);
        });
      Panel.track(doors.map((d) => d.id), syncDoors);
      let swiping = false;
      const onScreen = () => Panel.onScreen("start");
      /* While a swipe is under way the page may be partly in view: keep drawing. */
      const sync = () => house.setActive(onScreen() || swiping);
      Panel.on("section", sync);
      Panel.on("swiping", (on) => {
        swiping = on;
        sync();
      });
      Panel.on("start", sync);
      document.addEventListener("visibilitychange", () => house.setActive(document.visibilityState === "visible" && (onScreen() || swiping)));
      Panel.house = house;
    },
  });
})();
