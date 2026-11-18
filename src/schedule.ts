export type LectureNumber = 1 | 2 | 3 | 4 | 5;

export interface Session {
  readonly course: string;
  /** Not included in the latest student-supplied timetable. */
  readonly teacher?: string;
  readonly group?: "A" | "B";
  /** Not included in the latest student-supplied timetable. */
  readonly laboratory?: "م1" | "م2" | "م3";
}

export interface LectureSlot {
  readonly title: string;
  /** Entries in the same slot are simultaneous, not consecutive lectures. */
  readonly sessions: readonly Session[];
}

export const WEEKDAYS = [
  "الأحد",
  "الاثنين",
  "الثلاثاء",
  "الأربعاء",
  "الخميس",
  "الجمعة",
  "السبت",
] as const;

/**
 * The student-approved weekly timetable, indexed Sunday (0) to Saturday (6).
 * Transcribed from the timetable image supplied on 2026-11-18.
 * The image provides course, day, order, and practical group only; teacher,
 * room, and exact lecture times are intentionally absent rather than guessed.
 * Friday and Saturday remain empty because the image has no entries for them.
 */
export const SCHEDULE: readonly (readonly LectureSlot[])[] = [
  // الأحد
  [
    {
      title: "المحاضرة الأولى",
      sessions: [{ course: "معمارية الحاسبة (نظري)" }],
    },
    {
      title: "المحاضرة الثانية",
       sessions: [{ course: "رسومات الحاسبة (نظري)" }],
    },
    {
      title: "المحاضرة الثالثة",
      sessions: [{ course: "معمارية الحاسبة (تمارين)" }],
    },
  ],
  // الاثنين
  [
    {
      title: "المحاضرة الأولى",
      sessions: [
        { course: "البرمجة المرئية (عملي)", group: "A" },
        { course: "رسومات (عملي)", group: "B" },
      ],
    },
    {
      title: "المحاضرة الثانية",
      sessions: [{ course: "البرمجة المرئية (نظري)" }],
    },
    {
      title: "المحاضرة الثالثة",
      sessions: [{ course: "المترجمات" }],
    },
  ],
  // الثلاثاء
  [
    {
      title: "المحاضرة الأولى",
      sessions: [{ course: "برمجة تطبيقات الموبايل (نظري)" }],
    },
    {
      title: "المحاضرة الثانية",
      sessions: [{ course: "شبكات الحاسبة (نظري)" }],
    },
    {
      title: "المحاضرة الثالثة",
      sessions: [{ course: "البرمجة المرئية (عملي)", group: "B" }],
    },
  ],
  // الأربعاء
  [
    {
      title: "المحاضرة الأولى",
      sessions: [{ course: "المترجمات (نظري)" }],
    },
    {
      title: "المحاضرة الثانية",
      sessions: [{ course: "المترجمات (عملي)", group: "A" }],
    },
    {
      title: "المحاضرة الثالثة",
      sessions: [
        { course: "رسومات (عملي)", group: "A" },
        { course: "المترجمات (عملي)", group: "B" },
      ],
    },
  ],
  // الخميس
  [
    {
      title: "المحاضرة الأولى",
      sessions: [{ course: "برمجة تطبيقات الموبايل (عملي)", group: "A" }],
    },
    {
      title: "المحاضرة الثانية",
      sessions: [{ course: "شبكات الحاسبة (عملي)", group: "B" }],
    },
    {
      title: "المحاضرة الثالثة",
      sessions: [{ course: "برمجة تطبيقات الموبايل (عملي)", group: "B" }],
    },
    {
      title: "المحاضرة الرابعة",
      sessions: [{ course: "شبكات الحاسبة (عملي)", group: "A" }],
    },
    {
      title: "المحاضرة الخامسة",
      sessions: [{ course: "شبكات الحاسبة (نظري)" }],
    },
  ],
  // الجمعة، السبت
  [],
  [],
];
