import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyEventAction, emptyEventDraft, EVENT_EXTRACTION_SCHEMA, extractEvent, extractEventQuery, missingEventField, parseEventHints, suggestCourseForTeacher } from "../src/event-extract";
import { COURSE_LABELS, formatEvent } from "../src/event-format";
import type { EventDraft } from "../src/event-types";
import type { NluAiBinding } from "../src/types";

const NOW = new Date("2026-10-15T09:00:00Z"); // Thursday, Baghdad noon.
const complete = (): EventDraft => ({ ...emptyEventDraft(), kind: "quiz", course: "compilers", date: "2026-10-19", audience: "B" });
const noHints = () => ({ kind: null, kindEvidence: null, courseEvidence: null, teacherEvidence: null, dateEvidence: null, timeEvidence: null, slotsEvidence: null, audienceEvidence: null, confidence: 0.99 });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("academic event actions", () => {
  it.each(["دعبول عدنا امتحان الاثنين", "دعبول سجللي كوز مترجمات", "دعبول واجب الموبايل باجر", "اضف ملاحظة عن الواجب"])("recognizes a submission without publishing it: %s", (text) => {
    expect(classifyEventAction(text)).toBe("submit");
  });
  it.each(["شنو عدنا امتحانات باجر", "شوكت الكويز", "عندنا امتحان الاثنين؟", "اكو واجب؟", "اعرض الملاحظات", "متى امتحان الموبايل"])("keeps event questions as lookup: %s", (text) => {
    expect(classifyEventAction(text)).toBe("list");
  });
  it.each([
    "امتحان", "امتحانات", "كوز", "كويز", "واجب", "واجبات", "الامتحان", "دعبول امتحان",
    "ماذا لدينا من الامتحانات", "ما لدينا من الواجبات", "مالدينا امتحانات", "ما هي الكوزات القادمة",
    "ماهي الواجبات", "هل لدينا امتحان للمترجمات", "هللدينا امتحان", "أعطني امتحانات الأسبوع الجاي",
    "شعندنا كوزات", "موعد امتحان المترجمات", "متى الامتحان", "ما الواجب", "المطلوب قراءته للمترجمات",
    "ما المطلوب قراءته للمترجمات", "ماذا ندرس للامتحان",
    "امتحانات وكوزات المترجمات باچر", "الواجبات الأسبوع الجاي",
  ])("treats bare categories and Iraqi/fusha knowledge requests as approved lookups: %s", text => {
    expect(classifyEventAction(text)).toBe("list");
  });
  it.each([
    "دعبول شعدنا امتحانات", "دعبول عندنا كوزات؟", "شنو الامتحانات والكوزات الجاية",
    "شنو لازم اقره للمترجمات", "شنو المطلوب بواجب المترجمات", "شنو عندنا تبليغات",
    "ذكرني بالكوزات", "شنو المطلوب مني", "شنو اقرا باجر", "عندي امتحان؟", "شنو عليّ",
    "شنو لازم نقرأ للامتحان", "شنو عليّ باچر مجموعة B", "اعرض التذكيرات",
    "دزلي ملف امتحان المترجمات الأسبوع الجاي", "جيبلي مرفق كوز الشبكات",
    "صور واجب الموبايل باچر", "عرض ملف المترجمات", "وريني ملفات امتحانات الأسبوع الجاي",
    "أريد ملف امتحان المترجمات الأسبوع الجاي", "نريد امتحانات الأسبوع الجاي",
    "أريد أعرف امتحان المترجمات", "اريد أشوف صور واجب الموبايل",
  ])("routes common Iraqi reminders and reading questions to approved notes: %s", text => {
    expect(classifyEventAction(text)).toBe("list");
  });
  it.each([
    "عدنا امتحان مترجمات الاثنين الجاي للكل", "عندنا كوز مترجمات باجر مجموعة B",
    "اكتب تبليغ عن واجب الموبايل", "دعبول عدنا امتحان وكوز باجر",
    "اريد أسجل امتحان مترجمات الاثنين الجاي", "أريد امتحان مترجمات الاثنين الجاي للكل",
  ])("retains declarative contributions as submissions: %s", text => {
    expect(classifyEventAction(text)).toBe("submit");
  });
  it.each(["دعبول", "شنو عدنا باجر", "اشرحلي الامتحان", "حل واجب المترجمات", "سويلي واجب موبايل", "شلون الجو", "صورة عادية", "ملف عادي"])("does not turn another request into a submission: %s", (text) => {
    expect(classifyEventAction(text)).toBeNull();
  });
});

describe("literal dated event extraction", () => {
  it.each([
    ["كويز مترجمات الاثنين الجاي مجموعة B", "2026-10-19"],
    ["امتحان موبايل الأربعاء القادم مجموعة A", "2026-10-21"],
    ["واجب شبكات الخميس الجاي للكل", "2026-10-22"],
    ["امتحان رسومات الاثنين للكل", "2026-10-19"],
    ["واجب مرئية باچر للكل", "2026-10-16"],
    ["واجب مرئية بعد باجر للكل", "2026-10-17"],
    ["امتحان معماريه اليوم الخميس للكل", "2026-10-15"],
    ["امتحان معماريه 19/10/2026 للكل", "2026-10-19"],
    ["امتحان معماريه ١٩/١٠ للكل", "2026-10-19"],
    ["امتحان معماريه 2026-10-19 للكل", "2026-10-19"],
    ["امتحان مترجمات الخميس الأسبوع الجاي للكل", "2026-10-22"],
    ["واجب مترجمات الأحد الأسبوع الجاي للكل", "2026-10-18"],
    ["كوز مترجمات الخميس هذا الأسبوع للكل", "2026-10-15"],
  ])("resolves only the supported literal date in %s", async (text, date) => {
    expect(await extractEvent(text, NOW)).toMatchObject({ date, dateUnspecified: false });
  });

  it.each(["الخميس", "31/2/2026", "19/10 و20/10", "باجر الاثنين", "الاثنين والاربعاء", "الاسبوع الجاي", "الاثنين الاسبوع بعد الجاي", "1/1"])(
    "requests a date instead of guessing for %s", async (phrase) => {
      const draft = await extractEvent(`امتحان مترجمات ${phrase} للكل`, NOW);
      expect(draft.date).toBeNull();
      expect(draft.dateUnspecified).toBe(false);
      expect(missingEventField(draft)).toBe("date");
    },
  );

  it("uses Baghdad midnight and calendar rollovers without adding a fixed day duration", async () => {
    expect((await extractEvent("واجب مترجمات باجر للكل", new Date("2026-10-14T20:59:59Z"))).date).toBe("2026-10-15");
    expect((await extractEvent("واجب مترجمات باجر للكل", new Date("2026-10-14T21:00:00Z"))).date).toBe("2026-10-16");
    expect((await extractEvent("امتحان مترجمات الاثنين الجاي للكل", new Date("2026-12-31T09:00:00Z"))).date).toBe("2027-01-04");
    expect((await extractEvent("امتحان مترجمات 29/2/2028 للكل", NOW)).date).toBe("2028-02-29");
    expect((await extractEvent("امتحان مترجمات 29/2/2027 للكل", NOW)).date).toBeNull();
  });

  it("allows an explicitly unknown date without fabricating a schedule date", async () => {
    const draft = await extractEvent("كوز مترجمات للكل الموعد غير محدد", NOW);
    expect(draft).toMatchObject({ kind: "quiz", course: "compilers", date: null, dateUnspecified: true, audience: "all" });
    expect(missingEventField(draft)).toBeNull();
  });

  it("does not mistake page/exercise numbers or a lecturer's timetable for an event date", async () => {
    const draft = await extractEvent("كويز دكتورة رقية صفحات 1/2 مجموعة B", NOW);
    expect(draft).toMatchObject({ teacher: "ruqayya", course: null, date: null, slots: [] });
    expect(suggestCourseForTeacher("ruqayya")).toBe("compilers");
    expect(missingEventField(draft)).toBe("course");
  });
});

describe("academic details, selected slots and audience", () => {
  it("preserves exclusions, unfamiliar terms and spelling exactly", async () => {
    const text = "دعبول عدنا كوز مترجمات الاثنين الجاي مجموعة B لحد الليكسل مو داخله";
    const draft = await extractEvent(text, NOW);
    expect(draft.details).toBe(text);
    expect(draft).toMatchObject({ kind: "quiz", course: "compilers", date: "2026-10-19", audience: "B", teacher: null });
    expect(formatEvent(draft, "علي")).toContain("لحد الليكسل مو داخله");
    expect(formatEvent(draft, "علي")).not.toContain("Excel");
  });

  it.each(["المحاضرتين الأولى والثانية", "المحاضرتين 1+2", "المحاضرات ١،٢", "المحاضرة الأولى والمحاضرة الثانية"])(
    "keeps two slots as one event for %s", async (selection) => {
      expect((await extractEvent(`امتحان مترجمات الاثنين الجاي للكل ${selection}`, NOW)).slots).toEqual([1, 2]);
    },
  );
  it("does not turn page numbers, alternatives or unknown lecture numbers into two slots", async () => {
    expect((await extractEvent("واجب مترجمات صفحات 1+2 باجر للكل", NOW)).slots).toEqual([]);
    expect((await extractEvent("امتحان مترجمات المحاضرة الأولى أو الثانية للكل", NOW)).slots).toEqual([]);
    expect((await extractEvent("امتحان مترجمات المحاضرة 4 للكل", NOW)).slots).toEqual([]);
    expect(await extractEvent("امتحان مترجمات المحاضرة اثنين للكل", NOW)).toMatchObject({ slots: [2], date: null });
    expect((await extractEvent("كوز مترجمات مختبر اثنين للكل", NOW)).date).toBeNull();
  });

  it.each([["مجموعة A", "A"], ["مجوعة b", "B"], ["كروب بي", "B"], ["للمجموعتين", "all"], ["مجموعة A وB", "all"], ["A", "A"]])(
    "extracts an explicit audience from %s", async (text, audience) => {
      expect((await extractEvent(text, NOW)).audience).toBe(audience);
    },
  );
  it.each(["مجموعة C", "مجموعة A أو B"])("keeps an invalid/uncertain audience empty for %s", async (text) => {
    expect((await extractEvent(text, NOW)).audience).toBeNull();
  });
  it('keeps bare Latin groups as query filters without inferring a new contribution audience', async () => {
    expect(extractEventQuery('شعدنا امتحانات B', NOW).audience).toBe('B');
    expect(extractEventQuery('شنو كوز compilers A', NOW)).toEqual({ kind: 'quiz', course: 'compilers', date: null, audience: 'A' });
    expect(extractEventQuery('شعدنا اليوم B', NOW)).toEqual({ kind: null, course: null, date: '2026-10-15', audience: 'B' });
    expect(extractEventQuery('امتحانات mobile', NOW)).toEqual({ kind: 'exam', course: 'mobile', date: null, audience: null });
    expect((await extractEvent('امتحان مترجمات باجر B', NOW)).audience).toBeNull();
    expect((await extractEvent('B', NOW)).audience).toBe('B');
    for (const query of ['شعدنا امتحانات C', 'شنو كوز A أو B', 'شنو كوز A or B', 'شنو كوز A أوB', 'شنو كوز AorB']) {
      expect(extractEventQuery(query, NOW).clarification).toBe('حدد مجموعة A أو B أو اكتب «للكل».');
    }
  });

  it.each([["الساعة 14:30", "14:30"], ["08:30", "08:30"], ["الساعة 8 الصبح", "08:00"], ["8:30 مساء", "20:30"]])(
    "keeps only an unambiguous supplied clock time in %s", async (text, time) => {
      expect((await extractEvent(text, NOW)).time).toBe(time);
    },
  );
  it.each(["8:30", "24:00", "14:75", "الوقت مو محدد"])("does not invent a clock time from %s", async (text) => {
    expect((await extractEvent(text, NOW)).time).toBeNull();
  });

  it("patches supplied fields while retaining the source details and attachment", async () => {
    const base = { ...complete(), details: "لحد الليكسل مو داخله", attachment: { kind: "photo" as const, fileId: "not-a-url", fileUniqueId: "unique" } };
    const draft = await extractEvent("20/10/2026", NOW, {}, base);
    expect(draft).toMatchObject({ date: "2026-10-20", details: base.details, attachment: base.attachment, kind: "quiz", audience: "B" });
    expect(base.date).toBe("2026-10-19");
  });

  it("keeps unknown people and conflicting course names out of inferred fields", async () => {
    expect((await extractEvent("امتحان دكتور أحمد خالد باجر للكل", NOW)).teacher).toBeNull();
    expect((await extractEvent("امتحان موبايل وشبكات باجر للكل", NOW)).course).toBeNull();
  });

  it("extracts lookup filters without creating an event", () => {
    expect(extractEventQuery("شنو عدنا كويز مترجمات باجر مجموعة B", NOW)).toEqual({ kind: "quiz", course: "compilers", date: "2026-10-16", audience: "B" });
  });

  it.each([
    "شنو امتحان 31/2/2026؟",
    "شنو امتحان باجر الاثنين؟",
    "شنو امتحانات الأسبوع بعد الجاي؟",
    "شنو امتحان 19 تشرين الأول؟",
    "شنو امتحان أمس؟",
    "شنو امتحان الموعد غير محدد؟",
    "شنو امتحان يوم 19؟",
    "شنو كوز مجموعة C؟",
    "شنو كوز مجموعة A أو B؟",
    "شنو امتحان موبايل وشبكات باچر؟",
    "شنو امتحان مادة الرياضيات؟",
    "شنو امتحان دكتورة رقية باچر؟",
    "شنو الامتحانات مو الواجبات باچر؟",
    "شنو لازم اقرا لمادة الرياضيات؟",
    "شنو لازم اقرا للرياضيات؟",
    "شنو اقرا بالرياضيات؟",
    "شنو المطلوب مني بالرياضيات؟",
    "شنو لازم اقرا باجر للفيزياء؟",
    "شنو المطلوب مني باچر مجموعة C؟",
    "شنو الامتحانات والكوزات باچر الاثنين؟",
    "شنو الامتحانات والكوزات للموبايل والشبكات؟",
    "شنو امتحان الأحد الماضي؟",
    "شنو امتحان المحاضرة الثانية؟",
    "شنو امتحان الساعة 9 صباحاً؟",
    "شنو امتحانات الأسبوع الجاي أو الحالي؟",
    "شنو امتحانات الأسبوع الجاي باچر؟",
    "شنو امتحانات الأسبوع الجاي 17/10/2026؟",
    "شنو امتحانات الأحد الأسبوع الجاي 19/10/2026؟",
    "دزلي ملف مادة الرياضيات الأسبوع الجاي",
    "جيبلي مرفق الفيزياء",
    "جيبلي ملف امتحان الفيزياء الأسبوع الجاي",
    "شنو عدنا امتحانات الرياضيات الأسبوع الجاي",
    "المطلوب قراءته للرياضيات",
    "ما المطلوب قراءته للفيزياء",
    "شعدنا بالرياضيات",
    "شعندنا باجر للفيزياء",
    "ماذا لدينا للرياضيات الأسبوع الجاي",
    "شعدنا الأسبوع الجاي مجموعة C",
    "شعندنا الأسبوع بعد الجاي",
    "شنو امتحان المترجمات والفيزياء",
    "شنو امتحان المترجمات مادة الرياضيات",
    "شعدنا للمترجمات للفيزياء",
  ])("requests clarification instead of dropping an explicit unresolved query filter: %s", text => {
    expect(extractEventQuery(text, NOW).clarification).toEqual(expect.any(String));
  });

  it.each([
    ["اعرض الملاحظات", { kind: null, course: null, date: null, audience: null }],
    ["شنو امتحانات باچر؟", { kind: "exam", course: null, date: "2026-10-16", audience: null }],
    ["شنو كوز مترجمات؟", { kind: "quiz", course: "compilers", date: null, audience: null }],
    ["شنو امتحان للكل؟", { kind: "exam", course: null, date: null, audience: "all" }],
    ["شنو امتحان مترجمات باچر مجموعة B؟", { kind: "exam", course: "compilers", date: "2026-10-16", audience: "B" }],
    ["شنو لازم اقره للمترجمات؟", { kind: null, course: "compilers", date: null, audience: null }],
    ["شنو اقرا باجر؟", { kind: null, course: null, date: "2026-10-16", audience: null }],
    ["شنو المطلوب بواجب المترجمات؟", { kind: "homework", course: "compilers", date: null, audience: null }],
    ["ذكرني بالكوزات مجموعة B", { kind: "quiz", course: null, date: null, audience: "B" }],
    ["شنو الامتحانات والكوزات الجاية؟", { kind: null, kinds: ["exam", "quiz"], course: null, date: null, audience: null }],
    ["شنو امتحانات وكوزات وواجبات المترجمات باچر للكل؟", { kind: null, kinds: ["exam", "quiz", "homework"], course: "compilers", date: "2026-10-16", audience: "all" }],
    ["اعرض الامتحانات واختبار قصير باچر", { kind: null, kinds: ["exam", "quiz"], course: null, date: "2026-10-16", audience: null }],
    ["شنو المطلوب مني؟", { kind: null, course: null, date: null, audience: null }],
    ["شنو عندنا تبليغات؟", { kind: null, course: null, date: null, audience: null }],
    ["شنو عليّ؟", { kind: null, course: null, date: null, audience: null }],
    ["شنو لازم اقرا؟", { kind: null, course: null, date: null, audience: null }],
    ["شنو لازم اقرا للامتحان؟", { kind: "exam", course: null, date: null, audience: null }],
    ["شنو اقرا لباچر؟", { kind: null, course: null, date: "2026-10-16", audience: null }],
    ["شنو المطلوب مني بمجموعة B؟", { kind: null, course: null, date: null, audience: "B" }],
    ["شنو لازم اقرا للكل؟", { kind: null, course: null, date: null, audience: "all" }],
    ["شنو امتحان أو واجب باچر؟", { kind: null, kinds: ["exam", "homework"], course: null, date: "2026-10-16", audience: null }],
    ["شنو الامتحانات لو الكوزات باچر؟", { kind: null, kinds: ["exam", "quiz"], course: null, date: "2026-10-16", audience: null }],
    ["شعدنا امتحانات او كوزات؟", { kind: null, kinds: ["exam", "quiz"], course: null, date: null, audience: null }],
    ["شعدنا امتحانات أوكوزات؟", { kind: null, kinds: ["exam", "quiz"], course: null, date: null, audience: null }],
    ["اعرض امتحان أو واجب", { kind: null, kinds: ["exam", "homework"], course: null, date: null, audience: null }],
    ["امتحان", { kind: "exam", course: null, date: null, audience: null }],
    ["شنو امتحان 19/10/2026", { kind: "exam", course: null, date: "2026-10-19", audience: null }],
    ["شنو واجبات 19/10/2026 كروب بي", { kind: "homework", course: null, date: "2026-10-19", audience: "B" }],
    ["شنو اختبار قصير", { kind: "quiz", course: null, date: null, audience: null }],
    ["شنو اختبار قصير 19/10/2026 كروب بي", { kind: "quiz", course: null, date: "2026-10-19", audience: "B" }],
    ["ما الواجب للمترجمات باچر", { kind: "homework", course: "compilers", date: "2026-10-16", audience: null }],
    ["أعطني امتحانات وكوزات المترجمات باچر مجموعة B", { kind: null, kinds: ["exam", "quiz"], course: "compilers", date: "2026-10-16", audience: "B" }],
    ["المطلوب قراءته للمترجمات", { kind: null, course: "compilers", date: null, audience: null }],
    ["شعدنا؟", { kind: null, course: null, date: null, audience: null }],
    ["شعندنا باجر للمترجمات مجموعة B", { kind: null, course: "compilers", date: "2026-10-16", audience: "B" }],
    ["ماذا لدينا للكل", { kind: null, course: null, date: null, audience: "all" }],
  ])("keeps legitimate broad and supported approved-event queries usable: %s", (text, filters) => {
    expect(extractEventQuery(text, NOW)).toEqual(filters);
  });
  it("keeps an uncertain multi-kind submission incomplete while allowing that union in a lookup", async () => {
    const text = "عدنا امتحان لو واجب مترجمات باچر للكل";
    expect(classifyEventAction(text)).toBe("submit");
    expect(await extractEvent(text, NOW)).toMatchObject({ kind: null, course: "compilers", date: "2026-10-16", audience: "all" });
    expect(missingEventField(await extractEvent(text, NOW))).toBe("kind");
  });

  it.each([
    ["شنو عدنا امتحانات الأسبوع الجاي؟", "2026-10-18", "2026-10-24", "next_week"],
    ["شنو الامتحانات والكوزات هالأسبوع؟", "2026-10-15", "2026-10-17", "current_week"],
    ["شنو واجبات الأسبوع الماضي؟", "2026-10-04", "2026-10-10", "last_week"],
  ])("extracts an inclusive calendar week instead of a broad upcoming lookup: %s", (text, fromDate, toDate, label) => {
    const query = extractEventQuery(text, NOW);
    expect(query).toMatchObject({ date: null, dateRange: { fromDate, toDate, label } });
    expect(query.clarification).toBeUndefined();
  });

  it("combines week boundaries with types, subject and group without losing attachment lookup intent", () => {
    const text = "دزلي ملفات امتحانات وكوزات المترجمات الأسبوع الجاي مجموعة B";
    expect(classifyEventAction(text)).toBe("list");
    expect(extractEventQuery(text, NOW)).toEqual({
      kind: null, kinds: ["exam", "quiz"], course: "compilers", date: null, audience: "B",
      dateRange: { fromDate: "2026-10-18", toDate: "2026-10-24", label: "next_week" },
    });
    expect(extractEventQuery("صور واجب الموبايل باچر", NOW)).toEqual({ kind: "homework", course: "mobile", date: "2026-10-16", audience: null });
    expect(extractEventQuery("عرض ملف المترجمات", NOW)).toEqual({ kind: null, course: "compilers", date: null, audience: null });
  });

  it("grounds a specific day inside its requested calendar week and checks explicit date agreement", () => {
    expect(extractEventQuery("شنو امتحانات الأحد الأسبوع الجاي؟", NOW)).toEqual({ kind: "exam", course: null, date: "2026-10-18", audience: null });
    expect(extractEventQuery("شنو امتحانات الخميس هذا الأسبوع؟", NOW)).toEqual({ kind: "exam", course: null, date: "2026-10-15", audience: null });
    expect(extractEventQuery("شنو امتحان الاثنين الأسبوع الجاي 19/10/2026؟", NOW)).toEqual({ kind: "exam", course: null, date: "2026-10-19", audience: null });
    expect(extractEventQuery("شنو امتحانات الأسبوع الجاي؟", new Date("2026-10-17T21:00:00Z"))).toMatchObject({ dateRange: { fromDate: "2026-10-25", toDate: "2026-10-31" } });
  });
  it('treats this week as upcoming by default but retains explicit dates and requested history', () => {
    const saturday = new Date('2026-10-24T09:00:00Z');
    expect(extractEventQuery('شعدنا هذا الاسبوع امتحانات؟ @daaboolbot', saturday)).toMatchObject({
      date: null, dateRange: { fromDate: '2026-10-24', toDate: '2026-10-24', label: 'current_week' },
    });
    expect(extractEventQuery('شنو امتحانات الأحد هذا الأسبوع؟', saturday)).toMatchObject({ date: '2026-10-18' });
    expect(extractEventQuery('شعدنا هذا الأسبوع امتحانات حتى اللي صارت؟', saturday)).toMatchObject({
      dateRange: { fromDate: '2026-10-18', toDate: '2026-10-24', label: 'current_week' },
    });
    expect(extractEventQuery('شعدنا هذا الأسبوع امتحانات حتى اللي صارت؟', saturday).clarification).toBeUndefined();
    expect(extractEventQuery('شنو امتحان 19/10/2026؟', saturday)).toMatchObject({ date: '2026-10-19' });
    expect(extractEventQuery('شنو امتحانات الأسبوع الماضي؟', saturday)).toMatchObject({ dateRange: { fromDate: '2026-10-11', toDate: '2026-10-17' } });
    expect(extractEventQuery('شنو امتحانات الأسبوع الجاي؟', saturday)).toMatchObject({ dateRange: { fromDate: '2026-10-25', toDate: '2026-10-31' } });
  });
});

describe("bounded, grounded event AI hints", () => {
  it("requires exact input evidence, a complete allowlisted schema and adequate confidence", () => {
    const text = "تقييم مفاجئ للمترجمات";
    const hints = { ...noHints(), kind: "quiz", kindEvidence: "تقييم مفاجئ", courseEvidence: "للمترجمات" };
    expect(parseEventHints({ response: JSON.stringify(hints) }, text)).toEqual(hints);
    expect(parseEventHints({ response: { ...hints, answer: "invented lecture" } }, text)).toBeNull();
    expect(parseEventHints({ response: { ...hints, dateEvidence: "الاثنين" } }, text)).toBeNull();
    expect(parseEventHints({ response: { ...hints, kind: "holiday" } }, text)).toBeNull();
    expect(parseEventHints({ response: { ...hints, confidence: 0.89 } }, text)).toBeNull();
    expect(parseEventHints({ response: { ...hints, confidence: Number.NaN } }, text)).toBeNull();
    expect(parseEventHints({ response: { ...hints, kindEvidence: "جو جميل" } }, text)).toBeNull();
    expect(parseEventHints({ response: Object.create(hints) }, text)).toBeNull();
    expect(parseEventHints({ response: Object.defineProperty({ ...hints }, "kind", { get: () => { throw new Error("unsafe"); } }) }, text)).toBeNull();
  });

  it("classifies unfamiliar academic phrasing through text-only grounded hints", async () => {
    const text = "تقييم مفاجئ للمترجمات باجر مجموعة B لحد الليكسل مو داخله";
    const run = vi.fn<NluAiBinding["run"]>().mockResolvedValue({ response: { ...noHints(), kind: "quiz", kindEvidence: "تقييم مفاجئ" } });
    const draft = await extractEvent(text, NOW, { AI: { run }, AI_FREE_TIER_CONFIRMED: "true" });
    expect(draft).toMatchObject({ kind: "quiz", course: "compilers", date: "2026-10-16", audience: "B", details: text });
    expect(run).toHaveBeenCalledTimes(1);
    const [model, input, options] = run.mock.calls[0]!;
    expect(model).toBe("@cf/ibm-granite/granite-4.0-h-micro");
    expect(input).toMatchObject({ temperature: 0, stream: false, max_tokens: 384, response_format: { type: "json_schema", json_schema: EVENT_EXTRACTION_SCHEMA } });
    expect((input.messages as { role: string; content: string }[])[1]).toEqual({ role: "user", content: JSON.stringify({ text }) });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not call AI for complete local events or without the confirmed free-plan gate", async () => {
    const run = vi.fn<NluAiBinding["run"]>();
    await extractEvent("كويز مترجمات باجر مجموعة B", NOW, { AI: { run }, AI_FREE_TIER_CONFIRMED: "true" });
    await extractEvent("تقييم مفاجئ", NOW, { AI: { run } });
    await extractEvent("تقييم مفاجئ", NOW, { AI: { run }, AI_FREE_TIER_CONFIRMED: "false" });
    expect(run).not.toHaveBeenCalled();
  });

  it("does not let AI choose a conflicting course or an ambiguous same-day weekday", async () => {
    const text = "امتحان موبايل وشبكات الخميس مجموعة B";
    const run = vi.fn<NluAiBinding["run"]>().mockResolvedValue({ response: { ...noHints(), courseEvidence: "موبايل", dateEvidence: "الخميس" } });
    const draft = await extractEvent(text, NOW, { AI: { run }, AI_FREE_TIER_CONFIRMED: "true" });
    expect(draft).toMatchObject({ course: null, date: null, dateUnspecified: false });
  });

  it("keeps the draft intact on malformed output, inference failure and bounded timeout", async () => {
    const text = "تقييم مفاجئ";
    const run = vi.fn<NluAiBinding["run"]>().mockRejectedValue(new Error("private-marker"));
    expect((await extractEvent(text, NOW, { AI: { run }, AI_FREE_TIER_CONFIRMED: "true" })).details).toBe(text);
    run.mockResolvedValue({ response: "not JSON" });
    expect((await extractEvent(text, NOW, { AI: { run }, AI_FREE_TIER_CONFIRMED: "true" })).kind).toBeNull();
    vi.useFakeTimers();
    run.mockImplementation(() => new Promise(() => {}));
    const pending = extractEvent(text, NOW, { AI: { run }, AI_FREE_TIER_CONFIRMED: "true" });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).kind).toBeNull();
  });
});

describe("safe event HTML", () => {
  it("shows explicit data, original exclusions, pending state and attachment metadata", () => {
    const draft = { ...complete(), slots: [1, 2] as (1 | 2 | 3)[], details: "لحد الليكسل مو داخله <b>نص</b>", attachment: { kind: "document" as const, fileId: "never-display-this", fileName: "واجب<&>.pdf" } };
    const output = formatEvent(draft, "علي <script>", "pending");
    expect(output).toContain("بانتظار موافقة الأدمن");
    expect(output).toContain(COURSE_LABELS.compilers);
    expect(output).toContain("2026-10-19");
    expect(output).toContain("الأولى + الثانية");
    expect(output).toContain("لحد الليكسل مو داخله &lt;b&gt;نص&lt;/b&gt;");
    expect(output).toContain("علي &lt;script&gt;");
    expect(output).toContain("واجب&lt;&amp;&gt;.pdf");
    expect(output).not.toContain("never-display-this");
    expect(output).not.toMatch(/08:|09:|10:/);
  });
  it("states unknown dates honestly and bounds long escaped data without broken entities", () => {
    const draft = { ...complete(), date: null, dateUnspecified: true, details: "<&>😀".repeat(3000) };
    const text = formatEvent(draft, "طالب", "approved");
    expect(text).toContain("الموعد بعده غير محدد");
    expect(text).toContain("التفاصيل طويلة");
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.replace(/<\/?b>/g, "")).not.toMatch(/[<>]/);
    expect(text).not.toMatch(/&(?:lt|gt|amp)?$/);
    expect(draft.details.length).toBeGreaterThan(4096);
  });
});

describe('short numeric dates in the October screenshots',()=>{
 const now=new Date('2026-10-28T14:22:00Z');
 it.each([
  ['11/5','2026-11-05'],['5/11','2026-11-05'],['الثلاثاء 11/3','2026-11-03'],
  ['الثلاثاء 3/11','2026-11-03'],['الثلاثاء ١١/٣','2026-11-03'],
 ])('uses a future interpretation consistent with the weekday: %s',(phrase,date)=>{
  expect(extractEventQuery('امتحان شبكات '+phrase,now)).toMatchObject({date});
 });
 it.each(['الثلاثاء 11/3/2026','الأربعاء 3/11','1/1','31/2','5/11 و6/11'])('keeps conflicting or unresolved dates blocked: %s',phrase=>{
  const parsed=extractEventQuery('امتحان شبكات '+phrase,now);expect(parsed.date).toBeNull();expect(parsed.clarification).toBeTruthy();
 });
 it('prefers day/month when both interpretations are future, unless the weekday resolves it',()=>{
  const january=new Date('2026-01-01T09:00:00Z');
  expect(extractEventQuery('امتحان شبكات 5/11',january).date).toBe('2026-11-05');
  expect(extractEventQuery('امتحان شبكات الاثنين 5/11',january).date).toBe('2026-05-11');
 });
});

describe('all records versus an explicitly shared student audience',()=>{
 it.each(['اعرض كل الامتحانات والكوزات','اعرض لي كل الامتحانات و الكوزات','كل الواجبات','جميع التبليغات'])('does not turn a record quantifier into A+B: %s',text=>{
  expect(extractEventQuery(text,NOW).audience).toBeNull();
 });
 it('keeps an explicit group filter alongside all records',()=>{
  expect(extractEventQuery('اعرض كل الامتحانات مجموعة B',NOW).audience).toBe('B');
  expect(extractEventQuery('اعرض كل الامتحانات للكل',NOW).audience).toBe('all');
 });
});
