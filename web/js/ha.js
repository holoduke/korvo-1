/* Home Assistant connection for the web panel.
 *
 * - Login uses HA's own OAuth2 flow (/auth/authorize + /auth/token), exactly
 *   like the HA frontend: no token lives in this code. Tokens are kept in
 *   localStorage and refreshed before they expire.
 * - Live state comes from the WebSocket API's subscribe_entities (compressed
 *   diff format), with keep-alive pings and automatic reconnects.
 * - ?demo starts an in-browser fake backend with the same interface, so the
 *   UI can be explored (and tested) without touching real lights.
 */
(function () {
  "use strict";

  const LS_TOKENS = "panel.tokens";
  const LS_HASS = "panel.hassUrl";

  /* ---- Auth ---------------------------------------------------------------- */

  function hassUrl() {
    const stored = localStorage.getItem(LS_HASS);
    if (stored) return stored.replace(/\/$/, "");
    return location.origin;
  }

  const clientId = () => location.origin + "/";
  const redirectUri = () => location.origin + location.pathname;

  function loadTokens() {
    try {
      return JSON.parse(localStorage.getItem(LS_TOKENS) || "null");
    } catch (e) {
      return null;
    }
  }

  function saveTokens(t) {
    localStorage.setItem(LS_TOKENS, JSON.stringify(t));
  }

  async function tokenRequest(params) {
    const body = new URLSearchParams({ client_id: clientId(), ...params });
    const res = await fetch(hassUrl() + "/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const err = new Error("token request failed: " + res.status);
      err.status = res.status;
      throw err;
    }
    const d = await res.json();
    return {
      access_token: d.access_token,
      refresh_token: d.refresh_token || params.refresh_token || null,
      expires: Date.now() + (d.expires_in || 1800) * 1000,
    };
  }

  function redirectToLogin() {
    const state = Math.random().toString(36).slice(2);
    sessionStorage.setItem("panel.oauthState", state);
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId(),
      redirect_uri: redirectUri(),
      state,
    });
    location.assign(hassUrl() + "/auth/authorize?" + q);
    return new Promise(() => {}); /* the page navigates away */
  }

  /* Returns a valid access token, completing or starting the OAuth flow. */
  async function getAccessToken() {
    const url = new URL(location.href);
    const code = url.searchParams.get("code");
    if (code) {
      const expected = sessionStorage.getItem("panel.oauthState");
      const got = url.searchParams.get("state");
      url.searchParams.delete("code");
      url.searchParams.delete("state");
      history.replaceState(null, "", url.pathname + (url.search || "") + url.hash);
      if (expected && got !== expected) throw new Error("OAuth state mismatch");
      saveTokens(await tokenRequest({ grant_type: "authorization_code", code }));
    }
    let t = loadTokens();
    if (!t || !t.access_token) return redirectToLogin();
    /* Long-lived tokens have no refresh token and no expiry: use as-is. */
    if (t.refresh_token && t.expires && t.expires - Date.now() < 60000) {
      try {
        t = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token });
        saveTokens(t);
      } catch (e) {
        if (e.status === 400 || e.status === 401 || e.status === 403) {
          localStorage.removeItem(LS_TOKENS);
          return redirectToLogin();
        }
        throw e; /* network trouble: let the reconnect loop retry */
      }
    }
    return t.access_token;
  }

  async function logout() {
    const t = loadTokens();
    localStorage.removeItem(LS_TOKENS);
    if (t && t.refresh_token) {
      try {
        await fetch(hassUrl() + "/auth/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: t.refresh_token }),
        });
      } catch (e) {
        /* best effort */
      }
    }
    location.replace(redirectUri());
  }

  /* ---- Small event emitter ------------------------------------------------- */

  function emitter() {
    const map = {};
    return {
      on(ev, cb) {
        (map[ev] = map[ev] || []).push(cb);
      },
      emit(ev, arg) {
        (map[ev] || []).forEach((cb) => cb(arg));
      },
    };
  }

  /* ---- Real WebSocket client ----------------------------------------------- */

  function createClient(entityIds) {
    const ev = emitter();
    const states = new Map();
    let ws = null;
    let nextId = 1;
    const pending = new Map();
    let pingTimer = null;
    let lastPong = 0;
    let retry = 0;
    let stopped = false;

    function send(msg) {
      return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error("not connected"));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, ...msg }));
      });
    }

    function applyEntities(msg) {
      const changed = [];
      if (msg.a) {
        for (const [id, s] of Object.entries(msg.a)) {
          states.set(id, {
            state: s.s,
            attributes: s.a || {},
            lastChanged: (s.lc || s.lu || 0) * 1000,
            lastUpdated: (s.lu || s.lc || 0) * 1000,
          });
          changed.push(id);
        }
      }
      if (msg.c) {
        for (const [id, diff] of Object.entries(msg.c)) {
          const cur = states.get(id);
          if (!cur) continue;
          const plus = diff["+"];
          const next = { ...cur, attributes: { ...cur.attributes } };
          if (plus) {
            if (plus.s !== undefined) next.state = plus.s;
            if (plus.a) Object.assign(next.attributes, plus.a);
            if (plus.lc) next.lastChanged = plus.lc * 1000;
            if (plus.lu) next.lastUpdated = plus.lu * 1000;
            else if (plus.lc) next.lastUpdated = plus.lc * 1000;
          }
          if (diff["-"] && diff["-"].a) diff["-"].a.forEach((k) => delete next.attributes[k]);
          states.set(id, next);
          changed.push(id);
        }
      }
      if (msg.r) {
        msg.r.forEach((id) => {
          states.delete(id);
          changed.push(id);
        });
      }
      return changed;
    }

    async function connect() {
      if (stopped) return;
      ev.emit("status", "connecting");
      let token;
      try {
        token = await getAccessToken();
      } catch (e) {
        scheduleReconnect();
        return;
      }
      const url = hassUrl().replace(/^http/, "ws") + "/api/websocket";
      ws = new WebSocket(url);
      let subscribed = false;
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "auth_required") {
          ws.send(JSON.stringify({ type: "auth", access_token: token }));
        } else if (msg.type === "auth_invalid") {
          localStorage.removeItem(LS_TOKENS);
          ev.emit("status", "auth-error");
          ws.close();
        } else if (msg.type === "auth_ok") {
          retry = 0;
          lastPong = Date.now();
          const id = nextId++;
          ws.send(JSON.stringify({ id, type: "subscribe_entities", entity_ids: entityIds }));
          pending.set(id, { resolve() {}, reject() {}, subscription: true });
          pingTimer = setInterval(() => {
            if (Date.now() - lastPong > 45000) {
              ws.close(); /* no pong: the socket is dead even if the browser hasn't noticed */
              return;
            }
            send({ type: "ping" }).then(() => (lastPong = Date.now())).catch(() => {});
          }, 20000);
        } else if (msg.type === "event" && msg.event) {
          const changed = applyEntities(msg.event);
          if (!subscribed) {
            subscribed = true;
            ev.emit("status", "connected");
          }
          if (changed.length) ev.emit("states", changed);
        } else if (msg.type === "result" || msg.type === "pong") {
          const p = pending.get(msg.id);
          if (!p) return;
          if (p.subscription) return; /* keep: events keep arriving on this id */
          pending.delete(msg.id);
          if (msg.type === "pong" || msg.success) p.resolve(msg.result);
          else p.reject(new Error((msg.error && msg.error.message) || "request failed"));
        }
      };
      ws.onclose = () => {
        clearInterval(pingTimer);
        pending.forEach((p) => p.reject && p.reject(new Error("connection closed")));
        pending.clear();
        if (!stopped) {
          ev.emit("status", "disconnected");
          scheduleReconnect();
        }
      };
      ws.onerror = () => {
        /* onclose follows and handles the retry */
      };
    }

    function scheduleReconnect() {
      const delay = Math.min(30000, 1000 * Math.pow(2, retry++));
      setTimeout(connect, delay);
    }

    document.addEventListener("visibilitychange", () => {
      /* Phones freeze background tabs; reconnect straight away on return. */
      if (!document.hidden && ws && ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
        retry = 0;
        connect();
      }
    });

    return {
      demo: false,
      states,
      on: ev.on,
      start: connect,
      hassUrl,
      logout,
      /* Fires a Home Assistant event (admin users); used for diagnostics. */
      fireEvent(eventType, eventData) {
        return send({ type: "fire_event", event_type: eventType, event_data: eventData });
      },
      callService(domain, service, serviceData, target, returnResponse) {
        const msg = { type: "call_service", domain, service };
        if (serviceData) msg.service_data = serviceData;
        if (target) msg.target = target;
        if (returnResponse) msg.return_response = true;
        return send(msg);
      },
      /* {entity_id: [{s, a (attributes), t: ms}]}, attributes included. */
      async historyFull(ids, start) {
        const res = await send({
          type: "history/history_during_period",
          start_time: start.toISOString(),
          entity_ids: ids,
          minimal_response: false,
          no_attributes: false,
          significant_changes_only: false,
        });
        const out = {};
        for (const [id, rows] of Object.entries(res || {})) {
          out[id] = rows.map((r) => ({ s: r.s, a: r.a || {}, t: (r.lu || r.lc) * 1000 }));
        }
        return out;
      },
      /* {entity_id: [{s: number|string, t: ms}]} for the period since `start`. */
      async history(ids, start) {
        const res = await send({
          type: "history/history_during_period",
          start_time: start.toISOString(),
          entity_ids: ids,
          minimal_response: true,
          no_attributes: true,
          significant_changes_only: false,
        });
        const out = {};
        for (const [id, rows] of Object.entries(res || {})) {
          out[id] = rows.map((r) => ({ s: r.s, t: (r.lu || r.lc) * 1000 }));
        }
        return out;
      },
    };
  }

  /* ---- Demo backend -------------------------------------------------------- */

  function createDemo(cfg) {
    const ev = emitter();
    const states = new Map();
    const now = Date.now();
    const set = (id, state, attributes, lc) =>
      states.set(id, { state, attributes: attributes || {}, lastChanged: lc || now, lastUpdated: lc || now });

    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

    const lights = new Set();
    cfg.tabs.forEach((t) => [...t.lights, ...t.devices].forEach((l) => lights.add(l.id)));
    [...lights].forEach((id, i) => {
      if (i % 11 === 5) return set(id, "unavailable");
      const on = rnd() > 0.45;
      const colour = /garage|playroom|keuken_muur|zitkamer_achter_muur/.test(id);
      set(id, on ? "on" : "off", {
        brightness: on ? Math.round(60 + rnd() * 195) : null,
        supported_color_modes: colour ? ["color_temp", "xy"] : ["color_temp"],
        min_color_temp_kelvin: 2202,
        max_color_temp_kelvin: 6535,
      });
    });
    cfg.tabs.forEach((t, ti) =>
      t.scenes.forEach((s, i) => set(s.id, new Date(now - (ti * 7 + i + 1) * 3600e3).toISOString(), {}, now - (ti * 7 + i + 1) * 3600e3))
    );
    const base = [14.2, 21.4, 22.1, 22.7, 23.6];
    const hum = [83, 58, 57, 54, 56];
    cfg.sensors.forEach((s, i) => {
      set(s.temp, String(base[i] ?? 21), { unit_of_measurement: "°C" });
      if (s.humidity) set(s.humidity, String(hum[i] ?? 50), { unit_of_measurement: "%" });
    });
    if (cfg.vacuum) {
      const v = cfg.vacuum;
      set(v.vacuum, "docked", {
        "robotic_vacuum.clean_values": "[]",
        "robotic_vacuum.consumables": JSON.stringify([
          { type: "sideBrush", used: 3, mode: 1 }, { type: "rollBrush", used: 2, mode: 1 }, { type: "filter", used: 4, mode: 1 },
          { type: "mop", used: 3, mode: 1 }, { type: "engineSensor", used: 14, mode: 1 }, { type: "dustbag", used: 5, mode: 1 },
          { type: "mopCleaningTrough", used: 38, mode: 1 },
        ]),
      });
      set(v.status, "charging", {});
      set(v.battery, "94", { unit_of_measurement: "%" });
      set(v.area, "0", {});
      set(v.mode, "BothWork", { options: ["BothWork", "OnlySweep", "OnlyMop", "SweepFirst", "Custom"] });
      set(v.fan, "Auto", { options: ["Quiet", "Auto", "Strong", "Max"] });
      set(v.water, "Mid", { options: ["Low", "Mid", "High"] });
      set(v.locate, "unknown", {});
    }
    if (cfg.bike) {
      const b = cfg.bike;
      set(b.battery, "86", { unit_of_measurement: "%" });
      set(b.location, "home", {});
      set(b.lock, "on", {});
      set(b.speed, "0", { unit_of_measurement: "km/h" });
    }
    if (cfg.car) {
      const c = cfg.car;
      set(c.battery, "61", { unit_of_measurement: "%" });
      set(c.range, "322.2", { unit_of_measurement: "km" });
      set(c.charging, "no_power", {});
      set(c.lock, "locked", {});
    }
    cfg.air.forEach((a) => {
      set(a.co2, "742", { unit_of_measurement: "ppm" });
      set(a.pm25, "4", { unit_of_measurement: "µg/m³" });
      set(a.quality, "good", {});
      set(a.temp, "22.8", { unit_of_measurement: "°C" });
      set(a.humidity, "55", { unit_of_measurement: "%" });
    });
    set(cfg.weather, "partlycloudy", { temperature: 17 });
    cfg.media.forEach((m, i) =>
      set(m.id, i === 0 ? "playing" : "idle", i === 0 ? { media_title: "Bloom", media_artist: "The Paper Kites" } : {})
    );

    function change(ids) {
      setTimeout(() => ev.emit("states", ids), 140);
    }

    return {
      demo: true,
      states,
      on: ev.on,
      hassUrl: () => "demo",
      fireEvent() {
        return Promise.resolve(null); /* nothing to report in demo mode */
      },
      logout() {
        location.replace(location.pathname);
      },
      start() {
        ev.emit("status", "connecting");
        setTimeout(() => {
          ev.emit("status", "connected");
          ev.emit("states", [...states.keys()]);
        }, 500);
      },
      async callService(domain, service, data, target, returnResponse) {
        const ids = [].concat((target && target.entity_id) || []);
        if (domain === "weather" && service === "get_forecasts") {
          const conds = ["partlycloudy", "rainy", "sunny"];
          const forecast = [0, 1, 2].map((d) => ({
            datetime: new Date(now + d * 86400e3).toISOString(),
            condition: conds[d],
            temperature: 18 + d,
          }));
          return { response: { [cfg.weather]: { forecast } } };
        }
        const v = cfg.vacuum;
        if (v && domain === "xiaomi_miot" && service === "get_properties") {
          const day = (n) => new Date(now - n * 86400e3).toISOString().slice(0, 10).replace(/-/g, "/");
          return {
            response: {
              clean_records: JSON.stringify([
                { d: "1970/01/02", t: "04:31:23", A: 35, T: 2646, M: 1, c: 2 },
                { d: day(2), t: "19:01:09", A: 74, T: 5466, M: 1, c: 0 },
                { d: day(1), t: "21:10:40", A: 22, T: 1310, M: 2, c: 0 },
                { d: day(0), t: "10:36:18", A: 19, T: 1022, M: 2, c: 0 },
              ]),
            },
          };
        }
        const rooms = v && domain === v.roomsDomain;
        if (v && (domain === "vacuum" || rooms || (domain === "select" && ids.some((i) => [v.mode, v.fan, v.water].includes(i))) || domain === "button")) {
          const now2 = Date.now();
          if (rooms && service === "stofzuig") {
            const vs = states.get(v.vacuum);
            set(v.vacuum, vs.state, { ...vs.attributes, "robotic_vacuum.clean_values": JSON.stringify(data.gebieden) }, now2);
          }
          if (domain === "select") ids.forEach((i) => set(i, data.option, (states.get(i) || {}).attributes, now2));
          const go = (state, status, area) => {
            set(v.vacuum, state, (states.get(v.vacuum) || {}).attributes || {}, now2);
            set(v.status, status, {}, now2);
            set(v.area, String(area), {}, now2);
          };
          if ((rooms && service === "stofzuig") || (domain === "vacuum" && service === "start")) go("cleaning", "sweeping", 3);
          if (domain === "vacuum" && service === "pause") go("paused", "paused", 3);
          if ((rooms && service === "naar_station") || (domain === "vacuum" && service === "return_to_base")) go("returning", "go charging", 3);
          change([v.vacuum, v.status, v.area, v.mode, v.fan, v.water]);
          return returnResponse ? { response: {} } : null;
        }
        const touched = [];
        const members = (id) => {
          const tab = cfg.tabs.find((t) => t.lights[0] && t.lights[0].id === id && t.devices.length);
          return tab && /lampen_/.test(id) ? [id, ...tab.devices.map((d) => d.id)] : [id];
        };
        ids.forEach((id) => {
          if (domain === "scene") {
            const ts = new Date().toISOString();
            set(id, ts, {}, Date.now());
            touched.push(id);
            return;
          }
          members(id).forEach((mid) => {
            const s = states.get(mid);
            if (!s || s.state === "unavailable") return;
            const attrs = { ...s.attributes };
            let on = s.state === "on";
            if (service === "toggle") on = !on;
            if (service === "turn_off") on = false;
            if (service === "turn_on") {
              on = true;
              if (data && data.brightness_pct != null) attrs.brightness = Math.round(data.brightness_pct * 2.55);
            }
            if (on && !attrs.brightness) attrs.brightness = 200;
            if (!on) attrs.brightness = null;
            set(mid, on ? "on" : "off", attrs, Date.now());
            touched.push(mid);
          });
        });
        change(touched);
        return returnResponse ? { response: {} } : null;
      },
      async historyFull(ids, start) {
        /* Past room runs for the vacuum, shaped like the real robot's history
         * (a mop-wash trip mid-run, rooms and area kept after docking):
         * room 8 (19 m²) today, 5 (14 m²) yesterday, 4 (22 m²) three days ago. */
        const out = {};
        const runs = [[8, 0.2, 19], [5, 1.1, 14], [4, 3.3, 22]];
        ids.forEach((id) => {
          out[id] = runs.flatMap(([room, daysAgo, m2]) => {
            const t = now - daysAgo * 86400e3;
            const at = (values, area, time) => ({
              "robotic_vacuum.clean_values": values,
              "robotic_vacuum.clean_area": area,
              "robotic_vacuum.clean_time": time,
            });
            return [
              { s: "cleaning", a: at(`[${room}]`, 0, 1), t },
              { s: "returning", a: at(`[${room}]`, Math.round(m2 * 0.7), 600), t: t + 10 * 60e3 },
              { s: "cleaning", a: at(`[${room}]`, Math.round(m2 * 0.7), 610), t: t + 13 * 60e3 },
              { s: "docked", a: at(`[${room}]`, m2, 1000), t: t + 20 * 60e3 },
              { s: "docked", a: at("[]", 0, 0), t: t + 60 * 60e3 }, /* counters cleared after drying */
            ];
          }).filter((r) => r.t >= start.getTime()).sort((x, y) => x.t - y.t);
        });
        return out;
      },
      async history(ids, start) {
        const out = {};
        ids.forEach((id) => {
          const cur = parseFloat((states.get(id) || {}).state);
          /* Plausible daily shapes: [amplitude, period (h), phase (h), noise]. */
          const shape = /carbon_dioxide/.test(id)
            ? [260, 2.6, 5, 40]
            : /pm2_5/.test(id)
              ? [4, 1.7, 2, 1.5]
              : /humidity/.test(id)
                ? [6, 3.5, 0, 1.5]
                : [1.4, 3.8, 6, 0.25];
          const rows = [];
          for (let t = start.getTime(); t <= Date.now(); t += 20 * 60e3) {
            const h = (t - start.getTime()) / 3600e3;
            const wave = shape[0] * Math.sin((h - shape[2]) / shape[1]);
            const v = Math.max(0, cur + wave + (rnd() - 0.5) * shape[3]);
            rows.push({ s: String(v.toFixed(1)), t });
          }
          out[id] = rows;
        });
        return out;
      },
    };
  }

  window.HA = { createClient, createDemo, logout };
})();
