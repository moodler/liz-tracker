/**
 * Travel space unit tests — dedupKey() helper
 *
 * Tests the type-aware dedup key logic introduced in TRACK-224.
 */

import { describe, it, expect } from "vitest";
import { _dedupKey as dedupKey } from "./travel.js";

/** Null separator used in dedup keys */
const N = "\x00";

describe("dedupKey", () => {
  // ── Returns null when confirmation or provider is missing ──

  it("returns null when confirmation is missing", () => {
    expect(dedupKey({ provider: "Qantas", type: "flight" })).toBeNull();
  });

  it("returns null when provider is missing", () => {
    expect(dedupKey({ confirmation: "ABC123", type: "flight" })).toBeNull();
  });

  it("returns null when both are missing", () => {
    expect(dedupKey({ type: "flight", title: "QF21" })).toBeNull();
  });

  it("returns null for empty strings", () => {
    expect(dedupKey({ confirmation: "", provider: "", type: "flight" })).toBeNull();
  });

  // ── Flights: confirmation + provider + flight_number ──

  it("includes flight_number for flight segments", () => {
    const key = dedupKey({
      type: "flight",
      confirmation: "DXNRYI",
      provider: "Singapore Airlines",
      flight_number: "SQ224",
    });
    expect(key).toBe(`DXNRYI${N}Singapore Airlines${N}SQ224`);
  });

  it("different flight numbers under same PNR produce different keys", () => {
    const base = { type: "flight", confirmation: "DXNRYI", provider: "Singapore Airlines" };
    const key1 = dedupKey({ ...base, flight_number: "SQ224" });
    const key2 = dedupKey({ ...base, flight_number: "SQ856" });
    const key3 = dedupKey({ ...base, flight_number: "SQ835" });
    const key4 = dedupKey({ ...base, flight_number: "SQ213" });

    expect(key1).not.toBe(key2);
    expect(key2).not.toBe(key3);
    expect(key3).not.toBe(key4);
    // All are unique
    const keys = new Set([key1, key2, key3, key4]);
    expect(keys.size).toBe(4);
  });

  it("same flight_number + confirmation + provider produces same key", () => {
    const seg = {
      type: "flight",
      confirmation: "DXNRYI",
      provider: "Singapore Airlines",
      flight_number: "SQ224",
    };
    expect(dedupKey(seg)).toBe(dedupKey({ ...seg, seat: "34A" }));
  });

  it("flight without flight_number falls back to confirmation+provider", () => {
    const key = dedupKey({
      type: "flight",
      confirmation: "DXNRYI",
      provider: "Singapore Airlines",
    });
    expect(key).toBe(`DXNRYI${N}Singapore Airlines`);
  });

  // ── Lodging: confirmation + provider + title ──

  it("includes title for lodging segments", () => {
    const key = dedupKey({
      type: "lodging",
      confirmation: "BK123",
      provider: "Booking.com",
      title: "Park Hyatt Tokyo",
    });
    expect(key).toBe(`BK123${N}Booking.com${N}Park Hyatt Tokyo`);
  });

  it("different lodging titles under same booking produce different keys", () => {
    const base = { type: "lodging", confirmation: "BK123", provider: "Booking.com" };
    const key1 = dedupKey({ ...base, title: "Park Hyatt Tokyo" });
    const key2 = dedupKey({ ...base, title: "Park Hyatt Kyoto" });
    expect(key1).not.toBe(key2);
  });

  it("lodging without title falls back to confirmation+provider", () => {
    const key = dedupKey({
      type: "lodging",
      confirmation: "BK123",
      provider: "Booking.com",
    });
    expect(key).toBe(`BK123${N}Booking.com`);
  });

  // ── Transport: confirmation + provider + title ──

  it("includes title for transport segments", () => {
    const key = dedupKey({
      type: "transport",
      confirmation: "RP456",
      provider: "JR Pass",
      title: "Train WUX→SZH",
    });
    expect(key).toBe(`RP456${N}JR Pass${N}Train WUX→SZH`);
  });

  it("different transport titles under same booking produce different keys", () => {
    const base = { type: "transport", confirmation: "RP456", provider: "JR Pass" };
    const key1 = dedupKey({ ...base, title: "Train WUX→SZH" });
    const key2 = dedupKey({ ...base, title: "Bus SZH→GZ" });
    expect(key1).not.toBe(key2);
  });

  // ── Other types: confirmation + provider only ──

  it("activity uses confirmation+provider only", () => {
    const key = dedupKey({
      type: "activity",
      confirmation: "ACT789",
      provider: "Viator",
      title: "City Tour",
    });
    expect(key).toBe(`ACT789${N}Viator`);
  });

  it("restaurant uses confirmation+provider only", () => {
    const key = dedupKey({
      type: "restaurant",
      confirmation: "RES123",
      provider: "OpenTable",
      title: "Sushi Saito",
    });
    expect(key).toBe(`RES123${N}OpenTable`);
  });

  it("meeting uses confirmation+provider only", () => {
    const key = dedupKey({
      type: "meeting",
      confirmation: "MTG456",
      provider: "Zoom",
      title: "Client call",
    });
    expect(key).toBe(`MTG456${N}Zoom`);
  });

  it("note uses confirmation+provider only", () => {
    const key = dedupKey({
      type: "note",
      confirmation: "NOTE789",
      provider: "System",
      title: "Reminder",
    });
    expect(key).toBe(`NOTE789${N}System`);
  });

  // ── Edge cases ──

  it("segment with no type falls back to confirmation+provider", () => {
    const key = dedupKey({
      confirmation: "ABC",
      provider: "XYZ",
    });
    expect(key).toBe(`ABC${N}XYZ`);
  });

  it("handles non-string values gracefully via String() coercion", () => {
    const key = dedupKey({
      type: "flight",
      confirmation: 12345 as unknown,
      provider: "Airline" as unknown,
      flight_number: 789 as unknown,
    });
    expect(key).toBe(`12345${N}Airline${N}789`);
  });
});
