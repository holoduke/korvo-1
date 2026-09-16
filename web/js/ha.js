/* Home Assistant connection for the web panel.
 *
 * - Login uses HA's own OAuth2 flow (/auth/authorize + /auth/token), exactly
 *   like the HA frontend: no token lives in this code. Tokens are kept in
 *   localStorage and refreshed before they expire.
 * - Live state comes from the WebSocket API's subscribe_entities (compressed
 *   diff format), with keep-alive pings and automatic reconnects.
 * - ?demo uses the fake backend in ha-demo.js instead, with the same interface.
 */
(function () {
  "use strict";

  const LS_TOKENS = "panel.tokens";
  const LS_HASS = "panel.hassUrl";
  /* Units statistics are reported in, whatever the sensor itself uses. */
  const STAT_UNITS = { energy: "kWh", volume: "L" };

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

  /* ---- Real WebSocket client ----------------------------------------------- */

  function createClient(entityIds) {
    const ev = Util.emitter();
    const states = new Map();
    let ws = null;
    let nextId = 1;
    const pending = new Map();
    let pingTimer = null;
    let lastPong = 0;
    let retry = 0;
    let stopped = false;
    let reconnectTimer = 0;
    let connecting = false; /* from starting a connection until it is authenticated or closed */
    let authed = false;
    /* A request made while the connection is down (a tap right after the tablet
     * wakes up) brings the connection back at once and waits for it, this long. */
    const WAIT_FOR_CONNECTION_MS = 15000;
    const waiting = []; /* {flush()} */

    function transmit(msg) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, ...msg }));
      });
    }

    function send(msg) {
      if (authed && ws && ws.readyState === WebSocket.OPEN) return transmit(msg);
      return new Promise((resolve, reject) => {
        const item = {
          flush() {
            clearTimeout(timer);
            transmit(msg).then(resolve, reject);
          },
        };
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(item), 1);
          reject(new Error("geen verbinding met Home Assistant"));
        }, WAIT_FOR_CONNECTION_MS);
        waiting.push(item);
        reconnectNow();
      });
    }

    /* Home Assistant's REST config API (scenes, automations; admin users). A GET
     * of something that does not exist is null. */
    async function configApi(method, path, body) {
      const token = await getAccessToken();
      const res = await fetch(`${hassUrl()}/api/config/${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 404 && method === "GET") return null;
      if (!res.ok) throw new Error(`${path.split("/")[0]} ${res.status}`);
      return res.json();
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

    /* The socket is gone: its requests fail, and a new one follows after the backoff. */
    function closed() {
      clearInterval(pingTimer);
      pending.forEach((p) => p.reject && p.reject(new Error("verbinding met Home Assistant verbroken")));
      pending.clear();
      authed = false;
      connecting = false;
      if (stopped) return;
      ev.emit("status", "disconnected");
      scheduleReconnect();
    }
    /* Gives up on a socket that looks open but no longer answers. */
    function drop(socket) {
      if (socket !== ws) return;
      socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close();
      } catch (e) {
        /* already closing */
      }
      ws = null;
      closed();
    }

    async function connect() {
      if (stopped || connecting) return;
      clearTimeout(reconnectTimer);
      connecting = true;
      ev.emit("status", "connecting");
      let token;
      try {
        token = await getAccessToken();
      } catch (e) {
        connecting = false;
        scheduleReconnect();
        return;
      }
      const url = hassUrl().replace(/^http/, "ws") + "/api/websocket";
      const socket = (ws = new WebSocket(url));
      let subscribed = false;
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "auth_required") {
          socket.send(JSON.stringify({ type: "auth", access_token: token }));
        } else if (msg.type === "auth_invalid") {
          localStorage.removeItem(LS_TOKENS);
          ev.emit("status", "auth-error");
          socket.close();
        } else if (msg.type === "auth_ok") {
          connecting = false;
          authed = true;
          retry = 0;
          lastPong = Date.now();
          const id = nextId++;
          socket.send(JSON.stringify({ id, type: "subscribe_entities", entity_ids: entityIds }));
          pending.set(id, { resolve() {}, reject() {}, subscription: true });
          pingTimer = setInterval(() => {
            /* no pong: the socket is dead even if the browser hasn't noticed */
            if (Date.now() - lastPong > 45000) return drop(socket);
            transmit({ type: "ping" }).then(() => (lastPong = Date.now())).catch(() => {});
          }, 20000);
          waiting.splice(0).forEach((item) => item.flush());
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
          else {
            /* code: Home Assistant's error code; reason: what a device gave as its
             * reason for refusing (e.g. Tesla Fleet's "doors_open"), when known. */
            const error = msg.error || {};
            const err = new Error(error.message || "request failed");
            err.code = error.code;
            err.translationKey = error.translation_key;
            err.placeholders = error.translation_placeholders || {};
            err.reason = err.placeholders.reason;
            p.reject(err);
          }
        }
      };
      socket.onclose = () => {
        if (socket !== ws) return;
        ws = null;
        closed();
      };
      socket.onerror = () => {
        /* onclose follows and handles the retry */
      };
    }

    function scheduleReconnect() {
      clearTimeout(reconnectTimer);
      const delay = Math.min(30000, 1000 * Math.pow(2, retry++));
      reconnectTimer = setTimeout(connect, delay);
    }
    /* Connects at once instead of after the backoff (never a second socket). */
    function reconnectNow() {
      if (stopped || connecting || ws) return;
      retry = 0;
      connect();
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      /* Phones freeze background tabs: reconnect straight away on return, and ping
       * an open socket, which may have died while the page slept. */
      if (!ws) return reconnectNow();
      if (!authed) return;
      const socket = ws;
      const probe = setTimeout(() => drop(socket), 4000);
      transmit({ type: "ping" }).then(
        () => {
          clearTimeout(probe);
          lastPong = Date.now();
        },
        () => clearTimeout(probe)
      );
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
      /* A scene's stored per-entity states; null without a stored config. */
      async sceneConfig(sceneEntityId) {
        const s = states.get(sceneEntityId);
        const id = s && s.attributes && s.attributes.id;
        return id ? configApi("GET", `scene/config/${encodeURIComponent(id)}`) : null;
      },
      /* Replaces a scene's stored config (by its config id); Home Assistant reloads its scenes. */
      saveScene: (id, config) => configApi("POST", `scene/config/${encodeURIComponent(id)}`, config),
      /* An automation's stored config (by its config id); null when there is none. */
      automationConfig: (id) => configApi("GET", `automation/config/${encodeURIComponent(id)}`),
      /* Creates or replaces an automation; Home Assistant reloads its automations. */
      saveAutomation: (id, config) => configApi("POST", `automation/config/${encodeURIComponent(id)}`, config),
      deleteAutomation: (id) => configApi("DELETE", `automation/config/${encodeURIComponent(id)}`),
      /* Every current state once (which entities exist, light group members). */
      getStates() {
        return send({ type: "get_states" });
      },
      /* Also follow these entities, now and after every reconnect. */
      addEntities(more) {
        const fresh = more.filter((id) => !entityIds.includes(id));
        if (!fresh.length) return;
        entityIds.push(...fresh);
        if (ws && ws.readyState === WebSocket.OPEN) {
          const id = nextId++;
          pending.set(id, { resolve() {}, reject() {}, subscription: true });
          ws.send(JSON.stringify({ id, type: "subscribe_entities", entity_ids: fresh }));
        }
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
      /* Use per day since `start` from the long-term statistics, energy in kWh and
       * water in L: {entity_id: [{t: start of the day in ms, change}]}. */
      async dailyUse(ids, start) {
        const res = await send({
          type: "recorder/statistics_during_period",
          start_time: start.toISOString(),
          statistic_ids: ids,
          period: "day",
          types: ["change"],
          units: STAT_UNITS,
        });
        const out = {};
        for (const [id, rows] of Object.entries(res || {})) out[id] = rows.map((r) => ({ t: r.start, change: r.change }));
        return out;
      },
      /* Use so far today per entity (the running hour included, from the
       * short-term statistics): {entity_id: change | null}. */
      async useToday(ids) {
        const one = (id) =>
          send({ type: "recorder/statistic_during_period", statistic_id: id, calendar: { period: "day" }, types: ["change"], units: STAT_UNITS });
        const results = await Promise.all(ids.map(one));
        return Object.fromEntries(ids.map((id, i) => [id, results[i] && Number.isFinite(results[i].change) ? results[i].change : null]));
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

  window.HA = { createClient, logout };
})();
