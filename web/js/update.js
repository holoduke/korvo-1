/* Picks up new deploys. /thuis (the thuispaneel integration) serves
 * index.html with no-cache, but /local/panel has Home Assistant's 31-day
 * max-age, and an open page never reloads by itself: without this a panel
 * would run an old page until someone reloads it. A service worker would be
 * the usual fix, but those need https and the wall panel uses plain http on
 * the LAN.
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
    const res = await fetch("version.txt?t=" + Date.now(), { cache: "no-store", signal: AbortSignal.timeout(10000) });
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
      const fresh = await (await fetch(pageUrl(), { cache: "reload", signal: AbortSignal.timeout(20000) })).text();
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
  setInterval(() => !Panel.sleeping() && Panel.checkForUpdate(false), CHECK_EVERY); /* not while asleep: a reload would light the screen at night */
  /* Back in view: a waiting update is taken once the panel is quiet, not mid-use. */
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && Panel.checkForUpdate(false));
})();
