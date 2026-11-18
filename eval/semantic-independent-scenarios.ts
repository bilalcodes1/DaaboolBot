import type { CompilerInput } from '../src/semantic-compiler';
import type { ReadExecutionContext, ReadPermission } from '../src/read-tools';
import type { SemanticAction, SemanticScope, TargetSnapshot, TrustedInstruction } from '../src/semantic-plan';

/** New offline scenario facts. This module has no gold, evaluator or model imports. */
export const INDEPENDENT_SCENARIO_VERSION = 'semantic-independent-scenarios-v1';
export const INDEPENDENT_INTENT_FIXTURE_VERSION = 'authored-current-message-intent-annotations-v1';
export const INDEPENDENT_INTENT_ANNOTATOR = 'synthetic_design_annotation' as const;
export const INDEPENDENT_INTENT_LIMITATION = 'Independent intent is supplied only by synthetic authored fixture annotations; no production intent supplier is implemented or validated.';

/** Synthetic authenticated identities, unrelated to message wording or proposal labels. */
export const INDEPENDENT_FIXTURE_IDENTITIES = {
  administrator: { verified: true, userId: 910000, ownerUid: 910000 },
  student: { verified: true, userId: 910001, ownerUid: 910000 },
} as const;
type FixtureIdentity = keyof typeof INDEPENDENT_FIXTURE_IDENTITIES;
const capabilities: Readonly<Record<FixtureIdentity, readonly SemanticAction[]>> = {
  administrator: ['read', 'create', 'update', 'cancel', 'undo', 'publish'],
  student: ['read', 'create', 'update', 'cancel', 'undo'],
};
const readPermissions: readonly ReadPermission[] = ['schedule.read', 'cohort.read', 'announcements.read', 'roster.read', 'operations.read_own'];

export const INDEPENDENT_SCENARIO_IDS = [
  'p3h-samepublish-admin', 'p3h-samepublish-student', 'p3h-wrongtarget', 'p3h-stalesnapshot',
  'p3h-create-positive', 'p3h-negated-create', 'p3h-create-missing-course',
  'p3h-time-only-update', 'p3h-ambiguous-publish',
] as const;
export type IndependentScenarioId = typeof INDEPENDENT_SCENARIO_IDS[number];

interface CurrentMessageSpan { start: number; end: number }
/** Independent application-side design annotation, stored separately from labels.
 * It is never projected into model messages and is not a production intent check.
 */
export type IndependentIntentAnnotation = {
  annotator: typeof INDEPENDENT_INTENT_ANNOTATOR;
  operationId: string;
  currentMessageSpan: CurrentMessageSpan;
  requiredDependencies: readonly string[];
} & (
  | { action: 'create'; speechAct: 'command' }
  | { action: 'publish'; speechAct: 'command'; selectors: readonly { listId: string; position: number }[] }
  | { action: 'update'; speechAct: 'correction'; selectors: readonly { listId: string; position: number }[];
      fieldEdits: readonly { field: 'time'; mode: 'set'; value: string; currentMessageSpan: CurrentMessageSpan }[] }
);

export interface IndependentScenarioFacts {
  id: IndependentScenarioId;
  authenticatedIdentity: FixtureIdentity;
  session: Omit<SemanticScope, 'userId'>;
  originalTimestamp: number;
  now: number;
  messageId: number;
  updateId: number;
  expiresAt: number;
  currentMessage: { text: string };
  intentAnnotations: readonly IndependentIntentAnnotation[];
  list: { id: string; entries: readonly {
    position: number; candidates: readonly { recordId: string; shownRevision: number }[];
    handle: string; description: string;
  }[] } | null;
  records: readonly {
    id: string; revision: number; ownerId: number; state: TargetSnapshot['state'];
    independentVerification: TargetSnapshot['independentVerification'];
  }[];
}

const timestamp = Date.parse('2026-11-02T09:00:00+03:00');
/** The paired scenarios share utterance/list/records; only authenticated identity differs. */
function authoredFacts(id: IndependentScenarioId, authenticatedIdentity: FixtureIdentity, secondRecordRevision = 4): IndependentScenarioFacts {
  const text = 'انشر التبليغ الثاني للطلاب.';
  return {
    id, authenticatedIdentity,
    session: { botId: 991001, chatId: -1009910001, threadId: 42 },
    originalTimestamp: timestamp, now: timestamp + 5, messageId: 701, updateId: 7001,
    expiresAt: timestamp + 60 * 60 * 1000,
    currentMessage: { text },
    intentAnnotations: [{ annotator: INDEPENDENT_INTENT_ANNOTATOR, operationId: 'current-request',
      action: 'publish', speechAct: 'command', currentMessageSpan: { start: 0, end: text.length },
      selectors: [{ listId: 'phase3h-list', position: 2 }], requiredDependencies: [] }],
    list: { id: 'phase3h-list', entries: [
      { position: 1, candidates: [{ recordId: 'phase3h-graphics', shownRevision: 3 }], handle: 'p3h-item-1', description: 'امتحان الرسومات بتاريخ 2026-11-08' },
      { position: 2, candidates: [{ recordId: 'phase3h-networks', shownRevision: 4 }], handle: 'p3h-item-2', description: 'امتحان الشبكات بتاريخ 2026-11-12' },
    ] },
    records: [
      { id: 'phase3h-graphics', revision: 3, ownerId: 910001, state: 'active', independentVerification: 'unverified' },
      { id: 'phase3h-networks', revision: secondRecordRevision, ownerId: 910001, state: 'active', independentVerification: 'unverified' },
    ],
  };
}

function messageOnlyFacts(id: IndependentScenarioId, text: string): IndependentScenarioFacts {
  return { ...authoredFacts(id, 'student'), currentMessage: { text }, intentAnnotations: [], list: null, records: [] };
}
const createFacts = messageOnlyFacts('p3h-create-positive', 'Create كوز Mobile Applications باچر.');
createFacts.intentAnnotations = [{ annotator: INDEPENDENT_INTENT_ANNOTATOR, operationId: 'current-request',
  action: 'create', speechAct: 'command', currentMessageSpan: { start: 0, end: createFacts.currentMessage.text.length },
  requiredDependencies: [] }];
const updateFacts = authoredFacts('p3h-time-only-update', 'student');
updateFacts.currentMessage = { text: 'For item 1, change only the time to 09:45.' };
updateFacts.intentAnnotations = [{ annotator: INDEPENDENT_INTENT_ANNOTATOR, operationId: 'current-request',
  action: 'update', speechAct: 'correction', currentMessageSpan: { start: 0, end: updateFacts.currentMessage.text.length },
  selectors: [{ listId: 'phase3h-list', position: 1 }], requiredDependencies: [],
  fieldEdits: [{ field: 'time', mode: 'set', value: '09:45', currentMessageSpan: { start: 36, end: 41 } }] }];
const ambiguousFacts = authoredFacts('p3h-ambiguous-publish', 'administrator');
ambiguousFacts.list!.entries = ambiguousFacts.list!.entries.map(entry => entry.position === 2
  ? { ...entry, candidates: [...entry.candidates, { recordId: 'phase3h-networks-duplicate', shownRevision: 4 }] } : entry);
ambiguousFacts.records = [...ambiguousFacts.records, { id: 'phase3h-networks-duplicate', revision: 4,
  ownerId: 910001, state: 'active', independentVerification: 'unverified' }];

const scenarios: Readonly<Record<IndependentScenarioId, IndependentScenarioFacts>> = {
  'p3h-samepublish-admin': authoredFacts('p3h-samepublish-admin', 'administrator'),
  'p3h-samepublish-student': authoredFacts('p3h-samepublish-student', 'student'),
  // Both positions resolve; the separately authored current-message annotation selects the second.
  'p3h-wrongtarget': authoredFacts('p3h-wrongtarget', 'administrator'),
  // The prior list remains revision 4; the independently supplied current row is revision 5.
  'p3h-stalesnapshot': authoredFacts('p3h-stalesnapshot', 'administrator', 5),
  'p3h-create-positive': createFacts,
  'p3h-negated-create': messageOnlyFacts('p3h-negated-create', 'لا تضيف كوز الموبايل باچر.'),
  'p3h-create-missing-course': messageOnlyFacts('p3h-create-missing-course', 'سجل امتحان السبت.'),
  'p3h-time-only-update': updateFacts,
  'p3h-ambiguous-publish': ambiguousFacts,
};

/** Clone authored facts so callers cannot change future fixture authority. */
export function independentScenarioFacts(id: IndependentScenarioId): IndependentScenarioFacts {
  if (!Object.hasOwn(scenarios, id)) throw Error('Unknown independent scenario');
  return structuredClone(scenarios[id]);
}

/** Translate synthetic annotations with structural checks only. There is no
 * lexical routing, phrase matching or inference from user/model wording here.
 * This does not validate the annotator's semantic judgment or provide one.
 */
function authoredCurrentInstructions(facts: IndependentScenarioFacts): TrustedInstruction[] {
  const ids = new Set(facts.intentAnnotations.map(annotation => annotation.operationId));
  if (ids.size !== facts.intentAnnotations.length) throw Error('Duplicate independent intent annotation');
  const boundedSpan = (span: CurrentMessageSpan, parent = { start: 0, end: facts.currentMessage.text.length }) => {
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
      || span.start < parent.start || span.end <= span.start || span.end > parent.end) throw Error('Invalid independent intent span');
    return { sourceId: 'message', start: span.start, end: span.end };
  };
  return facts.intentAnnotations.map(annotation => {
    if (annotation.annotator !== INDEPENDENT_INTENT_ANNOTATOR || !annotation.operationId
      || new Set(annotation.requiredDependencies).size !== annotation.requiredDependencies.length
      || annotation.requiredDependencies.some(id => !ids.has(id) || id === annotation.operationId)) throw Error('Invalid independent intent annotation');
    const instruction: TrustedInstruction = { operationId: annotation.operationId, action: annotation.action,
      speechAct: annotation.speechAct, evidence: boundedSpan(annotation.currentMessageSpan),
      requiredDependencies: [...annotation.requiredDependencies] };
    if (annotation.action === 'create') return instruction;
    if (!facts.list || !annotation.selectors.length) throw Error('Missing independent intent selector');
    const positions = new Set<number>();
    instruction.requestedTargets = annotation.selectors.map(selector => {
      if (selector.listId !== facts.list!.id || !Number.isSafeInteger(selector.position) || selector.position < 1
        || positions.has(selector.position) || facts.list!.entries.filter(entry => entry.position === selector.position).length !== 1) throw Error('Invalid independent intent selector');
      positions.add(selector.position);
      return { type: 'previous_list', listId: selector.listId, position: selector.position };
    });
    if (annotation.action === 'update') {
      if (annotation.selectors.length !== 1 || annotation.fieldEdits.length !== 1) throw Error('Invalid independent intent edits');
      const edit = annotation.fieldEdits[0]!;
      if (edit.field !== 'time' || edit.mode !== 'set' || typeof edit.value !== 'string' || !edit.value.length) throw Error('Invalid independent intent edit');
      instruction.requestedChanges = { time: { mode: edit.mode, value: edit.value,
        evidence: boundedSpan(edit.currentMessageSpan, annotation.currentMessageSpan) } };
    }
    return instruction;
  });
}

export interface BuiltIndependentScenario {
  id: IndependentScenarioId;
  input: CompilerInput;
  context: ReadExecutionContext;
  provenance: {
    scenarioVersion: typeof INDEPENDENT_SCENARIO_VERSION;
    intentVersion: typeof INDEPENDENT_INTENT_FIXTURE_VERSION;
    annotator: typeof INDEPENDENT_INTENT_ANNOTATOR;
    productionIntentSupplier: false;
    limitation: typeof INDEPENDENT_INTENT_LIMITATION;
  };
}

/** Application context is built entirely from fixed identity and scenario facts.
 * Publication capability and intent are independent: a student can request
 * publication, but that request never adds publication to local capabilities.
 */
export function buildIndependentScenario(id: IndependentScenarioId): BuiltIndependentScenario {
  const facts = independentScenarioFacts(id);
  const identity = INDEPENDENT_FIXTURE_IDENTITIES[facts.authenticatedIdentity];
  const scope: SemanticScope = { ...facts.session, userId: identity.userId };
  const list = facts.list;
  const listText = list ? `قائمة افتراضية ${list.id}: ${list.entries.map(entry => `${entry.position}. ${entry.description} (${entry.handle}).`).join(' ')}` : null;
  const destination = { chatId: facts.session.chatId, threadId: facts.session.threadId };
  const context: ReadExecutionContext = {
    originalText: facts.currentMessage.text, originalTimestamp: facts.originalTimestamp,
    now: facts.now, messageId: facts.messageId, updateId: facts.updateId, scope,
    actor: { ...identity }, allowedActions: [...capabilities[facts.authenticatedIdentity]],
    requireTargetIntent: true,
    sources: [
      { id: 'message', kind: 'current', text: facts.currentMessage.text, messageStart: 0 },
      ...(listText ? [{ id: 'prior-list', kind: 'reply' as const, text: listText, messageStart: null }] : []),
    ],
    instructions: authoredCurrentInstructions(facts),
    targetBindings: list?.entries.map(entry => ({
      selector: { type: 'previous_list', listId: list.id, position: entry.position },
      scope: { ...scope }, expiresAt: facts.expiresAt, snapshots: entry.candidates.map(candidate => {
        const record = facts.records.find(record => record.id === candidate.recordId);
        if (!record || facts.records.filter(record => record.id === candidate.recordId).length !== 1) throw Error('Invalid independent scenario record binding');
        return { reference: { kind: 'academic', id: record.id, revision: candidate.shownRevision },
          currentRevision: record.revision, ownerId: record.ownerId, state: record.state,
          independentVerification: record.independentVerification };
      }),
    })) ?? [],
    authorization: { scope: { ...scope }, expiresAt: facts.expiresAt, permissions: [...readPermissions], classroom: { ...destination } },
    announcementReferences: list?.entries.flatMap(entry => entry.candidates.length !== 1 ? [] : [{
      handle: entry.handle, scope: { ...scope }, expiresAt: facts.expiresAt,
      reference: { kind: 'academic' as const, id: entry.candidates[0]!.recordId, revision: entry.candidates[0]!.shownRevision }, destination: { ...destination },
    }]) ?? [],
    operationReferences: [],
  };
  return { id, input: { originalText: facts.currentMessage.text,
    ...(listText ? { conversation: { scope: { ...scope }, expiresAt: facts.expiresAt,
      turns: [{ role: 'assistant' as const, text: listText }] } } : {}) },
    context, provenance: { scenarioVersion: INDEPENDENT_SCENARIO_VERSION, intentVersion: INDEPENDENT_INTENT_FIXTURE_VERSION, annotator: INDEPENDENT_INTENT_ANNOTATOR,
      productionIntentSupplier: false, limitation: INDEPENDENT_INTENT_LIMITATION } };
}
