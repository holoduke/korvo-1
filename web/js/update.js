/* Picks up new deploys. Home Assistant serves /local with a 31-day max-age,
 * index.html included, so a home-screen app would otherwise keep running an
 * old page for weeks (the ?v= stamps only help once index.html itself is
 * fresh). A service worker would be the usual fix, but those need https and
 * the panel is served over plain http on the LAN.
 *
 * tools/web_deploy.sh writes version.txt next to index.html. This script reads
 * it past the HTTP cache, and when it names another version it refreshes the
 * cached copy of this page, checks that copy really carries the new version,
 * and reloads (the hash keeps the section and floor). At start-up that happens
 * at once; later only while nobody is using the panel. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const CHECK_EVERY = 10 * 60e3;
  const IDLE_BEFORE_RELOAD = 60e3;
  const TRIED_KEY = "panel.updateTried";

  const meta = document.querySelector('meta[name="panel-version"]');
  const current = meta ? meta.content : "";
  /* Unstamped (local development server) or demo: nothing to update. */
  if (!current || current === "__VERSION__" || new URLSearchParams(location.search).has("demo")) return;

  const pageUrl = () => location.pathname + location.search;
  let busy = false;

  async function remoteVersion() {
    const res = await fetch("version.txt?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("version.txt " + res.status);
    return (await res.text()).trim();
  }

  function idle() {
    const saver = document.getElementById("saver");
    return document.visibilityState !== "visible" || (saver && !saver.hidden) || (Panel.idleFor ? Panel.idleFor() : Infinity) >= IDLE_BEFORE_RELOAD;
  }

  Panel.checkForUpdate = async function (atStart) {
    if (busy) return false;
    busy = true;
    try {
      const remote = await remoteVersion();
      if (!remote || remote === current) return false;
      if (!atStart && !idle()) return false; /* try again on the next check */
      let tried = null;
      try {
        tried = sessionStorage.getItem(TRIED_KEY);
      } catch (e) {
        /* storage unavailable: the page check below still prevents a loop */
      }
      if (tried === remote) {
        console.warn(`update: ${remote} is published but this page is still ${current}; not reloading again`);
        return false;
      }
      /* Replace the HTTP cache entry the reload will use, and only reload when
       * that fresh copy is the published version. */
      const fresh = await (await fetch(pageUrl(), { cache: "reload" })).text();
      if (!fresh.includes(`name="panel-version" content="${remote}"`)) return false;
      try {
        sessionStorage.setItem(TRIED_KEY, remote);
      } catch (e) {
        /* see above */
      }
      location.reload();
      return true;
    } catch (e) {
      return false; /* HA unreachable or mid-deploy: next check */
    } finally {
      busy = false;
    }
  };

  window.addEventListener("load", () => Panel.checkForUpdate(true));
  setInterval(() => Panel.checkForUpdate(false), CHECK_EVERY);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && Panel.checkForUpdate(true));
})();
