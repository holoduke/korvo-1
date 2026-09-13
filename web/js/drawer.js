/* "Alle lampen": a drawer between the tab bar and the bottom row with a tile
 * for every lamp in the active tab's drawer list. Swipe right to close. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;
  const drawer = $("drawer");
  let drawerTab = -1; /* the tab whose tiles the drawer holds */

  const isOpen = () => drawer.classList.contains("open");

  function place() {
    const btn = document.querySelector(`[data-all="${Panel.activeTab()}"]`);
    const row = btn && btn.closest(".row");
    drawer.style.top = $("tabbar").getBoundingClientRect().top + "px";
    drawer.style.bottom = (row ? window.innerHeight - row.getBoundingClientRect().top : 0) + "px";
  }

  function open() {
    const ti = Panel.activeTab();
    if (ti < 0) return;
    if (drawerTab !== ti) {
      const devices = cfg.tabs[ti].devices;
      $("drawerGrid").innerHTML = devices.map((d) => Panel.lightTile(d.id)).join("");
      devices.forEach((d) => Panel.renderLight(d.id));
      drawerTab = ti;
    }
    drawer.scrollTop = 0;
    place();
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    document.querySelectorAll("[data-all]").forEach((b) => b.classList.toggle("open", +b.dataset.all === ti));
  }

  function close() {
    if (!isOpen()) return;
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    document.querySelectorAll("[data-all]").forEach((b) => b.classList.remove("open"));
  }
  Panel.closeDrawer = close;

  Panel.defineAction("all", () => (isOpen() ? close() : open()));
  Panel.on("section", close);
  Panel.on("floor", close);
  Panel.on("escape", close);
  window.addEventListener("resize", () => isOpen() && place());

  Panel.addSwipe({
    root: drawer,
    axis: "x",
    accepts: (el, delta) => delta > 0, /* it only swipes closed */
    size: () => drawer.clientWidth,
    commit: 1 / 4,
    begin: () => drawer.classList.add("dragging"),
    move(raw) {
      const off = Math.max(0, raw);
      drawer.style.transform = `translate3d(${off}px,0,0)`;
      return off;
    },
    end(dir) {
      drawer.classList.remove("dragging");
      drawer.style.transform = "";
      if (dir < 0) close();
    },
  });
})();
