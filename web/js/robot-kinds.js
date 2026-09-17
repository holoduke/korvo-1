/* Robot vacuums in the Apparaten section: each robot of the Schoonmaak
 * section in short (its state, battery and this run) with its main actions, and
 * a way to its Schoonmaak panel for rooms, planning and settings. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const { fmt } = Util;
  const { raw, num, offline, btn, stat, offlineView } = Panel.applianceUi;

  const STATE_NL = { cleaning: "Zuigt", returning: "Terug naar dock", paused: "Gepauzeerd", docked: "In dock", idle: "Staat stil", error: "Storing" };
  const JOB = ["cleaning", "returning", "paused"];
  const floorName = (label) => (cfg.floors.find((f) => f.label === label) || {}).name || label;
  const cleaningSlug = () => Util.slug((cfg.sections.find((s) => s.kind === "vacuum") || { name: "" }).name);
  const openRow = (i) => `<div class="ap-row">${btn(i, "open", "Open in Schoonmaak", { ic: "calendar" })}</div>`;

  /* Home. The Xiaomi goes through robotkamers, which first ends a pending job. */
  function dock(a, call) {
    if (a.robot === "xiaomi") return Panel.client.callService(cfg.vacuum.roomsDomain, "naar_station").catch(Panel.commandFailed(a.label));
    return call("vacuum", "return_to_base", null, a.entities.vacuum);
  }

  Panel.defineAppliance("robot", {
    icon: "vacuum",
    /* "Alle apparaten uit": a robot at work goes home. */
    off: { active: (a) => ["cleaning", "paused"].includes(raw(a.entities.vacuum)), run: (a, call) => dock(a, call) },
    view(a, i) {
      const e = a.entities;
      if (offline(e.vacuum)) return { ...offlineView("De stofzuiger is niet bereikbaar"), controls: openRow(i) };
      const state = raw(e.vacuum);
      const job = JOB.includes(state);
      const battery = num(e.battery);
      const area = num(e.area);
      const fault = state === "error" || (!!e.problem && raw(e.problem) === "on");
      const start =
        state === "paused"
          ? btn(i, "start", "Verder", { primary: true, ic: "play" })
          : state === "cleaning"
            ? btn(i, "pause", "Pauze", { ic: "pause" })
            : btn(i, "start", a.robot === "xiaomi" ? "Hele huis" : "Start", { primary: true, ic: "play", disabled: state === "returning" });
      return {
        tone: fault ? "error" : state === "paused" ? "paused" : job ? "run" : "ready",
        pill: fault && !job ? "Storing" : STATE_NL[state] || state,
        big: Number.isFinite(battery) ? fmt(battery) : "--",
        unit: "% accu",
        sub: job && Number.isFinite(area) ? `${fmt(area)} m² deze ronde` : STATE_NL[state] || "",
        progress: state === "cleaning" ? "busy" : null,
        stats: [
          stat("Accu", Number.isFinite(battery) ? `${fmt(battery)}%` : "--"),
          stat(job ? "Deze ronde" : "Laatste ronde", Number.isFinite(area) ? `${fmt(area)} m²` : "--"),
          stat("Verdieping", floorName(a.floor)),
        ],
        controls:
          `<div class="ap-row">${start}` +
          (state !== "docked" && state !== "returning" ? btn(i, "dock", "Naar dock", { ic: "dock" }) : "") +
          `</div>` +
          openRow(i),
      };
    },
    actions: {
      start: (a, args, call) => call("vacuum", "start", null, a.entities.vacuum),
      pause: (a, args, call) => call("vacuum", "pause", null, a.entities.vacuum),
      dock: (a, args, call) => dock(a, call),
      open: (a) => (location.hash = `#${cleaningSlug()}/${a.floor}`),
    },
  });
})();
