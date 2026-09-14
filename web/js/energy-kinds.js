/* Energie: the kinds of device and what their cards show (see energy.js). */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { fmt } = Util;
  const E = Panel.energy;
  const stateOf = (id) => (Panel.st(id) || {}).state;
  const num = Panel.num;
  const known = Number.isFinite;

  /* Washer and dryer: power now and whether it runs; the washer's water too. */
  const MACHINE = { run: ["play", "Draait"], pause: ["pause", "Gepauzeerd"], stop: ["power", "Uit"] };
  const laundry = (iconName) => ({
    icon: iconName,
    use: true,
    chart: "power",
    meter: "energy",
    stats: ["energy", "water"],
    power: (e) => E.scaled(e.power),
    card(e) {
      if (E.missing(e.power) && E.missing(e.energy)) return E.offline();
      const w = E.scaled(e.power);
      const machine = MACHINE[stateOf(e.machine)];
      const running = stateOf(e.machine) === "run" || w > 5;
      const [big, unit] = E.power(w);
      const waterToday = E.today(e.water);
      const water = num(e.water);
      return {
        tone: running ? "active" : "idle",
        big,
        unit,
        chips: [
          machine || (running ? MACHINE.run : null),
          ["drop", known(waterToday) ? `${fmt(waterToday)} L vandaag` : null],
          ["drop", known(water) ? `${fmt(water / 1000, 1)} m³ totaal` : null],
        ],
        foot: E.meterFoot(e.energy),
      };
    },
  });
  Panel.defineEnergyKind("washer", laundry("washer"));
  Panel.defineEnergyKind("dryer", laundry("dryer"));

  /* Tesla: charging power, or the battery while it doesn't charge. The charger
   * counts towards the house only while the car is home. */
  Panel.defineEnergyKind("car", {
    icon: "car",
    use: true,
    chart: "chargerPower",
    meter: "energyAdded",
    stats: ["energyAdded"],
    power: (e) => (stateOf(e.location) === "home" ? E.scaled(e.chargerPower) : 0),
    card(e) {
      if (E.missing(e.battery) && E.missing(e.charging)) return E.offline("Geen gegevens");
      const charging = stateOf(e.charging);
      const active = charging === "charging" || charging === "starting";
      const soc = num(e.battery);
      const volts = num(e.chargerVoltage);
      const amps = num(e.chargerCurrent);
      const added = num(e.energyAdded);
      const [big, unit] = active ? E.power(E.scaled(e.chargerPower)) : [fmt(soc), "%"];
      return {
        tone: active ? "active" : "idle",
        big,
        unit: active ? `${unit} laden` : `${unit} accu`,
        level: soc,
        chips: [
          ["bolt", Panel.CHARGING_NL[charging] || null],
          ["dock", stateOf(e.location) ? Util.place(stateOf(e.location)) : null],
          active && ["battery", known(soc) ? `${fmt(soc)}%` : null],
          active && known(volts) && known(amps) && ["plug", `${fmt(volts)} V · ${fmt(amps)} A`],
          added > 0 && ["plus", `${fmt(added, 1)} kWh deze sessie`],
        ],
        foot: [[`Geladen vandaag <b>${E.kwhText(E.today(e.energyAdded))}</b>`]],
      };
    },
  });

  /* Stromer: battery, consumption per km and the energy it has used. */
  Panel.defineEnergyKind("bike", {
    icon: "bike",
    use: true,
    chart: null,
    meter: "energy",
    stats: ["energy"],
    power: () => NaN,
    card(e) {
      if (E.missing(e.battery) && E.missing(e.energy)) return E.offline();
      const soc = num(e.battery);
      const perKm = num(e.average);
      const km = num(e.distance);
      return {
        tone: "idle",
        big: fmt(soc),
        unit: "% accu",
        level: soc,
        chips: [
          ["bolt", known(perKm) ? `${fmt(perKm)} Wh/km` : null],
          ["bike", known(km) ? `${fmt(km)} km` : null],
        ],
        foot: E.meterFoot(e.energy),
      };
    },
  });

  /* JK BMS battery: charge, power (positive = charging, the BMS's own sign),
   * voltage and the cells' spread, cycles, health and temperature. */
  const CELL_SPREAD_WARN = 50; /* mV between the highest and lowest cell */
  Panel.defineEnergyKind("battery", {
    icon: "battery",
    use: false,
    chart: "power",
    meter: null,
    stats: ["charged", "discharged"],
    power: (e) => E.scaled(e.power),
    card(e) {
      if (E.missing(e.soc)) return E.offline();
      const soc = num(e.soc);
      const w = E.scaled(e.power);
      const volts = num(e.voltage);
      const cells = ["cell1", "cell2", "cell3", "cell4"].map((k) => num(e[k])).filter(known);
      const delta = num(e.delta);
      const cycles = num(e.cycles);
      const health = num(e.health);
      const temp = num(e.temp);
      const flow = !known(w) ? null : Math.abs(w) <= 5 ? "In rust" : `${w > 0 ? "Laadt" : "Levert"} ${E.power(Math.abs(w)).join(" ")}`;
      return {
        tone: w > 5 ? "active" : w < -5 ? "warn" : "idle",
        big: fmt(soc),
        unit: "%",
        level: soc,
        chips: [
          ["bolt", flow],
          ["battery", known(volts) ? `${fmt(volts, 2)} V` : null],
          ["list", cells.length ? `cellen ${fmt(Math.min(...cells), 3)}-${fmt(Math.max(...cells), 3)} V` : null],
          known(delta) && [delta > CELL_SPREAD_WARN ? "warning" : "check", `verschil ${fmt(delta)} mV`, delta > CELL_SPREAD_WARN ? "warn" : ""],
          ["clock", known(cycles) ? `${fmt(cycles)} cycli` : null],
          ["check", known(health) ? `${fmt(health)}% gezond` : null],
          ["thermometer", known(temp) ? `${fmt(temp, 1)}°` : null],
        ],
        foot: [[`Vandaag geladen <b>${E.kwhText(E.today(e.charged))}</b>`], [`ontladen <b>${E.kwhText(E.today(e.discharged))}</b>`]],
      };
    },
  });
})();
