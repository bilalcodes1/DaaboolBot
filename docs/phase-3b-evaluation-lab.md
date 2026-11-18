# Phase 3B — evaluation lab (offline build)

Historical Phase 3B report. The date gaps, smoke selection, reservation profile and
verification counts below are superseded by [Phase 3B.1](phase-3b1-eval-preflight.md).
The full 160-case dataset remains unchanged; no live evaluation has run.

## A. Files

New files only; no production routing or Phase 1/2/3A behavior changed:

- `src/semantic-eval.ts`: compiler-based evaluation, semantic comparison, sanitized
  records and separate understanding/safety/usability/performance summaries.
- `src/semantic-eval-guard.ts`: disabled-by-default guarded Groq transport.
- `eval/semantic-gold.ts`: human-authored synthetic gold, version
  `daaboul-synthetic-gold-v1`.
- `eval/run-semantic-lab.ts`: offline readiness, sequential partial runs and fixed smoke selection.
- `scripts/eval-semantic.mjs`: local in-memory bundle/CLI; no .env/.dev.vars loading.
- `tests/helpers/semantic-eval-mocks.ts`: test-only encoding of human gold into mock responses.
- `tests/semantic-eval.test.ts`: offline scoring, fixture, guard and CLI tests.
- `docs/phase-3b-evaluation-lab.md`: this report.
- `output/semantic-eval/offline-readiness.json`: sanitized readiness artifact.

## B. Dataset

160 cases, 20 categories, eight cases each: Iraqi/Anbari, MSA, English, mixed,
Iraqi typos, short messages, multi-turn, old-list replies, questions/commands,
negation/quotes, examples/hypotheticals, jokes/sarcasm, save/update/cancel,
multiple announcements, groups-only bulk edits, ambiguous targets, fake admin
claims, unauthorized actions, previous-data corrections, update→publish dependencies.

All expected plans and policy alternatives are human-authored fixtures. No model
answer creates or changes gold. Cases use synthetic actor/chat/record identities,
mocked ownership and independently labelled permission attestations. No real roster,
student messages or live conversation history enters a request. Calendar fixtures
include original Baghdad midnight, relative weekdays and explicit ISO dates.
Required screenshot phrases are present verbatim. Repeated wording has different
explicit conversational context; more than 150 distinct messages are present.

Unauthorized commands have two human-labelled policy outcomes: a correctly routed
proposal denied by the validator, or a safe conversational refusal. Neither is a
permission grant or executed command.

## C. Evaluator and metrics

The evaluator injects a transport into the existing GroqPlanner/SemanticCompiler.
It captures the bounded draft for raw comparison, then records the unchanged
compiler/Phase 1 validator decision. It uses the existing registry's catalog;
handlers are never invoked. Its injected backend methods throw if accidentally
called. This is proposal review, not a second planner or write executor. Avoiding
knowledge-tool execution also avoids exposing the production roster/profile.

Per-case records contain sanitized structural model/gold plans, dimension scores,
validator decision/reasons, failure categories, measured transport latency and
provider usage when supplied. They contain no raw prompt, conversation, reply prose,
credentials or DB/API handles. Unknown model text is redacted. Structural operation
IDs and independent action ordering are canonicalized; dependency edges survive.
Read handles participate in target comparison. Aliases reuse Phase 1 normalization.

Implemented summaries:

- **Understanding:** plan exactness, speech act, action, slot micro accuracy,
  target/dependency accuracy, ambiguity accuracy/precision/recall/F1. Target and
  dependency denominators include relevant cases, not trivial absent targets.
- **Safety:** unauthorized proposals, false write proposals and those accepted by
  the validator, wrong-target acceptance, hallucinated/unsupported fields/plans.
  Actual tool/unauthorized execution counts are zero by design and explicitly
  labelled; they are not evidence of model understanding.
- **Usability:** correct completion including expected policy outcome, unnecessary
  clarification, eligible safe abstention, context resolution, validator agreement.
- **Performance:** p50/p95, reported input/output/cache/total tokens, completeness
  counts, tokens per correct plan and errors/429/timeouts. Missing usage stays null.

HTTP/transport failures affect completion/error rates but are excluded from raw
understanding when no model output arrived. Malformed model output counts as a
model failure. A rejected wrong proposal is not mislabelled a validator false
rejection; validator agreement is scored only for semantically matching gold.
Wrong-target/false-write acceptance remains visible separately. Reject-everything
has zero raw-plan and completion accuracy in its tests.

Free reply/detail prose is not evaluated by exact wording. Detail presence, typed
slots, acts and evidence/policy validity are evaluated; naturalness and semantic
equivalence of unrestricted prose still require human review.

## D. Official Groq preflight

Documentation reviewed 2026-10-29: strict mode supports `openai/gpt-oss-120b`,
requires all object properties in required, closed objects and nullable optional
values, and supports nested anyOf. Streaming/tool use is excluded. The existing
fixed schema/request matches these documented constructs.
[Groq Structured Outputs](https://console.groq.com/docs/structured-outputs).

The guarded request pins model/schema version and static system prefix, requires
dynamic context last, stream=false and strict=true, and forbids tool calling,
unknown request properties, schema changes and model downgrade. Existing low
reasoning/include_reasoning settings follow the API reference.
[Groq API reference](https://console.groq.com/docs/api-reference).

**No live schema smoke or Groq request was performed.** Documentation readiness is
not actual provider acceptance. On 400, the future lab records status/code/type and
bounded exact error text with secrets removed, stops, and requires manual review
of the smallest schema correction. It never switches to weaker JSON mode.

## E. Offline verification

TypeScript succeeds. **636 tests pass, zero fail:** all 440 previous tests plus
196 new tests, across the requested 11-file regression set. This is not a claim
that unrelated project suites were rerun.

New tests cover fixture evidence/labels, round-trip mocked predictions, scoring
denominators, canonical dependencies, false writes/wrong targets, safe refusal,
context isolation, request shape, both opt-ins, synthetic prompt allowlist, token/
request stops, mock HTTP errors, timeout, partial runs, sanitized output and the
actual default offline CLI. Fetch is forbidden globally; HTTP-response mocks are
explicit injections. Offline readiness has zero model requests and null real
accuracy. Mock round-trip tests are integration checks, not Groq accuracy.

## F. Future live guards and estimated budget

Both `--live --smoke` and `DAABOUL_EVAL_LIVE=1` are required. The credential must
already be in `GROQ_API_KEY`; it is never read from a file or command argument.
Only the exact curated synthetic prompts are admitted. No Telegram/D1 bindings
exist. Requests are sequential, redirect=manual, without retries/downgrades.

Per-run ceilings: 12 HTTP requests, 50,000 total reported tokens, 5,000 reported
tokens/minute. Admission reserves the existing conservative request estimate
(including 2,048 maximum completion tokens), then settles from reported usage.
Cached tokens are conservatively included in these local limits. Missing usage
halts the run with the reservation retained, not a fabricated zero cost.

Before a later authorized run, inspect the organization limits in Groq Console.
Optional `DAABOUL_EVAL_ACCOUNT_TPM` records an operator-inspected lower TPM; it can
never raise the local 5,000 ceiling. When unavailable, source is explicitly
`unavailable_conservative`. Response limit/remaining/reset/retry headers further
restrict admission. Groq limits apply at organization level; request headers use
daily request counts, while token headers use TPM. 429/auth/400/errors or exhausted
budget stop immediately; there is no automatic sleep/retry/resume.
[Groq rate limits](https://console.groq.com/docs/rate-limits).

Offline estimates: **4,871–5,145 reserved tokens/request**. The twelve selected smoke
reservations sum to about **59,800 tokens**, not predicted billing. The 50,000 total
ceiling and 5,000 minute ceiling therefore may stop before 12. Five selected cases
individually exceed the conservative 5,000 reservation and cannot currently be
admitted. No guard is relaxed to conceal this; readiness lists their IDs. A future
separately reviewed prompt/completion-budget reduction is needed to admit them.

Actual requests/quota/cost for this build: **zero**. No live latency, token usage,
cache savings or monetary cost was measured.

## G. Known gaps

1. **Five validator false rejections already reproducible without a model:**
   prefixed relative dates such as `للثلاثاء`/`للخميس`/`للجمعة`/`للأربعاء` do not
   satisfy the current Phase 1 literal weekday check. Human gold remains unchanged,
   expected decision remains allow, and these score as validator failures. They are
   annotated knownValidatorGap, not re-labelled to make the checker look accurate.
   No production validator fix is made in this phase.
2. No live model understanding, fluency, schema acceptance or account quotas have
   been measured. Gold is an initial curated set, not a statistically representative
   language benchmark; review and held-out expansion are still needed.
3. Proposal acceptance is Phase 1 acceptance, not Phase 2 runtime permission or
   actual delivery. Runtime read enforcement remains covered by existing tests.
4. Token estimates are not an exact tokenizer. An unexpected provider usage report
   can exceed its reservation; the guard records the **actual** amount, flags
   observedBudgetBreach and stops immediately. No retrospective API client can
   unconsume tokens already reported. An absolute no-overshoot billing guarantee
   needs a verified tokenizer/provider-side cap; this implementation does not
   pretend otherwise. Local counters are per run; organization usage may differ.
5. Sanitized structural plans omit free prose and unknown text. Scores still retain
   mismatch categories; qualitative prose review needs a separately approved path.

## H. Exact command for a LATER approved smoke

Do not run until separately authorized. With the existing credential already in
the terminal environment, from the project directory:

```sh
DAABOUL_EVAL_LIVE=1 node scripts/eval-semantic.mjs --live --smoke
```

This command may produce a partial run because the conservative budgets above
remain enforced. It does not evaluate all 160 cases or activate the bot.

Safe default, already tested:

```sh
node scripts/eval-semantic.mjs
```

Only offline readiness metadata is written by the default command. Later live
records would be sanitized JSON under output/semantic-eval, mode 0600.

STOP: no live command, deploy, push, migrations or production changes performed.
