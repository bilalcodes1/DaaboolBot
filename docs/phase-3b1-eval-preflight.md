# Phase 3B.1 — local evaluation preflight

Historical preflight. Pacing/checkpoint behavior is superseded by
[Phase 3C.1](phase-3c1-live-eval-pacing.md). The later user-supplied live report
contains one actual response; no new live requests ran during Phase 3C.1.

Local changes and mocked tests only, 2026-10-30. Zero live requests. No Telegram,
D1 writes, migrations, deployment, push, secrets, dependencies or production routing
changes. Legacy production NLU is untouched. Semantic modules remain disconnected
from the production worker. The full 160 original messages/labels/contexts remain
unchanged; historical knownValidatorGap annotations identify regression cases,
not a current exemption from validation.

## A. Files changed

- `src/semantic-validator.ts`: evidenced contracted weekdays; conservative
  adjacent weekday/ISO mismatch check. Relative values remain unresolved.
- `src/groq-planner.ts`: bounded optional completion allowance; existing default
  remains 2,048. Only the evaluation runner selects 1,024.
- `src/semantic-eval.ts`: pass the lab allowance to the existing planner; report
  HTTP/schema, local schema, normalization and execution eligibility separately.
- `src/semantic-eval-guard.ts`: shared conservative reservation breakdown, explicit
  15% input margin, pinned 1,024 evaluation output budget, lower account RPM check,
  estimated vs reported accounting and settlement-time rolling window.
- `eval/semantic-preflight.ts` (new): adaptive selection and local schema/hash check.
- `eval/run-semantic-lab.ts`: use selection, current date-regression status and
  schema preflight in offline/later-live reports.
- `tests/semantic-eval.test.ts`: keep all existing cases, expect repaired dates to
  pass; exercise the lab profile and updated minute-boundary sample.
- `tests/semantic-eval-preflight.test.ts` (new): five regressions, calendar/evidence,
  budget boundaries, independent label/permission spot checks and offline guards.
- `docs/phase-3b-evaluation-lab.md`: mark prior budget/gap findings historical.
- This report; regenerated `output/semantic-eval/offline-readiness.json`.

## B. Five date findings

All five expressions are valid relative language. Original Telegram timestamp is
`2026-10-29T22:30:00Z`, **Friday 2026-10-30 01:30 Asia/Baghdad**. Processing time
must not replace it. These fixtures do not choose an absolute occurrence of a
weekday, particularly the same-day Friday case.

| Case | Original message | Expected meaning | Actual normalized date value, before and after repair | Prior rejection |
|---|---|---|---|---|
| save_update_cancel-05 | غير موعد الأول للخميس | Relative Thursday | `{kind:"relative",text:"للخميس"}` | ungrounded_value / date |
| save_update_cancel-06 | أجل امتحان الرسومات للثلاثاء | Relative Tuesday | `{kind:"relative",text:"للثلاثاء"}` | ungrounded_value / date |
| correction_previous-01 | صحح الأول للثلاثاء | Relative Tuesday | `{kind:"relative",text:"للثلاثاء"}` | ungrounded_value / date |
| correction_previous-05 | التبليغ السابق للجمعة | Relative Friday; no invented same-day/next-week choice | `{kind:"relative",text:"للجمعة"}` | ungrounded_value / date |
| correction_previous-07 | بدل تاريخ الرسومات للأربعاء | Relative Wednesday | `{kind:"relative",text:"للأربعاء"}` | ungrounded_value / date |

Common root cause: **validator lexical grounding**, not a failed date conversion.
Arabic `ل + الـ` contracts to `للـ`; the old recognizer required `الخميس`,
`الثلاثاء`, etc. Those exact substrings are absent from `للخميس`, `للثلاثاء`,
`للجمعة`, `للأربعاء`. Hamza/taa normalization does not restore the missing alef.

Repair: accept only a whole, evidenced contracted weekday as an additional
relative form. No evidence span, date value, original message, permission,
scope, ownership, revision or expiry check is removed. All five now pass the
existing validator with valid application context. Expired bindings still fail.
The original expression survives unchanged; **there is still no new date resolver**.

Additional guards reject invalid Gregorian ISO dates and ISO dates disguised as
relative text, including Arabic digits. Explicit adjacent weekday/ISO claims
(Arabic or English, either order) must agree with the Gregorian calendar or the
validator requests clarification. Numeric day/month expressions outside the
current ISO/relative contract have not gained an inferred date interpretation.

## C–D. Adaptive smoke and reservations

Six default cases; four core language/action cases come first, followed by context
and a forged-admin request. Select fewer when lower account/request/reserve limits
require it; missing core coverage is a pre-request blocker. No case is rewritten
or relabelled to lower its budget. Maximum selection is six, total planned reserve
is capped at **35,000**, independent hard ceilings stay **50,000 total / 5,000 per
rolling minute / 12 requests**.

| ID | Coverage | Input estimate | Input margin | Output reserved | Total reserve |
|---|---|---:|---:|---:|---:|
| iraqi_anbari-01 | Iraqi read, tomorrow | 2,833 | 425 | 1,024 | 4,282 |
| english-02 | English question/read | 2,832 | 425 | 1,024 | 4,281 |
| negation_quote-01 | Do not save | 2,845 | 427 | 1,024 | 4,296 |
| save_update_cancel-01 | Create, visual programming, Sunday, five-lecture coverage | 2,855 | 429 | 1,024 | 4,308 |
| old_list_reply-02 | Scoped second-list-item read | 3,070 | 461 | 1,024 | 4,555 |
| fake_admin_claim-01 | Verified student claims admin; publish denied or safe refusal | 3,028 | 455 | 1,024 | 4,507 |
| **Total** | | **17,463** | **2,622** | **6,144** | **26,229** |

Input estimate reuses the existing script-aware estimator including schema and
framing. An additional ceil(15% × input estimate) is reserved. Output reserves
the complete max_completion_tokens=1,024. This is **not an exact tokenizer,
predicted billing, actual usage or a measured accuracy score**. Provider usage
is recorded separately. No live tokens were consumed here.

## E. Minute-budget behavior

Immediately before every actual request the guard checks the real payload,
synthetic allowlist, single-request size, total remaining reserve, rolling 60-second
consumption plus the new reservation, and lower operator/provider limits.
Usage is retained for a full 60 seconds after response settlement. Exactly equal
to the cap is allowed; one token over is stopped before HTTP. Missing usage retains
the unknown reservation and stops. Unexpected reported overages are recorded
without clamping, flagged and stopped. Lower account RPM is separate from daily
remaining-request headers. Provider reset/retry metadata cannot raise local caps.

Requests remain sequential with **no automatic sleeping, resuming or retrying**.
After one normal response there may be insufficient minute headroom for another
4.3k reservation: the run then stops with a precise partial report. Six selected
cases do not mean all six will run in one minute. Selection solves individual and
total preflight blockers; the runtime limiter deliberately retains this stop.
429, schema/request 400, auth errors and timeout stop processing. No JSON-mode,
model, output-budget or schema fallback occurs.

## F. Schema readiness and evaluation quality

Exact schema name `semantic_plan_draft_v1`, version **1**. SHA-256 of
`JSON.stringify(MODEL_PLAN_DRAFT_JSON_SCHEMA)`:

`8e0983deadf3b0c8cb3452de7023cb1f64d470165771b2c441e6ad5fe53074b4`

The actual planner payload is tested: `openai/gpt-oss-120b`,
response_format=json_schema, strict=true, closed objects, every property required,
nullable optional fields, stream=false and no tools. Local schema walk finds
**11 closed objects / 25 nullable fields**. Schema/version are unchanged.

The stored 2026-10-29 review links the official
[structured-output documentation](https://console.groq.com/docs/structured-outputs)
and [API reference](https://console.groq.com/docs/api-reference). **Current docs
were not fetched in 3B.1**, because this phase forbids external calls. Local
compatibility and a stored doc review do not prove current provider acceptance.
Live acceptance remains not_tested.

Records now separate raw semantic comparison, HTTP 200/400 observation, local
schema validity, normalization/reason, validator decision, execution eligibility,
latency and provider-reported tokens. HTTP 200 is not semantic success. An allowed
write is proposal_only; allowed reads still require runtime checks. No executor
is connected. Reject-everything still scores zero completion/raw accuracy.

Human spot checks cover all six selected labels, original Baghdad date, the visual
programming alias/coverage and both positive and denied permission contexts.
English smoke uses an actual question, not the imperative `Tell me...` labelled
as a question by the original general read-fixture helper. That helper also labels
other imperative reads as question. The untouched full gold therefore still needs
a speech-act review before a whole-dataset accuracy claim. Also, `التبليغ السابق`
in correction_previous-05 has an underspecified conversational target; its date
grounding regression is valid, but target semantics require human adjudication.
It is excluded from smoke. No model output was used as its own ground truth.

## G. Verification

TypeScript succeeds. **663 tests pass / 0 fail** across 12 files: all 636 previous
cases plus 27 new tests. This is the original 11-file regression set plus the new
preflight suite, not a claim that unrelated project suites ran. The new suite forbids global fetch; transport mocks are explicitly
injected. Existing tests include mock 429/schema 400/auth errors, timeout, partial
runs and zero-network default CLI. The new tests cover all five contracted dates,
clock/evidence/expiry, weekday mismatch, reserved/actual accounting, adaptive
selection, total exhaustion, exact rolling boundaries, oversized requests and
lower account limits. The exact default CLI was also run offline; readiness records
zero live requests, null model accuracy and no remaining prefixed-weekday rejection.

## H. Remaining limits

- No live schema acceptance, latency, accuracy, token consumption or actual account
  quota has been measured. Recheck current docs/account limits before authorization.
- Rolling-minute limits may stop a partial smoke; this phase adds no automatic wait.
- The reservation is conservative but not a verified tokenizer. Unexpected usage
  cannot be retrospectively unconsumed; it is retained, flagged and stops the run.
- 1,024 output tokens may truncate a response; existing planner fails closed on
  non-stop finish reason and never silently increases allowance or retries.
- Full-dataset speech-act labels and the noted prior-target ambiguity need human
  adjudication before broad accuracy reporting; the six smoke labels were spot checked.
- Relative-date execution resolution remains future work, anchored to original
  Telegram time and Baghdad, not to evaluation/processing time.

## I. Exact later command — NOT executed

Only after separate explicit live authorization, with GROQ_API_KEY already in the
terminal environment (never written in command arguments or read from a file):

```sh
DAABOUL_EVAL_LIVE=1 node scripts/eval-semantic.mjs --live --smoke
```

Optional DAABOUL_EVAL_ACCOUNT_TPM may record an inspected lower account limit;
it cannot raise the local ceiling. The default remains offline:

```sh
node scripts/eval-semantic.mjs
```

STOP: await separate live authorization. No live command was run.
