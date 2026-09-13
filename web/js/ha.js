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
      /* A scene's stored per-entity states; null without a stored config. */
      async sceneConfig(sceneEntityId) {
        const s = states.get(sceneEntityId);
        const id = s && s.attributes && s.attributes.id;
        if (!id) return null;
        const token = await getAccessToken();
        const res = await fetch(`${hassUrl()}/api/config/scene/config/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error("scene config " + res.status);
        return res.json();
      },
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
