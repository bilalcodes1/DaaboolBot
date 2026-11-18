import { afterEach, describe, expect, it, vi } from "vitest";
import { getCalendarWeek } from "../src/calendar";
import { parseWeekRange, removeWeekSelectors, resolveWeekdayInRange } from "../src/date-range";

afterEach(() => vi.unstubAllEnvs());

const friday = new Date("2026-10-16T09:00:00Z");

describe("Sunday through Saturday calendar weeks in Baghdad", () => {
  it.each([
    ["2026-10-11T09:00:00Z", "2026-10-11", "2026-10-17"],
    ["2026-10-16T09:00:00Z", "2026-10-11", "2026-10-17"],
    ["2026-10-17T20:59:59.999Z", "2026-10-11", "2026-10-17"],
    ["2026-10-17T21:00:00Z", "2026-10-18", "2026-10-24"],
  ])("resolves %s using Baghdad's calendar boundary", (instant, fromDate, toDate) => {
    expect(getCalendarWeek(new Date(instant))).toEqual({ fromDate, toDate });
  });

  it("treats next week as the next whole calendar week, even on Sunday", () => {
    expect(getCalendarWeek(friday, 1)).toEqual({ fromDate: "2026-10-18", toDate: "2026-10-24" });
    expect(getCalendarWeek(new Date("2026-10-18T09:00:00Z"), 1)).toEqual({ fromDate: "2026-10-25", toDate: "2026-10-31" });
    expect(getCalendarWeek(friday, -1)).toEqual({ fromDate: "2026-10-04", toDate: "2026-10-10" });
  });

  it.each([
    ["2026-10-31T12:00:00Z", 1, "2026-11-01", "2026-11-07"],
    ["2026-12-31T12:00:00Z", 1, "2027-01-03", "2027-01-09"],
    ["2027-01-01T12:00:00Z", 0, "2026-12-27", "2027-01-02"],
    ["2028-02-29T12:00:00Z", 0, "2028-02-27", "2028-03-04"],
  ] as const)("handles month/year boundaries at %s", (instant, offset, fromDate, toDate) => {
    expect(getCalendarWeek(new Date(instant), offset)).toEqual({ fromDate, toDate });
  });

  it.each(["UTC", "America/Los_Angeles", "Pacific/Auckland", "Asia/Tokyo"])("does not use the host timezone %s", timezone => {
    vi.stubEnv("TZ", timezone);
    expect(getCalendarWeek(new Date("2026-10-17T21:00:00Z"))).toEqual({ fromDate: "2026-10-18", toDate: "2026-10-24" });
  });

  it("rejects invalid clock snapshots and fractional week offsets", () => {
    expect(() => getCalendarWeek(new Date("invalid"))).toThrow(RangeError);
    for (const offset of [0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => getCalendarWeek(friday, offset)).toThrow(RangeError);
    }
  });
});

describe("literal Arabic week ranges", () => {
  it.each([
    "شنو امتحانات الأسبوع الجاي", "الاسبوع القادم", "الأسبوع التالي", "بالأسبوع المقبل",
    "اسبوع جاي", "للاسبوع الجاي", "وللأسبوع القادم", "الاسبوع الجايه", "أُسْبُوع القادم",
    "الاسبوع اللي جاي", "الأسبوع الي جاي", "الاسبوع يلي جاي", "الاسبوع اللي يجي", "المختبرات مجموعة B الاسبوع الجاي",
  ])("extracts a concrete next-week range from %s", text => {
    expect(parseWeekRange(text, friday)).toEqual({
      matched: true, range: { fromDate: "2026-10-18", toDate: "2026-10-24", label: "next_week" }, conflicting: false,
    });
  });

  it.each(["هالأسبوع", "هالاسبوع", "وهالاسبوع", "هذا الأسبوع", "لهذا الاسبوع", "هاذا الاسبوع", "الأسبوع الحالي", "الاسبوع هذا"])("extracts this week from %s", text => {
    expect(parseWeekRange(text, friday)).toEqual({
      matched: true, range: { fromDate: "2026-10-11", toDate: "2026-10-17", label: "current_week" }, conflicting: false,
    });
  });

  it.each(["الأسبوع الماضي", "اسبوع سابق", "الأسبوع اللي راح", "بالأسبوع السابق", "الاسبوع الفات", "الاسبوع الفاته"])("extracts last week from %s", text => {
    expect(parseWeekRange(text, friday)).toEqual({
      matched: true, range: { fromDate: "2026-10-04", toDate: "2026-10-10", label: "last_week" }, conflicting: false,
    });
  });

  it.each(["الأسبوع الجاي وهذا الأسبوع", "هالاسبوع والاسبوع القادم", "الأسبوع الماضي أو القادم", "الأسبوع الجاي والحالي", "الأسبوع الجاي او الحالي"])("marks different selections conflicting in %s", text => {
    expect(parseWeekRange(text, friday)).toEqual({ matched: true, range: null, conflicting: true });
  });

  it.each([
    "الأسبوع بعد الجاي", "الأسبوع اللي بعد الجاي", "بعد الأسبوع القادم", "الأسبوع قبل الماضي",
    "بعد اسبوعين", "اسبوعين الجايه", "الاسبوع الثاني", "الاسبوع القريب", "الاسبوع مو الجاي",
    "مو الأسبوع القادم", "الاسبوع الجاي بعد الجاي", "الاسبوع اللي بعده", "الاسبوع البعده",
  ])("does not turn an unsupported range into a guessed next week: %s", text => {
    expect(parseWeekRange(text, friday)).toMatchObject({ matched: true, range: null });
  });

  it.each(["الاثنين الجاي", "شنو المختبر الجاي", "جدول الأسبوع", "الجدول الاسبوعي", "كل الاسبوع", "شرح معنى اسبوع", "مترجمات"])("leaves nonrelative/general week wording to its caller: %s", text => {
    expect(parseWeekRange(text, friday)).toEqual({ matched: false, range: null, conflicting: false });
  });

  it("preserves a weekday for resolution inside the selected week", () => {
    const parsed = parseWeekRange("مختبرات الأحد الأسبوع الجاي مجموعة B", friday);
    expect(parsed.range).not.toBeNull();
    expect(removeWeekSelectors("مختبرات الأحد الأسبوع الجاي مجموعة B")).toBe("مختبرات الاحد مجموعه b");
    expect(resolveWeekdayInRange(parsed.range!, 0)).toBe("2026-10-18");
    expect(resolveWeekdayInRange(parsed.range!, 1)).toBe("2026-10-19");
    expect(resolveWeekdayInRange(parsed.range!, 6)).toBe("2026-10-24");
  });

  it("removes repeated and unsupported week phrases without deleting course/group words", () => {
    expect(removeWeekSelectors("الأسبوع القادم الاسبوع الجاي مجموعة B")).toBe("مجموعه b");
    expect(removeWeekSelectors("امتحانات الأسبوع اللي بعد الجاي مترجمات")).toBe("امتحانات مترجمات");
  });

  it("does not accept an arbitrary date interval as a calendar week", () => {
    const week = getCalendarWeek(friday, 1);
    for (const weekday of [-1, 7, 0.5, Number.NaN]) {
      expect(() => resolveWeekdayInRange(week, weekday)).toThrow(RangeError);
    }
    expect(() => resolveWeekdayInRange({ fromDate: "2026-10-19", toDate: "2026-10-25" }, 1)).toThrow(RangeError);
    expect(() => resolveWeekdayInRange({ fromDate: "2026-10-18", toDate: "2026-10-23" }, 1)).toThrow(RangeError);
  });
});
