import { describe, expect, it } from "vitest";
import { emptyResult, type NluResult } from "../src/nlu-schema";
import { renderQuery } from "../src/query";
import { classifyLocal } from "../src/nlu-local";

function answer(fields: Partial<NluResult>, instant = "2026-10-18T06:45:00Z") {
  return renderQuery({ ...emptyResult("next"), ...fields }, new Date(instant));
}

describe("precise laboratory selections", () => {
  it("returns only the two Sunday group B laboratory sessions", () => {
    const { text } = answer({ intent: "lookup", day: "weekday", weekday: 0, labsOnly: true, group: "B" });
    expect(text).toContain("مختبرات الأحد | مجموعة B");
    expect(text.match(/📖/g)).toHaveLength(2);
    expect(text).toContain("شبكات الحاسبة | مجموعة B | م2");
    expect(text).toContain("برمجة تطبيقات الموبايل | مجموعة B | م1");
    expect(text).toContain("09:30–10:30");
    expect(text).toContain("10:30–11:30");
    expect(text).not.toMatch(/معمارية|مجموعة A|08:30/);
  });

  it("keeps both groups when no group is supplied and honors combined filters", () => {
    expect(answer({ intent: "lookup", labsOnly: true, day: "weekday", weekday: 0 }).text.match(/📖/g)).toHaveLength(4);
    const text = answer({ intent: "lookup", day: "weekday", weekday: 0, labsOnly: true, lab: 1, group: "B" }).text;
    expect(text.match(/📖/g)).toHaveLength(1);
    expect(text).not.toContain("شبكات");
  });

  it("does not treat every group-specific class as a laboratory or invent missing labs", () => {
    const text = answer({ intent: "lookup", day: "weekday", weekday: 4, labsOnly: true }).text;
    expect(text).toContain("ماكو مختبرات مطابقة ضمن الجدول الرسمي.");
    expect(text).not.toMatch(/📖|🕒|م1|م2|م3/);
  });
});

describe("clock-aware answers intersected with the exact official timetable", () => {
  it("answers an ordinary course timing question using the nearest future Baghdad date", () => {
    const selection = classifyLocal("شوكت محاضرة الموبايل مجموعة A")!;
    expect(selection.intent).toBe("next");
    const before = renderQuery(selection, new Date("2026-10-18T05:00:00Z")).text;
    expect(before).toContain("الأحد 2026-10-18");
    expect(before).toContain("09:30–10:30");
    expect(before).toContain("برمجة تطبيقات الموبايل | مجموعة A | م1");
    expect(before).toContain("د. احمد صبحي + مبرمج خبيب باسم");
    expect(before.match(/📖/g)).toHaveLength(1);
    const after = renderQuery(selection, new Date("2026-10-18T07:00:00Z")).text;
    // The shared Tuesday theoretical lecture is the next mobile class for A.
    expect(after).toContain("الثلاثاء 2026-10-20");
    expect(after).toContain("برمجة تطبيقات الموبايل (نظري)");
    expect(after).not.toContain("مجموعة B");
    expect(after).toContain("الأوقات مؤقتة وتقديرية");
  });

  it("keeps doctor questions weekly and timing questions with a date restricted to that date", () => {
    const doctor = renderQuery(classifyLocal("منو دكتور المترجمات مجموعة B")!, new Date("2026-10-18T07:00:00Z")).text;
    expect(doctor).toContain("ضمن الجدول الأسبوعي");
    expect(doctor).toContain("د. عصام طه");
    expect(doctor).toContain("د. عصام + د. رقية اياد");
    expect(doctor).not.toContain("مجموعة A");
    const timing = renderQuery(classifyLocal("وقت محاضرة الموبايل اليوم مجموعة A")!, new Date("2026-10-18T07:00:00Z")).text;
    expect(timing).toContain("2026-10-18");
    expect(timing).toContain("09:30–10:30 | 🟢 هسه مستمرة");
    expect(timing).not.toContain("الثلاثاء");
  });

  it.each([
    "شنو عندي المحاضرة اللي تجي مجموعة B", "منو دكتور المحاضرة اللي تجي مجموعة B",
    "شنو المحاضرة الجاية واسم الدكتور مالتها مجموعة B", "شنو المحاضرة اللي بعدها مجموعة B",
  ])("answers an explicit next lecture and its actual lecturer: %s", text => {
    const selection = classifyLocal(text)!;
    expect(selection.intent).toBe("next");
    const rendered = renderQuery(selection, new Date("2026-10-18T06:45:00Z")).text;
    expect(rendered).toContain("برمجة تطبيقات الموبايل | مجموعة B | م1");
    expect(rendered).toContain("د. احمد صبحي + مبرمج خبيب باسم");
    expect(rendered.match(/📖/g)).toHaveLength(1);
    expect(rendered).not.toMatch(/شبكات|مجموعة A|معمارية/);
  });

  it("searches next lecture only inside the specified next calendar week", () => {
    const text = answer({ day: "next_week", group: "B", labsOnly: true }, "2026-10-16T05:00:00Z").text;
    expect(text).toContain("الأحد 2026-10-18");
    expect(text).toContain("الأسبوع الجاي: 2026-10-18 إلى 2026-10-24");
    expect(text).toContain("شبكات الحاسبة | مجموعة B | م2");
    expect(text.match(/📖/g)).toHaveLength(1);
    expect(text).not.toMatch(/مجموعة A|2026-10-25/);
  });

  it("does not fall through to next week when this week has no remaining lectures", () => {
    const text = answer({ day: "current_week", group: "B" }, "2026-10-16T05:00:00Z").text;
    expect(text).toContain("ما بقت محاضرات جاية مطابقة بهذا الأسبوع");
    expect(text).not.toMatch(/📖|تبدي بعد/);
    const next = answer({ day: "current_week", course: "compilers", group: "B" }, "2026-10-13T05:00:00Z").text;
    expect(next).toContain("الأربعاء 2026-10-14");
    expect(next).not.toContain("الاثنين");
  });

  it("clarifies current/remaining in a dated future week without claiming it is happening now", () => {
    for (const intent of ["current", "remaining"] as const) {
      for (const day of ["current_week", "next_week", "last_week"] as const) {
        expect(answer({ intent, day }).id).toBe("clarify-time-day");
      }
    }
    expect(answer({ intent: "next", day: "last_week" }).id).toBe("clarify-time-week");
  });
  it("before classes returns only the first future slot and a countdown", () => {
    const text = answer({}, "2026-10-18T05:00:00Z").text;
    expect(text).toContain("الأحد 2026-10-18");
    expect(text).toContain("هسه 08:00 بتوقيت بغداد");
    expect(text).toContain("تبدي بعد 30 دقيقة");
    expect(text).toContain("معمارية الحاسبة (نظري)");
    expect(text.match(/📖/g)).toHaveLength(1);
    expect(text).toContain("الأوقات مؤقتة وتقديرية");
  });

  it("during a lecture next excludes the active lecture, while current returns it", () => {
    const next = answer({ group: "B" }).text;
    expect(next).toContain("برمجة تطبيقات الموبايل | مجموعة B | م1");
    expect(next).toContain("تبدي بعد 45 دقيقة");
    expect(next).not.toContain("شبكات");
    const current = answer({ intent: "current", group: "B" }).text;
    expect(current).toContain("شبكات الحاسبة | مجموعة B | م2");
    expect(current).toContain("هسه مستمرة");
    expect(current).toContain("تنتهي بعد 45 دقيقة");
    expect(current).not.toContain("الموبايل");
  });

  it("at exactly a slot boundary ends the old class and starts the new class", () => {
    const text = answer({ intent: "schedule", day: "today", group: "B" }, "2026-10-18T06:30:00Z").text;
    expect(text).toContain("08:30–09:30 | ✅ خلصت");
    expect(text).toContain("09:30–10:30 | 🟢 هسه مستمرة");
    expect(text).toContain("10:30–11:30 | ⏳ بعد ما بدت");
    expect(answer({ group: "B" }, "2026-10-18T06:30:00Z").text).toContain("10:30–11:30");
  });

  it("remaining includes the active slot and future slots but excludes finished slots", () => {
    const text = answer({ intent: "remaining", group: "B" }).text;
    expect(text.match(/📖/g)).toHaveLength(2);
    expect(text).toContain("شبكات الحاسبة");
    expect(text).toContain("برمجة تطبيقات الموبايل");
    expect(text).not.toContain("معمارية");
  });

  it("a group with no scheduled session in the current slot sees none", () => {
    const text = answer({ intent: "current", group: "A" }, "2026-10-13T07:35:00Z").text;
    expect(text).toContain("هسه ماكو محاضرة مطابقة مستمرة");
    expect(text).not.toMatch(/📖|البرمجة المرئية/);
    const next = answer({ group: "A" }, "2026-10-13T07:35:00Z").text;
    expect(next).toContain("الأربعاء 2026-10-14");
    expect(next).toContain("المترجمات (نظري)");
  });

  it("keeps simultaneous A/B alternatives when the user omits group", () => {
    const text = answer({ intent: "current" }).text;
    expect(text.match(/📖/g)).toHaveLength(2);
    expect(text).toContain("مجموعة A");
    expect(text).toContain("مجموعة B");
    expect(text.match(/09:30–10:30/g)).toHaveLength(1);
  });

  it("skips empty weekends when finding the next scheduled lecture", () => {
    const text = answer({}, "2026-10-15T08:30:00Z").text;
    expect(text).toContain("الأحد 2026-10-18");
    expect(text).toContain("تبدي بعد 69 ساعة");
    expect(text).not.toMatch(/عطلة|إلغاء/);
    expect(answer({}, "2026-10-16T05:00:00Z").text).toContain("الأحد 2026-10-18");
  });

  it("can find a filtered lecture at the same weekday next week after it has passed", () => {
    const text = answer({ course: "mobile", group: "A", labsOnly: true }, "2026-10-18T07:00:00Z").text;
    expect(text).toContain("الأحد 2026-10-25");
    expect(text).toContain("09:30–10:30");
    expect(text).not.toContain("مجموعة B");
  });

  it("explicit dates remain restricted, instead of silently showing another day", () => {
    for (const fields of [{ day: "today" }, { day: "weekday", weekday: 0 }] as Partial<NluResult>[]) {
      const text = answer(fields, "2026-10-18T08:30:00Z").text;
      expect(text).toContain("ما بقت محاضرات جاية مطابقة بهذا اليوم");
      expect(text).not.toContain("📖");
    }
    expect(answer({ day: "tomorrow" }, "2026-10-15T08:00:00Z").text).not.toContain("📖");
  });

  it("current and remaining cannot imply future or other weekdays are happening now", () => {
    for (const intent of ["current", "remaining"] as const) {
      expect(answer({ intent, day: "tomorrow" }).id).toBe("clarify-time-day");
      expect(answer({ intent, day: "weekday", weekday: 1 }).id).toBe("clarify-time-day");
      const finished = answer({ intent }, "2026-10-18T08:30:00Z").text;
      expect(finished).not.toContain("📖");
    }
  });

  it("respects precise millisecond boundaries and rounds countdowns up", () => {
    const before = "2026-10-18T05:29:59.999Z";
    expect(answer({ intent: "current" }, before).text).not.toContain("📖");
    expect(answer({}, before).text).toContain("تبدي بعد 1 دقيقة");
    expect(answer({ intent: "current" }, "2026-10-18T05:30:00.000Z").text).toContain("معمارية");
    expect(answer({ intent: "current" }, "2026-10-18T08:30:00.000Z").text).not.toContain("📖");
  });

  it("uses the Baghdad date across midnight and never manufactures matching courses", () => {
    const text = answer({ day: "today" }, "2026-10-17T21:00:00Z").text;
    expect(text).toContain("الأحد 2026-10-18");
    expect(text).toContain("08:30–09:30");
    expect(answer({ course: "mobile", lab: 3 }).text).not.toContain("📖");
  });

  it("asks about a missing course type only when that course is in the requested time window", () => {
    expect(answer({ intent: "current", course: "mobile", kind: "practical" }, "2026-10-18T05:30:00Z").id).not.toBe("clarify-kind");
    for (const intent of ["remaining", "next"] as const) {
      expect(answer({ intent, day: "today", course: "mobile", kind: "practical" }, "2026-10-18T09:00:00Z").id).not.toBe("clarify-kind");
    }
    expect(answer({ intent: "current", course: "mobile", kind: "practical", group: "A" }).id).toBe("clarify-kind");
  });
});
