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
    ["Deuren", ["door"]],
    ["Lucht en klimaat", ["air", "climate"]],
  ];
  const ICON = { presence: "person", motion: "motion", door: "door", air: "air", climate: "thermometer" };

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
    const card = root.querySelector(`[data-sensor-card="${i}"]`);
    const view = KINDS[c.kind](e);
    const offline = Panel.isLoaded() && Panel.unavailable(st(view.main));
    card.className = `sn-card tone-${offline ? "offline" : view.tone}`;
    const chips = offline ? [] : view.chips.filter((chip) => chip && chip[1]);
    const changed = (st(view.main) || {}).lastChanged;
    const battery = reading(e.battery, 0, "%");
    card.querySelector(".sn-body").innerHTML =
      `<div class="sn-value"><b${view.colour && !offline ? ` style="color:${view.colour}"` : ""}>${esc(offline ? "Offline" : view.big)}</b>` +
      (!offline && view.unit ? `<span>${view.unit}</span>` : "") +
      `</div>` +
      (chips.length ? `<div class="sn-chips">${chips.map(([ic, text]) => `<span>${icon(ic)}${esc(text)}</span>`).join("")}</div>` : "") +
      `<footer class="sn-foot"><span>${changed ? esc(Util.since(changed)) : ""}</span>` +
      (battery ? `<span class="${Panel.num(e.battery) < 20 ? "low" : ""}">${icon("battery")}${battery}</span>` : "") +
      `</footer>`;
    if (flash) {
      void card.offsetWidth; /* restart the animation */
      card.classList.add("flash");
    }
  }

  function build(page) {
    root = page.querySelector(".sn");
    root.innerHTML = GROUPS.map(([title, kinds]) => {
      const members = cards.map((c, i) => [c, i]).filter(([c]) => kinds.includes(c.kind));
      if (!members.length) return "";
      return (
        `<section class="sn-group"><h2 class="sn-title">${title}</h2><div class="sn-grid">` +
        members
          .map(
            ([c, i]) =>
              `<article class="sn-card" data-sensor-card="${i}"><header class="sn-head"><span class="sn-icon">${icon(ICON[c.kind])}</span>` +
              `<b>${esc(c.label)}</b><i class="sn-dot"></i></header><div class="sn-body"></div></article>`
          )
          .join("") +
        `</div></section>`
      );
    }).join("");
    cards.forEach((_, i) => render(i, false));
  }

  Panel.definePage("sensors", { className: "sensors-page", html: () => `<div id="sensorsPage" class="sn"></div>`, build });
  cards.forEach((c, i) => Panel.track(Object.values(c.entities), (changed, first) => render(i, !first)));
  /* "3 min geleden" moves on. */
  Panel.on("minute", () => cards.forEach((_, i) => render(i, false)));
})();
