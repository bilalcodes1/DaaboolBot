import { describe, expect, it } from "vitest";
import { getTomorrow } from "../src/calendar";
import { escapeHtml, formatTomorrow } from "../src/format";
import { SCHEDULE, WEEKDAYS } from "../src/schedule";

describe("Baghdad's next calendar day", () => {
  it.each([
    ["2026-10-11T09:00:00Z", 1, "2026-10-12", "الاثنين"],
    ["2026-10-12T09:00:00Z", 2, "2026-10-13", "الثلاثاء"],
    ["2026-10-13T09:00:00Z", 3, "2026-10-14", "الأربعاء"],
    ["2026-10-14T09:00:00Z", 4, "2026-10-15", "الخميس"],
    ["2026-10-15T09:00:00Z", 5, "2026-10-16", "الجمعة"],
    ["2026-10-16T09:00:00Z", 6, "2026-10-17", "السبت"],
    ["2026-10-17T09:00:00Z", 0, "2026-10-18", "الأحد"],
  ])("%s resolves to %s / %s / %s", (instant, weekday, date, dayName) => {
    expect(getTomorrow(new Date(instant))).toEqual({ weekday, date });
    expect(formatTomorrow(new Date(instant))).toMatchObject({ date, dayName });
  });

  it("changes tomorrow at midnight in Baghdad, three hours before UTC midnight", () => {
    expect(getTomorrow(new Date("2026-10-12T20:59:59.999Z"))).toEqual({
      weekday: 2,
      date: "2026-10-13",
    });
    expect(getTomorrow(new Date("2026-10-12T21:00:00.000Z"))).toEqual({
      weekday: 3,
      date: "2026-10-14",
    });
  });

  it.each([
    ["2026-10-31T09:00:00Z", "2026-11-01", 0],
    ["2026-12-31T09:00:00Z", "2027-01-01", 5],
    ["2026-12-30T21:00:00Z", "2027-01-01", 5],
    ["2028-02-28T09:00:00Z", "2028-02-29", 2],
    ["2028-02-29T09:00:00Z", "2028-03-01", 3],
    ["2027-02-28T09:00:00Z", "2027-03-01", 1],
  ])("handles calendar rollover from %s", (instant, date, weekday) => {
    expect(getTomorrow(new Date(instant))).toEqual({ weekday, date });
  });

  it("rejects invalid dates instead of returning a misleading timetable", () => {
    expect(() => getTomorrow(new Date("invalid"))).toThrow(RangeError);
  });
});

describe("the exact photo transcription approved on 2026-10-15", () => {
  it("preserves every course, teacher, group, laboratory, and slot", () => {
    const actual = SCHEDULE.map((day) => day.map((slot) => ({
      title: slot.title,
      sessions: slot.sessions.map((session) => {
        const data = session as { course: string; teacher: string; group?: string; laboratory?: string };
        return [data.course, data.teacher, data.group ?? null, data.laboratory ?? null];
      }),
    })));

    expect(actual).toEqual([
      [
        { title: "المحاضرة الأولى", sessions: [["معمارية الحاسبة (نظري)", "د. مصطفى معد", null, null]] },
        { title: "المحاضرة الثانية", sessions: [
          ["برمجة تطبيقات الموبايل", "د. احمد صبحي + مبرمج خبيب باسم", "A", "م1"],
          ["شبكات الحاسبة", "د. فؤاد + د. مصطفى", "B", "م2"],
        ] },
        { title: "المحاضرة الثالثة", sessions: [
          ["برمجة تطبيقات الموبايل", "د. احمد صبحي + مبرمج خبيب باسم", "B", "م1"],
          ["شبكات الحاسبة", "د. فؤاد + د. مصطفى", "A", "م2"],
        ] },
      ],
      [
        { title: "المحاضرة الأولى", sessions: [
          ["البرمجة المرئية", "د. سعد + مبرمج هبة", "A", "م1"],
          ["رسومات (عملي)", "د. شموس + م.م. سرى", "B", "م2"],
        ] },
        { title: "المحاضرة الثانية", sessions: [["البرمجة المرئية (نظري)", "د. سعد عدنان", null, null]] },
        { title: "المحاضرة الثالثة", sessions: [["المترجمات", "د. عصام طه", null, null]] },
      ],
      [
        { title: "المحاضرة الأولى", sessions: [["برمجة تطبيقات الموبايل (نظري)", "د. احمد صبحي", null, null]] },
        { title: "المحاضرة الثانية", sessions: [["شبكات الحاسبة (نظري)", "د. فؤاد سليم", null, null]] },
        { title: "المحاضرة الثالثة", sessions: [["البرمجة المرئية", "د. سعد + مبرمجة هبة", "B", "م1"]] },
      ],
      [
        { title: "المحاضرة الأولى", sessions: [["المترجمات (نظري)", "د. عصام طه", null, null]] },
        { title: "المحاضرة الثانية", sessions: [["المترجمات (عملي)", "د. عصام + م.م. بلال فواز", "A", "م3"]] },
        { title: "المحاضرة الثالثة", sessions: [
          ["رسومات (عملي)", "د. شموس + م.م. سرى", "A", "م2"],
          ["المترجمات (عملي)", "د. عصام + د. رقية اياد", "B", "م2"],
        ] },
      ],
      [
        { title: "المحاضرة الأولى", sessions: [["رسومات الحاسبة (نظري)", "د. شموس", null, null]] },
        { title: "المحاضرة الثانية", sessions: [["شبكات الحاسبة (نظري)", "د. فؤاد سليم", null, null]] },
        { title: "المحاضرة الثالثة", sessions: [["معمارية الحاسبة (تمارين)", "د. مصطفى معد", null, null]] },
      ],
      [],
      [],
    ]);
  });

  it("keeps the approved خبيب باسم spelling and distinct Hiba role labels", () => {
    const sunday = formatTomorrow(new Date("2026-10-17T09:00:00Z")).text;
    const monday = formatTomorrow(new Date("2026-10-11T09:00:00Z")).text;
    const tuesday = formatTomorrow(new Date("2026-10-12T09:00:00Z")).text;
    expect(sunday.match(/مبرمج خبيب باسم/g)).toHaveLength(2);
    expect(monday).toContain("د. سعد + مبرمج هبة");
    expect(tuesday).toContain("د. سعد + مبرمجة هبة");
  });

  it("retains all 19 approved sessions and the previously supplied empty weekend", () => {
    const counts = SCHEDULE.map((day) => day.reduce((total, slot) => total + slot.sessions.length, 0));
    expect(counts).toEqual([5, 4, 3, 4, 3, 0, 0]);
    expect(counts.reduce((total, count) => total + count, 0)).toBe(19);
  });

  it("preserves approved honorifics and lab abbreviations in rendered replies", () => {
    const monday = formatTomorrow(new Date("2026-10-11T09:00:00Z")).text;
    const wednesday = formatTomorrow(new Date("2026-10-13T09:00:00Z")).text;
    expect(monday).toContain("د. شموس + م.م. سرى");
    expect(wednesday).toContain("د. عصام + م.م. بلال فواز");
    expect(wednesday).toContain("د. عصام + د. رقية اياد");
    expect(wednesday).toContain("📍 م3");
    expect(wednesday).toContain("📍 م2");
    expect(wednesday).not.toContain("مختبر");
  });

  it("does not add a practical suffix to courses where the approved photo omits it", () => {
    const sunday = formatTomorrow(new Date("2026-10-17T09:00:00Z")).text;
    const monday = formatTomorrow(new Date("2026-10-11T09:00:00Z")).text;
    const tuesday = formatTomorrow(new Date("2026-10-12T09:00:00Z")).text;
    expect(sunday).not.toContain("(عملي)");
    expect(monday).toContain("📖 البرمجة المرئية\n📍 م1");
    expect(tuesday).toContain("📖 البرمجة المرئية\n👥 مجموعة B\n📍 م1");
    expect(monday).not.toContain("البرمجة المرئية (عملي)");
    expect(tuesday).not.toContain("البرمجة المرئية (عملي)");
  });
});

describe("Telegram HTML output", () => {
  it("keeps simultaneous groups under their one original slot", () => {
    const text = formatTomorrow(new Date("2026-10-17T09:00:00Z")).text;
    expect(text.match(/المحاضرة الثانية/g)).toHaveLength(1);
    expect(text.match(/المحاضرة الثالثة/g)).toHaveLength(1);
    expect(text).toContain("المحاضرة الثانية – محاضرتان متزامنتان");
    const second = text.slice(text.indexOf("2️⃣"), text.indexOf("3️⃣"));
    expect(second).toContain("👥 مجموعة A\n📖 برمجة تطبيقات الموبايل\n📍 م1");
    expect(second).toContain("👥 مجموعة B\n📖 شبكات الحاسبة\n📍 م2");
    const third = text.slice(text.indexOf("3️⃣"));
    expect(third).toContain("👥 مجموعة B\n📖 برمجة تطبيقات الموبايل\n📍 م1");
    expect(third).toContain("👥 مجموعة A\n📖 شبكات الحاسبة\n📍 م2");
  });

  it.each(["2026-10-15T09:00:00Z", "2026-10-16T09:00:00Z"])(
    "reports no scheduled lectures on weekends from %s",
    (instant) => {
      const text = formatTomorrow(new Date(instant)).text;
      expect(text).toContain("باچر ما عدكم محاضرات مجدولة.");
      expect(text).not.toContain("المحاضرة الأولى");
      expect(text).not.toMatch(/عطلة|إلغاء/);
    },
  );

  it("escapes all HTML-sensitive characters using entities Telegram supports", () => {
    expect(escapeHtml('<script a="x">A&B\'s</script>')).toBe(
      "&lt;script a=&quot;x&quot;&gt;A&amp;B&#39;s&lt;/script&gt;",
    );
  });

  it("renders all seven days safely and labels the user-approved temporary times", () => {
    for (let day = 11; day <= 17; day += 1) {
      const { text, dayName, date } = formatTomorrow(new Date(Date.UTC(2026, 9, day, 9)));
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(WEEKDAYS).toContain(dayName);
      expect(text).toContain(`<b>دعبول | جدول ${dayName}</b>`);
      expect(text).toContain(date);
      expect(text).not.toContain("undefined");
      if (text.includes("📖")) {
        expect(text).toContain("الأوقات مؤقتة وتقديرية بتوقيت بغداد");
        expect(text).toContain("08:30–09:30");
        expect(text).toContain("09:30–10:30");
        expect(text).toContain("10:30–11:30");
      } else expect(text).not.toMatch(/\d{1,2}:\d{2}/);
      expect(text.match(/<b>/g)?.length).toBe(text.match(/<\/b>/g)?.length);
      expect(text.replace(/<\/?b>/g, "")).not.toMatch(/[<>]/);
    }
  });
});
