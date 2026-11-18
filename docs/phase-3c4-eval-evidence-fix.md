# Phase 3C.4 — evaluation evidence fix

Offline implementation and mocked evaluation only. No live Groq requests,
Telegram, production D1, migrations, deployment, push or production routing
changes. No dependencies added. Prompt V2 and frozen gold labels are unchanged.

## A. Files changed

- `eval/semantic-evidence.ts`: bounded evidence capture, persistence redaction,
  span/source diagnostics and full evidence checks for resume.
- `src/semantic-eval.ts`: opt-in full trace, captured usage on HTTP errors,
  untouched raw scoring before redaction, late-response protection. Invalid model
  evidence is no longer labelled a validator false rejection.
- `src/groq-planner.ts`: export the existing usage parser for reuse. Planner
  requests, prompt, model, timeout and schema are unchanged.
- `src/semantic-eval-guard.ts`: numeric allowlisted response metadata and shared
  error redaction, including malformed sensitive bodies.
- `eval/semantic-checkpoint.ts`: evidence-required checkpoint v2, identity,
  completeness, schema, source, normalization and accounting verification.
- `eval/run-semantic-lab.ts`: enable the trace for each guarded synthetic request
  and include it in the existing checkpoint after each settled case.
- `scripts/eval-semantic.mjs`: bounded serialized files; retain atomic owner-only
  checkpoint writes, lock, fsync, rename and write-ahead protection.
- `tests/semantic-eval-evidence.test.ts`: 28 new mocked regressions.
- This report; regenerated `output/semantic-eval/contrast-readiness.json` offline.

## B. Evidence saved

Each new live-mode record contains `evidence`: case ID, timestamp, original
synthetic message, full frozen expected plan, exact model content, parsed draft,
full normalized SemanticPlanV1, normalization status, validator verdict and reason
codes, original evidence spans and UTF-16 source regions, action/entity/target/
dependency comparison, actual API-reported input/output/total/cache tokens,
latency, HTTP status, numeric rate-limit headers, sanitized provider error,
planner error and model/prompt/schema identity hashes.

No-secret raw model content preserves original whitespace and escaping. Scoring
and validation always use the untouched response first. Only the persisted copy
is redacted. Truncation, redaction, missing content and unavailable stages are
explicit; missing usage remains null. Malformed JSON retains its bounded raw
content. Malformed sensitive content can be withheld rather than expose a key.
HTTP errors have no fabricated model content. No request headers or environment
snapshots are persisted.

Scoring separates raw semantic match, model correctness including contract/evidence
checks, JSON correctness, local schema validity, normalization fidelity, validator
policy comparison and read execution eligibility. A wrong proposal is not model
success just because the validator rejects it. Read candidates still require
runtime authorization/backend checks. Tools executed = 0; final response
possibility is unmeasured. Prose quality and factual accuracy require review.

Model ID: `openai/gpt-oss-120b`. Its hash is SHA-256 of the identifier, **not**
model weights. Prompt V2's raw UTF-8 hash remains
`536a4f6fb939901db2edec93e238b3f2719236ce840481bd6549df43f6aed4f1`.
The checkpoint's existing prompt-hash convention is SHA-256(JSON.stringify(prompt)):
`0da66cab0dfe91c051b45b3d677f11323577db3b49d825443a39c6235c1a2175`.
Schema V1 hash remains
`8e0983deadf3b0c8cb3452de7023cb1f64d470165771b2c441e6ad5fe53074b4`.

## C. Verification

TypeScript passes. **801 tests pass, zero fail, across 16 files**: the previous
773 targeted regressions plus 28 evidence tests. This is the existing targeted
semantic/assistant/read-tool regression set, not a claim that unrelated suites ran.

Mocks cover exact persistence, wrong action, invalid evidence, malformed JSON,
429/400/auth errors, actual reported error usage, timeout, late completion,
interrupted body delivery, unknown usage, safe resume without repeating completed
calls, missing trace fields, legacy rejection, multibyte size limits, oversized
provider bodies, escaped secrets, malformed multiline authorization and parseable
sanitized JSON. Native global fetch is forbidden in these tests. Simulated
live-mode results are never reported as actual Groq accuracy.

The exact offline counterpart also passed, returning liveRequests=0:

```sh
node scripts/eval-semantic.mjs --cases iraqi_anbari-01,english-tomorrow,social-wellbeing
```

## D. Resume and persistence safety

Checkpoint v2 requires complete evidence and verifies model, prompt, schema,
frozen gold/context, selected IDs/order, individual trace structure, original
sources, normalized plans, ledger, receipts and rolling reservations. Existing
v1 checkpoints lacking evidence are blocked without automatic upgrade. In-flight
unknown outcomes and terminal errors cannot be automatically replayed.

Checkpoints use temporary owner-only files, file fsync, atomic rename and directory
fsync. Write-ahead markers remain in place if persistence fails after dispatch.
Original historical reports remain incomplete. The old live report's SHA-256 is
still `afbeb7795b686277f18a70d5ea257914f55449dbba076a1d401bd4126093f718`;
its missing raw response and spans were not invented or reconstructed.

Limits: provider body 64 KiB, captured model content 32 KiB, evidence record
256 KiB, serialized local output/checkpoint 4 MiB. The storage cap accounts for
raw + parsed + normalized copies; it does not increase any API token budget.
Oversized data is marked incomplete, bounded and stopped; errors/partial runs
remain saved. No D1 or Telegram bindings are introduced.

## E. Remaining blockers

No real calls ran. Actual schema acceptance, model understanding, account limits,
usage and latency remain unmeasured. The process credential is absent (presence
check only; no secret files read). A subsequent explicit live authorization and
an environment credential are needed for the next experiment. Offline compatibility
and mocked evidence capture do not prove live acceptance or production readiness.

## F. Exact next live command — verified offline, not executed

With the credential already in the environment, under a later live authorization:

```sh
DAABOUL_EVAL_LIVE=1 node scripts/eval-semantic.mjs --live --smoke --cases iraqi_anbari-01,english-tomorrow,social-wellbeing
```

Exactly those three IDs; maximum 3 requests, sequential, no retries/fallback,
5,000 reserved tokens per rolling 60 seconds, 20,000 cumulative reserved tokens,
50,000 reported-token hard cap and a 10-minute original deadline. Reservations
are 4,609 + 4,608 + 4,610 = **13,827**. Lower actual account limits still apply.
This is a new experiment, not a resume of the incomplete historical report.

STOP. No live command or production integration performed.
