/* Sound, off unless switched on in Instellingen: a soft click on a tap, a
 * two-note chime when a second tap confirms something, one low tone when the
 * connection to Home Assistant goes. Never for a change that came from
 * elsewhere. Web Audio, unlocked by the first touch. */
(function () {
  "use strict";
  const Panel = window.Panel;
  let ctx = null;
  let wasConnected = false;

  function ready() {
    if (!Panel.prefs.sound) return null;
    if (!ctx) {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        return null;
      }
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }
  /* One note: freq Hz for ms, at gain (0..1), starting `at` seconds from now. */
  function note(freq, ms, gain, type = "sine", at = 0) {
    const c = ready();
    if (!c) return;
    const t0 = c.currentTime + at;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + ms / 1000 + 0.02);
  }
  Panel.sound = {
    tap: () => note(1700, 40, 0.03, "triangle"),
    confirm: () => {
      note(660, 120, 0.05);
      note(990, 180, 0.05, "sine", 0.11);
    },
    lost: () => note(150, 550, 0.06),
  };
  window.addEventListener("pointerdown", () => ready(), { capture: true, passive: true });
  window.addEventListener("panel:confirmed", () => Panel.sound.confirm());
  Panel.on("status", (s) => {
    if (Panel.isLoaded() && wasConnected && s !== "connected") Panel.sound.lost();
    wasConnected = s === "connected";
  });
})();
