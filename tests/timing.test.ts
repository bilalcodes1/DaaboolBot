import { afterEach, describe, expect, it, vi } from "vitest";
import { addCalendarDays, getBaghdadNow, getTomorrow } from "../src/calendar";
import { formatMinuteOfDay, getDayTiming, getSlotPhase, getSlotTiming, PROVISIONAL_TIMES } from "../src/timing";

afterEach(() => { vi.unstubAllEnvs(); });

describe("Baghdad calendar and clock", () => {
  it("returns one precise clock snapshot including seconds and milliseconds", () => {
    expect(getBaghdadNow(new Date("2026-10-15T05:30:12.345Z"))).toEqual({
      weekday: 4, date: "2026-10-15", minuteOfDay: 510,
      second: 12, millisecond: 345, secondOfDay: 30612, millisecondOfDay: 30612345,
    });
  });

  it.each(["UTC", "America/Los_Angeles", "Pacific/Auckland", "Asia/Tokyo"])("is independent of host timezone %s", timezone => {
    vi.stubEnv("TZ", timezone);
    const now = new Date("2026-10-12T21:00:00.000Z");
    expect(getBaghdadNow(now)).toMatchObject({ weekday: 2, date: "2026-10-13", minuteOfDay: 0, second: 0, millisecondOfDay: 0 });
    expect(getTomorrow(now)).toEqual({ weekday: 3, date: "2026-10-14" });
    expect(addCalendarDays("2026-10-17", 1)).toEqual({ weekday: 0, date: "2026-10-18" });
  });

  it("changes the date exactly at Baghdad midnight and avoids hour 24", () => {
    expect(getBaghdadNow(new Date("2026-10-12T20:59:59.999Z"))).toMatchObject({
      date: "2026-10-12", weekday: 1, minuteOfDay: 1439, second: 59, millisecondOfDay: 86_399_999,
    });
    expect(getBaghdadNow(new Date("2026-10-12T21:00:00.000Z"))).toMatchObject({
      date: "2026-10-13", weekday: 2, minuteOfDay: 0, second: 0, millisecondOfDay: 0,
    });
  });

  it.each([
    ["2026-10-31", 1, "2026-11-01", 0],
    ["2026-12-31", 1, "2027-01-01", 5],
    ["2028-02-28", 1, "2028-02-29", 2],
    ["2028-02-29", 1, "2028-03-01", 3],
    ["2026-10-18", -1, "2026-10-17", 6],
    ["2026-10-16", 3, "2026-10-19", 1],
  ] as const)("adds calendar days %s + %s without a host-timezone dependency", (date, days, expectedDate, weekday) => {
    expect(addCalendarDays(date, days)).toEqual({ date: expectedDate, weekday });
  });

  it("rejects invalid dates and fractional offsets instead of normalizing misleading input", () => {
    for (const date of ["2026-02-30", "2026-13-01", "2026-1-01", "invalid"]) {
      expect(() => addCalendarDays(date, 1)).toThrow(RangeError);
    }
    expect(() => addCalendarDays("2026-10-15", 0.5)).toThrow(RangeError);
    expect(() => addCalendarDays("2026-10-15", Number.NaN)).toThrow(RangeError);
    expect(() => getBaghdadNow(new Date("invalid"))).toThrow(RangeError);
  });
});

describe("explicitly provisional lecture times", () => {
  it("keeps the three approved one-hour assumptions in one clearly temporary object", () => {
    expect(PROVISIONAL_TIMES.temporary).toBe(true);
    expect(PROVISIONAL_TIMES.label).toContain("مؤقتة");
    expect(PROVISIONAL_TIMES.slots.map(slot => [formatMinuteOfDay(slot.startMinute), formatMinuteOfDay(slot.endMinute)])).toEqual([
      ["08:30", "09:30"], ["09:30", "10:30"], ["10:30", "11:30"],
    ]);
    expect(getSlotTiming(2)).toMatchObject({ slot: 2, startMinute: 570, endMinute: 630 });
    expect(() => getSlotTiming(4)).toThrow(RangeError);
    expect(() => formatMinuteOfDay(-1)).toThrow(RangeError);
    expect(() => formatMinuteOfDay(30.5)).toThrow(RangeError);
  });

  it.each([
    ["05:29:59.999", null, 1, [1, 2, 3]],
    ["05:30:00.000", 1, 2, [1, 2, 3]],
    ["06:29:59.999", 1, 2, [1, 2, 3]],
    ["06:30:00.000", 2, 3, [2, 3]],
    ["07:29:59.999", 2, 3, [2, 3]],
    ["07:30:00.000", 3, null, [3]],
    ["08:29:59.999", 3, null, [3]],
    ["08:30:00.000", null, null, []],
  ] as const)("uses exact start/end boundaries at UTC %s (Baghdad +03:00)", (time, currentSlot, nextSlot, remainingSlots) => {
    const now = new Date(`2026-10-15T${time}Z`);
    expect(getDayTiming(now)).toMatchObject({ currentSlot, nextSlot, remainingSlots });
  });

  it("marks the previous slot ended at exactly the next slot's inclusive start", () => {
    const transition = new Date("2026-10-15T06:30:00.000Z");
    expect(getSlotPhase(1, transition)).toBe("ended");
    expect(getSlotPhase(2, transition)).toBe("current");
    expect(getSlotPhase(3, transition)).toBe("before");
  });

  it("reports clock slots on weekends without pretending that a lecture is scheduled", () => {
    const friday = getDayTiming(new Date("2026-10-16T05:30:00.000Z"));
    expect(friday.calendar.weekday).toBe(5);
    expect(friday.currentSlot).toBe(1);
    // This module provides no course/teacher facts and does not skip calendar days.
    expect(friday).not.toHaveProperty("course");
    expect(friday.calendar.date).toBe("2026-10-16");
  });
});
