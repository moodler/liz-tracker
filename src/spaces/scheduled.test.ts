import { describe, it, expect } from "vitest";
import { computeNextRun, sanitizeScheduledSpaceData } from "./scheduled.js";

// ── computeNextRun ──

describe("computeNextRun", () => {
  it("returns null for manual frequency", () => {
    expect(computeNextRun({ frequency: "manual" })).toBe(null);
  });

  it("returns null for custom frequency", () => {
    expect(computeNextRun({ frequency: "custom", cron_override: "0 */6 * * *" })).toBe(null);
  });

  it("returns null for once frequency", () => {
    expect(computeNextRun({ frequency: "once", time: "09:00" })).toBe(null);
  });

  it("returns null when no frequency", () => {
    expect(computeNextRun({})).toBe(null);
  });

  it("returns next hour boundary for hourly", () => {
    const now = new Date("2026-03-29T10:15:00Z");
    const result = computeNextRun({ frequency: "hourly", timezone: "UTC" }, now);
    expect(result).not.toBeNull();
    const nextRun = new Date(result!);
    expect(nextRun.getUTCHours()).toBe(11);
    expect(nextRun.getUTCMinutes()).toBe(0);
  });

  it("returns today's time for daily if not yet passed", () => {
    // 10:15 UTC, scheduled for 14:00 UTC — should return today at 14:00
    const now = new Date("2026-03-29T10:15:00Z");
    const result = computeNextRun({ frequency: "daily", time: "14:00", timezone: "UTC" }, now);
    expect(result).not.toBeNull();
    const nextRun = new Date(result!);
    expect(nextRun.getUTCDate()).toBe(29);
    expect(nextRun.getUTCHours()).toBe(14);
    expect(nextRun.getUTCMinutes()).toBe(0);
  });

  it("returns tomorrow's time for daily if already passed", () => {
    // 16:00 UTC, scheduled for 14:00 UTC — should return tomorrow at 14:00
    const now = new Date("2026-03-29T16:00:00Z");
    const result = computeNextRun({ frequency: "daily", time: "14:00", timezone: "UTC" }, now);
    expect(result).not.toBeNull();
    const nextRun = new Date(result!);
    expect(nextRun.getUTCDate()).toBe(30);
    expect(nextRun.getUTCHours()).toBe(14);
  });

  it("respects timezone for daily schedule", () => {
    // 2026-03-29 at 22:00 UTC = 2026-03-30 at 06:00 AWST (Australia/Perth = UTC+8)
    // Scheduled for 07:00 Perth time — not yet passed in Perth, should return today (Mar 30) at 07:00 Perth
    const now = new Date("2026-03-29T22:00:00Z");
    const result = computeNextRun({ frequency: "daily", time: "07:00", timezone: "Australia/Perth" }, now);
    expect(result).not.toBeNull();
    const nextRun = new Date(result!);
    // 07:00 AWST = 23:00 UTC on Mar 29
    expect(nextRun.getUTCDate()).toBe(29);
    expect(nextRun.getUTCHours()).toBe(23);
    expect(nextRun.getUTCMinutes()).toBe(0);
  });

  it("finds next matching day for weekly schedule", () => {
    // 2026-03-29 is a Sunday. Schedule for Monday and Wednesday at 09:00 UTC.
    const now = new Date("2026-03-29T10:00:00Z");
    const result = computeNextRun({
      frequency: "weekly",
      time: "09:00",
      timezone: "UTC",
      days_of_week: ["monday", "wednesday"],
    }, now);
    expect(result).not.toBeNull();
    const nextRun = new Date(result!);
    // Next Monday is March 30
    expect(nextRun.getUTCDate()).toBe(30);
    expect(nextRun.getUTCHours()).toBe(9);
  });

  it("skips today for weekly if time already passed", () => {
    // 2026-03-30 is Monday, 11:00 UTC. Schedule for Monday at 09:00 UTC.
    const now = new Date("2026-03-30T11:00:00Z");
    const result = computeNextRun({
      frequency: "weekly",
      time: "09:00",
      timezone: "UTC",
      days_of_week: ["monday", "wednesday"],
    }, now);
    expect(result).not.toBeNull();
    const nextRun = new Date(result!);
    // Should be Wednesday April 1
    expect(nextRun.getUTCDate()).toBe(1);
    expect(nextRun.getUTCMonth()).toBe(3); // April = month 3 (0-based)
  });

  it("returns 1st of next month for monthly if past", () => {
    // March 15, 10:00 UTC — scheduled for 09:00 monthly
    const now = new Date("2026-03-15T10:00:00Z");
    const result = computeNextRun({ frequency: "monthly", time: "09:00", timezone: "UTC" }, now);
    expect(result).not.toBeNull();
    const nextRun = new Date(result!);
    expect(nextRun.getUTCMonth()).toBe(3); // April
    expect(nextRun.getUTCDate()).toBe(1);
    expect(nextRun.getUTCHours()).toBe(9);
  });

  it("returns 1st of current month if today is the 1st and time not passed", () => {
    const now = new Date("2026-04-01T07:00:00Z");
    const result = computeNextRun({ frequency: "monthly", time: "09:00", timezone: "UTC" }, now);
    expect(result).not.toBeNull();
    const nextRun = new Date(result!);
    expect(nextRun.getUTCMonth()).toBe(3); // April
    expect(nextRun.getUTCDate()).toBe(1);
    expect(nextRun.getUTCHours()).toBe(9);
  });

  it("returns null for invalid time format", () => {
    expect(computeNextRun({ frequency: "daily", time: "invalid", timezone: "UTC" })).toBe(null);
  });

  it("returns null for daily without time", () => {
    expect(computeNextRun({ frequency: "daily", timezone: "UTC" })).toBe(null);
  });
});

// ── sanitizeScheduledSpaceData with next_run ──

describe("sanitizeScheduledSpaceData computes next_run", () => {
  it("sets next_run when schedule config is present", () => {
    const input = JSON.stringify({
      schedule: { frequency: "daily", time: "09:00", timezone: "UTC" },
      status: { next_run: null, last_run: null },
      todo: [],
      ignore: [],
    });
    const result = JSON.parse(sanitizeScheduledSpaceData(input, "scheduled"));
    expect(result.status.next_run).not.toBeNull();
  });

  it("sets next_run to null for manual frequency", () => {
    const input = JSON.stringify({
      schedule: { frequency: "manual", timezone: "UTC" },
      status: { next_run: null },
      todo: [],
      ignore: [],
    });
    const result = JSON.parse(sanitizeScheduledSpaceData(input, "scheduled"));
    expect(result.status.next_run).toBe(null);
  });

  it("does not add status.next_run for non-scheduled data", () => {
    const input = JSON.stringify({ title: "just a regular item" });
    const result = JSON.parse(sanitizeScheduledSpaceData(input));
    expect(result.status).toBeUndefined();
  });
});
