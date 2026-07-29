import { describe, expect, it, vi } from "vitest";
import { parseStatus, type PresenceRow } from "@/lib/lobby-state";
import { roomNameFor, sanitizeTableName, tableNumberFromRoom } from "@/lib/tables";

/**
 * The contract that replaced the container pool.
 *
 * Tables used to be attributed by the push URL: one lobby container each, one
 * `-URL .../t3/` each, so a row's table was known before the payload was read.
 * With a single lobby the room name is the only carrier, which makes these
 * three things load-bearing: the `(#n)` suffix survives a round trip, a name a
 * player can actually type cannot forge one, and a row for a room we did not
 * name is recognised as "not a table" rather than mis-attributed.
 */

const rowsOf = (...lines: string[]): PresenceRow[] => parseStatus(lines.join("\n") + "\n");

describe("room naming", () => {
  it("round-trips the table number", () => {
    for (const slot of [1, 7, 12, 64, 512]) {
      expect(tableNumberFromRoom(roomNameFor({ slot, name: "Sunday game" }))).toBe(slot);
    }
  });

  it("keeps two tables of the same name apart", () => {
    const a = roomNameFor({ slot: 3, name: "Sunday game" });
    const b = roomNameFor({ slot: 9, name: "Sunday game" });
    expect(a).not.toBe(b);
    expect(tableNumberFromRoom(a)).toBe(3);
    expect(tableNumberFromRoom(b)).toBe(9);
  });

  it("treats rooms it did not name as not-a-table", () => {
    for (const room of ["Main Room", "our game", "Table 3", "(#)", "#4", "(#4) trailing"]) {
      expect(tableNumberFromRoom(room)).toBeNull();
    }
  });

  it("refuses names that could forge the suffix", () => {
    expect(sanitizeTableName("Sneaky (#4)")).toBeNull();
    expect(sanitizeTableName("Sneaky #4")).toBeNull();
    // ...while ordinary parenthesised names still work and stay unambiguous.
    expect(sanitizeTableName("Sunday (long)")).toBe("Sunday (long)");
    expect(tableNumberFromRoom(roomNameFor({ slot: 2, name: "Sunday (long)" }))).toBe(2);
  });
});

describe("parseStatus", () => {
  it("reads module, room and player from the reporter's three columns", () => {
    expect(rowsOf("Here I Stand\tSunday game (#3)\tChase")).toEqual([
      { module: "Here I Stand", room: "Sunday game (#3)", player: "Chase" },
    ]);
  });

  it("drops blank and short lines rather than inventing fields", () => {
    expect(rowsOf("", "Here I Stand\tMain Room", "  ", "a\tb\tc")).toEqual([
      { module: "a", room: "b", player: "c" },
    ]);
  });
});

describe("lobby store", () => {
  // A fresh store per test. The exported singleton is pinned to globalThis to
  // survive Next's HMR, so dropping the pin *and* resetting the module cache is
  // what actually gets a new one.
  async function freshStore() {
    delete (globalThis as Record<string, unknown>).__vassalLobbyStore;
    vi.resetModules();
    return (await import("@/lib/lobby-state")).lobbyStore;
  }

  it("splits one push across the rooms it names", async () => {
    const store = await freshStore();
    store.update(
      rowsOf(
        "Here I Stand\tSunday game (#3)\tChase",
        "Here I Stand\tSunday game (#3)\tJordan",
        "Vassal 40k\tskirmish (#7)\tSam",
        "Here I Stand\tMain Room\tWanderer",
      ),
    );

    expect(store.playersAt(3)).toEqual(["Chase", "Jordan"]);
    expect(store.playersAt(7)).toEqual(["Sam"]);
    expect(store.hall()).toEqual(["Wanderer"]);
    expect([...store.occupiedTables()].sort((a, b) => a - b)).toEqual([3, 7]);
    expect(store.get().playerCount).toBe(4);
  });

  it("holds more tables at once than the old eight-container pool could", async () => {
    const store = await freshStore();
    store.update(
      rowsOf(
        ...Array.from({ length: 12 }, (_, i) => `Here I Stand\tgame (#${i + 1})\tp${i + 1}`),
      ),
    );
    expect(store.occupiedTables().size).toBe(12);
    expect(store.playersAt(12)).toEqual(["p12"]);
  });

  it("replaces the whole picture on each push, since each carries the full roster", async () => {
    const store = await freshStore();
    store.update(rowsOf("Here I Stand\tgame (#1)\tChase"));
    store.update(rowsOf("Here I Stand\tgame (#2)\tJordan"));
    expect(store.playersAt(1)).toEqual([]);
    expect(store.playersAt(2)).toEqual(["Jordan"]);
  });
});

describe("table attribution", () => {
  // Regression: rooms are namespaced per module, so the same `(#n)` can exist
  // under two modules at once. Found live 2026-07-28 — one player opened two
  // tables before launching either, both JVMs read the same room name, and the
  // portal merged two different games into one table row.
  async function withRooms(...lines: string[]) {
    delete (globalThis as Record<string, unknown>).__vassalLobbyStore;
    vi.resetModules();
    const { lobbyStore } = await import("@/lib/lobby-state");
    const { playersAtTable } = await import("@/lib/table-presence");
    lobbyStore.update(parseStatus(lines.join("\n") + "\n"));
    return playersAtTable;
  }

  it("does not hand one module's room to another module's table", async () => {
    const playersAtTable = await withRooms(
      "Here I Stand (500th Anniversary Edition)\tclash (#2)\tChase",
      "Twilight Struggle 3.1\tclash (#2)\tJordan",
    );
    expect(playersAtTable({ slot: 2, modulePath: "/his" })).toEqual(["Chase"]);
    expect(playersAtTable({ slot: 2, modulePath: "/twilight-struggle" })).toEqual([
      "Jordan",
    ]);
  });

  it("keeps a room whose module is not in the catalog rather than hiding it", async () => {
    const playersAtTable = await withRooms("Some Unlisted Module\tgame (#4)\tSam");
    expect(playersAtTable({ slot: 4, modulePath: "/whatever" })).toEqual(["Sam"]);
  });
});
