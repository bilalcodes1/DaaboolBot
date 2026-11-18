# Phase 3C.1 — inspect one live result, fix pacing offline

No new Groq calls, Telegram, D1, migrations, deployment, push, secrets or production
changes. The one historical result below comes from the explicitly supplied file
`output/semantic-eval/smoke-2026-10-30T07-11-04-821Z.json`, not from a new run here.
The original report is preserved. Human gold, semantic prompt and model remain unchanged.

## A. First live result

One completed API response, case **iraqi_anbari-01**, input **«شعدنا باچر؟»**.
The transport succeeded (HTTP 200; no planner error). The first case was
**semantically incorrect**. Second case english-02 was stopped before dispatch.

| Dimension | Gold | Stored model meaning |
|---|---|---|
| Speech act | question | question |
| Action | read | reply |
| Subject | schedule | conversation |
| Tool | get_schedule | absent |
| Period | tomorrow | absent |
| Target / dependencies | none / none | none / none |

The original synthetic timestamp is 2026-10-29T22:30:00Z, Friday October 30 at
01:30 Baghdad; tomorrow would be Saturday October 31. Gold intentionally requests
the relative `tomorrow` period rather than inventing a model-supplied absolute date.

Normalization reported **ok**. Validator rejected with **invalid_evidence**;
executionEligibility=not_eligible. The original file retains sanitized canonical
model/gold meanings, not the complete raw draft, evidence offsets, reply prose or
normalized SemanticPlanV1. Those cannot be reconstructed. The precise invalid
source/span is therefore unknown. A validator rejection is not correct understanding.

## B. Actual API usage and latency

- Input: **1,905** tokens.
- Output: **196** tokens.
- Total: **2,101** tokens.
- Cached tokens: **not reported**, not a fabricated zero.
- Transport/planner latency: **1,051 ms**. One sample cannot establish a useful
  latency distribution, p50/p95 or general quality claim.

Historical rate headers: limitTokens=8,000; remainingTokens=5,807;
remainingRequests=999 (daily remaining requests, not RPM);
resetTokensMs=16,447. These are historical observations, not current account limits.

## C. Schema acceptance

The report records HTTP 200, localSchemaValid=true and normalization=ok, with
strict JSON schema metadata for openai/gpt-oss-120b. Thus this strict-schema request
was accepted on that run; semantic correctness did not follow. The preflight's
static `liveAcceptance=not_tested` was not updated by the older reporter and must
not override the per-case HTTP/local-schema observations.

Schema version 1, SHA-256:
`8e0983deadf3b0c8cb3452de7023cb1f64d470165771b2c441e6ad5fe53074b4`.
The historical report has no prompt identity/hash, complete request hash, durable
in-flight ledger or reliable reservation timestamps. File modification time is
not substituted for any of those.

## D. Semantic accuracy of this single case

Speech act 1/1; action 0/1; typed slots 0/2; full meaning 0/1. There is no
target/dependency-bearing case here to score meaningfully. Failure categories:
wrong_action, wrong_entity (missing tool/period), invalid_or_unsupported_plan.
Validator reason: invalid_evidence. No false write or unsafe action executed.

Cause established by the stored evidence: wrong semantic routing plus invalid
evidence. The exact model reasoning, prompt failure and invalid offsets are not
available, so no more specific cause is asserted. Recommendation: repair/retest
this semantic failure offline before another authorized live quality experiment.

## E. Pacing implementation

Files changed:

- `src/semantic-eval-guard.ts`: capacity calculation shared by pre-request waiting
  and transport admission. Bounded, cancellable waits outside the existing planner
  deadline; strict reservation retention in paced mode; snapshot/restore and
  cumulative deadline/account limits.
- `eval/semantic-checkpoint.ts` (new): versioned checkpoint, identity, records,
  receipt/window accounting and fail-closed resume validation.
- `eval/run-semantic-lab.ts`: use existing SemanticEvaluator/Compiler/Planner only;
  sequential pacing, durable lifecycle callbacks, completed-case skipping and
  safety stops. No tool handler execution.
- `scripts/eval-semantic.mjs`: atomic 0600 checkpoint replace with file/directory
  fsync, per-checkpoint process lock, SIGINT/SIGTERM cancellation, safe offline
  checkpoint check. No secret file loading.
- `eval/semantic-preflight.ts`: update readiness wording for pacing.
- `tests/semantic-eval-pacing.test.ts` (new); previous report supersession note;
  this report and regenerated offline readiness.

Why the previous run stopped: **2,101 reported + 4,281 next reservation = 6,382**,
above the 5,000 rolling cap. No second HTTP request was sent.

New paced mode holds the **full 4,282 first reservation** for 60 seconds after
settlement, even when actual usage is only 2,101. The next reservation would make
8,563, so it waits for capacity. Reported API usage remains a separate counter.
If reported usage exceeds its reservation, the larger amount is retained and
budget breaches stop the run; estimates are not an exact tokenizer.

Limits are unchanged or tighter: **six total smoke dispatches across resumes**,
**5,000 reserved per rolling 60 seconds**, **50,000 reported total**, **ten minutes
absolute duration including waiting/HTTP/cancellation/resume gaps**. Selection
stays the same six synthetic cases, reserve 26,229. Existing generic unpaced
transport tests retain their older 12-request harness cap; the paced runner/guard
independently enforce six.

Waiting is in cancellable <=1-second slices with capacity rechecked each time and
again immediately before HTTP. The whole run has a fixed deadline and the wait
loop is bounded; a non-advancing clock fails closed. A request larger than a hard
or inspected lower TPM cap is rejected without waiting. Provider token/request
remaining credits use their recorded reset times; missing reset information fails
closed rather than probing. Lower inspected limits survive resume and cannot be
raised by omitting/changing the next environment setting. There are no parallel
calls or automatic API retries. 429, 400, auth failures, unknown usage, timeout,
safety failure and exhausted budget stop the run.

The ten-second existing planner deadline covers an actual attempt only. Waiting
does not falsely trigger planner timeout. Evaluation cancellation/deadline also
aborts in-flight HTTP; unknown outcomes/costs cannot be automatically replayed.

## F. Resume readiness

**The supplied historical report is NOT resumable.** Local validation returns
legacy_report_missing_reliable_checkpoint before credentials or transport access.
No conversion from sanitized plans, inferred prompt identity or file timestamps
is performed. The first call is not repeated, and the remaining five are not run.

Future paced runs create a separate checkpoint before dispatch and after each
result, recording completed case IDs/results, cumulative requests/usage, full
reservation window, per-case receipts/rate headers, original start/deadline,
model/schema/prompt identities and full synthetic gold/context/request hashes.
Identity/record/accounting/clock/receipt mismatches block resume. The integrity
hash detects corruption; it is not a cryptographic signature against a deliberate
editor of the local owner-controlled checkpoint.

An in-flight marker is fsynced before sending. After a crash with an uncertain
call, or failure to persist its returned result, resume stops rather than guessing
whether to repeat it. Terminal API/safety failures are not retried. A cancellation
strictly before a request may resume within the original deadline; completed
cases and their costs are carried forward. A complete checkpoint makes zero new
calls. Invalid checkpoints cannot grant production permissions or execute tools.

New CLI modes:

- `--check-resume PATH`: offline identity/accounting check, no credential needed.
- `--live --smoke --resume PATH`: only for a valid new checkpoint and separately
  authorized live work with both existing opt-ins; never for the supplied legacy file.

## G. Offline verification

TypeScript succeeds. **689 tests pass, 0 fail across 13 files**: all 663 previous
tests plus 26 new pacing/checkpoint tests. This is the prior regression set plus
the new pacing suite, not a claim that unrelated suites ran. Tests inject clocks,
sleeps and HTTP responses; global fetch is forbidden.
Coverage includes first reserve 4,282, delayed second request, full reservations,
six-request/total/duration limits, lower provider/account limits, HTTP errors with
no retry, cancellation during wait/HTTP, skipped completed cases, preserved
costs/deadline/window, corrupt identity/receipts, expired/uncertain checkpoints,
before/after-dispatch persistence failure, complete checkpoint with no replay,
and rejection of the actual historical report. The safe CLI check was executed
offline and returned exit code 2 with liveRequests=0. Default readiness remains
offline, reports six requests / 50,000 total / 5,000 rolling / 600,000 ms caps,
and has zero new live requests. The original live report remains 8,662 bytes.

## H. Exact safe command and stop

There is **no safe live resume command for the supplied report**. This exact local
check is safe and was run; expected result is blocked, zero API calls:

```sh
node scripts/eval-semantic.mjs --check-resume output/semantic-eval/smoke-2026-10-30T07-11-04-821Z.json
```

For a future valid checkpoint, replace PATH only with that actual checkpoint
filename, after explicit live authorization:

```sh
DAABOUL_EVAL_LIVE=1 node scripts/eval-semantic.mjs --live --smoke --resume PATH
```

This template was not executed. No new live run or automatic expansion occurred.
Production, gold and semantic prompt remain unchanged. STOP.
