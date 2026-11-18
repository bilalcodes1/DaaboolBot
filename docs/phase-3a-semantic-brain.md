# Phase 3A — semantic brain, offline only

## A. Files changed

New files only; Phase 1/2 contracts, worker routing and production configuration
are unchanged:

- `src/semantic-draft.ts`: ModelPlanDraftV1, strict wire/local schemas and normalization.
- `src/groq-planner.ts`: injectable one-request GroqPlanner, bounds and metrics.
- `src/semantic-compiler.ts`: ContextBuilder, SemanticCompiler and ReadSemanticBrain.
- `tests/fixtures/semantic-brain-fixtures.ts`: 25 labeled fixtures with independent
  expected SemanticPlanV1 plans.
- `tests/semantic-compiler.test.ts`: mocked integration, schema and trust tests.
- `docs/phase-3a-semantic-brain.md`: this report.

## B. Pipeline

Application input and independently supplied ReadExecutionContext → ContextBuilder
→ GroqPlanner(mock transport) → bounded JSON parsing → ModelPlanDraftV1 local
validation/normalization → unchanged Phase 1 SemanticValidator → unchanged Phase 2
ReadPlanExecutor → typed read results.

SemanticCompiler.compile returns the versioned proposal, validation summary and
metrics. ReadSemanticBrain.run executes only a validated read/reply plan whose
compilation status is ready. Any write/publish in the plan prevents execution of
the whole plan, including otherwise independent reads. Authorized write plans
remain proposal_only; unproven intent/authority/targets retain validation errors.

Conversation and clarification return model reply proposals without tools. Empty
draft operations are an explicit no_op, not a claim that an empty plan passed
Phase 1 (which deliberately requires a nonempty plan). Missing typed read inputs
produce clarification_required with missing field names.

## C. Strict schema compatibility

Model: openai/gpt-oss-120b. Request format: json_schema, strict=true, stream=false,
temperature=0, max_completion_tokens=2048, reasoning_effort=low, include_reasoning=false.
There are no tools/tool_choice or simultaneous function calls.

Every object is closed and every property required. Optional draft sections and
values use nested anyOf with null. The root is an object. The conservative wire
subset uses only type, properties, required, additionalProperties, items, enum and
anyOf. There are no conditional schemas, refs, root unions or combinatorial
SemanticPlan unions. Separate local schemas enforce string/array/integer bounds;
strict provider output is never sufficient for authorization or domain validity.

These structural rules are checked recursively in tests and follow the existing
local assistant-ai.ts conventions. **Current vendor documentation and actual
Groq acceptance were not verified:** this phase forbids all network access. This
is a local compatibility check, not provider certification. A controlled Phase 3B
schema-acceptance check is still required; do not weaken local contracts to pass it.

The existing model constant, message type and pure request-token estimator are
reused. The existing live gateway itself is not called: it can write quota/cache
state and invoke external providers, which this phase forbids.

## D. Verification

TypeScript passes. Targeted Vitest run: **440 passed, 0 failed** across 10 files:
365 preserved tests and 75 new tests. This is the requested regression set, not a
claim that every unrelated project test was rerun.

Fixtures cover Iraqi Arabic, MSA, English, mixed language and typos; save/question/
negation/correction, jokes, sarcasm, praise, aliases, coverage, pending answers and
reference selection. Other tests exercise actual Phase 1 and Phase 2 validation,
scope isolation, independent quote adoption, ambiguous targets, update→publish,
invalid schemas/JSON/evidence, injected authority, expiry while planning, backend
errors/timeouts and sanitized metrics. Global fetch is forbidden in new tests;
read backends and planner responses are mocks. No real D1 is supplied to this path.

**Mocks test integration and safety behavior, not real model understanding.
No mocked fixture pass rate is reported as Groq accuracy.**

## E. Trust/security boundaries

- Original text and UTF-16 source evidence survive unchanged. Negation is retained
  even when application-labelled sources cover only part of the original message.
- Only application context supplies verified actor, permissions, ownership grants,
  allowed handles, snapshots and revisions. The model has no fields for these.
- Context is snapshotted before awaiting the model. Foreign/expired history,
  pending requests and read data are omitted. At most two short conversation turns
  are sent; no group-history collection exists.
- Quotes, replies, previous conversation and read data are labelled as untrusted
  data, encoded inside a user-role JSON message after the static system prefix.
  Embedded instructions cannot create application attestations. Read instructions
  require current-user evidence; quote adoption for write data needs independent
  Phase 1 application attestations. Model claims alone cannot grant adoption.
- The model sees opaque reference handles/selectors, not ownership snapshots or
  authoritative versions. The real read dispatcher independently enforces scope,
  permissions and record ownership. Planning elapsed time advances the trusted
  execution clock for expiry checks; originalTimestamp remains fixed for dates.
- Normalization distinguishes explicit clear from null/missing and preserves
  update/publish dependencies. It never manufactures timestamps, groups, source
  verification, DB authorization or success receipts.
- Reply prose is marked model_proposal and has no renderer or delivery path. It
  must never be treated as a successful execution receipt. Read results come only
  from the existing typed executor; no second AI call synthesizes claimed results.
- The injected transport is trusted application code, not a sandbox. This module
  has no default fetch transport, secret input, DB, retry/fallback provider, quota
  cache or Telegram binding. Errors return bounded categories, not raw messages.

## F. Prompt size, metrics and costs

Static instructions first; dynamic scoped context last. Only compact tool
signatures and academic aliases are included, not full registry descriptions or
large output schemas. Local course normalization supplies a hint, not intent routing.

Measured offline prompt sample (short Iraqi course question, no history/handles):
message JSON 3,936 bytes, 3,570 content characters; full request 8,148 bytes.
The reused heuristic estimates 2,840 input/framing/schema tokens and reserves
2,048 output tokens, giving a 4,888 request-token estimate. These are estimates,
not tokenizer output, billed tokens, cache savings or live latency measurements.

Metrics expose prompt bytes/characters, separate heuristic estimates, measured
planner transport latency, optional provider-reported prompt/completion/total/
cached token fields, planner errors, normalization errors and validator rejects.
Missing usage/cache counts remain null/absent, never fabricated zeroes. Synthetic
usage test values are explicitly mocks. Prompts, secrets and student data are not
persisted in diagnostic logs.

Hard bounds: 32 KiB serialized request/model JSON, 12 operations, bounded field
values, one planner request with a 2-second default timeout (configurable up to
10 seconds), no automatic retries or second request. Phase 2 retains its separate
read/output limits. Oversized or truncated output fails closed.

Actual external requests, live quota consumption and API charges in this phase:
**zero**. No current provider price/free-tier guarantees were checked.

## G. Gaps and limitations

Semantic validation proves structure/evidence/permissions, **not correct intent
understanding**. A model can still misclassify meaning while returning structurally
valid JSON; mock fixtures do not measure that risk or Iraqi fluency. Prompt
instructions alone are not a complete prompt-injection defense: application scope
and capabilities remain the enforcement boundary.

There is no production context provider, automatic identity inference, durable
pending state, write attestation builder, write executor, response renderer or
publication path. Dependency ordering is supported; arbitrary interpolation of one
read result into a later tool argument is not. Long multi-action drafts may exceed
the 2,048-token allowance and be rejected rather than silently truncated. Existing
Phase 2 legacy-detail and operation-ownership limitations still apply.

## H. Phase 3B proposal — not performed

With separate authorization, first check vendor schema acceptance using one small
synthetic request. Then evaluate a versioned held-out language dataset using
synthetic classroom data and mocked read backends. Measure intent, aliases,
negation/adoption, reference resolution, clarification quality, injection resistance,
latency and provider-reported token usage separately. Compare semantic plans and
actual typed read outcomes to human-labelled expectations. Keep production routing,
Telegram sends, real student data and every write/publish tool disabled throughout
that evaluation. Review failures and budget before any later activation.

STOP: no deployment, push, live evaluation, migrations, secrets or production edits.
