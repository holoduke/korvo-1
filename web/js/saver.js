/* The screensaver ("AI oog", or the screen off) after a quiet spell, and the
 * wall tablet's display kept awake while the app is in use. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;
  const saver = $("saver");
  Panel.SAVER_TIMES = [60e3, 300e3, 1800e3, 7200e3];
  Panel.SAVER_LABELS = ["1 min", "5 min", "30 min", "2 uur"];

  /* ---- Keep the screen on --------------------------------------------------------- */
  /* In the "Scherm uit" mode the lock is released so the tablet's own auto-lock
   * can switch the display off. The browser drops the lock whenever the page is
   * hidden, so it is taken again on return and on the next touch. */
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && "wakeLock" in navigator && document.visibilityState === "visible") {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => (wakeLock = null));
      } else if (!on && wakeLock) {
        const lock = wakeLock;
        wakeLock = null;
        await lock.release();
      }
    } catch (e) {
      wakeLock = null; /* not supported, or refused (e.g. low power mode) */
    }
  }
  const wantAwake = () => saver.hidden || Panel.prefs.saverMode !== 0;
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && keepAwake(wantAwake()));
  window.addEventListener("pointerdown", () => keepAwake(wantAwake()), { passive: true, capture: true });

  /* ---- Activity ------------------------------------------------------------------- */
  let lastActivity = Date.now();
  ["pointerdown", "keydown", "wheel"].forEach((ev) =>
    window.addEventListener(ev, () => (lastActivity = Date.now()), { capture: true, passive: true })
  );
  /* ms since the last touch, key or wheel; update.js waits for a quiet panel. */
  Panel.idleFor = () => Date.now() - lastActivity;
  /* The app is in use (again): restart the quiet spell and keep the screen on. */
  Panel.wake = function () {
    lastActivity = Date.now();
    keepAwake(true);
  };

  /* ---- Screensaver ----------------------------------------------------------------- */
  let flickerTimer = 0;

  function renderTemps() {
    const temps = cfg.sensors.map((s) => {
      const t = Panel.num(s.temp);
      return `<span>${s.abbr}</span><span class="v">${Number.isFinite(t) ? t.toFixed(1) + "°" : "-.-°"}</span>`;
    });
    const air = cfg.air.map((a) => {
      const v = Panel.num(a.co2);
      return `<span>${a.abbr}</span><span class="v">${Number.isFinite(v) ? Math.round(v) : "---"}</span>`;
    });
    $("eyeTemps").innerHTML = temps.concat(air).join("");
  }

  function renderMedia() {
    const box = $("eyeMedia");
    const strip = (v) => (v || "").split(" •")[0];
    const m = cfg.media.find((p) => (Panel.st(p.id) || {}).state === "playing");
    box.hidden = !m;
    if (!m) return;
    const a = Panel.st(m.id).attributes;
    const title = strip(a.media_title);
    const artist = strip(a.media_artist);
    box.querySelector(".where").innerHTML = `${icon("music")}<span>${m.label}</span>`;
    box.querySelector(".what").textContent = artist && title ? `${artist}  -  ${title}` : title;
  }

  function scheduleFlicker() {
    clearTimeout(flickerTimer);
    flickerTimer = setTimeout(() => {
      const glow = document.querySelector(".eye-glow");
      const times = Math.random() < 0.3 ? 2 : 1;
      let n = 0;
      const once = () => {
        glow.classList.remove("flicker");
        void glow.offsetWidth; /* restart the animation */
        glow.classList.add("flicker");
        if (++n < times) setTimeout(once, 260);
      };
      once();
      scheduleFlicker();
    }, 4000 + Math.random() * 5000);
  }

  Panel.showSaver = function () {
    if (!saver.hidden) return;
    saver.classList.toggle("off", Panel.prefs.saverMode === 0);
    renderTemps();
    renderMedia();
    ["popup", "climate", "settings", "plan"].forEach((id) => ($(id).hidden = true));
    Panel.closeDrawer();
    saver.hidden = false;
    if (Panel.prefs.saverMode === 1) scheduleFlicker();
    keepAwake(Panel.prefs.saverMode !== 0);
  };
  saver.addEventListener("click", () => {
    saver.hidden = true;
    clearTimeout(flickerTimer);
    Panel.wake();
  });
  setInterval(() => {
    const limit = Panel.SAVER_TIMES[Panel.prefs.saverIdx] || 300e3;
    /* Not while the splash is still up: the app hasn't been seen yet. */
    if (saver.hidden && !$("splash") && Date.now() - lastActivity > limit) Panel.showSaver();
  }, 1000);

  Panel.on("minute", () => {
    $("saverClock").textContent = Util.hm(new Date());
    if (!saver.hidden) renderTemps();
  });
  Panel.track(
    cfg.media.map((m) => m.id),
    () => !saver.hidden && renderMedia()
  );
})();
