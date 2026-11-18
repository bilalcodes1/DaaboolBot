# Phase 3C.3 preflight fix — offline only

No live Groq, Telegram, D1, deployment, push, migrations, secret output, new
dependencies or production routing changes. The semantic prompt/schema/model and
the original 160 + 44 fixture labels are unchanged.

## Files changed

- `eval/semantic-case-selection.ts` (new): resolves the approved three existing
  fixture IDs, adapts their labels to the existing evaluator contract, validates
  synthetic trusted context and exact source spans, pins V2/model/schema and
  preflights reservations. Gold is built before any evaluated model response.
- `eval/run-semantic-lab.ts`: explicit comma-separated `--cases`; preflight-only
  selection; no unknown-ID/count fallback; route the same evaluator/runner through
  the narrower experiment limits.
- `src/semantic-eval-guard.ts`: app-owned lower request and cumulative **reserved**
  token limits. Completed reported usage never releases cumulative reservations.
- `eval/semantic-checkpoint.ts`: bind contrast limits into checkpoint identity and
  validate the cumulative cap across resumes. Missing/changing `--cases` cannot
  convert the three-case checkpoint into the older six-case experiment.
- `scripts/eval-semantic.mjs`: print selected IDs/reserve, save explicit offline
  readiness to `output/semantic-eval/contrast-readiness.json`.
- `tests/semantic-case-selection.test.ts` (new), this report, readiness artifact.

## Verified frozen selection

| ID | Exact existing text | Original expected meaning | Reservation |
|---|---|---|---:|
| iraqi_anbari-01 | شعدنا باچر؟ | read / get_schedule(tomorrow) | 4,609 |
| english-tomorrow | What's tomorrow's schedule? | read / get_schedule(tomorrow) | 4,608 |
| social-wellbeing | شلونك دعبول؟ | reply / conversation, no tool | 4,610 |
| **Total** | | | **13,827** |

Iraqi gold/context is reused unchanged. English/social meaning and text come from
the existing contrastive fixture file, without changing their labels. Their
application context is the same synthetic read-only context already used by those
offline regressions: verified user 900001, synthetic classroom/bot scope,
original timestamp 2026-10-29T22:30:00Z, Asia/Baghdad, and current source `message`.
Evidence is [0, originalText.length) in source-local UTF-16 and validates against
the actual string. Expected reply prose is an unscored synthetic placeholder;
its original action/speech act/subject are retained. No model evidence is copied
or repaired before scoring or validation.

`--cases` currently permits exactly these three distinct approved IDs, retaining
explicit order. Unknown, unsupported, repeated, missing or malformed values fail
before credentials/HTTP. There is no substitution for an unavailable case and no
falling back to the legacy six when an explicit selection fails. Legacy
`--smoke` without `--cases` remains a separate six-case mode for existing tests;
the command below explicitly selects only the new three-case experiment.

## Pinned configuration and limits

- Model: openai/gpt-oss-120b. No fallback/model change.
- Prompt: semantic-brain-v2, SHA-256
  `536a4f6fb939901db2edec93e238b3f2719236ce840481bd6549df43f6aed4f1`.
- Strict schema v1, SHA-256
  `8e0983deadf3b0c8cb3452de7023cb1f64d470165771b2c441e6ad5fe53074b4`.
- At most **3** dispatches across resumes, independently enforced by guard and loop.
- At most **20,000 cumulative reserved tokens**. Reservations are not replaced
  by cheaper reported usage in this cumulative ledger.
- At most **5,000 reserved tokens per rolling 60 seconds**, held after settlement.
- At most **600,000 ms** overall, including waits and resume gaps.
- Sequential requests; cancellable pacing; no API retries or production execution.
- Lower account/provider limits still restrict admission. These local reservations
  are estimates, not an exact tokenizer, actual API usage or monetary cost.

Preflight validates all expected plans with the existing validator and uses the
same ContextBuilder/Planner/Evaluator. No tool handlers, Telegram or database
bindings are added. Actual model proposals still receive their original schema,
normalization, evidence, scope and authority checks.

## Verification

TypeScript succeeds. **773 tests pass, zero fail, across 15 files**: all 755
previous regressions plus 18 new selection/budget/CLI tests. This is the targeted
regression set, not a claim that unrelated project suites ran. Tests forbid global
network fetch and inject API/clock/persistence mocks. They cover frozen labels,
all three actual regions, model/schema/request preflight, unknown/malformed IDs,
order, lower account limits, exact 20,000 reservation boundary, fourth-request
rejection, cumulative accounting, resume scope and the actual offline CLI.

The exact offline counterpart was executed:

```sh
node scripts/eval-semantic.mjs --cases iraqi_anbari-01,english-tomorrow,social-wellbeing
```

Result: mode=offline, datasetCases=3, the requested IDs only, reserve=13,827,
liveRequests=0. Native HTTP was never used. Mocked success is not Groq accuracy.

## Exact later live command — not executed

Only under a subsequent live instruction, with GROQ_API_KEY already in the same
process environment; never put the key in command arguments or this chat:

```sh
DAABOUL_EVAL_LIVE=1 node scripts/eval-semantic.mjs --live --smoke --cases iraqi_anbari-01,english-tomorrow,social-wellbeing
```

This is a new experiment, not a resume of the historical failed report. The
command has been verified by parsing, mock execution of the identical flags and
its offline CLI counterpart; it has **not** been verified by actual API calls.

## Remaining blockers / limits

GROQ_API_KEY is absent from the current process environment (presence-only check;
no value printed). Actual current account quota, schema acceptance, latency,
usage/cost and semantic quality remain unmeasured. No external quota probe ran.

The existing evaluator still retains sanitized canonical meaning rather than full
raw model JSON and full normalized-plan/evidence traces. This case-filtering fix
does not silently add broader response logging. The original Phase 3C.3 detailed
trace requirement needs that gap addressed before claiming a complete live
diagnostic report. Selection/budget readiness is established; no live result or
full diagnostic-recording readiness is claimed.

STOP: no live command was run; production and frozen gold remain unchanged.
