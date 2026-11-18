import type { CourseId, TeacherId } from "./nlu-schema";
import type { NluAiBinding } from "./types";

export type EventKind = "exam" | "quiz" | "homework";
export type EventAudience = "A" | "B" | "all";

export interface AttachmentRef {
  kind: "photo" | "document";
  fileId: string;
  fileUniqueId?: string;
  fileName?: string;
}

export interface EventDraft {
  kind: EventKind | null;
  course: CourseId | null;
  teacher: TeacherId | null;
  date: string | null;
  dateUnspecified: boolean;
  time: string | null;
  slots: (1 | 2 | 3 | 4 | 5)[];
  audience: EventAudience | null;
  /** Exact student text: preserve exclusions, unfamiliar terms and spelling. */
  details: string;
  attachment: AttachmentRef | null;
}

export interface EventQuery {
  kind: EventKind | null;
  /** A clear combined lookup, such as exams AND quizzes; never used for submissions. */
  kinds?: EventKind[];
  course: CourseId | null;
  date: string | null;
  /** Inclusive Baghdad calendar bounds; undated notes do not belong to a week. */
  dateRange?: { fromDate: string; toDate: string; label?: "next_week" | "current_week" | "last_week" };
  audience: EventAudience | null;
}

export interface EventExtractionEnv {
  AI?: NluAiBinding;
  AI_FREE_TIER_CONFIRMED?: string;
}

export function emptyEventDraft(): EventDraft {
  return {
    kind: null,
    course: null,
    teacher: null,
    date: null,
    dateUnspecified: false,
    time: null,
    slots: [],
    audience: null,
    details: "",
    attachment: null,
  };
}
