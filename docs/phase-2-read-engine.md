# Phase 2 — offline read engine

Status: implemented offline. No production routing, secrets, migrations, deployment,
Groq requests, Telegram sends, audit/session updates, or scheduled-task changes.

## Files

- `src/read-tool-contracts.ts`: seven discriminated invocations, typed outputs,
  closed bounded input/output schemas and a small schema validator.
- `src/read-tools.ts`: fixed registry, authorization, scoped adapters, result
  projection, provenance, timeouts, SELECT-only D1 reader facade.
- `src/read-plan-executor.ts`: Phase 1 validation, whole-plan write refusal,
  bounded dependency ordering and bounded typed results.
- `src/semantic-plan.ts` and `src/semantic-validator.ts`: optional typed `tool`
  field on read actions; existing Phase 1 plans remain valid.
- `src/assistant-knowledge.ts`: extracted the existing pure roster matcher for
  reuse; the existing conversational caller retains its two-word threshold.
- `tests/read-plan-executor.test.ts`: offline security/domain/failure tests and
  an integration check against the existing readers with an in-memory database.

## Tools and reused sources

| Tool | Existing read source | Required permission |
| --- | --- | --- |
| get_schedule | renderQuery, emptyResult, existing official SCHEDULE | schedule.read |
| get_courses | COHORT_COURSES, derived from the official schedule | cohort.read |
| get_cohort_info | COHORT_PROFILE, COHORT_COURSES, STUDENT_ROSTER | cohort.read |
| search_announcements | readAcademicReports, extractEventQuery, academicHistoricalRequest | announcements.read |
| get_announcement | getAcademicReport | announcements.read |
| find_student | existing roster name-token matcher, extracted as findRosterNames | roster.read |
| get_operation_status | EventStore.getJob | operations.read_own |

Course resolution uses Phase 1 semanticCourseHint. Calendar rendering uses the
original message timestamp in Asia/Baghdad. Active-report expiry uses the trusted
application clock. Temporary lecture changes remain announcement records and do
not rewrite the official schedule.

## Execution contract

Construct `ReadPlanExecutor(new ToolRegistry(mockReaders))` for offline use.
`createReadBackends(db)` supplies the reviewed existing SELECT readers, but is not
wired into the worker. No database access is available through tool arguments.

A read operation supplies `tool: { name, version: 1, input }` alongside the existing
grounded query. The executor rejects legacy read operations without this explicit
invocation rather than inferring a tool from prose. Search input text must equal
the grounded query. Input objects cannot contain roles, permissions, SQL, arbitrary
functions, or unknown fields. Invalid/missing capability grants fail closed.

The application, never the model, supplies ReadExecutionContext: verified actor,
bot/chat/thread/user scope, timestamps, allowed read capabilities, classroom scope,
and expiring target/operation handles. Both dispatcher and adapter wrappers check
capabilities. Record visibility, destination, revision and operation ownership are
checked separately. Raw database IDs in tool input are not authorization.

Private reports are visible only in their author's exact private chat/thread;
classroom records must match the trusted destination and thread. The existing
explicit group/channel association is reused. Roster lookup requires a separate
permission and returns names only: no Telegram identity, gender or personal facts
are inferred. Ambiguous and absent names remain ambiguous/empty.

Archive access needs both an explicit tool option and historical intent in the
current user's grounded instruction. Cancelled records remain excluded. Missing
records return not_found; empty searches succeed; unknown handles/tools reject;
backend failures/timeouts never become successful writes or delivery claims.

At most 12 actions, 10 returned search/name matches, 30 inspected backend rows,
64 trusted handles per category, 1 second per tool, 16 KiB per tool output and
64 KiB aggregate result budget. Dependencies require succeeded predecessors;
failed/denied/skipped predecessors block dependents. Independent reads still run.
Timeout abort signals are propagated and late results discarded. A D1 SELECT
already in flight cannot be forcibly cancelled by AbortSignal.

## Explicit limitations / Phase 3 prerequisites

- No production context provider or model/compiler integration is included.
- Existing outbox jobs have no standalone owner column. get_operation_status
  requires an independently established, expiring application ownership binding;
  getJob and a model-supplied job ID cannot establish ownership. No such binding
  means no lookup. Provenance identifies this application attestation explicitly.
- get_announcement currently supports academic report handles. Legacy event
  detail handles return a typed rejection until a separately reviewed legacy
  visibility adapter is added. Search uses existing academic report storage.
- Read-backend injection is a trusted application boundary. The supplied adapter
  exposes only SELECT statements; arbitrary injected application code is not a
  sandbox. No production model is allowed to inject code or a backend.
- Cohort facts use the configured profile/roster, not newly inferred demographics.
- Proposed next phase: compile natural language into these explicit invocations,
  supply independently verified context and handles, compare offline/shadow
  results, then review write-tool contracts separately. No deployment or write
  capability is implied by this phase.
