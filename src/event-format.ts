import { addCalendarDays } from "./calendar";
import { escapeHtml } from "./format";
import type { CourseId, TeacherId } from "./nlu-schema";
import { WEEKDAYS } from "./schedule";
import type { EventDraft, EventKind } from "./event-types";

export const COURSE_LABELS: Readonly<Record<CourseId, string>> = {
  architecture: "معمارية الحاسبة",
  mobile: "برمجة تطبيقات الموبايل",
  networks: "شبكات الحاسبة",
  visual: "البرمجة المرئية",
  compilers: "المترجمات",
  graphics: "رسومات الحاسبة",
};

export const EVENT_KIND_LABELS: Readonly<Record<EventKind, string>> = {
  exam: "امتحان", quiz: "كويز", homework: "واجب",
};

const TEACHER_LABELS: Readonly<Record<TeacherId, string>> = {
  mustafa: "مصطفى معد", ahmed: "احمد صبحي", khubaib: "خبيب باسم", fouad: "فؤاد سليم",
  saad: "سعد عدنان", hiba: "هبة", shumous: "شموس", sura: "سرى", issam: "عصام طه",
  bilal: "بلال فواز", ruqayya: "رقية اياد",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "بانتظار موافقة الأدمن", approved: "مساهمة طلابية معتمدة", rejected: "مرفوض", draft: "مسودة",
};

/** Escape within a raw HTML budget without splitting characters or entities. */
function escapedWithin(text: string, budget: number): { text: string; clipped: boolean } {
  let output = "";
  for (const character of text) {
    const escaped = escapeHtml(character);
    if (output.length + escaped.length > budget) return { text: output, clipped: true };
    output += escaped;
  }
  return { text: output, clipped: false };
}

export function formatEvent(draft: EventDraft, author: string, status?: string): string {
  const kind = draft.kind ? EVENT_KIND_LABELS[draft.kind] : "ملاحظة دراسية";
  const lines = [`📌 <b>دعبول | ${escapeHtml(kind)}</b>`];
  if (status) lines.push(`📋 ${escapedWithin(STATUS_LABELS[status] ?? status, 120).text}`);
  lines.push(`📖 ${draft.course ? escapeHtml(COURSE_LABELS[draft.course]) : "المادة تحتاج تحديد"}`);
  if (draft.teacher) lines.push(`👨‍🏫 ${escapeHtml(TEACHER_LABELS[draft.teacher])}`);
  if (draft.date) {
    try {
      const { weekday } = addCalendarDays(draft.date, 0);
      lines.push(`📅 ${WEEKDAYS[weekday]} ${escapeHtml(draft.date)}`);
    } catch { lines.push("📅 الموعد يحتاج تأكيد"); }
  } else lines.push(draft.dateUnspecified ? "📅 الموعد بعده غير محدد" : "📅 الموعد يحتاج تحديد");
  if (draft.time) lines.push(/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(draft.time) ? `🕒 ${draft.time}` : "🕒 الوقت يحتاج تأكيد");
  if (draft.slots.length) {
    const labels = { 1: "الأولى", 2: "الثانية", 3: "الثالثة", 4: "الرابعة", 5: "الخامسة" };
    lines.push(`🔢 المحاضرة: ${draft.slots.map((slot) => labels[slot]).join(" + ")}`);
  }
  lines.push(`👥 ${draft.audience === "all" ? "المجموعتين A وB" : draft.audience ? `مجموعة ${draft.audience}` : "المجموعة تحتاج تحديد"}`);
  if (draft.attachment) {
    const name = draft.attachment.fileName ? `: ${escapedWithin(draft.attachment.fileName, 160).text}` : "";
    lines.push(`${draft.attachment.kind === "photo" ? "🖼 صورة مرفقة" : "📎 ملف مرفق"}${name}`);
  }
  lines.push(`👤 مساهمة: ${escapedWithin(author, 200).text}`);
  const header = lines.join("\n");
  if (!draft.details) return header;
  const prefix = `${header}\n\n📝 <b>المطلوب حسب التبليغ:</b>\n`;
  const suffix = "\n⚠️ التفاصيل طويلة؛ راجع النص الأصلي الكامل قبل الموافقة.";
  const details = escapedWithin(draft.details, 4096 - prefix.length - suffix.length);
  return `${prefix}${details.text}${details.clipped ? suffix : ""}`;
}
