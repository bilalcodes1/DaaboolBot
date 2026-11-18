import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyLocal } from "../src/nlu-local";
import { emptyResult, type NluResult } from "../src/nlu-schema";
import { MIN_CONFIDENCE, NLU_MODEL, NLU_SCHEMA, NluClassifier, parseAiClassification } from "../src/nlu";
import { renderQuery } from "../src/query";
import type { NluAiBinding } from "../src/types";

const AMBIGUOUS = "شو عدينا بكرة؟";
const VALID: NluResult = { ...emptyResult("schedule"), day: "tomorrow", confidence: 0.99 };
const ENVELOPE = { response: JSON.stringify(VALID) };

function aiBinding(response: unknown = ENVELOPE) {
  const run = vi.fn<NluAiBinding["run"]>().mockResolvedValue(response);
  return { run, env: { AI: { run }, AI_FREE_TIER_CONFIRMED: "true" } };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded Workers AI classification", () => {
  it.each([
    "شنو عدنا باچر؟", "جدول اليوم", "وين عملي الموبايل لمجموعة A؟",
    "شوكت محاضرة خبيب باسم؟", "اشرح شبكات", "محاضرات قواعد بيانات", "اليوم وباجر",
    "شنو عدنا مختبرات يوم الاحد مجوعة b", "شنو المحاضرة الجاية", "شنو عدنا هسه", "شنو بقه اليوم",
    "شنو المختبرات اللي عدنا مجموعة B الأسبوع الجاي", "منو الدكتور مال المحاضرة اللي تجي مجموعة B",
  ])("keeps clear/local questions away from AI: %s", async text => {
    const { run, env } = aiBinding();
    const expected = classifyLocal(text);
    expect(expected).not.toBeNull();
    expect(await new NluClassifier().classify(text, env)).toEqual(expected);
    expect(run).not.toHaveBeenCalled();
  });

  it("passes only the current question, bounded generation and the exact schema to the selected model", async () => {
    const { run, env } = aiBinding();
    expect(classifyLocal(AMBIGUOUS)).toBeNull();
    expect(await new NluClassifier().classify(AMBIGUOUS, env)).toEqual(VALID);
    expect(run).toHaveBeenCalledTimes(1);
    const [model, inputs, options] = run.mock.calls[0]!;
    expect(model).toBe(NLU_MODEL);
    expect(model).toBe("@cf/ibm-granite/granite-4.0-h-micro");
    expect(inputs).toMatchObject({
      stream: false, temperature: 0, max_tokens: 192,
      response_format: { type: "json_schema", json_schema: NLU_SCHEMA },
    });
    const messages = inputs.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: JSON.stringify({ text: AMBIGUOUS }) });
    expect(messages[0]!.content).not.toContain(AMBIGUOUS);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(NLU_SCHEMA.additionalProperties).toBe(false);
    expect(NLU_SCHEMA.required).toHaveLength(11);
    expect(NLU_SCHEMA.required).toContain("labsOnly");
    expect(NLU_SCHEMA.properties.labsOnly.type).toBe("boolean");
    for (const branch of NLU_SCHEMA.anyOf) {
      expect(branch.required).toHaveLength(11);
      expect(branch.required).toContain("labsOnly");
      expect(branch.additionalProperties).toBe(false);
    }
    expect(messages[0]!.content).toContain("Return all eleven fields, JSON only");
    expect(messages[0]!.content).toContain("Never include names, times, lecture data or a student-facing answer");
    expect(messages[0]!.content).toContain('"intent":"next","day":"unspecified"');
    expect(messages[0]!.content).toContain('"intent":"current","day":"unspecified"');
  });

  it.each([
    { response: "not JSON <b>raw model answer</b>" },
    { response: "```json\n{}\n```" },
    { response: { ...VALID, answer: "synthetic-private-marker" } },
    { response: { ...VALID, course: "invented-course" } },
    { response: { ...VALID, teacher: "invented-teacher" } },
    { response: { ...VALID, confidence: MIN_CONFIDENCE - 0.01 } },
    { response: { ...VALID, day: "weekday", weekday: null } },
    { response: { ...VALID, weekday: 3 } },
    { response: JSON.stringify(Object.fromEntries(Object.entries(VALID).filter(([key]) => key !== "teacher"))) },
    { response: { ...VALID, group: "C" } },
    { response: { ...VALID, lab: 4 } },
    { response: { ...VALID, labsOnly: "true" } },
    { response: Object.fromEntries(Object.entries(VALID).filter(([key]) => key !== "labsOnly")) },
    { response: { ...emptyResult("clarify"), labsOnly: true } },
    { response: { ...emptyResult("next"), day: "week" } },
    { response: { ...VALID, day: "weekday", weekday: 4, confidence: 1 } },
    { response: { ...emptyResult("lookup"), group: "B", confidence: 0.99 } },
    { response: "x".repeat(4001) },
    { response: null },
    null,
  ])("clarifies invalid, invented or uncertain output without exposing it (%#)", async response => {
    const { run, env } = aiBinding(response);
    const result = await new NluClassifier().classify(AMBIGUOUS, env);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toEqual(emptyResult());
    const text = renderQuery(result).text;
    expect(text).not.toMatch(/raw model answer|synthetic-private-marker|invented-course|invented-teacher|```/);
    expect(text).toContain("حدّد اليوم أو المادة");
  });

  it("accepts documented structured/text envelopes and the confidence threshold exactly", () => {
    expect(parseAiClassification({ response: VALID })).toEqual(VALID);
    expect(parseAiClassification(ENVELOPE)).toEqual(VALID);
    expect(parseAiClassification({ choices: [{ message: { content: JSON.stringify(VALID) } }] })).toEqual(VALID);
    expect(parseAiClassification({ response: { ...VALID, confidence: MIN_CONFIDENCE } }))
      .toEqual({ ...VALID, confidence: MIN_CONFIDENCE });
    expect(parseAiClassification(VALID)).toBeNull();
    expect(parseAiClassification({ response: { ...VALID, confidence: Number.NaN } })).toBeNull();
  });

  it("accepts allowlisted lab and temporal classifications without model-generated facts", () => {
    const laboratory: NluResult = { ...emptyResult("lookup"), day: "weekday", weekday: 0, group: "B", labsOnly: true, confidence: 0.99 };
    expect(parseAiClassification({ response: laboratory })).toEqual(laboratory);
    for (const intent of ["next", "current", "remaining"] as const) {
      const temporal = { ...emptyResult(intent), confidence: 0.99 };
      expect(parseAiClassification({ response: JSON.stringify(temporal) })).toEqual(temporal);
      expect(parseAiClassification({ response: { ...temporal, startsAt: "invented time" } })).toBeNull();
      expect(parseAiClassification({ response: { ...temporal, answer: "invented lecture" } })).toBeNull();
    }
  });

  it("rejects a high-confidence invented Thursday and a lost explicit next intent", () => {
    const question = "ايمتى المحاضره الجايه مجموعه B";
    const wrongThursday = { ...emptyResult("lookup"), day: "weekday", weekday: 4, group: "B", confidence: 0.98 };
    expect(parseAiClassification({ response: wrongThursday }, question)).toBeNull();
    expect(parseAiClassification({ response: { ...wrongThursday, day: "unspecified", weekday: null } }, question)).toBeNull();
    const correct = { ...emptyResult("next"), group: "B", confidence: 0.99 };
    expect(parseAiClassification({ response: correct }, question)).toEqual(correct);
  });

  it("requires each actionable AI date to match the literal question, including omitted days", () => {
    const sundayLabs = { ...emptyResult("lookup"), day: "weekday", weekday: 0, group: "B", labsOnly: true, confidence: 0.99 };
    const question = "شنو عدنا مختبرات يوم الاحد مجوعة b";
    expect(parseAiClassification({ response: sundayLabs }, question)).toEqual(sundayLabs);
    expect(parseAiClassification({ response: { ...sundayLabs, day: "unspecified", weekday: null } }, question)).toBeNull();
    expect(parseAiClassification({ response: { ...sundayLabs, weekday: 4 } }, question)).toBeNull();
    expect(parseAiClassification({ response: VALID }, "شنو جدولنا")).toBeNull();
    expect(parseAiClassification({ response: VALID }, "شنو عدنا باجير")).toBeNull();
    for (const text of ["شو عدنه بكرة", "شنو عدنة بكرى؟", "عطوني جدول الغد", "شباب عطوني ترتيب حصصنا للغد"]) {
      expect(parseAiClassification({ response: VALID }, text)).toEqual(VALID);
    }
  });

  it("grounds today/current and remaining while preserving the no-facts fallback responses", () => {
    const current = { ...emptyResult("current"), day: "today", confidence: 0.99 };
    expect(parseAiClassification({ response: current }, "شنو المحاضرة الحالية اليوم")).toEqual(current);
    expect(parseAiClassification({ response: { ...current, day: "unspecified" } }, "شنو المحاضرة الحالية اليوم")).toBeNull();
    expect(parseAiClassification({ response: { ...VALID, day: "today" } }, "شنو المحاضرة الحالية اليوم")).toBeNull();
    expect(parseAiClassification({ response: { ...emptyResult("remaining"), confidence: 0.99 } }, "شنو بقه هسه")).not.toBeNull();
    expect(parseAiClassification({ response: { ...emptyResult("lookup"), group: "B", confidence: 0.99 } }, "شنو بقه هسه")).toBeNull();
    expect(parseAiClassification({ response: emptyResult() }, "شنو بقه الخميس والجمعة")).toEqual(emptyResult());
    expect(parseAiClassification({ response: emptyResult("out_of_scope") }, "اريد انام اليوم")).toEqual(emptyResult("out_of_scope"));
  });

  it("does not interpret numeric laboratory/slot words as an explicit Monday", () => {
    const laboratory = { ...emptyResult("lookup"), lab: 2, confidence: 0.99 };
    expect(parseAiClassification({ response: laboratory }, "مختبر اثنين")).toEqual(laboratory);
    expect(parseAiClassification({ response: { ...laboratory, day: "weekday", weekday: 1 } }, "مختبر اثنين")).toBeNull();
    const lecture = { ...emptyResult("lookup"), slot: 2, confidence: 0.99 };
    expect(parseAiClassification({ response: lecture }, "المحاضرة الثانية")).toEqual(lecture);
    expect(parseAiClassification({ response: { ...lecture, day: "today" } }, "المحاضرة الثانية")).toBeNull();
  });

  it("grounds dated weeks without confusing next week with the next lecture", () => {
    const question = "شنو المختبرات اللي عدنا مجموعة B الأسبوع الجاي";
    const correct = { ...emptyResult("lookup"), day: "next_week", labsOnly: true, group: "B", confidence: 0.99 };
    expect(parseAiClassification({ response: correct }, question)).toEqual(correct);
    for (const day of ["week", "current_week", "unspecified", "tomorrow"]) {
      expect(parseAiClassification({ response: { ...correct, day } }, question)).toBeNull();
    }
    for (const mutation of [{ labsOnly: false }, { group: null }, { group: "A" }, { course: "compilers" }, { intent: "next" }]) {
      expect(parseAiClassification({ response: { ...correct, ...mutation } }, question)).toBeNull();
    }
    expect(parseAiClassification({ response: correct }, "مختبرات الأسبوع بعد الجاي مجموعة B")).toBeNull();
    const next = { ...correct, intent: "next", labsOnly: false };
    expect(parseAiClassification({ response: next }, "شنو المحاضرة اللي تجي الأسبوع الجاي مجموعة B")).toEqual(next);
    expect(parseAiClassification({ response: { ...next, intent: "lookup" } }, "شنو المحاضرة اللي تجي الأسبوع الجاي مجموعة B")).toBeNull();
  });

  it("grounds an implicit nearest-course time question without accepting an invented date or teacher", () => {
    const text = "موعد محاضرة المترجمات مجموعة B";
    const expected = { ...emptyResult("next"), course: "compilers", group: "B", confidence: 0.99 };
    expect(parseAiClassification({ response: expected }, text)).toEqual(expected);
    for (const mutation of [{ intent: "lookup" }, { day: "today" }, { teacher: "issam" }, { group: null }, { course: null }]) {
      expect(parseAiClassification({ response: { ...expected, ...mutation } }, text)).toBeNull();
    }
  });

  it.each(["شنو عدهم اليوم B", "شنو عندهم اليومB", "شنوعدهماليومB"])(
    "does not let AI lose or widen the explicit Baghdad day/group in %s", text => {
      const expected = { ...emptyResult("lookup"), day: "today", group: "B", confidence: 0.99 };
      expect(parseAiClassification({ response: expected }, text)).toEqual(expected);
      for (const mutation of [{ group: null }, { group: "A" }, { day: "tomorrow" }, { day: "unspecified" }]) {
        expect(parseAiClassification({ response: { ...expected, ...mutation } }, text)).toBeNull();
      }
      expect(parseAiClassification({ response: expected }, `${text} C`)).toBeNull();
    },
  );

  it("keeps an explicit course timing day and does not infer the next lecture or its lecturer", () => {
    const text = "وقت محاضرة المترجمات باجر مجموعة A";
    const expected = { ...emptyResult("lookup"), day: "tomorrow", course: "compilers", group: "A", confidence: 0.99 };
    expect(parseAiClassification({ response: expected }, text)).toEqual(expected);
    expect(parseAiClassification({ response: { ...expected, intent: "next" } }, text)).toBeNull();
    expect(parseAiClassification({ response: { ...expected, teacher: "issam" } }, text)).toBeNull();
  });

  it("rejects actionable AI output for explicit unknown names and lost literal entities", () => {
    const ahmed = { ...emptyResult("lookup"), teacher: "ahmed", confidence: 0.99 };
    expect(parseAiClassification({ response: ahmed }, "دكتور أحمد خالد")).toBeNull();
    const mobile = { ...emptyResult("lookup"), course: "mobile", confidence: 0.99 };
    expect(parseAiClassification({ response: mobile }, "موعد محاضرة الكيمياء")).toBeNull();
    expect(parseAiClassification({ response: { ...VALID, course: "mobile" } }, AMBIGUOUS)).toBeNull();
    expect(parseAiClassification({ response: { ...VALID, teacher: "ahmed" } }, AMBIGUOUS)).toBeNull();
    expect(parseAiClassification({ response: { ...VALID, course: "graphics" } }, "عند من ناخذ الشغلات اللي نرسمها بالحاسوب غداً")).toBeNull();
  });

  it("renders the fixed local out-of-scope response even when the AI envelope contains other text", async () => {
    const outOfScope = { ...emptyResult("out_of_scope"), confidence: 0.99 };
    const { env } = aiBinding({ response: JSON.stringify(outOfScope), other: "never show this model prose" });
    const result = await new NluClassifier().classify(AMBIGUOUS, env);
    expect(renderQuery(result).text).toBe("حبيبي آني دعبول، مختص بجدول محاضرات المرحلة الثالثة 😂❤️");
  });

  it("does not make AI calls without a binding, free-plan confirmation or within input guards", async () => {
    const { run, env } = aiBinding();
    const classifier = new NluClassifier();
    expect(await classifier.classify(AMBIGUOUS)).toEqual(emptyResult());
    expect(await classifier.classify(AMBIGUOUS, { AI: env.AI })).toEqual(emptyResult());
    expect(await classifier.classify(AMBIGUOUS, { ...env, AI_FREE_TIER_CONFIRMED: "false" })).toEqual(emptyResult());
    expect(await classifier.classify("x".repeat(321), env)).toEqual(emptyResult());
    expect(await classifier.classify("هلا؟", env, true)).toEqual(emptyResult());
    expect(run).not.toHaveBeenCalled();
    expect(await classifier.classify("شنو عدنا باچر؟", {})).toMatchObject({ intent: "schedule", day: "tomorrow" });
  });

  it("keeps local timetable requests working after quota or inference failure and logs no raw error", async () => {
    const { run, env } = aiBinding();
    run.mockRejectedValue(new Error("synthetic-private-marker quota exceeded"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const classifier = new NluClassifier();
    expect(await classifier.classify(AMBIGUOUS, env)).toEqual(emptyResult());
    expect(await classifier.classify("جدول اليوم", env)).toMatchObject({ intent: "schedule", day: "today" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    [false, 5000], [true, 4000],
  ] as const)("returns clarification at the bounded timeout (inline=%s)", async (inline, milliseconds) => {
    vi.useFakeTimers();
    const { run, env } = aiBinding();
    run.mockImplementation(() => new Promise(() => {}));
    const classifier = new NluClassifier();
    let completed = false;
    const pending = classifier.classify(AMBIGUOUS, env, inline).then(result => { completed = true; return result; });
    await vi.advanceTimersByTimeAsync(milliseconds - 1);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(emptyResult());
    expect(run).toHaveBeenCalledTimes(1);
    expect(await classifier.classify("شنو عدنا باچر؟", env)).toMatchObject({ intent: "schedule", day: "tomorrow" });
  });

  it.each([false, true])("accepts valid inference after 3.5 seconds without an early timeout (inline=%s)", async inline => {
    vi.useFakeTimers();
    const { run, env } = aiBinding();
    run.mockImplementation(() => new Promise(resolve => { setTimeout(() => { resolve(ENVELOPE); }, 3500); }));
    const pending = new NluClassifier().classify(AMBIGUOUS, env, inline);
    await vi.advanceTimersByTimeAsync(3500);
    expect(await pending).toEqual(VALID);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("limits simultaneous classification calls to two and releases capacity after they settle", async () => {
    const { run, env } = aiBinding();
    const resolvers: ((value: unknown) => void)[] = [];
    run.mockImplementation(() => new Promise(resolve => { resolvers.push(resolve); }));
    const classifier = new NluClassifier();
    const first = classifier.classify(AMBIGUOUS, env);
    const second = classifier.classify(AMBIGUOUS, env);
    expect(await classifier.classify(AMBIGUOUS, env)).toEqual(emptyResult());
    expect(run).toHaveBeenCalledTimes(2);
    resolvers.forEach(resolve => { resolve(ENVELOPE); });
    expect(await first).toEqual(VALID);
    expect(await second).toEqual(VALID);
    run.mockResolvedValue(ENVELOPE);
    expect(await classifier.classify(AMBIGUOUS, env)).toEqual(VALID);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("limits AI to twelve attempts per minute while keeping locals free and resetting the next minute", async () => {
    const instant = Date.parse("2026-10-13T10:00:00Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(instant);
    const { run, env } = aiBinding();
    const classifier = new NluClassifier();
    for (let index = 0; index < 12; index++) expect(await classifier.classify(AMBIGUOUS, env)).toEqual(VALID);
    expect(await classifier.classify(AMBIGUOUS, env)).toEqual(emptyResult());
    expect(run).toHaveBeenCalledTimes(12);
    expect(await classifier.classify("جدول اليوم", env)).toMatchObject({ intent: "schedule", day: "today" });
    expect(run).toHaveBeenCalledTimes(12);
    clock.mockReturnValue(instant + 60_000);
    expect(await classifier.classify(AMBIGUOUS, env)).toEqual(VALID);
    expect(run).toHaveBeenCalledTimes(13);
  });
});
