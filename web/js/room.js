/* A room, opened by a tap on the house: its lamps as tiles (the power button
 * switches, the name opens the lamp popup), a line with what is known about
 * it, and all of it on or off at once. Outside the swipe roots, so the tiles
 * take plain clicks here. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { $ } = Panel;
  let current = null; /* {floor, name, lights} */

  function render() {
    if (!current) return;
    const lights = current.lights;
    $("roomLamps").innerHTML = lights.length ? lights.map(Panel.lightTile).join("") : `<div class="room-empty">Geen lampen in deze kamer</div>`;
    lights.forEach(Panel.renderLight); /* the tiles then follow their lamps on their own */
    facts();
  }
  /* The line of facts: lamps on, climate, presence. */
  function facts() {
    const lights = current.lights;
    const on = lights.filter((id) => (Panel.st(id) || {}).state === "on").length;
    const parts = [lights.length ? `${on} van ${lights.length} lampen aan` : null];
    if (current.card) {
      const t = Panel.num(current.card.entities.temperature);
      const h = Panel.num(current.card.entities.humidity);
      if (Number.isFinite(t)) parts.push(`${Util.fmt(t, 1)}°${Number.isFinite(h) ? ` · ${Math.round(h)}%` : ""}`);
    }
    if (current.presence) parts.push((Panel.st(current.presence) || {}).state === "on" ? "iemand aanwezig" : "niemand");
    $("roomSub").textContent = parts.filter(Boolean).join("  ·  ");
    $("roomOn").disabled = !lights.length;
    $("roomOff").disabled = !lights.length;
  }

  /* room: {floor, name, lights, card, presence} as hud.js knows it. */
  Panel.openRoom = function (room) {
    current = room;
    $("roomTitle").textContent = room.name;
    render();
    Panel.openOverlay($("room"));
  };

  $("roomClose").innerHTML = icon("close");
  $("roomClose").addEventListener("click", () => Panel.closeOverlay($("room")));
  $("room").addEventListener("click", (e) => e.target === $("room") && Panel.closeOverlay($("room")));
  $("roomLamps").addEventListener("click", (e) => {
    const power = e.target.closest("[data-power]");
    const lamp = e.target.closest("[data-lamp]");
    if (power) Panel.toggleLight(power.dataset.power);
    else if (lamp) Panel.openLightPopup(lamp.dataset.lamp);
  });
  $("roomOn").addEventListener("click", () => current && Panel.setBrightness(current.lights, 100));
  $("roomOff").addEventListener("click", () => current && Panel.setBrightness(current.lights, 0));
  Panel.on("light", (id) => current && !$("room").hidden && current.lights.includes(id) && facts());
  Panel.on("escape", () => (current = null));
})();
