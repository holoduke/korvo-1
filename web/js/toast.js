/* A short message at the bottom of the screen, e.g. when Home Assistant could
 * not carry out a command (a car that does not wake up, an appliance that
 * refuses a program). */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { $ } = Panel;
  const SHOW_MS = 6000;
  let timer = 0;

  Panel.toast = function (text) {
    const el = $("toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove("show"), SHOW_MS);
  };

  /* A catch handler for a service call: "Tesla: opdracht mislukt (reason)". */
  Panel.commandFailed = (subject) => (err) =>
    Panel.toast(`${subject}: opdracht mislukt${err && err.message ? ` (${err.message})` : ""}`);
})();
