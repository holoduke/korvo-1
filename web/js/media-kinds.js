/* Media in the Apparaten section: the WiiM speakers, each with its transport,
 * volume, source and whether it plays along with the first speaker, and the
 * TV (a DLNA media player, switched on with a Wake-on-LAN button in Home
 * Assistant when there is one). */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { esc, known, clamp } = Util;
  const { s, attrs, btn, chip, stepper, stat, note, offlineView } = Panel.applianceUi;

  /* media_player supported_features bits */
  const F = { PAUSE: 1, VOLUME_SET: 4, VOLUME_MUTE: 8, PREVIOUS: 16, NEXT: 32, TURN_OFF: 256, SELECT_SOURCE: 2048, STOP: 4096, PLAY: 16384, GROUPING: 524288 };
  const STATE_NL = { playing: "Speelt", paused: "Gepauzeerd", idle: "Stil", on: "Aan", off: "Uit", standby: "Stand-by", buffering: "Laden" };
  const VOLUME_STEP = 0.05;

  const reachable = (id) => !!s(id) && s(id).state !== "unavailable";
  const can = (id, feature) => ((attrs(id).supported_features || 0) & feature) !== 0;
  const volumeOf = (id) => (attrs(id).volume_level == null ? NaN : Number(attrs(id).volume_level));
  const percent = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : "--");
  const art = (at) => (at.entity_picture ? `<img class="ap-art" src="${esc(at.entity_picture)}" alt="">` : "");

  /* Previous, play/pause, next (or stop), then volume and mute, for one player. */
  function transport(i, key, id) {
    const playing = s(id).state === "playing";
    const volume = volumeOf(id);
    const muted = !!attrs(id).is_volume_muted;
    const buttons = [
      can(id, F.PREVIOUS) && btn(i, `prev|${key}`, "Vorige", { ic: "prev" }),
      (can(id, F.PAUSE) || can(id, F.PLAY)) && btn(i, `play|${key}`, playing ? "Pauze" : "Speel", { primary: !playing, ic: playing ? "pause" : "play" }),
      can(id, F.NEXT) && btn(i, `next|${key}`, "Volgende", { ic: "next" }),
      can(id, F.STOP) && !can(id, F.PAUSE) && btn(i, `stop|${key}`, "Stop", { ic: "stop" }),
    ].filter(Boolean);
    const sound = [
      can(id, F.VOLUME_SET) &&
        stepper(i, `vol|${key}`, percent(volume), { canDown: !(volume <= 0), canUp: !(volume >= 1), down: "Zachter", up: "Harder" }),
      can(id, F.VOLUME_MUTE) && btn(i, `mute|${key}`, muted ? "Gedempt" : "Dempen", { active: muted, ic: "mute" }),
    ].filter(Boolean);
    return (
      (buttons.length ? `<div class="ap-row ap-media">${buttons.join("")}</div>` : "") +
      (sound.length ? `<div class="ap-row ap-media ap-sound">${sound.join("")}</div>` : "")
    );
  }

  const player = (verb) => (a, [key], call) => call("media_player", verb, null, a.entities[key]);
  const MEDIA_ACTIONS = {
    play: player("media_play_pause"),
    prev: player("media_previous_track"),
    next: player("media_next_track"),
    stop: player("media_stop"),
    vol(a, [key, dir], call) {
      const current = volumeOf(a.entities[key]);
      const next = clamp(Math.round(((Number.isFinite(current) ? current : 0.3) + Number(dir) * VOLUME_STEP) * 100) / 100, 0, 1);
      call("media_player", "volume_set", { volume_level: next }, a.entities[key]);
    },
    mute: (a, [key], call) =>
      call("media_player", "volume_mute", { is_volume_muted: !attrs(a.entities[key]).is_volume_muted }, a.entities[key]),
  };

  /* ---- WiiM speakers -------------------------------------------------------------------- */
  function speakerHtml(i, p, leader, grouped) {
    if (!reachable(p.id)) return `<section class="ap-player off"><header><b>${esc(p.label)}</b><span>Offline</span></header></section>`;
    const at = attrs(p.id);
    const status = [STATE_NL[s(p.id).state] || s(p.id).state, at.source].filter(known).join(" · ");
    const sources =
      can(p.id, F.SELECT_SOURCE) && Array.isArray(at.source_list)
        ? `<div class="ap-chips">${at.source_list.map((src) => chip(i, `source|${p.key}|${src}`, src, src === at.source)).join("")}</div>`
        : "";
    const together =
      p !== leader && can(p.id, F.GROUPING) && reachable(leader.id)
        ? `<div class="ap-row">${btn(i, `group|${p.key}`, `Samen met ${leader.label}`, { active: grouped.includes(p), ic: "link" })}</div>`
        : "";
    return `<section class="ap-player"><header><b>${esc(p.label)}</b><span>${esc(status)}</span></header>${transport(i, p.key, p.id)}${sources}${together}</section>`;
  }

  Panel.defineAppliance("speakers", {
    icon: "speaker",
    view(a, i) {
      const players = a.players.map((p) => ({ ...p, id: a.entities[p.key] }));
      const live = players.filter((p) => reachable(p.id));
      if (!live.length) return offlineView("De speakers zijn niet bereikbaar");
      const lead = live.find((p) => s(p.id).state === "playing") || live.find((p) => s(p.id).state === "paused");
      const at = lead ? attrs(lead.id) : {};
      const leader = players[0];
      const members = attrs(leader.id).group_members || [];
      const grouped = players.filter((p) => p !== leader && members.includes(p.id));
      const playing = lead && s(lead.id).state === "playing";
      return {
        tone: playing ? "run" : lead ? "paused" : "ready",
        pill: playing ? "Speelt" : lead ? "Gepauzeerd" : "Stil",
        big: lead ? (known(at.media_title) ? at.media_title : lead.label) : "Geen muziek",
        word: true,
        sub: lead ? [at.media_artist, `${lead.label}${known(at.source) ? ` via ${at.source}` : ""}`].filter(known).join(" · ") : "",
        extra: lead ? art(at) : "",
        stats: [
          stat("Samen", grouped.length ? [leader, ...grouped].map((p) => p.label).join(" + ") : "Los"),
          stat("Bereikbaar", `${live.length} van ${players.length}`),
        ],
        controls: players.map((p) => speakerHtml(i, p, leader, grouped)).join(""),
      };
    },
    actions: {
      ...MEDIA_ACTIONS,
      source: (a, [key, source], call) => call("media_player", "select_source", { source }, a.entities[key]),
      group(a, [key], call) {
        const leader = a.entities[a.players[0].key];
        const id = a.entities[key];
        if ((attrs(leader).group_members || []).includes(id)) call("media_player", "unjoin", null, id);
        else call("media_player", "join", { group_members: [id] }, leader);
      },
    },
  });

  /* ---- TV --------------------------------------------------------------------------- */
  Panel.defineAppliance("tv", {
    icon: "tv",
    view(a, i) {
      const e = a.entities;
      const wake = s(e.wake) ? `<div class="ap-row">${btn(i, "wake", "Aanzetten", { primary: true, ic: "power" })}</div>` : "";
      if (!reachable(e.player) || s(e.player).state === "off") {
        return {
          tone: "off",
          pill: "Uit",
          big: "Uit",
          word: true,
          sub: "Het scherm staat uit of is niet bereikbaar",
          stats: [],
          controls: wake + note(wake ? "Aanzetten gaat via Wake-on-LAN: het scherm moet netwerk-stand-by aan hebben." : "Aanzetten kan alleen op het scherm zelf."),
        };
      }
      const at = attrs(e.player);
      const state = s(e.player).state;
      return {
        tone: state === "playing" ? "run" : state === "paused" ? "paused" : "ready",
        pill: state === "playing" ? "Speelt" : state === "paused" ? "Gepauzeerd" : "Aan",
        big: known(at.media_title) ? at.media_title : "Aan",
        word: true,
        sub: [at.media_artist, at.source].filter(known).join(" · "),
        extra: art(at),
        stats: [stat("Volume", percent(volumeOf(e.player))), stat("Geluid", at.is_volume_muted ? "Gedempt" : "Aan")],
        controls:
          transport(i, "player", e.player) +
          (can(e.player, F.TURN_OFF) ? `<div class="ap-row">${btn(i, "off", "Uitzetten", { ic: "power", confirm: true })}</div>` : ""),
      };
    },
    actions: {
      ...MEDIA_ACTIONS,
      wake: (a, args, call) => call("button", "press", null, a.entities.wake),
      off: (a, args, call) => call("media_player", "turn_off", null, a.entities.player),
    },
  });
})();
