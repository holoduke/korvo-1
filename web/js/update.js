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
 * at once; later only while nobody is using the panel.
 *
 * An app installed on a phone is mostly resumed from the background, not
 * started, and is in use the moment it is back: coming back after a while
 * counts as a start. The reload is a navigation to the page with ?u=<version>
 * rather than location.reload(), which iOS may answer from the page it still
 * holds in memory; the parameter is taken off the address once loaded. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const CHECK_EVERY = 10 * 60e3;
  const IDLE_BEFORE_RELOAD = 60e3;
  const AWAY_IS_START = 30e3; /* back in view after this long counts as a start */
  const TRIED_KEY = "panel.updateTried";
  const RETRY_TRIED_MS = 3600e3;
  const isPhone = () => matchMedia("(max-width: 760px), (orientation: landscape) and (max-height: 440px)").matches;

  /* /local/panel is the same app, but Home Assistant gives everything there a
   * 31-day max-age; /thuis (the thuispaneel integration) serves the page with
   * no-cache. An app opened at the old address moves over, with its query and
   * place. (A home-screen app installed from the old address keeps that as its
   * scope and opens /thuis/ as an outside page: install it again from /thuis/.) */
  if (location.pathname.startsWith("/local/panel")) {
    location.replace("/thuis/" + location.search + location.hash);
    Panel.leaving = true; /* main.js does not start: no login or connection on the way out */
    return;
  }

  const meta = document.querySelector('meta[name="panel-version"]');
  const current = meta ? meta.content : "";
  /* Unstamped (local development server) or demo: nothing to update. */
  if (!current || current === "__VERSION__" || new URLSearchParams(location.search).has("demo")) return;

  /* Loaded through an update navigation: take ?u= off the address again. */
  const here = new URL(location.href);
  if (here.searchParams.has("u") || here.searchParams.has("saver")) {
    here.searchParams.delete("u");
    here.searchParams.delete("saver"); /* splash.js has read it */
    history.replaceState(history.state, "", here.pathname + here.search + here.hash);
  }

  const pageUrl = () => location.pathname + location.search;
  let busy = false;
  let hiddenAt = 0;

  /* AbortSignal.timeout is missing on older tablet browsers (Safari < 16):
   * there it threw, and the panel silently never updated. */
  function timeout(ms) {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  }
  async function remoteVersion() {
    const res = await fetch("version.txt?t=" + Date.now(), { cache: "no-store", signal: timeout(10000) });
    if (!res.ok) throw new Error("version.txt " + res.status);
    return (await res.text()).trim();
  }

  function idle() {
    return document.visibilityState !== "visible" || (Panel.saverShown && Panel.saverShown()) || (Panel.idleFor ? Panel.idleFor() : Infinity) >= IDLE_BEFORE_RELOAD;
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
      /* "version|time": a failed try blocks that version for an hour, not for the tab's life */
      const [triedV, triedAt] = String(tried || "").split("|");
      if (triedV === remote && Date.now() - Number(triedAt || 0) < RETRY_TRIED_MS) {
        console.warn(`update: ${remote} is published but this page is still ${current}; not reloading again yet`);
        return false;
      }
      /* Replace the HTTP cache entry the reload will use, and only reload when
       * that fresh copy is the published version. */
      const fresh = await (await fetch(pageUrl(), { cache: "reload", signal: timeout(20000) })).text();
      if (!fresh.includes(`name="panel-version" content="${remote}"`)) return false;
      try {
        sessionStorage.setItem(TRIED_KEY, `${remote}|${Date.now()}`);
      } catch (e) {
        /* see above */
      }
      const next = new URL(location.href);
      next.searchParams.set("u", remote); /* not "v": that would make /thuis cache the page for a year */
      /* under a screensaver: the new page goes straight back to it, without the
       * boot show and without counting as someone at the panel */
      if (Panel.saverShown && Panel.saverShown()) next.searchParams.set("saver", "1");
      location.replace(next.pathname + next.search + next.hash);
      return true;
    } catch (e) {
      return false; /* HA unreachable or mid-deploy: next check */
    } finally {
      busy = false;
    }
  };

  window.addEventListener("load", () => Panel.checkForUpdate(true));
  setInterval(() => !Panel.sleeping() && Panel.checkForUpdate(false), CHECK_EVERY); /* not while asleep: a reload would light the screen at night */
  /* Back in view: after a while away (an installed app reopened from the
   * background) that is a start and a waiting update is taken at once;
   * after a short look elsewhere only once the panel is quiet, not mid-use. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    /* Only a phone: there reopening the app is a start. A wall tablet coming
     * back from its display being off is someone about to use it: it waits
     * for a quiet panel, so the reload never lands under a finger. */
    Panel.checkForUpdate(isPhone() && hiddenAt > 0 && Date.now() - hiddenAt > AWAY_IS_START);
  });
  /* iOS restores a backgrounded app from its page cache without a load event. */
  window.addEventListener("pageshow", (e) => e.persisted && Panel.checkForUpdate(true));
})();
