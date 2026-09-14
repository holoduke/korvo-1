/* Demo backend for ?demo: an in-browser Home Assistant with the real client's
 * interface (states, services, history), seeded so every run looks the same.
 * The UI can be explored and tested with it without touching real devices. */
(function () {
  "use strict";

  function createDemo(cfg) {
    const ev = Util.emitter();
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
        "robotic_vacuum.disturb_switch": 0,
        "break_clean_switch-17-2": 1,
        "carpet_boost_switch-17-7": 0,
        "robotic_vacuum.drying_switch": 1,
        "robotic_vacuum.drying_time": 120,
        "mop_wash_frequency-17-23": 10,
        "robotic_vacuum.clean_count": 1,
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
      /* The robot's action selects: they show no option, the property follows. */
      set(v.setMode, "", { options: ["", "BothWork", "OnlySweep", "OnlyMop", "SweepFirst", "Custom"] });
      set(v.setFan, "", { options: ["", "Quiet", "Auto", "Strong", "Max"] });
      set(v.setWater, "", { options: ["", "Low", "Mid", "High"] });
    }
    /* The Tuya robot upstairs: charged in its dock, the filter wants cleaning. */
    (cfg.tuyaVacuums || []).forEach((r) => {
      const e = r.entities;
      set(e.vacuum, "docked", { fan_speed_list: ["Off", "Low", "Medium", "High", "Max"], fan_speed: "Medium", status: "charged", supported_features: 14260 });
      set(e.battery, "100", { unit_of_measurement: "%" });
      set(e.area, "8", { unit_of_measurement: "m²" });
      set(e.time, "6", { unit_of_measurement: "min" });
      set(e.problem, "off", { fault_code: 0 });
      set(e.mopping, "medium", { options: ["off", "low", "medium", "high"] });
      set(e.efficiency, "Normal", { options: ["Careful", "Normal", "Fast"] });
      [["edgeLife", 882], ["rollLife", 1782], ["filterLife", 45]].forEach(([k, v]) => set(e[k], String(v), { unit_of_measurement: "min" }));
      set(e.edgeDirty, "off");
      set(e.rollDirty, "off");
      set(e.filterDirty, "on");
      set(e.dnd, "off");
      set(e.breakClean, "on");
      set(e.autoBoost, "off");
      set(e.yMopping, "off");
      ["edgeReset", "rollReset", "filterReset"].forEach((k) => set(e[k], "unknown"));
      set(e.totalArea, "277", { unit_of_measurement: "m²" });
      set(e.totalRuns, "12");
      set(e.totalTime, "316", { unit_of_measurement: "min" });
    });
    if (cfg.bike) {
      const b = cfg.bike;
      set(b.battery, "86", { unit_of_measurement: "%" });
      set(b.location, "home", {});
      set(b.lock, "on", {});
      set(b.speed, "0", { unit_of_measurement: "km/h" });
    }
    if (cfg.car) {
      const e = cfg.car.entities;
      const put = (key, state, attributes = {}) => set(e[key], state, attributes);
      put("battery", "61", { unit_of_measurement: "%" });
      put("usable", "60", { unit_of_measurement: "%" });
      put("range", "322.2", { unit_of_measurement: "km" });
      put("estRange", "290", { unit_of_measurement: "km" });
      put("charging", "no_power", { options: ["starting", "charging", "stopped", "complete", "disconnected", "no_power"] });
      put("charge", "off");
      put("chargeLimit", "70", { min: 50, max: 100, step: 1, unit_of_measurement: "%" });
      put("chargeAmps", "24", { min: 0, max: 24, step: 1, unit_of_measurement: "A" });
      put("chargerPower", "0", { unit_of_measurement: "kW" });
      put("chargerVoltage", "0", { unit_of_measurement: "V" });
      put("chargerCurrent", "0", { unit_of_measurement: "A" });
      put("chargeRate", "0", { unit_of_measurement: "km/h" });
      put("energyAdded", "0", { unit_of_measurement: "kWh" });
      put("timeToFull", "unavailable");
      put("cable", "on");
      put("port", "open", { supported_features: 3 });
      put("cableLock", "locked");
      put("lock", "locked");
      put("sentry", "off");
      put("frunk", "closed", { supported_features: 1 });
      put("trunk", "closed", { supported_features: 3 });
      put("windows", "closed", { supported_features: 3 });
      ["doorFL", "doorFR", "doorRL", "doorRR", "winFL", "winFR", "winRL", "winRR"].forEach((k) => put(k, "off"));
      put("climate", "off", {
        hvac_modes: ["heat_cool", "off"], min_temp: 15, max_temp: 28, preset_modes: ["off", "keep", "dog", "camp"],
        current_temperature: 29, temperature: 21.5, preset_mode: "off",
      });
      put("inside", "29.1", { unit_of_measurement: "°C" });
      put("outside", "17.5", { unit_of_measurement: "°C" });
      put("defrost", "off");
      ["seatFL", "seatFR", "seatRL", "seatRC", "seatRR"].forEach((k) => put(k, "off", { options: ["off", "low", "medium", "high"] }));
      put("wheel", "off", { options: ["off", "low", "high"] });
      put("precond", "off");
      put("battHeater", "off");
      put("online", "on");
      put("present", "off");
      put("location", "home");
      put("shift", "unknown");
      put("speed", "unknown", { unit_of_measurement: "km/h" });
      put("power", "0", { unit_of_measurement: "kW" });
      put("odometer", "18342.6", { unit_of_measurement: "km" });
      put("tireFL", "2.9", { unit_of_measurement: "bar" });
      put("tireFR", "2.9", { unit_of_measurement: "bar" });
      put("tireRL", "2.8", { unit_of_measurement: "bar" });
      put("tireRR", "2.4", { unit_of_measurement: "bar" });
      ["tireWarnFL", "tireWarnFR", "tireWarnRL"].forEach((k) => put(k, "off"));
      put("tireWarnRR", "on");
      put("destination", "unknown");
      put("distToArrival", "unknown", { unit_of_measurement: "km" });
      put("timeToArrival", "unavailable");
      put("socAtArrival", "unknown", { unit_of_measurement: "%" });
      put("trafficDelay", "unknown", { unit_of_measurement: "min" });
      ["flash", "honk", "homelink", "keyless", "fart", "wake"].forEach((k) => put(k, "unknown"));
      put("media", "off");
      put("update", "off", { installed_version: "2026.32.3", latest_version: "2026.32.3" });
    }
    /* Appliances: a washer mid-cycle, a running dishwasher, a hob with two zones on. */
    (cfg.appliances || []).forEach((ap) => {
      const e = ap.entities;
      const put = (key, state, attributes = {}) => e[key] && set(e[key], state, attributes);
      const soon = (min) => new Date(now + min * 60e3).toISOString();
      if (ap.kind === "washer" || ap.kind === "dryer") {
        const washer = ap.kind === "washer";
        put("state", washer ? "run" : "stop", { options: ["stop", "run", "pause"] });
        put("machine", washer ? "run" : "stop", { options: ["pause", "run", "stop"] });
        put("job", washer ? "ai_wash" : "none");
        put("done", washer ? soon(42) : soon(-95));
        put("power", washer ? "380" : "0", { unit_of_measurement: "W" });
        put("energy", washer ? "186.9" : "138.1", { unit_of_measurement: "kWh" });
        put("water", "9192.4", { unit_of_measurement: "L" });
        put("remote", "on");
        put("lock", "off");
        put("on", washer ? "on" : "off");
      } else if (ap.kind === "dishwasher") {
        const programs = ["001", "Auto1", "Auto2", "Auto3", "Eco50", "Kurz60", "LearningDishwasher", "MachineCare", "PreRinse"];
        put("op", "Run");
        put("door", "Closed");
        put("phase", "MainWash");
        put("selected", "Eco50", { options: programs });
        put("active", "Eco50", { options: programs });
        put("remaining", "5400", { unit_of_measurement: "s" });
        put("progress", "35", { unit_of_measurement: "%" });
        put("startAllowed", "on");
        put("abort", "unknown");
        put("energy", "46");
        put("water", "40");
        put("care", "9");
        ["extradry", "hygiene", "speed", "silence"].forEach((k) => put(k, "off"));
      } else if (ap.kind === "oven") {
        const programs = ["HotAir", "TopBottomHeating", "HotAirGrilling", "GrillLargeArea", "PizzaSetting", "AirFry", "600Watt", "Max"];
        put("op", "Ready");
        put("door", "Closed");
        put("temp", "23", { unit_of_measurement: "°C" });
        ["setpoint", "program", "remaining", "elapsed", "progress"].forEach((k) => put(k, "unknown"));
        ["pause", "resume", "abort"].forEach((k) => put(k, "unknown"));
        put("selected", "HotAir", { options: programs });
        put("active", "unknown", { options: programs });
        put("setpointSet", "180", { min: 0, max: 300, step: 1, unit_of_measurement: "°C" });
        put("duration", "3600", { min: 0, max: 266400, step: 1, unit_of_measurement: "s" });
        put("powerstate", "On", { options: ["On", "Standby"] });
        put("startAllowed", "on");
        ["fastpreheat", "lamp", "childlock", "light"].forEach((k) => put(k, "off"));
      } else if (ap.kind === "hob") {
        const levels = ["Off", "KeepWarm", "10", "20", "30", "40", "50", "60", "70", "80", "90", "Boost1"];
        put("op", "Run");
        put("power", "On");
        put("zone1", "50", { options: levels });
        put("zone2", "Off", { options: levels });
        put("zone3", "KeepWarm", { options: levels });
        put("zone4", "Off", { options: levels });
        put("childlock", "off");
        put("filter", "2");
        put("filterReset", "unknown");
        put("vent", "Level03", { options: ["Off", "Automatic", "Level01", "Level02", "Level03", "Level04", "Level05", "BoostLevel1", "AfterRun"] });
        put("airmode", "Recirculation", { options: ["Recirculation", "Extraction"] });
      } else if (ap.kind === "filter") {
        Object.keys(e).forEach((k) => put(k, "unavailable"));
      } else if (ap.kind === "fridge") {
        put("temp", "4", { unit_of_measurement: "°C" });
        put("setpoint", "4", { min: 3, max: 9, step: 1, unit_of_measurement: "°C" });
        ["supercool", "party", "night"].forEach((k) => put(k, "off"));
      } else if (ap.kind === "speakers") {
        /* The first two play together; the last is idle on its line input. */
        const ids = ap.players.map((p) => e[p.key]);
        const group = ids.slice(0, 2);
        ap.players.forEach((p, n) =>
          put(p.key, n < 2 ? "playing" : "idle", {
            supported_features: 678463,
            volume_level: [0.32, 0.33, 0.49][n] ?? 0.4,
            is_volume_muted: false,
            group_members: n < 2 ? group : [ids[n]],
            source: n < 2 ? "Network" : "Line In",
            ...(n < 2 ? { media_title: "Bloom", media_artist: "The Paper Kites" } : { source_list: ["Network", "Bluetooth", "Line In", "Optical In", "TV"] }),
          })
        );
      } else if (ap.kind === "tv") {
        put("player", "unavailable", { supported_features: 0 });
        put("wake", "unknown");
      }
    });
    /* Room lamps that no drawer lists still have to exist in the demo. */
    cfg.tabs.forEach((t) =>
      (t.areas || []).forEach((a) =>
        a.lights.forEach((id, i) => {
          if (!states.has(id)) set(id, i % 3 ? "on" : "off", { brightness: 150, supported_color_modes: ["color_temp", "hs"], friendly_name: id.replace("light.", "").replace(/_/g, " ") });
        })
      )
    );
    cfg.air.forEach((a) => {
      set(a.co2, "742", { unit_of_measurement: "ppm" });
      set(a.pm25, "4", { unit_of_measurement: "µg/m³" });
      set(a.quality, "good", {});
      set(a.temp, "22.8", { unit_of_measurement: "°C" });
      set(a.humidity, "55", { unit_of_measurement: "%" });
    });
    /* Sensor cards: someone in the first presence room, the first door open, a gone outdoor sensor. */
    const firstOfKind = new Set();
    (cfg.sensorCards || []).forEach((c, n) => {
      const e = c.entities;
      const first = !firstOfKind.has(c.kind);
      firstOfKind.add(c.kind);
      const ago = (first ? 2 : 25 + n * 6) * 60e3;
      const put = (key, state, attributes = {}) => e[key] && !states.has(e[key]) && set(e[key], state, attributes, now - ago);
      const gone = /buiten/.test(c.name);
      if (c.kind === "presence") put("presence", first ? "on" : "off");
      if (c.kind === "motion") put("occupancy", "unavailable");
      if (c.kind === "door") (put("contact", first ? "on" : "off"), put("tamper", "off"));
      put("temperature", gone ? "unavailable" : (20.8 + (n % 5) * 0.4).toFixed(1), { unit_of_measurement: "°C" });
      put("humidity", gone ? "unavailable" : String(58 + (n % 4) * 3), { unit_of_measurement: "%" });
      put("illuminance", String(first ? 35 : 0), { unit_of_measurement: "lx" });
      put("distance", "1.4", { unit_of_measurement: "m" });
      put("battery", gone || c.kind === "motion" ? "unavailable" : String(first ? 90 : 100), { unit_of_measurement: "%" });
    });
    /* Energie: the devices' own states come from the appliances and the car above;
     * the Stromer's counters, one battery at work and one out of reach. No smart
     * meter: tests add one with setState. */
    let batteries = 0;
    (cfg.energy || []).forEach((d) => {
      const e = d.entities;
      const put = (key, state, attributes = {}) => e[key] && !states.has(e[key]) && set(e[key], state, attributes);
      if (d.kind === "bike") {
        put("battery", "86", { unit_of_measurement: "%" });
        put("energy", "27510", { unit_of_measurement: "Wh" });
        put("average", "14", { unit_of_measurement: "Wh" });
        put("distance", "1872.3", { unit_of_measurement: "km" });
      } else if (d.kind === "battery" && batteries++ === 0) {
        put("soc", "76", { unit_of_measurement: "%" });
        put("power", "420", { unit_of_measurement: "W" });
        put("voltage", "13.31", { unit_of_measurement: "V" });
        ["cell1", "cell2", "cell3", "cell4"].forEach((k, i) => put(k, String(3.326 + i * 0.002), { unit_of_measurement: "V" }));
        put("delta", "6", { unit_of_measurement: "mV" });
        put("cycles", "112");
        put("health", "98", { unit_of_measurement: "%" });
        put("temp", "27.5", { unit_of_measurement: "°C" });
        put("charged", "812.4", { unit_of_measurement: "kWh" });
        put("discharged", "776.9", { unit_of_measurement: "kWh" });
      } else if (d.kind === "battery") {
        Object.keys(e).forEach((k) => put(k, "unavailable"));
      }
    });
    /* A plausible day's use per counter: kWh, water in L. */
    const demoUse = (id) =>
      /water/.test(id) ? 48
      : /energy_added/.test(id) ? 14
      : /energy_used/.test(id) ? 0.25
      : /charged/.test(id) ? 1.2
      : /import/.test(id) ? 9
      : /export/.test(id) ? 3
      : /droger/.test(id) ? 1.6
      : 0.9;
    const WEEK_SHAPE = [0.4, 1.3, 0, 1, 1.6, 0.2];

    set(cfg.weather, "partlycloudy", { temperature: 17 });
    cfg.media.forEach((m, i) => {
      if (!states.has(m.id)) set(m.id, i === 0 ? "playing" : "idle", i === 0 ? { media_title: "Bloom", media_artist: "The Paper Kites" } : {});
    });

    /* A media player's next state and attributes after a service call. */
    function mediaChange(id, cur, service, data) {
      const a = { ...cur.attributes };
      let state = cur.state;
      if (service === "media_play_pause") state = state === "playing" ? "paused" : "playing";
      else if (service === "media_stop") state = "idle";
      else if (service === "turn_off") state = "off";
      else if (service === "volume_set") a.volume_level = data.volume_level;
      else if (service === "volume_mute") a.is_volume_muted = data.is_volume_muted;
      else if (service === "select_source") a.source = data.source;
      else if (service === "join") a.group_members = [...new Set([...(a.group_members || [id]), ...data.group_members])];
      else if (service === "unjoin") a.group_members = [id];
      return [state, a];
    }

    const automations = new Map(); /* config id -> automation config */

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
      /* Demo scenes switch every lamp of their tab on, "uit" scenes off. */
      async sceneConfig(sceneEntityId) {
        const tab = cfg.tabs.find((t) => t.scenes.some((s) => s.id === sceneEntityId));
        if (!tab) return null;
        const off = /uit/.test(sceneEntityId);
        const colourful = /party|cuba|paars|regenboog|rood|blauw|groen|oranje|pink/.test(sceneEntityId);
        const lamps = [...tab.devices.map((d) => d.id), ...(tab.areas || []).flatMap((a) => a.lights)];
        const stored = (i) =>
          off ? { state: "off" }
          : colourful ? { state: "on", brightness: 200, hs_color: [[280, 240, 0, 120][i % 4], 100] }
          : { state: "on", brightness: 120 + (i % 3) * 40, color_temp_kelvin: 2700 };
        return { id: sceneEntityId, entities: Object.fromEntries(lamps.map((id, i) => [id, stored(i)])) };
      },
      /* Automations the panel writes (cleaning schedules), kept in memory. */
      async automationConfig(id) {
        return automations.get(id) || null;
      },
      async saveAutomation(id, config) {
        const entity = `automation.${id}`;
        automations.set(id, config);
        set(entity, (states.get(entity) || {}).state || "on", { id, friendly_name: config.alias, last_triggered: null }, Date.now());
        change([entity]);
        return { result: "ok" };
      },
      async deleteAutomation(id) {
        automations.delete(id);
        states.delete(`automation.${id}`);
        return { result: "ok" };
      },
      /* Demo states; a tab's "lampen ..." group holds that tab's drawer lamps. */
      async getStates() {
        const groups = new Map(cfg.tabs.filter((t) => t.lights[0] && /^light\.lampen_/.test(t.lights[0].id)).map((t) => [t.lights[0].id, t.devices.map((d) => d.id)]));
        return [...states.entries()].map(([id, s]) => ({
          entity_id: id,
          state: s.state,
          attributes: groups.has(id) ? { ...s.attributes, entity_id: groups.get(id) } : s.attributes,
        }));
      },
      addEntities() {
        /* the demo holds every state already */
      },
      /* For tests: a state change as Home Assistant would report it. */
      setState(id, { state, attributes }) {
        const cur = states.get(id) || { state: "unknown", attributes: {} };
        set(id, state === undefined ? cur.state : state, attributes || cur.attributes, Date.now());
        ev.emit("states", [id]);
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
        /* Home Assistant's own actions (reload an integration, refresh an entity): nothing changes. */
        if (domain === "homeassistant") return returnResponse ? { response: {} } : null;
        if (domain === "automation") {
          ids.forEach((id) => states.has(id) && set(id, service === "turn_off" ? "off" : "on", states.get(id).attributes, Date.now()));
          change(ids);
          return returnResponse ? { response: {} } : null;
        }
        /* Appliance commands (before the vacuum branch, which also takes buttons). */
        /* The robots' cards act on the robots below, not as appliances. */
        const applEntities = (cfg.appliances || []).filter((ap) => ap.kind !== "robot").flatMap((ap) => Object.values(ap.entities));
        if (ids.length && ids.every((id) => applEntities.includes(id))) {
          const t = Date.now();
          ids.forEach((id) => {
            const cur = states.get(id) || { state: "unknown", attributes: {} };
            let next = cur.state;
            let attributes = cur.attributes;
            if (domain === "select") next = data.option;
            else if (domain === "switch") next = service === "turn_on" ? "on" : "off";
            else if (domain === "number") next = String(data.value);
            else if (domain === "button") next = new Date(t).toISOString();
            else if (domain === "media_player") [next, attributes] = mediaChange(id, cur, service, data);
            set(id, next, attributes, t);
            (cfg.appliances || []).forEach((ap) => {
              const e = ap.entities;
              const also = (key, state) => set(e[key], state, (states.get(e[key]) || {}).attributes || {}, t);
              if ((ap.kind === "washer" || ap.kind === "dryer") && id === e.state) also("machine", next);
              if (ap.kind === "dishwasher" && id === e.active) also("op", "Run");
              if (ap.kind === "dishwasher" && id === e.abort) also("op", "Ready");
              if (ap.kind === "oven" && id === e.pause) also("op", "Pause");
              if (ap.kind === "oven" && id === e.resume) also("op", "Run");
              if (ap.kind === "oven" && id === e.abort) also("op", "Ready");
              if (ap.kind === "oven" && id === e.powerstate) also("op", next === "On" ? "Ready" : "Inactive");
              if (ap.kind === "oven" && id === e.active) {
                also("op", "Run");
                also("setpoint", states.get(e.setpointSet).state);
                also("remaining", states.get(e.duration).state);
              }
              if (ap.kind === "tv" && id === e.wake) set(e.player, "unknown", { supported_features: 20493, volume_level: 0.2, is_volume_muted: false }, t);
              if (ap.kind === "speakers" && domain === "media_player" && Object.values(e).includes(id)) {
                /* Every member of a group lists the same members. */
                const players = Object.values(e);
                const members = service === "join" ? states.get(id).attributes.group_members : null;
                players.filter((m) => m !== id).forEach((m) => {
                  const ma = states.get(m).attributes;
                  if (service === "join" && members.includes(m)) set(m, states.get(m).state, { ...ma, group_members: members }, t);
                  if (service === "unjoin") set(m, states.get(m).state, { ...ma, group_members: (ma.group_members || [m]).filter((x) => x !== id) }, t);
                });
              }
            });
          });
          change(applEntities);
          return returnResponse ? { response: {} } : null;
        }
        /* Car commands (before the vacuum branch, which also takes buttons). */
        const carEntities = cfg.car ? Object.values(cfg.car.entities) : [];
        if (ids.length && ids.every((id) => carEntities.includes(id))) {
          const t = Date.now();
          const e = cfg.car.entities;
          ids.forEach((id) => {
            const cur = states.get(id) || { state: "unknown", attributes: {} };
            const a = cur.attributes || {};
            let next = cur.state;
            let nextAttrs = a;
            if (domain === "switch") next = service === "turn_on" ? "on" : "off";
            else if (domain === "lock") next = service === "lock" ? "locked" : "unlocked";
            else if (domain === "cover") next = service === "open_cover" ? "open" : "closed";
            else if (domain === "number") next = String(data.value);
            else if (domain === "select") next = data.option;
            else if (domain === "button") next = new Date(t).toISOString();
            else if (domain === "climate") {
              if (service === "turn_on") next = "heat_cool";
              if (service === "turn_off") next = "off";
              if (service === "set_temperature") nextAttrs = { ...a, temperature: data.temperature };
              if (service === "set_preset_mode") nextAttrs = { ...a, preset_mode: data.preset_mode };
            } else if (domain === "media_player") {
              if (service === "media_play_pause") next = cur.state === "playing" ? "paused" : "playing";
              if (service === "volume_set") nextAttrs = { ...a, volume_level: data.volume_level };
            }
            set(id, next, nextAttrs, t);
            if (id === e.charge) set(e.charging, next === "on" ? "charging" : "stopped", (states.get(e.charging) || {}).attributes || {}, t);
          });
          change([...ids, cfg.car.entities.charging]);
          return returnResponse ? { response: {} } : null;
        }
        /* The Tuya robots (before the Xiaomi branch, which takes every vacuum and button call). */
        const tuya = (cfg.tuyaVacuums || []).find((r) => ids.some((id) => Object.values(r.entities).includes(id)));
        if (tuya) {
          const e = tuya.entities;
          const t = Date.now();
          const put = (id, state, extra) => {
            const cur = states.get(id) || { state: "unknown", attributes: {} };
            set(id, state === undefined ? cur.state : state, { ...cur.attributes, ...extra }, t);
          };
          if (domain === "vacuum" && service === "start") put(e.vacuum, "cleaning", { status: "smart" });
          if (domain === "vacuum" && service === "pause") put(e.vacuum, "paused", { status: "paused" });
          if (domain === "vacuum" && service === "return_to_base") put(e.vacuum, "returning", { status: "returning" });
          if (domain === "vacuum" && service === "set_fan_speed") put(e.vacuum, undefined, { fan_speed: data.fan_speed });
          if (domain === "vacuum" && service === "send_command") put(e.vacuum, "cleaning", { status: data.command === "edge" ? "edge_cleaning" : "smart" });
          if (domain === "switch") ids.forEach((id) => put(id, service === "turn_on" ? "on" : "off"));
          if (domain === "select") ids.forEach((id) => put(id, data.option));
          if (domain === "button") {
            ids.forEach((id) => {
              put(id, new Date(t).toISOString());
              const part = ["edge", "roll", "filter"].find((p) => e[`${p}Reset`] === id);
              if (part) {
                put(e[`${part}Life`], "9000");
                put(e[`${part}Dirty`], "off");
              }
            });
          }
          change(Object.values(e));
          return returnResponse ? { response: {} } : null;
        }
        const v = cfg.vacuum;
        /* The Xiaomi's settings through its MIoT actions: the attribute follows. */
        if (v && domain === "xiaomi_miot" && service === "call_action") {
          const attr = { 24: "robotic_vacuum.disturb_switch", 25: "break_clean_switch-17-2", 34: "carpet_boost_switch-17-7", 48: "robotic_vacuum.drying_switch", 43: "robotic_vacuum.drying_time", 44: "mop_wash_frequency-17-23", 28: "robotic_vacuum.clean_count" }[data.aiid];
          if (attr) {
            const vs = states.get(v.vacuum);
            const value = data.params[0];
            set(v.vacuum, vs.state, { ...vs.attributes, [attr]: typeof value === "boolean" ? Number(value) : value }, Date.now());
            change([v.vacuum]);
          }
          return returnResponse ? { response: {} } : null;
        }
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
        const setters = v ? { [v.setMode]: v.mode, [v.setFan]: v.fan, [v.setWater]: v.water } : {};
        if (v && (domain === "vacuum" || rooms || (domain === "select" && ids.some((i) => i in setters)) || domain === "button")) {
          const now2 = Date.now();
          if (rooms && service === "stofzuig") {
            const vs = states.get(v.vacuum);
            set(v.vacuum, vs.state, { ...vs.attributes, "robotic_vacuum.clean_values": JSON.stringify(data.gebieden) }, now2);
          }
          if (domain === "select") ids.forEach((i) => set(setters[i], data.option, (states.get(setters[i]) || {}).attributes, now2));
          const go = (state, status, area) => {
            set(v.vacuum, state, (states.get(v.vacuum) || {}).attributes || {}, now2);
            set(v.status, status, {}, now2);
            set(v.area, String(area), {}, now2);
          };
          if ((rooms && service === "stofzuig") || (domain === "vacuum" && service === "start")) go("cleaning", "sweeping", 3);
          if (domain === "vacuum" && service === "pause") go("paused", "paused", 3);
          if (domain === "vacuum" && service === "stop") go("idle", "idle", 3); /* stands still where it is */
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
          /* A run of today stays today, however close to midnight the demo starts. */
          const midnight = new Date(now).setHours(0, 0, 0, 0);
          out[id] = runs.flatMap(([room, daysAgo, m2]) => {
            const t = daysAgo < 1 ? Math.max(midnight, now - daysAgo * 86400e3) : now - daysAgo * 86400e3;
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
      /* Six earlier days of use per counter (today's comes from useToday). */
      async dailyUse(ids, start) {
        const out = {};
        ids.filter((id) => states.has(id)).forEach((id) => {
          const day = new Date(start);
          day.setHours(0, 0, 0, 0);
          out[id] = WEEK_SHAPE.map((f) => {
            const row = { t: day.getTime(), change: Math.round(demoUse(id) * f * 100) / 100 };
            day.setDate(day.getDate() + 1);
            return row;
          });
        });
        return out;
      },
      async useToday(ids) {
        return Object.fromEntries(ids.map((id) => [id, states.has(id) ? Math.round(demoUse(id) * 80) / 100 : null]));
      },
      async history(ids, start) {
        const out = {};
        ids.forEach((id) => {
          const tuyaRobot = (cfg.tuyaVacuums || []).find((r) => r.entities.vacuum === id);
          if (tuyaRobot) {
            /* Its states around the runs below: this morning's run stops on a fault
             * and goes on without going home. */
            const at = (hoursAgo) => Date.now() - hoursAgo * 3600e3;
            out[id] = [
              { s: "docked", t: start.getTime() },
              { s: "cleaning", t: at(26) },
              { s: "docked", t: at(26) + 26 * 60e3 },
              { s: "cleaning", t: at(5) },
              { s: "error", t: at(5) + 25 * 60e3 },
              { s: "cleaning", t: at(4.4) - 30e3 },
              { s: "docked", t: at(4.4) + 26 * 60e3 },
            ];
            return;
          }
          if (/_cleaning_(area|time)$/.test(id)) {
            /* A Tuya robot's counters, reset when a run starts: one yesterday, one this
             * morning that stopped after 24 min and resumed 12 min later (its counters
             * start over, so it looks like a third run of 8 m²). */
            if (!states.has(id)) return;
            const area = /area$/.test(id);
            const rows = [{ s: "0", t: start.getTime() }];
            [[26, 22, 18], [5, 31, 27], [4.4, 8, 6]].forEach(([hoursAgo, m2, min]) => {
              const t0 = Date.now() - hoursAgo * 3600e3;
              rows.push({ s: "0", t: t0 });
              for (let k = 1; k <= 4; k++) rows.push({ s: String(Math.round(((area ? m2 : min) * k) / 4)), t: t0 + k * 6 * 60e3 });
            });
            out[id] = rows;
            return;
          }
          if (/power(_phase_\d)?$/.test(id)) {
            /* Power: mostly idle, a cycle at full load every 8 hours (a battery swings both ways). */
            if (!states.has(id)) return;
            const kw = (states.get(id).attributes || {}).unit_of_measurement === "kW";
            const rows = [];
            for (let t = start.getTime(); t < Date.now(); t += 10 * 60e3) {
              const h = (t - start.getTime()) / 3600e3;
              const v = /jk_bms/.test(id) ? Math.round(500 * Math.sin(h / 2.5)) : h % 8 > 6.5 ? (kw ? 7.2 : 1900) : 0;
              rows.push({ s: String(v), t });
            }
            rows.push({ s: states.get(id).state, t: Date.now() });
            out[id] = rows;
            return;
          }
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

  window.HA.createDemo = createDemo;
})();
