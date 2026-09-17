/* The screensaver after a quiet spell (the house of the Start section with the
 * header and tabs slid away, the "AI oog", or the screen off), and the wall
 * tablet's display kept awake while the app is in use. */
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
  let requesting = null; /* the request under way: a second call waits for it instead of taking a second lock */
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && "wakeLock" in navigator && document.visibilityState === "visible") {
        if (!requesting) requesting = navigator.wakeLock.request("screen").finally(() => (requesting = null));
        wakeLock = await requesting;
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

  /* ---- The house as screensaver ----------------------------------------------------- */
  /* The Start section as it is, the house turning on: only the header and the
   * tab bar slide away, and back at the first touch, key or mouse move. Their
   * grid rows animate between their measured height and nothing (an "auto" row
   * cannot animate), with the rows' content clipped and fading meanwhile. */
  const CHROME_MS = 600;
  const app = $("app");
  let houseSaver = false;
  let before = ""; /* where the app was (its URL hash) when the house took over */
  let chromeTimer = 0;
  let natural = { hdr: 0, tab: 0 }; /* the rows' heights before they slid away */
  function chrome(show) {
    clearTimeout(chromeTimer);
    const rows = (hdr, tab) => {
      app.style.setProperty("--hdr-row", hdr + "px");
      app.style.setProperty("--tab-row", tab + "px");
    };
    document.body.classList.add("chrome-anim");
    if (!show) {
      natural = { hdr: $("header").offsetHeight, tab: $("tabbar").offsetHeight };
      rows(natural.hdr, natural.tab);
      void app.offsetHeight; /* the rows start from their measured height */
      document.body.classList.add("saver-house");
      rows(0, 0);
      return;
    }
    document.body.classList.remove("saver-house");
    rows(natural.hdr, natural.tab);
    chromeTimer = setTimeout(() => {
      app.style.removeProperty("--hdr-row");
      app.style.removeProperty("--tab-row");
      document.body.classList.remove("chrome-anim");
    }, CHROME_MS + 50);
  }
  /* Awake: the header and tabs come back, and so does the place the app was
   * at (the section, and its floor or device) before the house took over. */
  function wakeHouse() {
    if (!houseSaver) return;
    houseSaver = false;
    chrome(true);
    if (before && before !== location.hash) Panel.goHash(before, false); /* back at once: no glide through the sections or floors */
    before = "";
    Panel.wake();
  }
  ["pointerdown", "pointermove", "touchstart", "keydown", "wheel"].forEach((ev) => window.addEventListener(ev, wakeHouse, { capture: true, passive: true }));
  Panel.houseSaverOn = () => houseSaver;

  /* ---- Screensaver ----------------------------------------------------------------- */
  let flickerTimer = 0;

  function renderTemps() {
    const temps = cfg.sensors.map((s) => {
      const t = Panel.num(s.temp);
      return `<span>${s.abbr}</span><span class="v">${Number.isFinite(t) ? Util.fmt(t, 1) + "°" : "-.-°"}</span>`;
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
    if (!saver.hidden || houseSaver) return;
    Panel.closeDialogs();
    Panel.closeDrawer();
    if (Panel.prefs.saverMode === 2) {
      houseSaver = true;
      before = location.hash;
      Panel.showSection("start");
      chrome(false);
      keepAwake(true);
      return;
    }
    saver.classList.toggle("off", Panel.prefs.saverMode === 0);
    renderTemps();
    renderMedia();
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
    if (saver.hidden && !houseSaver && !$("splash") && Date.now() - lastActivity > limit) Panel.showSaver();
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
