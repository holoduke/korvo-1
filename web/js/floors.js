/* Verlichting's floors: lift-style buttons on the left (the highest floor on
 * top), a page per floor that slides vertically and follows a vertical swipe,
 * and each floor's own bottom row. The page and row contents come from
 * lighting.js. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;

  Panel.floor = 0; /* index into cfg.floors (0 = begane grond) */
  Panel.floorOrder = cfg.floors.map((_, i) => i).reverse(); /* display order, top to bottom */
  Panel.floorPos = (fi) => Panel.floorOrder.indexOf(fi);

  let page = null;
  let view = null;
  let track = null;
  let railInd = null;
  const railBtns = () => [...page.querySelectorAll(".rail-btn")];

  Panel.definePage("floors", {
    className: "floors-page",
    html: () =>
      `<nav class="rail" aria-label="Verdieping"><div class="rail-track"><i class="rail-ind"></i>` +
      Panel.floorOrder
        .map((fi) => `<button class="rail-btn" data-floor="${fi}"><b>${cfg.floors[fi].label}</b><span>${cfg.floors[fi].name}</span></button>`)
        .join("") +
      `</div></nav>` +
      `<div class="floor-view"><div class="floor-track">` +
      Panel.floorOrder.map((fi) => `<div class="floor" data-floor-panel="${fi}">${Panel.lightingPanel(cfg.floors[fi].tab)}</div>`).join("") +
      `</div></div>` +
      `<div class="floor-rows">` +
      cfg.floors.map((f, fi) => `<div class="floor-row${fi === 0 ? " active" : ""}" data-floor-row="${fi}">${Panel.lightingRow(f.tab)}</div>`).join("") +
      `</div>`,
    build(el) {
      page = el;
      view = el.querySelector(".floor-view");
      track = el.querySelector(".floor-track");
      railInd = el.querySelector(".rail-ind");
    },
    /* "1" or "1/keuken": the floor and the chosen room. */
    route: {
      path() {
        const area = Panel.areaOf(Panel.floor);
        return cfg.floors[Panel.floor].label + (area ? "/" + Util.slug(area.label) : "");
      },
      go([floor, area], animate) {
        const fi = cfg.floors.findIndex((f) => f.label.toLowerCase() === floor);
        if (fi >= 0) Panel.setFloor(fi, animate);
        Panel.setAreaBySlug(Panel.floor, area || "");
      },
    },
  });

  function setTrack(pos, offPx, animate) {
    track.classList.toggle("snapping", !!animate);
    track.style.transform = `translate3d(0,calc(${-pos * 100}% + ${offPx}px),0)`;
  }
  function setRailInd(posFloat, animate) {
    const btns = railBtns();
    const i = Util.clamp(Math.floor(posFloat), 0, btns.length - 1);
    const f = Util.clamp(posFloat - i, 0, 1);
    const a = btns[i];
    const b = btns[Math.min(btns.length - 1, i + 1)];
    railInd.style.transition = animate ? "transform .24s cubic-bezier(.22,.61,.36,1), height .24s" : "none";
    railInd.style.height = a.offsetHeight + (b.offsetHeight - a.offsetHeight) * f + "px";
    railInd.style.transform = `translate3d(0,${a.offsetTop + (b.offsetTop - a.offsetTop) * f}px,0)`;
  }

  Panel.setFloor = function (fi, animate) {
    if (!page) return;
    fi = Util.clamp(fi, 0, cfg.floors.length - 1);
    const changed = fi !== Panel.floor;
    Panel.floor = fi;
    const pos = Panel.floorPos(fi);
    railBtns().forEach((el) => el.classList.toggle("active", +el.dataset.floor === fi));
    page.querySelectorAll(".floor-row").forEach((el) => el.classList.toggle("active", +el.dataset.floorRow === fi));
    setTrack(pos, 0, animate);
    setRailInd(pos, animate);
    if (changed) {
      Panel.emit("floor", fi);
      Panel.emit("route");
    }
  };

  Panel.defineAction("floor", (el) => Panel.setFloor(+el.dataset.floor, true));

  Panel.addSwipe({
    root: $("stage"),
    axis: "y",
    accepts: (el) => cfg.sections[Panel.section].kind === "floors" && !!el.closest(".floor-view"),
    size: () => view.clientHeight,
    commit: 1 / 5,
    move(raw, size) {
      const pos = Panel.floorPos(Panel.floor);
      const last = cfg.floors.length - 1;
      const atEdge = (raw > 0 && pos === 0) || (raw < 0 && pos === last);
      const off = atEdge ? raw * 0.3 : Util.clamp(raw, -size, size);
      setTrack(pos, off, false);
      setRailInd(Util.clamp(pos - off / size, 0, last), false);
      return off;
    },
    end(dir) {
      /* +1 is the panel below: a lower floor */
      const to = Panel.floorPos(Panel.floor) + dir;
      Panel.setFloor(to >= 0 && to < cfg.floors.length ? Panel.floorOrder[to] : Panel.floor, true);
    },
  });

  window.addEventListener("keydown", (e) => {
    if (!page || Panel.overlayOpen() || cfg.sections[Panel.section].kind !== "floors") return;
    if (e.key === "ArrowUp") Panel.setFloor(Panel.floor + 1, true);
    if (e.key === "ArrowDown") Panel.setFloor(Panel.floor - 1, true);
  });
  window.addEventListener("resize", () => page && setRailInd(Panel.floorPos(Panel.floor), false));

  Panel.on("start", () => {
    if (!page) return;
    Panel.setFloor(Panel.floor, false);
    requestAnimationFrame(() => setRailInd(Panel.floorPos(Panel.floor), false));
    new ResizeObserver(() => setRailInd(Panel.floorPos(Panel.floor), false)).observe(page.querySelector(".rail-track"));
  });
})();
