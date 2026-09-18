/* The house as the Start page draws it (js/house3d.js): a plan in metres,
 * taken from the builder's drawings (plans, elevations and sections, 2025).
 * x runs along the front of the house from the wall shared with the
 * neighbour (x = 0) to the garage side; z runs from the front wall (0) to the
 * back; y is height above the ground floor.
 *
 * The two-storey main block carries a gable roof with the ridge along the
 * street, with a dormer on each slope; single-storey blocks with flat roofs
 * stand beside and behind it: the garage, which runs on past the back of the
 * house, and the rear extension. Rooms are the PANEL_AREAS rooms per floor
 * (floor = the PANEL_FLOORS label), so the drawing can later light a room up
 * with its lamps; which room sits where is read off the plans as well as it
 * can be. Adjust here, nothing else refers to these numbers. */
window.HOUSE_PLAN = {
  main: { x: 0, z: 0, w: 5.6, d: 13.0 },
  levels: [
    { floor: "0", y: 0, h: 3.0 },
    { floor: "1", y: 3.0, h: 3.0 },
    { floor: "2", y: 6.0, h: 0 },
  ],
  /* Gutter at 6.2 m, ridge at 10.45 m (section B-B), eaves over the front and
   * back walls. A dormer on each slope, its flat top at 9.0 m. */
  roof: { eavesY: 6.2, ridgeY: 10.45, overhang: 0.3 },
  dormers: [
    /* window: where the glass sits in the dormer's face (Merk-U, Merk-V on page 7) */
    { side: "front", x: 2.95, w: 2.35, topY: 9.0, setback: 1.2, window: { a: 3.07, w: 2.1 } },
    { side: "back", x: 1.1, w: 3.75, topY: 9.0, setback: 1.2, window: { a: 1.22, w: 3.5, mullions: [2.39, 3.55] } },
  ],
  /* Single-storey, flat roof at 3.0 m: the garage block beside the house, set
   * back from the front and running 4.4 m past the back wall, and the rear
   * extension across the back of the main block. */
  flat: [
    { name: "garage", x: 5.6, z: 4.95, w: 3.75, d: 12.45, h: 3.0 },
    /* joined: one space with the room behind the main block's back wall, so
     * no floor or side lines where the two meet (the ceiling line stays). */
    { name: "aanbouw", x: 0, z: 13.0, w: 5.6, d: 1.9, h: 3.0, joined: true },
  ],
  /* Rooms per floor: name (as in PANEL_AREAS), and the rectangle they take;
   * outline: false leaves the outline undrawn (an open space). */
  rooms: {
    /* climate: the PANEL_SENSOR_CARDS climate card that reads in the room (or
     * whose reading it shares: one open space); areas: the PANEL_AREAS rooms
     * whose lamps are in it (its own name when left out); tab: a lighting tab
     * whose lamps are all in it; robotRoom: the robot's name for it. */
    0: [
      { name: "Gameroom", climate: "Voorkamer", x: 0, z: 0, w: 5.6, d: 3.6 },
      { name: "Gang", x: 0, z: 3.6, w: 5.6, d: 3.45 },
      /* One open space: no outline of their own, their walls are in walls. */
      { name: "Keuken", climate: "Keuken", x: 0, z: 7.05, w: 5.6, d: 3.45, outline: false },
      { name: "Eetkamer", climate: "Keuken", areas: ["Eetkamer", "Zitkamer"], x: 0, z: 10.5, w: 5.6, d: 4.4, outline: false },
      { name: "Garage", climate: "Garage", tab: "Garage", x: 5.6, z: 4.95, w: 3.75, d: 7.75 },
      /* The garage block's part behind the garage wall, open to the big room:
       * the back sitting room (the Gameroom's lamps are in here too). */
      { name: "Zitk. achter", climate: "Zitkamer achter", robotRoom: "Zitkamer achter", x: 5.6, z: 12.7, w: 3.75, d: 4.7 },
    ],
    /* First floor (plan, page 6): Naomi's room on the neighbour's side with
     * its one window, Valerie's on the garage side with two and reaching
     * further back, the landing with the stair and a toilet, the bathroom,
     * and the back bedroom across the full width. Their walls are in walls. */
    1: [
      { name: "Naomi", x: 0, z: 0, w: 2.84, d: 3.77 },
      { name: "Valerie", x: 2.84, z: 0, w: 2.76, d: 5.0 },
      { name: "Gang", x: 0, z: 3.77, w: 2.84, d: 5.03 },
      { name: "Badkamer", x: 2.84, z: 5.0, w: 2.76, d: 3.8 },
      { name: "Gillis en Ilse", x: 0, z: 8.8, w: 5.6, d: 4.2 },
    ],
    /* Attic (plan, page 7): the stair and the technical room along the
     * neighbour's wall, the front room, a small hall with the baby's room off
     * it, and the back room; their walls are in walls, so no outlines here. */
    2: [
      { name: "Voorkamer", climate: "Zolder voor", x: 1.45, z: 1.44, w: 4.15, d: 4.46, outline: false },
      { name: "Gang", climate: "Zoldergang", x: 1.45, z: 5.9, w: 1.35, d: 2.8, outline: false },
      { name: "Babykamer", x: 2.8, z: 5.9, w: 2.8, d: 2.1, outline: false },
      { name: "Achterkamer", climate: "Zolder achter", x: 0, z: 8.7, w: 5.6, d: 4.3, outline: false },
    ],
  },
  /* Sensors outside the rooms, shown on the layers at their place (metres):
   * the outside sensor hangs on the front wall beside the gameroom's window. */
  sensors: [{ climate: "Buiten voor", at: [3.1, 1.6, -0.55] }],
  /* Inner walls of the ground floor, drawn as walls (floor line, ceiling line
   * and their ends), each in a vertical plane like the openings: plane "z" runs
   * along the front (at = its z), plane "x" along the side (at = its x); a is
   * where it starts, w its length, h its height. */
  walls: [
    { plane: "z", at: 3.6, a: 0, w: 5.6, h: 3.0 } /* sitting room | hall */,
    { plane: "z", at: 7.05, a: 0, w: 5.6, h: 3.0 } /* hall | kitchen */,
    { plane: "x", at: 3.9, a: 5.75, w: 1.3, h: 3.0 } /* the toilet */,
    { plane: "z", at: 5.75, a: 3.9, w: 1.7, h: 3.0 },
    { plane: "z", at: 12.7, a: 5.6, w: 3.75, h: 3.0 } /* garage | back sitting room */,
    /* first floor (y: the floor it stands on) */
    { plane: "x", at: 2.84, a: 0, w: 8.8, y: 3.0, h: 3.0 } /* Naomi, landing | Valerie, bathroom */,
    { plane: "z", at: 3.77, a: 0, w: 2.84, y: 3.0, h: 3.0 } /* Naomi | landing */,
    { plane: "z", at: 5.0, a: 2.84, w: 2.76, y: 3.0, h: 3.0 } /* Valerie | bathroom */,
    { plane: "z", at: 8.8, a: 0, w: 5.6, y: 3.0, h: 3.0 } /* landing, bathroom | back bedroom */,
    { plane: "z", at: 7.25, a: 0, w: 1.25, y: 3.0, h: 3.0 } /* the toilet off the landing */,
    { plane: "x", at: 1.25, a: 7.25, w: 1.55, y: 3.0, h: 3.0 },
    /* attic */
    { plane: "x", at: 1.45, a: 3.6, w: 7.0, y: 6.0, h: 2.3 } /* stair, technical room | the rooms */,
    { plane: "z", at: 7.1, a: 0, w: 1.45, y: 6.0, h: 2.3 } /* stair | technical room */,
    { plane: "z", at: 10.6, a: 0, w: 1.45, y: 6.0, h: 2.3 } /* technical room | back room */,
    { plane: "z", at: 5.9, a: 1.45, w: 4.15, y: 6.0, h: 2.3 } /* front room | hall, baby's room */,
    { plane: "x", at: 2.8, a: 5.9, w: 2.8, y: 6.0, h: 2.3 } /* hall | baby's room, back room */,
    { plane: "z", at: 8.0, a: 2.8, w: 2.8, y: 6.0, h: 2.3 } /* baby's room | back room */,
    { plane: "z", at: 8.7, a: 1.45, w: 1.35, y: 6.0, h: 2.3 } /* hall | back room */,
  ],
  /* Windows and doors, as rectangles on a wall: plane "z" is a wall along the
   * front (at = its z), plane "x" a side wall (at = its x); a is where the
   * opening starts along that wall, y its sill. Read off the plans and the
   * elevations: no openings in the side walls but the front door. A key names
   * an opening the page can light up (house3d's highlight); sensor names the
   * PANEL_SENSOR_CARDS contact on it, which lights it up while open; floor:
   * false leaves the floor unmarked across it (an open passage). */
  openings: [
    /* front wall (the plan): on the left the gameroom's pair of doors to the
     * street, on the right the window that turns the corner: its tilt-and-turn
     * pane on the left (the window contact), a fixed pane to the corner, and
     * another tilt-and-turn pane in the side wall; above, the three bedroom
     * windows */
    { key: "deur_gameroom", sensor: "Deur gameroom", plane: "z", at: 0, a: 0.45, w: 1.55, y: 0, h: 2.4 },
    { plane: "z", at: 0, a: 1.225, w: 0.02, y: 0, h: 2.4 } /* between the two leaves */,
    { key: "raam_gameroom", sensor: "Raam gameroom", plane: "z", at: 0, a: 2.6, w: 1.0, y: 0.6, h: 1.8 },
    { plane: "z", at: 0, a: 3.6, w: 1.9, y: 0.6, h: 1.8 },
    { key: "raam_gameroom_zij", sensor: "Raam gameroom zij", plane: "x", at: 5.6, a: 0.1, w: 1.0, y: 0.6, h: 1.8 } /* the side pane of the corner window */,
    /* upstairs (plan, page 6): Naomi's one window of two panes (left and right
     * seen from inside), and Valerie's two windows (1 the left, 2 the right) */
    { key: "raam_naomi_links", sensor: "Raam Naomi links", plane: "z", at: 0, a: 0.43, w: 0.775, y: 3.95, h: 1.65 },
    { key: "raam_naomi_rechts", sensor: "Raam Naomi rechts", plane: "z", at: 0, a: 1.205, w: 0.775, y: 3.95, h: 1.65 },
    { key: "raam_valerie_1", sensor: "Raam Valerie 1", plane: "z", at: 0, a: 2.9, w: 1.0, y: 3.95, h: 1.65 },
    { key: "raam_valerie_2", sensor: "Raam Valerie 2", plane: "z", at: 0, a: 4.15, w: 1.0, y: 3.95, h: 1.65 },
    /* upstairs, inside: the doors off the landing (Naomi's, Valerie's, the
     * bathroom's, the toilet's) and the back bedroom's */
    { plane: "z", at: 3.77, a: 1.8, w: 0.9, y: 3.0, h: 2.3 },
    { plane: "x", at: 2.84, a: 3.95, w: 0.9, y: 3.0, h: 2.3 },
    { plane: "x", at: 2.84, a: 6.05, w: 0.9, y: 3.0, h: 2.3 },
    { plane: "x", at: 1.25, a: 7.85, w: 0.8, y: 3.0, h: 2.3 },
    { plane: "z", at: 8.8, a: 1.65, w: 0.9, y: 3.0, h: 2.3 },
    /* attic (page 7): the hall's doors to the front room, the baby's room, the
     * back room and the technical room (the dormer windows are in dormers) */
    { plane: "z", at: 5.9, a: 1.7, w: 0.9, y: 6.0, h: 2.1 },
    { plane: "x", at: 2.8, a: 6.0, w: 0.9, y: 6.0, h: 2.1 },
    { plane: "z", at: 8.7, a: 1.7, w: 0.9, y: 6.0, h: 2.1 },
    { plane: "x", at: 1.45, a: 7.6, w: 0.9, y: 6.0, h: 2.1 },
    /* the front door in the recess, and the garage door */
    { key: "voordeur", sensor: "Voordeur", plane: "x", at: 5.6, a: 3.98, w: 0.97, y: 0, h: 2.5 },
    { key: "garagedeur", sensor: "Garagedeur 2", plane: "z", at: 4.95, a: 6.05, w: 2.6, y: 0, h: 2.35 },
    /* inside: the wide sliding-door openings in the two hall walls, the door
     * from the big room into the garage, and the open passage into the back
     * sitting room */
    { plane: "z", at: 3.6, a: 1.65, w: 1.6, y: 0, h: 2.4 },
    { plane: "z", at: 7.05, a: 1.65, w: 1.6, y: 0, h: 2.4 },
    { key: "garagedeur_binnen", sensor: "Garage tussendeur", plane: "x", at: 5.6, a: 10.3, w: 0.95, y: 0, h: 2.3 },
    /* the meter cupboard: the box in the hall beside the toilet, its door on the kitchen side */
    { key: "meterkast", sensor: "Meterkast", plane: "z", at: 7.05, a: 4.35, w: 0.8, y: 0, h: 2.1 },
    { plane: "x", at: 5.6, a: 12.9, w: 1.9, y: 0, h: 2.6, floor: false } /* open passage: no line on the floor */,
    /* back: the bedroom's two windows (1.55 m each, page 6), each of two
     * opening panes with a contact: 1 and 2 the window on the right coming in
     * from the landing, 3 and 4 the one on the left, the lower number the left
     * pane seen from inside; then the kitchen's sliding door, and the back
     * sitting room's sliding door at the end of the garage block */
    { key: "raam_achterkamer_2", sensor: "Raam achterkamer Gillis en Ilse 2", plane: "z", at: 13.0, a: 1.175, w: 0.775, y: 4.0, h: 1.6 },
    { key: "raam_achterkamer_1", sensor: "Raam achterkamer Gillis en Ilse 1", plane: "z", at: 13.0, a: 1.95, w: 0.775, y: 4.0, h: 1.6 },
    { key: "raam_achterkamer_4", sensor: "Raam achterkamer Gillis en Ilse 4", plane: "z", at: 13.0, a: 3.265, w: 0.775, y: 4.0, h: 1.6 },
    { key: "raam_achterkamer_3", sensor: "Raam achterkamer Gillis en Ilse 3", plane: "z", at: 13.0, a: 4.04, w: 0.775, y: 4.0, h: 1.6 },
    { key: "schuifpui_keuken", sensor: "Schuifpui keuken", plane: "z", at: 14.9, a: 1.2, w: 3.5, y: 0, h: 2.6 },
    { plane: "z", at: 14.9, a: 2.95, w: 0.02, y: 0, h: 2.6 } /* its mullion */,
    { key: "schuifpui_achterkamer", plane: "z", at: 17.4, a: 5.95, w: 2.3, y: 0, h: 2.6 },
    { plane: "z", at: 17.4, a: 7.1, w: 0.02, y: 0, h: 2.6 } /* its mullion */,
  ],
};
