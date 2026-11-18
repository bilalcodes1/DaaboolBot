# Phase 3H — create regression and evaluation integrity

Mode: targeted offline work. No live provider requests, Telegram sends, D1 calls, production routing changes, migrations, deployment or push.

## A. Proven findings and uncertainty

The exact `p3e-03` message in both live experiments is `Create كوز Mobile Applications باچر.`. V4 produced `create / command`, quiz, Mobile Applications, and the original relative `باچر`, with no extra details. V5 instead produced `reply / question / clarification` and requested date, optional time, audience or content. The V5 answer violates its existing instructions; it is not evidence of missing business data.

Reconstructing the existing builders matches the saved message hashes:

| | V4 | V5 |
|---|---|---|
| SHA-256(JSON.stringify messages) | `98f3a36766f4be545eb40df0713ed2ce68e0b031ae0ae2708aee360053fc6279` | `38096fcc56619e14d9a31786641cf3382464b783a621ff214516d8b7dc3462a5` |
| Prompt characters / UTF-8 bytes | 3319 / 3337 | 3939 / 3957 |

The dynamic model context is identical: the same text, current source `[0,36)`, mobile hint, verified synthetic student, empty conversation/selectors/references, and original Baghdad date 2026-10-30. Thus the supplied tomorrow is 2026-10-31; the November 2 transport time must not replace the original message time. The validator-only V5 target/dependency overlay does not enter model messages.

Both experiments use `openai/gpt-oss-120b`, temperature 0, low reasoning, 1024 completion-token limit, strict schema hash `8e0983deadf3b0c8cb3452de7023cb1f64d470165771b2c441e6ad5fe53074b4`, no streaming/tools/fallback. The saved request hash covers messages, not the whole HTTP envelope; the model hash identifies the model string, not provider weights.

There is no proven causal prompt bug. The wording about independent intent might contribute to excess caution, but the same prompt already separates proposing an action from authorization and explicitly forbids clarification for absent optional fields. One response per version does not establish a deterministic regression, even with temperature 0. V5 and its hash remain frozen; no V6, forced-create routing, phrase matching, or rewriting a clarification into a successful create was introduced.

## B. Targeted corrections

The proven defects addressed here are evaluation construction and the optional-details expectation. New scenario facts are independent of expected plans: fixed authenticated identities supply capabilities; fixture list/record data supplies scope, ownership and revisions. Separately authored synthetic current-message intent annotations supply offline validator attestations. Their structural translator performs no lexical routing. The annotations, capabilities and database IDs are not exposed as model answers.

The nine scenarios cover the same admin/student publish request, a wrong target, a stale snapshot, create, negated create, genuinely missing course, time-only update and an ambiguous target. Labels and expected plans are stored separately. The existing compiler, V5 normalizer, strict schema and validator are reused. Historical evaluators/CLI and frozen reports remain reproducible; the new scenario set is an explicit offline evaluation preparation, not silently activated production or live routing.

Synthetic annotations are not a production intent supplier or an external human annotation panel. They demonstrate isolation from gold and model output, not general language understanding.

## C. Versioned gold correction

Historical `daaboul-understanding-gold-v1` requires a nonempty extra `details` field in raw `p3e-03` meaning. Existing business logic and final V5 permit absent/null extra details and preserve exact current source evidence as canonical display text. A new expectation version therefore permits omission/null or valid literal details while retaining quiz, mobile, supplied relative date, command force, no invented optional fields and valid provenance.

Old V4/V5 scores are preserved. Corrected-contract raw scoring is reported separately; it must not hide invented details, malformed field entries, invalid evidence, extra time/group, or the V5 wrong action. API success, safe clarification and policy rejection are not interchangeable with correct understanding.

New label versions are `daaboul-independent-understanding-gold-v1` and `daaboul-p3e03-optional-details-expectation-v1`. `independentEvaluationCase` constructs scenario context first, then attaches separate expectations for the existing evaluator. `compareOptionalCreateDetails` returns historical and corrected comparisons independently; it never modifies raw plans, expected plans or source text. Optional-details projection also checks create field modes, nullable/date-kind consistency, current-source spans, containment and inactive properties. Semantic value grounding, authorization and execution eligibility remain the existing validator's responsibility; corrected raw matching is not execution approval.

The new comparison of the recorded `p3e-03` outputs is:

| Recorded output | Historical raw match | Corrected optional-details meaning |
|---|---|---|
| V4 create/command, omitted extra details | false | true |
| V5 clarification/question | false | false |

This is a versioned business-rule correction, not evidence of model improvement. The historical report bytes and scores are unchanged.

## D. Verification

- `npm run typecheck`: passed.
- `vitest run tests/semantic-*.test.ts tests/read-plan-executor.test.ts`: **1,144 passed, 0 failed, 0 pending across 23 files**. This includes 101 new tests: 48 scenario/security tests, 16 create/input-integrity tests, and 37 expectation/scoring tests. These counts are not added twice.
- Tests forbid global `fetch` in the new suites and use injected mock planner transports, direct validator proposals and local recorded synthetic JSON. No live model accuracy was measured.
- Admin publication passes; the same student request is `permission_denied`. Changing expected labels cannot grant permission. Wrong target, stale revision 4 versus current 5, ambiguous candidates, scope/owner/version/expiry failures and spoofed identity remain blocked.
- Kind/course missing from create fail; absent time/group/extra details do not. A false create on negated text has no independent instruction and is blocked. An actual clarification stays a clarification, never rewritten to create. Updates preserve omitted fields.
- Both saved request-message hashes, original Baghdad context and V4/V5 prompt hashes match. Historical report byte hashes remain V4 `4842c421798ed6f9fe3cb4032f509d4db02487f3a277c2326cc014d898bf46e0` and V5 `32be67e399831b720c0f43a0cdfade5a51805e8034e8bd2ad88dccc02ffd5c64`.
- This was a targeted offline regression run, not a rerun of socket-dependent production runtime/D1 suites. No new dependencies were added.

Added files: `eval/semantic-independent-scenarios.ts`, `eval/semantic-independent-expectations.ts`, three tests (`semantic-independent-scenarios`, `semantic-create-integrity`, `semantic-independent-expectations`), this report and `output/semantic-eval/phase-3h-create-integrity-audit.json`. No pre-existing production, evaluator, CLI, prompt, schema or gold file was edited.

The local audit artifact contains only a separate recorded-output comparison. It records zero new live requests, tool executions, Telegram sends and D1 writes. No mocked response is evidence that Groq improved.

## E. Remaining errors and next gate

The observed V5 create clarification remains a real uncorrected model error. Other recorded raw errors remain: singular publication `target` instead of the instructed vector, and `command` instead of `correction` for the time update. This phase does not retune those outputs or alter their history.

A separately authorized, bounded live create/negation contrast would be justified after this offline gate; it has not been run or authorized by this phase. A read-only internal pilot first needs actual read cases with independent mock context, current scope/permission/reference checks, bounded backend results, rendering and error handling verification, explicit disabled mutation execution, and a separate activation decision. No write/publish integration is approved by these fixtures.
