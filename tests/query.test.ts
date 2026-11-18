import { describe, expect, it } from "vitest";
import { formatTomorrow } from "../src/format";
import { emptyResult, type NluResult } from "../src/nlu-schema";
import { renderQuery } from "../src/query";
import { SCHEDULE, type LectureSlot } from "../src/schedule";

const NOW = new Date("2026-10-13T09:00:00Z");
function query(selection: Partial<NluResult> = {}): NluResult {
  return { ...emptyResult("lookup"), ...selection };
}

describe("deterministic official timetable queries", () => {
  it("preserves the existing default tomorrow response, inline title and date id", () => {
    const result = renderQuery(query({ intent: "schedule", day: "tomorrow" }), NOW);
    expect(result).toEqual({
      text: formatTomorrow(NOW).text,
      title: "📚 جدول محاضرات باچر – الأربعاء",
      id: "tomorrow-2026-10-14",
    });
  });

  it("calculates today and tomorrow at Baghdad midnight rather than UTC midnight", () => {
    const before = new Date("2026-10-12T20:59:59.999Z");
    const after = new Date("2026-10-12T21:00:00.000Z");
    expect(renderQuery(query({ intent: "schedule", day: "today" }), before).text).toContain("جدول الاثنين");
    expect(renderQuery(query({ intent: "schedule", day: "today" }), before).text).toContain("2026-10-12");
    expect(renderQuery(query({ intent: "schedule", day: "today" }), after).text).toContain("جدول الثلاثاء");
    expect(renderQuery(query({ intent: "schedule", day: "today" }), after).text).toContain("2026-10-13");
    expect(renderQuery(query({ day: "tomorrow", course: "compilers" }), after).text).toContain("2026-10-14");
  });

  it("renders a named weekday as its regular schedule without guessing a date", () => {
    const text = renderQuery(query({ intent: "schedule", day: "weekday", weekday: 0 }), NOW).text;
    expect(text).toContain("جدول الأحد");
    expect(text).toContain("مبرمج خبيب باسم");
    expect(text).not.toMatch(/2026-|📅|عطلة|إلغاء/);
  });

  it.each(["A", "B"] as const)("group %s keeps shared lectures and only that group's sessions", group => {
    const text = renderQuery(query({ day: "weekday", weekday: 0, group }), NOW).text;
    expect(text).toContain("معمارية الحاسبة (نظري)");
    expect(text.match(new RegExp(`مجموعة ${group}`, "g"))).toHaveLength(2);
    expect(text).not.toContain(`مجموعة ${group === "A" ? "B" : "A"}`);
    expect(text).toContain("د. مصطفى معد");
  });

  it("combines course, teacher, group, laboratory, slot and kind with AND", () => {
    const text = renderQuery(query({
      day: "weekday", weekday: 3, course: "compilers", teacher: "bilal",
      group: "A", lab: 3, slot: 2, kind: "practical",
    }), NOW).text;
    expect(text).toContain("المحاضرة الثانية");
    expect(text).toContain("المترجمات (عملي) | مجموعة A | م3");
    expect(text).toContain("د. عصام + م.م. بلال فواز");
    expect(text).not.toContain("المحاضرة الأولى");
    expect(text).not.toContain("المحاضرة الثالثة");
    expect(renderQuery(query({ day: "weekday", weekday: 3, teacher: "bilal", group: "B" }), NOW).text)
      .toContain("ماكو محاضرات مطابقة ضمن الجدول الرسمي.");
  });

  it("a lab filter excludes shared lectures without a specified laboratory", () => {
    const text = renderQuery(query({ lab: 2 }), NOW).text;
    expect(text).toContain("ضمن الجدول الأسبوعي");
    expect(text).not.toContain("(نظري)");
    expect(text).not.toContain("م1");
    expect(text).not.toContain("م3");
    expect(text.match(/\| م2/g)).toHaveLength(5);
    expect(text.match(/📖/g)).toHaveLength(5);
  });

  it("teacher families match shortened official names without rewriting them", () => {
    const mustafa = renderQuery(query({ teacher: "mustafa" }), NOW).text;
    expect(mustafa).toContain("د. مصطفى معد");
    expect(mustafa).toContain("د. فؤاد + د. مصطفى");
    expect(mustafa.match(/📖/g)).toHaveLength(4);
    const hiba = renderQuery(query({ teacher: "hiba" }), NOW).text;
    expect(hiba).toContain("د. سعد + مبرمج هبة");
    expect(hiba).toContain("د. سعد + مبرمجة هبة");
    expect(hiba.match(/📖/g)).toHaveLength(2);
    const khubaib = renderQuery(query({ teacher: "khubaib" }), NOW).text;
    expect(khubaib.match(/مبرمج خبيب باسم/g)).toHaveLength(2);
  });

  it("matches the approved academic prefixes while preserving their exact display", () => {
    const sura = renderQuery(query({ teacher: "sura" }), NOW).text;
    expect(sura.match(/📖/g)).toHaveLength(2);
    expect(sura.match(/د\. شموس \+ م\.م\. سرى/g)).toHaveLength(2);
    expect(sura).not.toContain("د. سرى");
    const bilal = renderQuery(query({ teacher: "bilal" }), NOW).text;
    expect(bilal.match(/📖/g)).toHaveLength(1);
    expect(bilal).toContain("د. عصام + م.م. بلال فواز");
    expect(bilal).not.toContain("د. بلال فواز");
  });

  it("matches the shortened official graphics name through the allowlisted course aliases", () => {
    const graphics = renderQuery(query({ course: "graphics" }), NOW).text;
    expect(graphics.match(/📖/g)).toHaveLength(3);
    expect(graphics.match(/📖 رسومات \(عملي\)/g)).toHaveLength(2);
    expect(graphics).toContain("رسومات الحاسبة (نظري)");
    expect(graphics).not.toContain("رسومات الحاسبة (عملي)");
    expect(renderQuery(query({ course: "graphics", kind: "practical", group: "A" }), NOW).text.match(/📖/g)).toHaveLength(1);
  });

  it("never infers a practical course label from the approved laboratory or group", () => {
    const mobile = renderQuery(query({ course: "mobile", group: "A", lab: 1 }), NOW).text;
    expect(mobile).toContain("برمجة تطبيقات الموبايل | مجموعة A | م1");
    expect(mobile).not.toContain("(عملي)");
    for (const course of ["mobile", "networks", "visual"] as const) {
      expect(renderQuery(query({ course, kind: "practical" }), NOW)).toEqual({
        id: "clarify-kind", title: "وضّح نوع المحاضرة",
        text: "نوع هذي المحاضرات مو مذكور بالجدول. اكتب اسم المادة أو المختبر بدون تحديد نظري/عملي.",
      });
    }
    const explicitPractical = renderQuery(query({ kind: "practical" }), NOW).text;
    expect(explicitPractical.match(/📖/g)).toHaveLength(4);
    expect(explicitPractical).not.toMatch(/برمجة تطبيقات الموبايل|شبكات الحاسبة|البرمجة المرئية/);
  });

  it("clarifies an omitted type only when the remaining exact filters match unqualified rows", () => {
    expect(renderQuery(query({ day: "weekday", weekday: 0, course: "mobile", lab: 1, group: "A", kind: "theory" }), NOW).id)
      .toBe("clarify-kind");
    // No row matches this laboratory even when kind is removed.
    expect(renderQuery(query({ day: "weekday", weekday: 0, course: "mobile", lab: 3, kind: "practical" }), NOW).text)
      .toContain("ماكو محاضرات مطابقة ضمن الجدول الرسمي.");
    // Tuesday's mobile lecture is explicitly theoretical, rather than unqualified.
    expect(renderQuery(query({ day: "weekday", weekday: 2, course: "mobile", kind: "practical" }), NOW).text)
      .toContain("ماكو محاضرات مطابقة ضمن الجدول الرسمي.");
    expect(renderQuery(query({ day: "weekday", weekday: 1, course: "compilers", kind: "theory" }), NOW).id)
      .toBe("clarify-kind");
    // The weekly query still returns Wednesday's explicitly theoretical compilers lecture.
    expect(renderQuery(query({ course: "compilers", kind: "theory" }), NOW).text).toContain("المترجمات (نظري)");
  });

  it("does not invent a theory label for the unqualified Monday compilers lecture", () => {
    const all = renderQuery(query({ course: "compilers" }), NOW).text;
    expect(all.match(/📖/g)).toHaveLength(4);
    const theory = renderQuery(query({ course: "compilers", kind: "theory" }), NOW).text;
    expect(theory.match(/📖/g)).toHaveLength(1);
    expect(theory).toContain("الأربعاء");
    expect(theory).not.toContain("الاثنين");
    expect(renderQuery(query({ kind: "exercises" }), NOW).text).toContain("معمارية الحاسبة (تمارين)");
  });

  it("reports no matches without inventing cancellations, holidays or alternate lectures", () => {
    const result = renderQuery(query({ course: "mobile", lab: 3 }), NOW);
    expect(result.text).toContain("ماكو محاضرات مطابقة ضمن الجدول الرسمي.");
    expect(result.text).not.toMatch(/📖|عطلة|إلغاء|الساعة/);
    const weekend = renderQuery(query({ intent: "schedule", day: "weekday", weekday: 5 }), NOW);
    expect(weekend.text).toContain("ماكو محاضرات مطابقة ضمن الجدول الرسمي.");
  });

  it("renders the entire official week completely, safely and below Telegram limits", () => {
    const result = renderQuery(query({ intent: "schedule", day: "week" }), NOW);
    const timetable: readonly (readonly LectureSlot[])[] = SCHEDULE;
    const sessions = timetable.flatMap(day => day.flatMap(slot => slot.sessions));
    expect(result.text.match(/📖/g)).toHaveLength(sessions.length);
    for (const session of sessions) {
      expect(result.text).toContain(session.course);
      expect(result.text).toContain(session.teacher);
    }
    expect(result.text).toContain("الجمعة");
    expect(result.text).toContain("السبت");
    expect(result.text.length).toBeLessThanOrEqual(4096);
    expect(result.id.length).toBeLessThanOrEqual(64);
    expect(result.text.replace(/<\/?b>/g, "")).not.toMatch(/[<>]/);
    expect(result.text).toContain("الأوقات مؤقتة وتقديرية بتوقيت بغداد");
    expect(result.text.match(/08:30–09:30/g)).toHaveLength(5);
    expect(result.text.match(/10:30–11:30/g)).toHaveLength(5);
    expect(result.text).not.toMatch(/2026-|undefined/);
  });

  it("uses the exact out-of-scope response and asks clarification without assuming a day", () => {
    expect(renderQuery(query({ intent: "out_of_scope" }), NOW).text)
      .toBe("حبيبي آني دعبول، مختص بجدول محاضرات المرحلة الثالثة 😂❤️");
    expect(renderQuery(query({ intent: "clarify" }), NOW).text).toContain("حدّد اليوم أو المادة");
    const unspecified = renderQuery(query({ intent: "schedule" }), NOW);
    expect(unspecified.text).toContain("تريد جدول أي يوم؟");
    expect(unspecified.text).not.toContain("📖");
    expect(renderQuery(query({ day: "weekday", weekday: 7 }), NOW).id).toBe("clarify-day");
  });

  it("does not echo unvalidated content as markup or timetable facts", () => {
    const malicious = query({ course: "<script>" as NluResult["course"] });
    const result = renderQuery(malicious, NOW);
    expect(result.text).not.toContain("<script>");
    expect(result.text).toContain("ماكو محاضرات مطابقة ضمن الجدول الرسمي.");
  });

  it("returns only group B laboratories dated inside the next Sunday–Saturday week", () => {
    const friday = new Date("2026-10-16T09:00:00Z");
    const result = renderQuery(query({ day: "next_week", group: "B", labsOnly: true }), friday);
    expect(result.text).toContain("مختبرات الأسبوع الجاي | مجموعة B");
    expect(result.text).toContain("2026-10-18 إلى 2026-10-24");
    expect(result.text).toContain("الأحد 2026-10-18");
    expect(result.text).toContain("الاثنين 2026-10-19");
    expect(result.text).toContain("الثلاثاء 2026-10-20");
    expect(result.text).toContain("الأربعاء 2026-10-21");
    expect(result.text.match(/📖/g)).toHaveLength(5);
    expect(result.text).not.toMatch(/مجموعة A|معمارية|\(نظري\)|تمارين|2026-10-1[0-7]|2026-10-25/);
    expect(result.text).toContain("المترجمات (عملي) | مجموعة B | م2");
    expect(result.text.length).toBeLessThanOrEqual(4096);
    expect(result.id).not.toBe(renderQuery(query({ day: "next_week", group: "B", labsOnly: true }), new Date("2026-10-18T00:00:00Z")).id);
  });

  it("preserves all intersected filters for a dated week without exposing unrelated lectures", () => {
    const result = renderQuery(query({
      day: "next_week", course: "compilers", teacher: "ruqayya", group: "B", labsOnly: true, lab: 2, slot: 3, kind: "practical",
    }), NOW);
    expect(result.text.match(/📖/g)).toHaveLength(1);
    expect(result.text).toContain("الأربعاء 2026-10-21");
    expect(result.text).toContain("د. عصام + د. رقية اياد");
    expect(result.text).not.toMatch(/المحاضرة الأولى|المحاضرة الثانية|مجموعة A|م1|م3|الأحد 2026/);
  });

  it.each([
    ["current_week", "2026-10-11 إلى 2026-10-17", "الأحد 2026-10-11"],
    ["last_week", "2026-10-04 إلى 2026-10-10", "الأحد 2026-10-04"],
  ] as const)("renders %s as the exact Baghdad calendar week", (day, range, sunday) => {
    const result = renderQuery(query({ day, labsOnly: true, group: "A" }), new Date("2026-10-16T09:00:00Z"));
    expect(result.text).toContain(range);
    expect(result.text).toContain(sunday);
    expect(result.text.match(/📖/g)).toHaveLength(5);
    expect(result.text).not.toContain("مجموعة B");
  });

  it("advances next week at Sunday midnight in Baghdad and keeps a full dated week within message bounds", () => {
    const selection = query({ intent: "schedule", day: "next_week" });
    const before = renderQuery(selection, new Date("2026-10-17T20:59:59.999Z"));
    const after = renderQuery(selection, new Date("2026-10-17T21:00:00.000Z"));
    expect(before.text).toContain("2026-10-18 إلى 2026-10-24");
    expect(after.text).toContain("2026-10-25 إلى 2026-10-31");
    expect(after.text.match(/📖/g)).toHaveLength(19);
    expect(after.text).toContain("الجمعة 2026-10-30");
    expect(after.text).toContain("السبت 2026-10-31");
    expect(after.text.length).toBeLessThanOrEqual(4096);
  });
});
