/* Verlichting's floors: lift-style buttons on the left (the highest floor on
 * top), a page per floor that slides vertically and follows a vertical swipe,
 * and each floor's own bottom row. The page and row contents come from
 * lighting.js. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;

  Panel.floor = 0; /* index into cfg.floors (0 = begane grond) */
  /* Display order, top to bottom: the storeys from the top down, then the
   * floors that are not a storey (the garage) at the bottom. */
  const storey = (i) => /^\d+$/.test(cfg.floors[i].label);
  Panel.floorOrder = [...cfg.floors.map((_, i) => i).filter(storey).reverse(), ...cfg.floors.map((_, i) => i).filter((i) => !storey(i))];
  Panel.floorPos = (fi) => Panel.floorOrder.indexOf(fi);

  let page = null;
  let view = null;
  let track = null;
  let placeInd = null; /* the rail's indicator (rail.js) */
  const railBtns = () => [...page.querySelectorAll(".rail-btn")];

  Panel.definePage("floors", {
    className: "floors-page",
    html: () =>
      Panel.railHtml(Panel.floorOrder.map((fi) => ({ key: fi, label: cfg.floors[fi].label, name: cfg.floors[fi].name })), "data-floor") +
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
      placeInd = Panel.railIndicator(el.querySelector(".rail"));
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

  /* The track moves frame by frame, under the finger and when it glides into
   * place (Util.glide; see there why not a CSS transition). */
  const SNAP_MS = 320;
  let trackY = 0;
  let glide = null;
  function setTrack(pos, offPx, animate, velocity) {
    const to = -pos * view.clientHeight + offPx;
    if (glide) glide.cancel();
    glide = null;
    const place = (y) => {
      trackY = y;
      track.style.transform = `translate3d(0,${y}px,0)`;
    };
    if (!animate) return place(to);
    glide = Util.glide(trackY, to, SNAP_MS, place, () => (glide = null), velocity);
  }
  const gliding = () => !!glide;

  /* velocity (px/ms, from a swipe's release) sets the glide's speed. */
  Panel.setFloor = function (fi, animate, velocity) {
    if (!page) return;
    fi = Util.clamp(fi, 0, cfg.floors.length - 1);
    const changed = fi !== Panel.floor;
    Panel.floor = fi;
    const pos = Panel.floorPos(fi);
    railBtns().forEach((el) => el.classList.toggle("active", +el.dataset.floor === fi));
    page.querySelectorAll(".floor-row").forEach((el) => el.classList.toggle("active", +el.dataset.floorRow === fi));
    setTrack(pos, 0, animate, velocity);
    placeInd(pos, animate);
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
      placeInd(Util.clamp(pos - off / size, 0, last), false);
      return off;
    },
    end(dir, velocity) {
      /* +1 is the panel below: a lower floor */
      const to = Panel.floorPos(Panel.floor) + dir;
      Panel.setFloor(to >= 0 && to < cfg.floors.length ? Panel.floorOrder[to] : Panel.floor, true, velocity);
    },
  });

  window.addEventListener("keydown", (e) => {
    if (!page || Panel.overlayOpen() || cfg.sections[Panel.section].kind !== "floors") return;
    if (e.key === "ArrowUp") Panel.setFloor(Panel.floor + 1, true);
    if (e.key === "ArrowDown") Panel.setFloor(Panel.floor - 1, true);
  });
  /* Safari resizes the viewport when its toolbar changes: a glide under way is
   * re-aimed, not cut short to its end. */
  window.addEventListener("resize", () => {
    if (!page) return;
    setTrack(Panel.floorPos(Panel.floor), 0, gliding());
    placeInd(Panel.floorPos(Panel.floor), gliding());
  });

  Panel.on("start", () => {
    if (!page) return;
    Panel.setFloor(Panel.floor, false);
    requestAnimationFrame(() => placeInd(Panel.floorPos(Panel.floor), false));
    new ResizeObserver(() => placeInd(Panel.floorPos(Panel.floor), false)).observe(page.querySelector(".rail-track"));
  });
})();
