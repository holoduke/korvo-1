/* Audio: the WiiM speakers, all of them on one page.
 *
 *   Nu speelt     the group that plays (else the first speaker): its cover,
 *                 title and source, the sound's quality, transport, how far
 *                 the track is, and one volume for the whole group
 *   Groepen       which speakers play together (the leader first), every
 *                 speaker in or out of a group with a tap, everything together
 *                 or apart, and the house's own auto-grouping (the WiiM
 *                 automations that keep Keuken and Woonkamer together) on/off
 *   Speakers      per speaker: volume, mute, transport, source, equalizer
 *                 (on/off, its presets, the ten bands), sleep timer, and how
 *                 it is doing (Wi-Fi, temperatures, firmware)
 *   Snel          pause all, mute all, volumes alike, Bluetooth pairing
 *
 * Playing, volume, source and groups go through Home Assistant's wiim
 * integration (media_player services). The equalizer, sleep timer, Wi-Fi and
 * temperatures are not in that integration: the thuispaneel integration reads
 * them from the speakers' own HTTP API (websocket thuispaneel/audio, a fixed
 * list of commands in thuispaneel/audio/cmd; ha/custom_components/thuispaneel/audio.py).
 */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg } = Panel;
  const { esc, fmt, clamp } = Util;
  const PLAYERS = (cfg.media || []).map((m) => ({ id: m.id, label: m.label }));
  const REFRESH_MS = 20e3;
  /* The house's WiiM automations: Keuken and Woonkamer kept together, volumes alike. */
  const AUTO = [
    "automation.wiim_keuken_volgt_living_room",
    "automation.wiim_living_room_volgt_keuken",
    "automation.wiim_groep_herstellen_als_niets_speelt",
    "automation.wiim_volume_keuken_en_living_room_gelijk",
  ];
  /* rest_command.wiim_keuken_bluetooth (a service, no entity): the kitchen speaker ready for Bluetooth */
  const BT_SPEAKER = "media_player.kitchen";
  const SLEEP = [0, 15, 30, 60, 90, 120];
  /* source names in Dutch: the speaker's own modes and Home Assistant's source_list names */
  const SOURCE_NL = {
    wifi: "Wifi", bluetooth: "Bluetooth", "line-in": "Line-in", optical: "Optisch", coaxial: "Coax", HDMI: "HDMI", udisk: "USB",
    Network: "Wifi", "Line In": "Line-in", "Optical In": "Optisch", TV: "TV (HDMI)",
  };
  const STATE_NL = { playing: "Speelt", paused: "Pauze", idle: "Stil", on: "Aan", off: "Uit", standby: "Stand-by", buffering: "Laden", unavailable: "Offline" };

  const s = (id) => Panel.st(id);
  const at = (id) => (s(id) || {}).attributes || {};
  const online = (id) => !!s(id) && s(id).state !== "unavailable";
  const playing = (id) => (s(id) || {}).state === "playing";
  const label = (id) => (PLAYERS.find((p) => p.id === id) || {}).label || at(id).friendly_name || id;
  const vol = (id) => (at(id).volume_level == null ? NaN : Number(at(id).volume_level));
  const pct = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : "–");
  const real = (v) => v && !/^unknown$/i.test(String(v)) ? String(v).split(" •")[0] : "";
  /* A speaker's group: its members, the leader first (as the wiim integration lists them). */
  const members = (id) => {
    const m = (at(id).group_members || []).filter((x) => PLAYERS.some((p) => p.id === x));
    return m.length ? m : [id];
  };
  const leaderOf = (id) => members(id)[0];
  const isLeader = (id) => leaderOf(id) === id;
  function groups() {
    const seen = new Set(), out = [];
    for (const p of PLAYERS) {
      if (seen.has(p.id)) continue;
      const m = members(p.id).filter((x) => !seen.has(x));
      m.forEach((x) => seen.add(x));
      out.push(m);
    }
    return out;
  }
  /* The group shown on top: the one that plays, else the largest. */
  function heroGroup() {
    const gs = groups();
    return gs.find((g) => g.some(playing)) || gs.slice().sort((a, b) => b.length - a.length)[0] || [];
  }

  /* ---- The speakers' own data (thuispaneel/audio) -------------------------------------- */
  let audio = null; /* {at, speakers: [...]} */
  let loadedAt = 0, busy = false, failed = false;
  let cmdGen = 0; /* bumped by every command: a refresh that started before one is out of date */
  const extra = (id) => ((audio && audio.speakers) || []).find((x) => x.entity_id === id) || null;
  async function load() {
    if (busy || !Panel.client || !Panel.client.audio) return;
    busy = true;
    const gen = cmdGen;
    try {
      const res = await Panel.client.audio();
      failed = false;
      if (gen !== cmdGen) {
        /* a command landed meanwhile and brought its own fresh state: keep that, ask again shortly */
        setTimeout(load, 3000);
      } else {
        audio = res;
        loadedAt = Date.now();
      }
    } catch (e) {
      failed = true;
    } finally {
      busy = false;
    }
    render();
  }
  async function cmd(id, what, value, done) {
    cmdGen++;
    try {
      const res = await Panel.client.audioCmd(id, what, value);
      if (res && res.speaker && audio) audio.speakers = audio.speakers.map((x) => (x.entity_id === id ? res.speaker : x));
      if (done) Panel.toast(done, "ok");
    } catch (e) {
      Panel.toast(`${label(id)}: niet gelukt${e && e.message ? ` (${e.message})` : ""}`);
    }
    render();
  }
  const call = (domain, service, data, ids, subject) =>
    Panel.client.callService(domain, service, data || null, ids ? { entity_id: ids } : null).catch(Panel.commandFailed(subject || "Audio"));

  /* ---- Pieces ----------------------------------------------------------------------------- */
  const btn = (act, text, o = {}) =>
    `<button class="au-btn${o.primary ? " primary" : ""}${o.active ? " active" : ""}${o.round ? " round" : ""}" data-act="${esc(act)}"${o.disabled ? " disabled" : ""} aria-label="${esc(text)}">${o.ic ? icon(o.ic) : ""}${o.round ? "" : `<span>${esc(text)}</span>`}</button>`;
  const slider = (act, v, o = {}) =>
    `<label class="au-slider${o.big ? " big" : ""}">${icon(o.muted ? "mute" : "speaker")}<input type="range" min="0" max="100" step="1" value="${Number.isFinite(v) ? Math.round(v * 100) : 0}" data-act="${esc(act)}" aria-label="${esc(o.aria || "Volume")}"><b>${pct(v)}</b></label>`;
  function bars(dbm) {
    const n = !Number.isFinite(dbm) ? 0 : dbm >= -55 ? 4 : dbm >= -65 ? 3 : dbm >= -72 ? 2 : 1;
    return `<span class="au-bars n${n}"><i></i><i></i><i></i><i></i></span>`;
  }
  /* The ten equalizer bands as bars from the middle line. Values come either
   * 0..100 around 50 or as dB around 0. */
  function eqBands(bandsIn, on) {
    const v = (bandsIn || []).filter(Number.isFinite);
    if (!v.length) return "";
    const centered = v.some((x) => x > 20) ? v.map((x) => x - 50) : v;
    const max = Math.max(1, ...centered.map(Math.abs));
    const names = ["31", "63", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];
    return (
      `<div class="au-eqbands${on ? "" : " off"}">` +
      centered.map((x, i) => `<div><span style="--h:${(Math.abs(x) / max) * 50}%" class="${x >= 0 ? "up" : "down"}"></span><em>${names[i] || ""}</em></div>`).join("") +
      `</div>`
    );
  }
  function art(id) {
    const a = at(id);
    const pic = a.entity_picture && !/^unknown/i.test(a.entity_picture) ? a.entity_picture : "";
    return pic
      ? `<img class="au-art" src="${esc(pic)}" alt="">`
      : `<div class="au-art empty${playing(id) ? " live" : ""}">${icon("music")}<span class="au-eq-anim"><i></i><i></i><i></i><i></i></span></div>`;
  }
  /* What a speaker plays, in words: title and artist, else its source. */
  function nowText(id) {
    const a = at(id), x = extra(id) || {};
    const title = real(a.media_title) || real(x.title), artist = real(a.media_artist) || real(x.artist);
    return { title, artist, album: real(a.media_album_name), source: sourceName(id) };
  }
  function sourceName(id) {
    const x = extra(id);
    if (x && x.follower) return `volgt ${label(leaderOf(id))}`;
    const src = at(id).source || (x && x.mode);
    return src ? SOURCE_NL[src] || src : "";
  }
  /* Sources: the integration's list when it has one, else the speaker's own modes. */
  function sources(id) {
    const list = at(id).source_list;
    if (list && list.length) return list.map((name) => ({ name, label: SOURCE_NL[name] || name, active: at(id).source === name, via: "ha" }));
    const mode = (extra(id) || {}).mode;
    return ["wifi", "bluetooth"].map((m) => ({ name: m, label: SOURCE_NL[m], active: mode === m || (m === "bluetooth" && at(id).source === "Bluetooth"), via: "wiim" }));
  }
  function quality(id) {
    const q = (extra(id) || {}).quality || {};
    const parts = [];
    if (q.rate > 0) parts.push(`${fmt(q.rate / 1000, q.rate % 1000 ? 1 : 0)} kHz`);
    if (q.bits > 0) parts.push(`${q.bits} bit`);
    if (q.kbps > 0) parts.push(`${fmt(q.kbps)} kbit/s`);
    return parts.join(" · ");
  }
  /* Where the track is, in seconds, from the position and when it was read. */
  function position(id) {
    const a = at(id);
    const d = Number(a.media_duration), p = Number(a.media_position);
    if (!(d > 0) || !Number.isFinite(p)) return null;
    const since = playing(id) && a.media_position_updated_at ? (Date.now() - new Date(a.media_position_updated_at).getTime()) / 1000 : 0;
    return { pos: clamp(p + since, 0, d), dur: d };
  }
  const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

  /* ---- Rendering ---------------------------------------------------------------------- */
  let root = null;
  function heroHtml() {
    const g = heroGroup();
    if (!g.length) return "";
    const lead = g[0];
    const n = nowText(lead), q = quality(lead), p = position(lead);
    const vols = g.map(vol).filter(Number.isFinite);
    const gv = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : NaN;
    const allMuted = g.every((id) => at(id).is_volume_muted);
    return (
      `<div class="dc-panel au-hero${playing(lead) ? " live" : ""}">` +
      art(lead) +
      `<div class="au-hero-body">` +
      `<div class="au-kicker">${playing(lead) ? "Nu speelt" : STATE_NL[(s(lead) || {}).state] || "Stil"} · ${esc(g.map(label).join(" + "))}</div>` +
      `<div class="au-title">${esc(n.title || (playing(lead) ? n.source || "Muziek" : "Niets aan het spelen"))}</div>` +
      `<div class="au-sub">${esc([n.artist, n.album].filter(Boolean).join(" · ") || (n.title ? "" : n.source ? `Bron: ${n.source}` : ""))}</div>` +
      `<div class="au-tags">${n.source ? `<span>${esc(n.source)}</span>` : ""}${q ? `<span>${esc(q)}</span>` : ""}${g.length > 1 ? `<span>${g.length} speakers samen</span>` : ""}</div>` +
      (p ? `<div class="au-prog"><span class="au-t0">${mmss(p.pos)}</span><div><b style="width:${(p.pos / p.dur) * 100}%"></b></div><span>${mmss(p.dur)}</span></div>` : "") +
      `<div class="au-transport">` +
      btn(`prev|${lead}`, "Vorige", { ic: "prev", round: true }) +
      btn(`play|${lead}`, playing(lead) ? "Pauze" : "Speel", { ic: playing(lead) ? "pause" : "play", round: true, primary: true }) +
      btn(`next|${lead}`, "Volgende", { ic: "next", round: true }) +
      btn(`stop|${lead}`, "Stop", { ic: "stop", round: true }) +
      `</div>` +
      `<div class="au-hero-vol">${slider(`gvol|${g.join(",")}`, gv, { big: true, muted: allMuted, aria: "Volume van de groep" })}${btn(`gmute|${g.join(",")}`, allMuted ? "Geluid aan" : "Dempen", { ic: "mute", active: allMuted })}</div>` +
      `</div></div>`
    );
  }
  function groupsHtml() {
    const gs = groups();
    const autoKnown = AUTO.filter((id) => s(id));
    const autoOn = autoKnown.length && autoKnown.every((id) => s(id).state === "on");
    const cards = gs
      .map((g) => {
        const lead = g[0];
        const live = g.some(playing);
        return (
          `<div class="au-group${live ? " live" : ""}${g.length > 1 ? " multi" : ""}">` +
          `<div class="au-group-head"><b>${g.length > 1 ? `Groep ${esc(label(lead))}` : esc(label(lead))}</b><span>${esc(STATE_NL[(s(lead) || {}).state] || "")}</span></div>` +
          `<div class="au-chain">` +
          g.map((id, i) => `${i ? `<span class="au-link">${icon("link")}</span>` : ""}<span class="au-node${i === 0 ? " lead" : ""}${online(id) ? "" : " off"}">${icon("speaker")}<span>${esc(label(id))}</span>${i === 0 && g.length > 1 ? "<em>leider</em>" : ""}</span>`).join("") +
          `</div>` +
          `<div class="au-row">` +
          (g.length > 1 ? btn(`split|${g.join(",")}`, "Groep opheffen", { ic: "close" }) : "") +
          PLAYERS.filter((p) => !g.includes(p.id) && isLeader(p.id))
            .map((p) => btn(`join|${p.id}|${lead}`, `Voeg ${label(p.id)} toe`, { ic: "plus", disabled: !online(p.id) }))
            .join("") +
          `</div></div>`
        );
      })
      .join("");
    return (
      `<div><h2 class="dc-title">Groepen</h2><div class="dc-panel au-groups">` +
      `<div class="au-row au-group-actions">` +
      PLAYERS.filter((p) => online(p.id)).map((p) => btn(`all|${p.id}`, `Alles samen met ${label(p.id)}`, { ic: "link", active: members(p.id).length === PLAYERS.filter((x) => online(x.id)).length && isLeader(p.id) })).join("") +
      btn("apart", "Alles los", { ic: "close" }) +
      `</div>` +
      `<div class="au-group-list">${cards}</div>` +
      (autoKnown.length
        ? `<div class="au-auto"><div><b>Automatisch koppelen</b><span>Keuken en Woonkamer spelen altijd samen, met hetzelfde volume; Bluetooth gaat eerst via de keuken. Uit: de groepen blijven zoals je ze hier zet.</span></div>` +
          `<button class="au-switch${autoOn ? " on" : ""}" data-act="auto|${autoOn ? "off" : "on"}" role="switch" aria-checked="${autoOn}" aria-label="Automatisch koppelen"><i></i></button></div>`
        : "") +
      `</div></div>`
    );
  }
  function speakerHtml(id) {
    const st = s(id), x = extra(id);
    if (!st || st.state === "unavailable")
      return `<div class="dc-panel au-card off"><div class="au-card-head">${icon("speaker")}<div><b>${esc(label(id))}</b><span>Offline</span></div></div><p class="au-note">Home Assistant bereikt deze speaker niet.</p></div>`;
    const a = at(id), n = nowText(id), muted = !!a.is_volume_muted, lead = leaderOf(id), grouped = members(id).length > 1;
    const role = grouped ? (lead === id ? "Leider" : `Volgt ${label(lead)}`) : "Los";
    const w = (x && x.wifi) || {};
    const eq = (x && x.eq) || null;
    const left = x && x.sleep > 0 ? x.sleep : 0;
    return (
      `<div class="dc-panel au-card${playing(id) ? " live" : ""}">` +
      `<div class="au-card-head">${icon("speaker")}<div><b>${esc(label(id))}</b><span>${esc([x && x.model, role].filter(Boolean).join(" · "))}</span></div><em class="au-state ${esc(st.state)}">${esc(STATE_NL[st.state] || st.state)}</em></div>` +
      `<div class="au-now">${playing(id) || n.title ? `${icon("music")}<span>${esc(n.title ? [n.title, n.artist].filter(Boolean).join(" – ") : n.source || "Muziek")}</span>` : `<span class="dim">${esc(n.source ? `Bron: ${n.source}` : "Niets aan het spelen")}</span>`}</div>` +
      `<div class="au-volrow">${slider(`vol|${id}`, vol(id), { muted })}${btn(`mute|${id}`, muted ? "Geluid aan" : "Dempen", { ic: "mute", active: muted, round: true })}</div>` +
      `<div class="au-row au-small">` +
      btn(`prev|${id}`, "Vorige", { ic: "prev", round: true, disabled: lead !== id }) +
      btn(`play|${id}`, playing(id) ? "Pauze" : "Speel", { ic: playing(id) ? "pause" : "play", round: true, primary: !playing(id), disabled: lead !== id }) +
      btn(`next|${id}`, "Volgende", { ic: "next", round: true, disabled: lead !== id }) +
      (grouped ? btn(`leave|${id}`, lead === id ? "Groep opheffen" : "Loskoppelen", { ic: "close" }) : "") +
      `</div>` +
      `<div class="au-block"><h3>Bron</h3><div class="au-chips">` +
      sources(id).map((src) => `<button class="au-chip${src.active ? " active" : ""}" data-act="src|${id}|${src.via}|${esc(src.name)}"${lead !== id ? " disabled" : ""}>${esc(src.label)}</button>`).join("") +
      `</div></div>` +
      (eq
        ? `<div class="au-block"><h3>Equalizer <button class="au-switch small${eq.on ? " on" : ""}" data-act="eq|${id}|${eq.on ? "off" : "on"}" role="switch" aria-checked="${eq.on}" aria-label="Equalizer"><i></i></button></h3>` +
          `<select class="au-select" data-act="eqp|${id}" aria-label="Equalizer-stand"${eq.on ? "" : " disabled"}>${(eq.presets || []).map((p) => `<option${p === eq.name ? " selected" : ""}>${esc(p)}</option>`).join("")}${eq.presets && eq.presets.includes(eq.name) ? "" : `<option selected>${esc(eq.name || "Eigen")}</option>`}</select>` +
          eqBands(eq.bands, eq.on) +
          `</div>`
        : "") +
      (x && x.online
        ? `<div class="au-block"><h3>Slaaptimer${left ? ` <span class="au-left">nog ${Math.ceil(left / 60)} min</span>` : ""}</h3><div class="au-chips">` +
          SLEEP.map((m) => `<button class="au-chip${(m === 0 && !left) ? " active" : ""}" data-act="sleep|${id}|${m * 60}">${m ? `${m} min` : "Uit"}</button>`).join("") +
          `</div></div>` +
          `<div class="au-health">` +
          `<span>${bars(w.rssi)}<b>${Number.isFinite(w.rssi) ? `${w.rssi} dBm` : w.wired ? "Kabel" : "–"}</b>${w.band ? ` ${esc(w.band)}` : ""}${Number.isFinite(Number(w.rate)) && w.rate ? ` · ${fmt(Number(w.rate))} Mbit/s` : ""}</span>` +
          (Number.isFinite(x.temp_cpu) ? `<span>${icon("thermometer")}CPU <b>${x.temp_cpu}°</b>${Number.isFinite(x.temp_amp) ? ` · versterker <b>${x.temp_amp}°</b>` : ""}</span>` : "") +
          `<span>${icon("wrench")}${esc(x.firmware || "")}${x.update ? ` <b class="warn">update</b>` : ""}</span>` +
          `<span>${icon("globe")}${esc(x.host)}${x.internet ? "" : ` <b class="warn">geen internet</b>`}</span>` +
          `</div>`
        : x && x.error
          ? `<p class="au-note">Extra gegevens niet bereikbaar (${esc(x.error)}).</p>`
          : "") +
      `</div>`
    );
  }
  function quickHtml() {
    const any = PLAYERS.filter((p) => online(p.id));
    const allMuted = any.length && any.every((p) => at(p.id).is_volume_muted);
    return (
      `<div><h2 class="dc-title">Snel</h2><div class="dc-panel au-quick">` +
      btn("pauseall", "Alles pauzeren", { ic: "pause" }) +
      btn("muteall", allMuted ? "Alles geluid aan" : "Alles dempen", { ic: "mute", active: allMuted }) +
      btn("evenvol", "Volume overal gelijk", { ic: "speaker" }) +
      (PLAYERS.some((p) => p.id === BT_SPEAKER) ? btn("btpair", "Bluetooth koppelen via keuken", { ic: "link" }) : "") +
      btn("refresh", "Speakers vernieuwen", { ic: "refresh" }) +
      `</div></div>`
    );
  }
  function render() {
    if (!root || !Panel.onScreen("audio")) return;
    /* not while a finger is on a slider or a menu is open: that would pull it away */
    if (holding || (document.activeElement && root.contains(document.activeElement) && document.activeElement.tagName === "SELECT")) {
      pending = true;
      return;
    }
    pending = false;
    const scroll = root.scrollTop;
    root.innerHTML =
      heroHtml() +
      groupsHtml() +
      `<div><h2 class="dc-title">Speakers</h2><div class="au-cards">${PLAYERS.map((p) => speakerHtml(p.id)).join("")}</div></div>` +
      quickHtml() +
      (failed && !audio ? `<p class="au-note">Equalizer, slaaptimer en wifi komen van de thuispaneel-integratie; die antwoordt nu niet.</p>` : "");
    root.scrollTop = scroll;
  }

  /* ---- Acting --------------------------------------------------------------------------- */
  let holding = false, pending = false, holdTimer = 0;
  const volTimers = new Map();
  function setVolume(ids, v) {
    const key = ids.join(",");
    clearTimeout(volTimers.get(key));
    volTimers.set(key, setTimeout(() => call("media_player", "volume_set", { volume_level: Math.round(v * 100) / 100 }, ids, "Volume"), 120));
  }
  function act(a, el) {
    const [what, ...p] = a.split("|");
    const ids = (p[0] || "").split(",").filter(Boolean);
    switch (what) {
      case "play": return call("media_player", "media_play_pause", null, p[0]);
      case "prev": return call("media_player", "media_previous_track", null, p[0]);
      case "next": return call("media_player", "media_next_track", null, p[0]);
      case "stop": return call("media_player", "media_stop", null, p[0]);
      case "mute": return call("media_player", "volume_mute", { is_volume_muted: !at(p[0]).is_volume_muted }, p[0]);
      case "gmute": {
        const m = !ids.every((id) => at(id).is_volume_muted);
        return call("media_player", "volume_mute", { is_volume_muted: m }, ids);
      }
      case "join": return call("media_player", "join", { group_members: [p[0]] }, p[1], "Koppelen");
      case "leave": return call("media_player", "unjoin", null, leaderOf(p[0]) === p[0] ? members(p[0]).slice(1) : p[0], "Loskoppelen");
      case "split": return call("media_player", "unjoin", null, ids.slice(1), "Groep opheffen");
      case "all": {
        const others = PLAYERS.filter((x) => x.id !== p[0] && online(x.id)).map((x) => x.id);
        const loose = others.filter((id) => leaderOf(id) !== p[0] && members(id).length > 1);
        return (loose.length ? call("media_player", "unjoin", null, loose) : Promise.resolve()).then(() =>
          call("media_player", "join", { group_members: others }, p[0], "Alles samen"));
      }
      case "apart": {
        const followers = PLAYERS.filter((x) => online(x.id) && !isLeader(x.id)).map((x) => x.id);
        if (!followers.length) return Panel.toast("Alle speakers spelen al los", "ok");
        if (AUTO.some((id) => (s(id) || {}).state === "on")) Panel.toast("Let op: automatisch koppelen staat aan en zet Keuken en Woonkamer weer samen", "warn");
        return call("media_player", "unjoin", null, followers, "Alles los");
      }
      case "auto": return call("automation", p[0] === "on" ? "turn_on" : "turn_off", null, AUTO.filter((id) => s(id)), "Automatisch koppelen");
      case "src":
        if (p[1] === "ha") return call("media_player", "select_source", { source: p[2] }, p[0], "Bron");
        return cmd(p[0], "mode", p[2]).then(() => setTimeout(load, 2500));
      case "eq": return cmd(p[0], "eq", p[1]);
      case "sleep": return cmd(p[0], "sleep", Number(p[1]), Number(p[1]) ? `${label(p[0])} gaat over ${Number(p[1]) / 60} min uit` : `Slaaptimer ${label(p[0])} uit`);
      case "pauseall": return call("media_player", "media_pause", null, PLAYERS.filter((x) => playing(x.id) && isLeader(x.id)).map((x) => x.id), "Pauzeren");
      case "muteall": {
        const on = PLAYERS.filter((x) => online(x.id));
        return call("media_player", "volume_mute", { is_volume_muted: !on.every((x) => at(x.id).is_volume_muted) }, on.map((x) => x.id));
      }
      case "evenvol": {
        const g = heroGroup(), v = vol(g[0]);
        if (!Number.isFinite(v)) return;
        return call("media_player", "volume_set", { volume_level: v }, PLAYERS.filter((x) => online(x.id)).map((x) => x.id), "Volume").then(() => Panel.toast(`Overal ${pct(v)}`, "ok"));
      }
      case "btpair": return call("rest_command", "wiim_keuken_bluetooth", null, null, "Bluetooth").then(() => Panel.toast("Keuken staat klaar voor Bluetooth: kies ‘Kitchen’ op je telefoon", "ok"));
      case "refresh": return load();
    }
  }
  function build(page) {
    root = page.querySelector("#audioPage");
    root.addEventListener("click", (e) => {
      const el = e.target.closest("button[data-act]");
      if (!el || el.disabled) return;
      act(el.dataset.act, el);
    });
    root.addEventListener("input", (e) => {
      const el = e.target;
      if (el.type !== "range") return;
      const [what, ids] = el.dataset.act.split("|");
      const v = Number(el.value) / 100;
      el.parentElement.querySelector("b").textContent = pct(v);
      setVolume(ids.split(","), v);
      if (what === "gvol") return;
    });
    root.addEventListener("change", (e) => {
      const el = e.target;
      if (el.tagName === "SELECT") {
        const [, id] = el.dataset.act.split("|");
        cmd(id, "eq_preset", el.value, `${label(id)}: ${el.value}`);
        el.blur();
      }
    });
    const hold = () => {
      holding = true;
      clearTimeout(holdTimer);
    };
    const release = () => {
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        holding = false;
        if (pending) render();
      }, 700);
    };
    /* any finger on the page holds the rebuilds back, so the button under it stays the one tapped */
    root.addEventListener("pointerdown", hold);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
  }
  /* The hero's track position, every second while something plays. */
  setInterval(() => {
    if (!root || !Panel.onScreen("audio") || Panel.sleeping()) return;
    const g = heroGroup(), p = g.length && position(g[0]);
    const bar = root.querySelector(".au-prog b"), t0 = root.querySelector(".au-t0");
    if (p && bar) {
      bar.style.width = `${(p.pos / p.dur) * 100}%`;
      t0.textContent = mmss(p.pos);
    }
  }, 1000);

  /* ---- Quick controls beside the 3D house ---------------------------------------- */
  /* While music plays (and ten minutes after a pause, to resume): a card in
   * the column with the garage door — what plays and where, play/pause,
   * previous and next, the whole group's volume in steps, and mute. */
  const QUICK_STEP = 0.05;
  const PAUSED_KEEP_MS = 10 * 60e3;
  let quick = null;
  let quickVol = null; /* {key, value, until}: the volume last sent, so quick taps step on */
  function quickGroup() {
    const g = heroGroup();
    if (!g.length) return null;
    const lead = g[0];
    const st = s(lead);
    if (!st) return null;
    if (st.state === "playing") return g;
    const pausedFor = Date.now() - (st.lastChanged || 0); /* ha.js keeps it as ms */
    return st.state === "paused" && pausedFor < PAUSED_KEEP_MS ? g : null;
  }
  function groupVolume(g) {
    const key = g.join(",");
    if (quickVol && quickVol.key === key && Date.now() < quickVol.until) return quickVol.value;
    const v = g.map(vol).filter(Number.isFinite);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  }
  let quickHeld = false, quickPending = false;
  let quickBox = null;
  function renderQuick() {
    if (!quick) return;
    /* not under a finger: the button pressed must still be there when it lifts */
    if (quickHeld) return void (quickPending = true);
    const g = quickGroup();
    const was = quickBox.hidden;
    quickBox.hidden = !g || roomOpen;
    if (was !== quickBox.hidden) Panel.emit("quickaudio"); /* start.js places it */
    if (!g) return;
    const lead = g[0], n = nowText(lead), v = groupVolume(g);
    const muted = g.every((id) => at(id).is_volume_muted);
    const what = n.title ? [n.title, n.artist].filter(Boolean).join(" – ") : n.source ? `Bron: ${n.source}` : "Muziek";
    quick.classList.toggle("live", playing(lead));
    quick.innerHTML =
      `<div class="cw-title">${icon("music")}<span>${esc(g.map(label).join(" + "))}</span></div>` +
      `<div class="aq-now" title="${esc(what)}">${esc(what)}</div>` +
      `<div class="aq-row aq-transport">` +
      `<button class="ap-btn" data-aq="prev" aria-label="Vorige">${icon("prev")}</button>` +
      `<button class="ap-btn primary" data-aq="play" aria-label="${playing(lead) ? "Pauze" : "Speel"}">${icon(playing(lead) ? "pause" : "play")}</button>` +
      `<button class="ap-btn" data-aq="next" aria-label="Volgende">${icon("next")}</button>` +
      `</div>` +
      `<div class="aq-row aq-vol">` +
      `<button class="ap-btn" data-aq="down" aria-label="Zachter"${v <= 0 ? " disabled" : ""}>${icon("minus")}</button>` +
      `<b class="aq-pct${muted ? " muted" : ""}">${muted ? "stil" : pct(v)}</b>` +
      `<button class="ap-btn" data-aq="up" aria-label="Harder"${v >= 1 ? " disabled" : ""}>${icon("plus")}</button>` +
      `</div>` +
      `<button class="ap-btn aq-mute${muted ? " on" : ""}" data-aq="mute" aria-label="${muted ? "Geluid aan" : "Dempen"}">${icon("mute")}<span>${muted ? "Geluid aan" : "Dempen"}</span></button>`;
  }
  function quickAct(what) {
    const g = quickGroup();
    if (!g) return;
    const lead = g[0];
    if (what === "play") return call("media_player", "media_play_pause", null, lead);
    if (what === "prev") return call("media_player", "media_previous_track", null, lead);
    if (what === "next") return call("media_player", "media_next_track", null, lead);
    if (what === "mute") return call("media_player", "volume_mute", { is_volume_muted: !g.every((id) => at(id).is_volume_muted) }, g);
    const cur = groupVolume(g);
    const next = clamp(Math.round(((Number.isFinite(cur) ? cur : 0.3) + (what === "up" ? QUICK_STEP : -QUICK_STEP)) * 100) / 100, 0, 1);
    quickVol = { key: g.join(","), value: next, until: Date.now() + 4000 };
    renderQuick(); /* the new number at once, before the speakers confirm */
    if (g.some((id) => at(id).is_volume_muted)) call("media_player", "volume_mute", { is_volume_muted: false }, g);
    return call("media_player", "volume_set", { volume_level: next }, g, "Volume");
  }
  Panel.on("start", () =>
    /* after covers.js has put up its column (on "start" too) */
    requestAnimationFrame(() => {
      const house = document.querySelector(".start-page .house");
      if (!house) return;
      /* its own place: start.js stands it above the garage door's column; on a phone it is a bar along the top */
      house.insertAdjacentHTML("beforeend", `<div class="house-cover house-audio" data-house-audio hidden><div class="cover cw aq"></div></div>`);
      const box = house.querySelector("[data-house-audio]");
      quick = box.querySelector(".aq");
      quickBox = box;
      quick.addEventListener("click", (e) => {
        const b = e.target.closest("[data-aq]");
        if (b && !b.disabled) quickAct(b.dataset.aq);
      });
      ["pointerdown", "touchstart"].forEach((ev) => quick.addEventListener(ev, (e) => e.stopPropagation(), { passive: true }));
      quick.addEventListener("pointerdown", () => (quickHeld = true));
      const letGo = () =>
        quickHeld &&
        setTimeout(() => {
          quickHeld = false;
          if (quickPending) (quickPending = false), renderQuick();
        }, 400);
      window.addEventListener("pointerup", letGo);
      window.addEventListener("pointercancel", letGo);
      renderQuick();
    })
  );
  let roomOpen = false; /* a room's panel stands where it would */
  Panel.on("room", (room) => {
    roomOpen = !!room;
    renderQuick();
  });
  Panel.track(PLAYERS.map((p) => p.id), () => renderQuick());
  /* the ten minutes after a pause run out without a state change */
  Panel.everyAwake(60e3, () => renderQuick());

  Panel.definePage("audio", { className: "audio-page", html: () => `<div id="audioPage" class="dc-page au-page"></div>`, build });
  const later = Panel.whenShown("audio", render);
  Panel.track(PLAYERS.map((p) => p.id).concat(AUTO), () => later());
  Panel.on("section", (i) => {
    if (cfg.sections[i].kind !== "audio") return;
    render();
    if (Panel.isLoaded() && Date.now() - loadedAt > REFRESH_MS / 2) load();
  });
  Panel.on("loaded", () => Panel.onScreen("audio") && load());
  Panel.everyAwake(REFRESH_MS, () => Panel.isLoaded() && Panel.onScreen("audio") && load());
})();
