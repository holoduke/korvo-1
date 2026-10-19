/* Start section: the house (js/house3d.js, from js/house-plan.js), turning
 * slowly, for two fingers to zoom, turn and tilt. It only draws while it is
 * on screen, and stops as soon as another section or an overlay takes over. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;

  const HINT_MS = 9000; /* the gesture hint goes on its own after this */

  /* The quick controls beside the house stand in two columns: on the left the
   * heating's thermostat (heating.js) with the energy (house-quick.js) above
   * it, on the right the garage door (covers.js) with the lights
   * (house-quick.js) and the music (audio.js) above it. Each column stands
   * with its bottom on one line with the ask bar (ask.js): level with its
   * bottom where it runs between them (a panel, an iPad), just above its top
   * where it runs under them (a phone). The left one stays below the readout
   * at the top left (hud.js), however many lines that has. A column with too
   * little room gives up, in turn, what it can do without (TIGHT). */
  const GAP = 10;
  const TIGHT = {
    left: ["no-quick-energy"],
    right: ["tight-door", "tight-now", "tight-off", "tight-mute", "no-quick-lights"], /* start.css */
  };
  const shown = (el) => !!el && !el.hidden && !!el.offsetParent;
  function layoutSides(house) {
    const box = house.getBoundingClientRect();
    const ask = house.querySelector(".house-ask");
    const a = ask && ask.offsetParent ? ask.getBoundingClientRect() : null;
    const hud = house.querySelector("[data-hud]");
    /* the music card as a bar along the top (a phone): the door's column stays below it */
    const musicEl = house.querySelector("[data-house-audio]");
    const musicBar = !!musicEl && !musicEl.hidden && getComputedStyle(musicEl).getPropertyValue("--aq-dock").trim() === "bar";
    house.classList.toggle("music-bar", musicBar);
    if (musicBar) musicEl.style.top = "";
    const columns = {
      left: { floor: hud ? hud.getBoundingClientRect().bottom - box.top + 12 : 8, items: ["[data-house-heat]", "[data-house-energy]"] },
      right: {
        floor: musicBar ? musicEl.getBoundingClientRect().bottom - box.top + 8 : 8,
        items: ["[data-house-cover]:not([data-house-audio])", "[data-house-lights]", ...(musicBar ? [] : ["[data-house-audio]"])],
      },
    };
    for (const [side, col] of Object.entries(columns)) {
      const left = side === "left";
      TIGHT[side].forEach((c) => house.classList.remove(c));
      for (let level = 0; ; level++) {
        const items = col.items.map((sel) => house.querySelector(sel)).filter(shown);
        if (!items.length) break;
        const r = items[0].getBoundingClientRect();
        const beside = a && (left ? a.left >= r.right : a.right <= r.left);
        const bottom = (a ? (beside ? a.bottom : a.top - 12) : box.bottom - 70) - box.top;
        const need = items.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0) + GAP * (items.length - 1);
        if (need > bottom - col.floor && level < TIGHT[side].length) {
          house.classList.add(TIGHT[side][level]);
          continue;
        }
        /* bottom up; what still does not fit runs off the top's floor rather than over the ask bar */
        let top = bottom;
        items.forEach((el, i) => {
          const h = el.getBoundingClientRect().height;
          top = i === 0 ? Math.max(col.floor, top - h) : top - GAP - h;
          el.style.top = `${Math.round(i === 0 ? top : Math.max(col.floor, top))}px`;
        });
        break;
      }
    }
  }
  Panel.on("start", () =>
    /* after every module has put its part in (they do on "start" too) */
    requestAnimationFrame(() => {
      const house = document.querySelector(".start-page .house");
      if (!house) return;
      const place = () => layoutSides(house);
      const ro = new ResizeObserver(place);
      [house, ...house.querySelectorAll(".house-ask, [data-hud], [data-house-heat], [data-house-cover], .house-quick")].forEach((el) => ro.observe(el));
      Panel.on("room", () => requestAnimationFrame(place)); /* a widget back from behind a room's panel */
      Panel.on("quickaudio", () => requestAnimationFrame(place)); /* the music card came or went */
      place();
    })
  );

  Panel.definePage("start", {
    className: "start-page",
    html: () =>
      `<div class="house"><canvas class="house-canvas"></canvas>` +
      `<div class="house-hint">${icon("expand")}<span>Twee vingers: draaien, kantelen en zoomen</span></div>` +
      `<div class="house-none" hidden>De 3D-weergave heeft WebGL nodig, dat deze browser niet geeft.</div></div>`,
    build(el) {
      const hint = el.querySelector(".house-hint");
      const HINT_AGAIN_MS = 7 * 86400e3; /* the hint returns after a week without a touch */
      const seen = () => {
        hint.classList.add("seen");
        Panel.setPref("houseTouched", Date.now());
      };
      if (Date.now() - (Panel.prefs.houseTouched || 0) < HINT_AGAIN_MS) hint.classList.add("seen");
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
        .map((o) => ({ key: o.key, sensor: o.sensor, id: (cards.find((c) => c.label === o.sensor) || { entities: {} }).entities.contact }))
        .filter((d) => d.id || console.warn(`house: no sensor card "${d.sensor}" for the plan's ${d.key}`));
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
      /* nor under the Vision screensaver, which covers the whole screen */
      const covered = () => !!(Panel.visionSaver && Panel.visionSaver.shown());
      const sync = () => house.setActive(!Panel.sleeping() && !covered() && (onScreen() || swiping));
      Panel.on("section", sync);
      Panel.on("vision", sync);
      Panel.on("sleep", sync);
      Panel.on("swiping", (on) => {
        swiping = on;
        sync();
      });
      Panel.on("start", sync);
      document.addEventListener("visibilitychange", () => (document.visibilityState === "visible" ? sync() : house.setActive(false)));
      Panel.house = house;
    },
  });
})();
