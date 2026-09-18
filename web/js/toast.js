/* A short message at the bottom of the screen, e.g. when Home Assistant could
 * not carry out a command (a car that does not wake up, an appliance that
 * refuses a program). */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { $ } = Panel;
  const SHOW_MS = { ok: 3000, warn: 5000, bad: 6000 };
  let timer = 0;

  /* tone: ok (done, green), warn (something to know), bad (failed, the default). */
  Panel.toast = function (text, tone = "bad") {
    const el = $("toast");
    el.textContent = text;
    el.dataset.tone = tone;
    el.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove("show"), SHOW_MS[tone] || SHOW_MS.bad);
  };

  /* A catch handler for a service call: "Tesla: opdracht mislukt (reason)". */
  Panel.commandFailed = (subject) => (err) =>
    Panel.toast(`${subject}: opdracht mislukt${err && err.message ? ` (${err.message})` : ""}`);
})();
