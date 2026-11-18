import type { AcademicCertainty, AcademicKind } from './academic-ai';
import type { AssistantReference } from './assistant-references';
import { COURSE_ALIASES, type CourseId } from './nlu-schema';

export const READ_TOOL_NAMES = ['get_schedule', 'get_courses', 'get_cohort_info', 'search_announcements',
  'get_announcement', 'find_student', 'get_operation_status'] as const;
export type ReadToolName = typeof READ_TOOL_NAMES[number];
export interface ReadToolInputs {
  get_schedule: { period: 'today' | 'tomorrow' | 'week'; course?: string; group?: 'A' | 'B' };
  get_courses: { course?: string };
  get_cohort_info: Record<string, never>;
  search_announcements: { query: string; course?: string; limit?: number; archive?: boolean };
  get_announcement: { reference: string; archive?: boolean };
  find_student: { name: string; limit?: number };
  get_operation_status: { reference: string };
}
export type ReadToolInvocation = { [K in ReadToolName]: { name: K; version: 1; input: ReadToolInputs[K] } }[ReadToolName];
export interface AnnouncementView {
  reference: AssistantReference; kind: AcademicKind; course: CourseId | null; date: string | null;
  audience: 'A' | 'B' | 'all' | null; certainty: AcademicCertainty; details: string; coverage: string;
  provenance: { kind: 'student_report'; sourceMessageId: number | null };
}
export interface ReadToolOutputs {
  get_schedule: { text: string; referenceDate: string; timezone: 'Asia/Baghdad'; officialOnly: true; sources: string[] };
  get_courses: { courses: { id: CourseId; label: string; instructors: string[] }[]; sources: string[] };
  get_cohort_info: { profile: string; studentCount: number; courseCount: number; sources: string[] };
  search_announcements: { announcements: AnnouncementView[]; truncated: boolean; sources: string[] };
  get_announcement: { announcement: AnnouncementView; sources: string[] };
  find_student: { names: string[]; ambiguous: boolean; truncated: boolean; sources: string[] };
  get_operation_status: { state: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
    delivery: 'queued' | 'confirmed_sent' | 'failed' | 'unknown' | 'cancelled'; sources: string[] };
}

/** Deliberately small JSON Schema subset; closed objects, bounded arrays/text, no coercion. */
export interface ReadSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, ReadSchema>; required?: readonly string[]; additionalProperties?: false;
  items?: ReadSchema; maxItems?: number; minLength?: number; maxLength?: number;
  minimum?: number; maximum?: number; enum?: readonly unknown[]; anyOf?: readonly ReadSchema[];
}
export function plainReadObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [null, Object.prototype].includes(Object.getPrototypeOf(value))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(p => Object.hasOwn(p, 'value'));
}
export function matchesReadSchema(value: unknown, schema: ReadSchema, depth = 0): boolean {
  if (depth > 10) return false;
  if (schema.anyOf) return schema.anyOf.some(s => matchesReadSchema(value, s, depth + 1));
  if (schema.enum) return schema.enum.includes(value);
  if (schema.type === 'null') return value === null;
  if (schema.type === 'string') return typeof value === 'string' && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? 10000);
  if (schema.type === 'integer') return Number.isSafeInteger(value) && Number(value) >= (schema.minimum ?? 0) && Number(value) <= (schema.maximum ?? Number.MAX_SAFE_INTEGER);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'array') return Array.isArray(value) && value.length <= (schema.maxItems ?? 12)
    && Reflect.ownKeys(value).length === value.length + 1
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(p => Object.hasOwn(p, 'value'))
    && value.every(v => matchesReadSchema(v, schema.items!, depth + 1));
  return schema.type === 'object' && plainReadObject(value)
    && (schema.required ?? []).every(k => Object.hasOwn(value, k))
    && Reflect.ownKeys(value).every(k => typeof k === 'string' && Object.hasOwn(schema.properties ?? {}, k)
      && matchesReadSchema(value[k], schema.properties![k]!, depth + 1));
}
const str = (maxLength = 1000): ReadSchema => ({ type: 'string', minLength: 1, maxLength });
const en = (...values: unknown[]): ReadSchema => ({ enum: values });
const integer = (minimum = 1, maximum = Number.MAX_SAFE_INTEGER): ReadSchema => ({ type: 'integer', minimum, maximum });
const object = (properties: Record<string, ReadSchema>, required = Object.keys(properties)): ReadSchema => ({ type: 'object', properties, required, additionalProperties: false });
const array = (items: ReadSchema, maxItems = 10): ReadSchema => ({ type: 'array', items, maxItems });
const nullable = (value: ReadSchema): ReadSchema => ({ anyOf: [value, { type: 'null' }] });
const courseId = en(...Object.keys(COURSE_ALIASES));
const source = array(str(100), 4);
const announcement = object({ reference: object({ kind: en('academic', 'legacy'), id: str(128), revision: integer() }),
  kind: en('exam', 'quiz', 'homework', 'discussion', 'note', 'lecture_change'), course: nullable(courseId), date: nullable(str(10)),
  audience: nullable(en('A', 'B', 'all')), certainty: en('asserted', 'tentative', 'unclear'), details: str(1000),
  coverage: { type: 'string', maxLength: 300 }, provenance: object({ kind: en('student_report'), sourceMessageId: nullable(integer()) }) });
export const READ_INPUT_SCHEMAS: { [K in ReadToolName]: ReadSchema } = {
  get_schedule: object({ period: en('today', 'tomorrow', 'week'), course: str(100), group: en('A', 'B') }, ['period']),
  get_courses: object({ course: str(100) }, []), get_cohort_info: object({}),
  search_announcements: object({ query: str(), course: str(100), limit: integer(1, 10), archive: { type: 'boolean' } }, ['query']),
  get_announcement: object({ reference: str(64), archive: { type: 'boolean' } }, ['reference']),
  find_student: object({ name: str(100), limit: integer(1, 10) }, ['name']),
  get_operation_status: object({ reference: str(64) }),
};
export const READ_OUTPUT_SCHEMAS: { [K in ReadToolName]: ReadSchema } = {
  get_schedule: object({ text: str(10000), referenceDate: str(10), timezone: en('Asia/Baghdad'), officialOnly: en(true), sources: source }),
  get_courses: object({ courses: array(object({ id: courseId, label: str(100), instructors: array(str(100), 12) }), 6), sources: source }),
  get_cohort_info: object({ profile: str(10000), studentCount: integer(0, 10000), courseCount: integer(0, 100), sources: source }),
  search_announcements: object({ announcements: array(announcement), truncated: { type: 'boolean' }, sources: source }),
  get_announcement: object({ announcement, sources: source }),
  find_student: object({ names: array(str(100)), ambiguous: { type: 'boolean' }, truncated: { type: 'boolean' }, sources: source }),
  get_operation_status: object({ state: en('pending', 'sending', 'sent', 'failed', 'cancelled'),
    delivery: en('queued', 'confirmed_sent', 'failed', 'unknown', 'cancelled'), sources: source }),
};
export function isReadToolInvocation(value: unknown): value is ReadToolInvocation {
  return plainReadObject(value) && Reflect.ownKeys(value).length === 3 && value.version === 1
    && typeof value.name === 'string' && READ_TOOL_NAMES.includes(value.name as ReadToolName)
    && matchesReadSchema(value.input, READ_INPUT_SCHEMAS[value.name as ReadToolName]);
}
