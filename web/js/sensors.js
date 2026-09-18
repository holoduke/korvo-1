/* Sensoren section: a live card per sensor device (presence, motion, doors,
 * air quality, temperature and humidity), grouped by what they sense. A card
 * lights up briefly whenever one of its readings changes, so activity shows
 * while walking past; presence, motion and an open door stay highlighted.
 * Each card says when its main reading last changed. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const { esc, fmt } = Util;
  const cards = cfg.sensorCards || [];

  const GROUPS = [
    ["Aanwezigheid en beweging", ["presence", "motion"]],
    ["Deuren en ramen", ["door", "window"]],
    ["Lucht en klimaat", ["air", "climate"]],
  ];
  const ICON = { presence: "person", motion: "motion", door: "door", window: "window", air: "air", climate: "thermometer" };

  const st = (id) => (id ? Panel.st(id) : undefined);
  const isOn = (id) => (st(id) || {}).state === "on";
  const reading = (id, digits, unit) => {
    const v = Panel.num(id);
    return Number.isFinite(v) ? `${fmt(v, digits)}${unit}` : null;
  };

  /* What a card shows: the entity whose state it leads with, a tone (active,
   * warn or idle), the large value and a few chips of [icon, text]. */
  const KINDS = {
    presence(e) {
      const here = isOn(e.presence);
      return {
        main: e.presence,
        tone: here ? "active" : "idle",
        big: here ? "Aanwezig" : "Niemand",
        chips: [
          ["thermometer", reading(e.temperature, 1, "°")],
          ["drop", reading(e.humidity, 0, "%")],
          ["sun", reading(e.illuminance, 0, " lx")],
          here && ["person", reading(e.distance, 1, " m")],
        ],
      };
    },
    motion(e) {
      const moving = isOn(e.occupancy);
      return { main: e.occupancy, tone: moving ? "active" : "idle", big: moving ? "Beweging" : "Rust", chips: [] };
    },
    door(e) {
      const open = isOn(e.contact);
      return { main: e.contact, tone: open ? "warn" : "idle", big: open ? "Open" : "Dicht", chips: [isOn(e.tamper) && ["warning", "Sabotage"]] };
    },
    window(e) {
      return this.door(e);
    },
    air(e) {
      const co2 = Panel.num(e.co2);
      const quality = Panel.quality(e.quality);
      return {
        main: e.co2,
        tone: "idle",
        big: Number.isFinite(co2) ? fmt(co2) : "--",
        unit: "ppm CO2",
        colour: Number.isFinite(co2) ? Panel.co2Colour(co2) : null,
        chips: [
          quality && ["check", quality[0]],
          ["thermometer", reading(e.temperature, 1, "°")],
          ["drop", reading(e.humidity, 0, "%")],
          ["air", reading(e.pm25, 0, " µg/m³")],
        ],
      };
    },
    climate(e) {
      return { main: e.temperature, tone: "idle", big: reading(e.temperature, 1, "°") || "--", chips: [["drop", reading(e.humidity, 0, "%")]] };
    },
  };

  let root = null;

  function render(i, flash) {
    if (!root) return;
    const c = cards[i];
    const e = c.entities;
    const view = KINDS[c.kind](e);
    const offline = Panel.isLoaded() && Panel.unavailable(st(view.main));
    const changed = (st(view.main) || {}).lastChanged;
    const battery = reading(e.battery, 0, "%");
    Panel.fillCard(
      root.querySelector(`[data-sensor-card="${i}"]`),
      offline
        ? { tone: "offline", big: "Offline", foot: [[changed ? esc(Util.since(changed)) : ""]] }
        : {
            ...view,
            foot: [[changed ? esc(Util.since(changed)) : ""], battery && [`${icon("battery")}${battery}`, Panel.num(e.battery) < 20 ? "low" : ""]],
          },
      flash
    );
  }

  function build(page) {
    root = page.querySelector(".dc-page");
    root.innerHTML = GROUPS.map(([title, kinds]) => {
      const members = cards.map((c, i) => [c, i]).filter(([c]) => kinds.includes(c.kind));
      if (!members.length) return "";
      return (
        `<section class="dc-group"><h2 class="dc-title">${title}</h2><div class="dc-grid">` +
        members.map(([c, i]) => Panel.cardHtml(`data-sensor-card="${i}"`, ICON[c.kind], c.label)).join("") +
        `</div></section>`
      );
    }).join("");
    cards.forEach((_, i) => render(i, false));
  }

  Panel.definePage("sensors", { className: "sensors-page", html: () => `<div id="sensorsPage" class="dc-page"></div>`, build });
  /* Flash a card only when one of its readings actually changed value, not on the
   * full state re-dispatch a websocket reconnect brings (which isn't first-time
   * but also isn't news to the user). */
  const prevSig = new Map();
  const sigOf = (c) => Object.values(c.entities).map((id) => (Panel.st(id) || {}).state || "").join("|");
  cards.forEach((c, i) =>
    Panel.track(Object.values(c.entities), (changed, first) => {
      const now = sigOf(c);
      const animate = !first && prevSig.has(i) && prevSig.get(i) !== now;
      prevSig.set(i, now);
      render(i, animate);
    })
  );
  /* "3 min geleden" moves on. */
  Panel.on("minute", () => cards.forEach((_, i) => render(i, false)));
})();
