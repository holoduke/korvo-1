/* Sections: the top tabs and their pages, side by side on a track that follows
 * a horizontal swipe. The place in the app lives in the URL hash
 * (#verlichting/1/keuken, #apparaten/wiim), so a reload or a bookmark lands on
 * the same place. A module adds a kind of page with
 *   Panel.definePage(kind, {className, html(section), build(pageElement, section),
 *                           route: {path(), go(parts, animate)}})
 * where route is the page's own part of the URL; it emits "route" when that changes. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;
  const stage = $("stage");
  const track = $("track");
  const ind = $("tabind");
  const tabs = () => [...document.querySelectorAll(".tab")];

  const pages = {};
  Panel.definePage = (kind, def) => (pages[kind] = def);
  Panel.section = 0;
  Panel.sectionIndex = (kind) => cfg.sections.findIndex((s) => s.kind === kind);
  Panel.showSection = function (kind) {
    const i = Panel.sectionIndex(kind);
    if (i >= 0) Panel.setSection(i, true);
  };
  /* The PANEL_TABS index whose lights the slider, drawer and bottom row use,
   * or -1 on a section without lights. */
  Panel.activeTab = function () {
    const s = cfg.sections[Panel.section];
    return s.kind === "floors" ? cfg.floors[Panel.floor].tab : s.kind === "tab" ? s.tab : -1;
  };

  Panel.on("build", () => {
    $("tabbar").insertAdjacentHTML(
      "afterbegin",
      cfg.sections.map((s, i) => `<button class="tab${i === 0 ? " active" : ""}" data-tab="${i}">${s.icon ? window.icon(s.icon) : ""}<span class="tab-label">${s.name}</span></button>`).join("")
    );
    track.innerHTML = cfg.sections
      .map((sec, si) => {
        const def = pages[sec.kind];
        if (!def) throw new Error(`no page defined for section kind "${sec.kind}"`);
        return `<section class="page ${def.className}" data-page="${si}">${def.html(sec)}</section>`;
      })
      .join("");
    cfg.sections.forEach((sec, si) => pages[sec.kind].build && pages[sec.kind].build(track.children[si], sec));
  });

  function setIndicator(pos, animate) {
    const t = tabs();
    const i = Util.clamp(Math.floor(pos), 0, t.length - 1);
    const f = Util.clamp(pos - i, 0, 1);
    const a = t[i];
    const b = t[Math.min(t.length - 1, i + 1)];
    const inset = 0.18;
    const left = (el) => el.offsetLeft + el.offsetWidth * inset;
    const width = (el) => el.offsetWidth * (1 - 2 * inset);
    ind.style.transition = animate ? "transform .3s cubic-bezier(.22,.61,.36,1), width .3s" : "none";
    ind.style.width = width(a) + (width(b) - width(a)) * f + "px";
    ind.style.transform = `translate3d(${left(a) + (left(b) - left(a)) * f}px,0,0)`;
  }

  /* The track moves frame by frame, under the finger and when it glides into
   * place (Util.glide; see there why not a CSS transition). */
  const SNAP_MS = 300;
  let trackX = 0;
  let glide = null;
  function setTrack(offsetPx, animate) {
    const to = -Panel.section * stage.clientWidth + offsetPx;
    if (glide) glide.cancel();
    glide = null;
    const place = (x) => {
      trackX = x;
      track.style.transform = `translate3d(${x}px,0,0)`;
    };
    if (!animate) return place(to);
    glide = Util.glide(trackX, to, SNAP_MS, place, () => (glide = null));
  }
  /* Whether the track is gliding into place (diag.js reports it). */
  Panel.sectionGliding = () => !!glide;

  /* A phone too narrow for every tab scrolls the bar: the active tab is kept in
   * view (scrollTo, not scrollIntoView, which could also shift the page track). */
  function revealTab(i, animate) {
    const bar = $("tabbar");
    const room = bar.scrollWidth - bar.clientWidth;
    if (room <= 0) return;
    const t = tabs()[i];
    bar.scrollTo({ left: Util.clamp(t.offsetLeft - (bar.clientWidth - t.offsetWidth) / 2, 0, room), behavior: animate ? "smooth" : "auto" });
  }

  Panel.setSection = function (i, animate) {
    i = Util.clamp(i, 0, cfg.sections.length - 1);
    const changed = i !== Panel.section;
    Panel.section = i;
    tabs().forEach((el, k) => el.classList.toggle("active", k === i));
    setTrack(0, animate);
    setIndicator(i, animate);
    revealTab(i, animate);
    if (changed) Panel.emit("section", i);
    writeHash();
  };

  Panel.addSwipe({
    root: stage,
    axis: "x",
    accepts: () => true,
    size: () => stage.clientWidth,
    commit: 1 / 5,
    begin: () => Panel.emit("swiping", true),
    move(raw, size) {
      const atEdge = (raw > 0 && Panel.section === 0) || (raw < 0 && Panel.section === cfg.sections.length - 1);
      const off = atEdge ? raw * 0.3 : Util.clamp(raw, -size, size);
      setTrack(off, false);
      setIndicator(Panel.section - off / size, false);
      return off;
    },
    end(dir) {
      Panel.emit("swiping", false);
      Panel.setSection(Panel.section + dir, true);
    },
  });

  /* ---- URL ---------------------------------------------------------------------- */
  /* replaceState keeps swipes out of the browser history; editing the hash by hand works too. */
  let urlReady = false; /* false until the hash has been read at start-up */
  function hashFor() {
    const s = cfg.sections[Panel.section];
    const path = pages[s.kind].route ? pages[s.kind].route.path() : "";
    return "#" + Util.slug(s.name) + (path ? "/" + path : "");
  }
  function writeHash() {
    if (!urlReady) return;
    const h = hashFor();
    if (location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h);
  }
  function applyHash(animate) {
    let raw = "";
    try {
      raw = decodeURIComponent(location.hash.slice(1));
    } catch (e) {
      /* malformed escape: treat as no hash */
    }
    const [sec, ...parts] = raw.toLowerCase().split("/");
    const si = cfg.sections.findIndex((s) => Util.slug(s.name) === sec);
    if (si >= 0) Panel.setSection(si, animate);
    const route = pages[cfg.sections[Panel.section].kind].route;
    if (route) route.go(parts, animate);
    writeHash(); /* normalise an unknown or partial hash */
  }
  window.addEventListener("hashchange", () => applyHash(true));
  Panel.on("route", writeHash);

  $("tabbar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) Panel.setSection(+b.dataset.tab, true);
  });
  /* Safari resizes the viewport when its toolbar changes, also right after a
   * swipe: a glide still under way is re-aimed, not cut short to its end. */
  window.addEventListener("resize", () => {
    const gliding = !!glide;
    setTrack(0, gliding);
    setIndicator(Panel.section, gliding);
  });
  window.addEventListener("keydown", (e) => {
    if (Panel.overlayOpen()) return;
    if (e.key === "ArrowRight") Panel.setSection(Panel.section + 1, true);
    if (e.key === "ArrowLeft") Panel.setSection(Panel.section - 1, true);
  });

  Panel.on("start", () => {
    Panel.setSection(Panel.section, false);
    urlReady = true;
    applyHash(false);
    /* Tab widths change once the web font has loaded and on rotation: the
     * indicator follows them. */
    const ro = new ResizeObserver(() => setIndicator(Panel.section, !!glide));
    tabs().forEach((tab) => ro.observe(tab));
    Util.watchOverflow($("tabbar"));
  });
})();
