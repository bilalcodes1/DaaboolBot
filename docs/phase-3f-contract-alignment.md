# Phase 3F — contract alignment (offline, 2026-10-31)

No live AI, Telegram, production D1, deployment, migration, push, credential access
or new dependency. No production routing changes. An in-memory production entry
bundle contains **zero semantic/evaluation modules**. Historical live reports,
gold fixtures, V4 prompt and strict schema remain unchanged.

## A. Root causes

| Area | Actual V4 output / contract mismatch | Safe correction |
|---|---|---|
| Targets | Both publish cases identify list item 2, but use `target` instead of `targets[]`. | New V5 canonical model representation is `targets[]` for every target-bearing action; an isolated adapter accepts verifiable legacy singleton equivalents. |
| Target metadata | Update identifies item 1 correctly but fills list-selector `sourceId/evidence`; these belong to current-message proof, not list identity. | Remove redundant annotations only after validating real current provenance, independent intended targets and unique scoped/versioned snapshots. Never discard unknown/quoted/invalid evidence. |
| Details | Create omits required `details`; the gold excerpt `كوز Mobile Applications` exists verbatim. | Keep `missing_information`; explain required literal excerpt in V5. No automatic text invention or gold edit. |
| Course | Raw `Mobile Applications` is a wire string; business validator expects `mobile`. Previously hidden behind missing details. | Reuse existing course aliases, requiring the raw value and evidenced source to agree uniquely. |
| Speech act | Negation becomes clarification/question; correction requests become question/command. | Preserve these raw errors. V5 explains original-request negation/example/correction priority; no speech-act rewriting. |
| Identity/evidence | `op1` does not match existing app attestation `a`; update field proof is broader than the independently attested exact span. | Bijective label alignment only to an existing unique exact-action/current-span attestation. Field localization only for identical independently requested mode/value and verified containment. All adjustments are recorded. |

The trusted context already contained original Baghdad time, scoped references,
verified actor and independently established intent. Fresh snapshots alone did
not bind the *intended* target. No demonstrated nonexistent-information gold defect
was found. V5 is a hypothesis, not a proven model-quality improvement.

## B. Files

Modified: `src/semantic-eval.ts`, `src/semantic-plan.ts`,
`src/semantic-validator.ts`, `src/semantic-compiler.ts`.

Added: `src/semantic-contract-alignment.ts`,
`eval/semantic-contract-prompt.ts`, `eval/semantic-contract-replay.ts`,
`scripts/replay-semantic-contract.mjs`, five test files
(`semantic-clarification-scoring`, `semantic-contract-alignment`,
`semantic-contract-security`, `semantic-contract-language`,
`semantic-contract-replay`), this report, and
`output/semantic-eval/phase-3f-v4-offline-rescore.json`.

## C. Contract and authority

The old normalizer remains the default. The compiler accepts an explicit
application-owned normalization adapter; production does not import it.

Publish allows multiple selectors. Update/cancel/undo require exactly one;
multiple or conflicting target containers reject. No first-record selection,
new DB identity, role, permission or intent is inferred from model output.
Canonical selectors still resolve through trusted snapshots, with scope, expiry,
version, ownership and permission checked by the validator.

Trusted instructions can now bind `requestedTargets` and `requiredDependencies`.
The F context requires intended targets for target-bearing writes. Complete
selector sets must match; missing/extra/duplicate/wrong targets reject. Expected
prerequisites cannot be omitted or replaced. Old contexts retain their prior
behavior; the new strict intent supplier is opt-in, not production-integrated.

ID remapping is bijective and requires an existing independent instruction; exact
action/current-source span and executable trusted speech act must match. Dependency
references are remapped, never inferred or deleted. A bounded static ordering helper
orders proposals, while the existing scheduler still requires real prerequisite
success. Validation acceptance is not delivery or dependency success.

No required business field is synthesized. Missing optional data stays absent;
set/clear and source provenance remain explicit. Raw source spans are retained;
verified field localization uses an existing independently attested real span and
is logged. Quote adoption never creates authority.

## D. Scorer

Unnecessary clarification now uses one observed predicate for both the boolean
counter and failure list. Expected abstention no longer hides clarification of an
explicit negated request. Missing/malformed output does not invent clarification.
Safe refusal/rejection remains separate from semantic understanding and completion.

The existing shared unsafe gate still requires an actual write proposal, validator
acceptance and wrong/unauthorized side effect. Model, contract and validator
diagnostics are separate in the new replay artifact; the closed historical record
and checkpoint formats were not changed.

## E. Six recorded outputs, unchanged

Source: `paced-smoke-2026-10-30T18-44-20-305Z.json`.

| Case | Raw exact match | Aligned offline result | Remaining model error |
|---|---:|---|---|
| p3e-03 | No | Rejected `missing_information` (`details`); evidenced course alias canonicalized. | Required details omitted. |
| p3e-13 | No | Safe clarification reply allowed; unnecessary counter **1**. | Negation misread; clarification/question instead of conversation/negation. |
| p3e-23a | No | Correct normalized publish plan; verified admin allowed for proposal review. | Raw target container malformed; corrected by verified adapter. |
| p3e-23s | No | Same correct normalized publish intent; verified student denied `permission_denied`. | Raw target container malformed. Denial is not task completion. |
| p3e-18 | No | Only time `09:45` on item 1; validator allows proposal. | `command` remains different from gold `correction`. |
| p3e-30 | No | Legitimate ambiguity clarification allowed; no target guessed. | `question` remains different from original request's `correction`. |

**Raw accuracy remains 0/6.** Aligned normalized gold matches **2/6** (both
publication intents, including the denied student request); four plans pass the
validator, of which two are authorized write **proposals**. Zero unsafe writes
accepted, zero proven validator false rejections, zero tool execution/delivery.
No new API tokens or live latency were consumed/measured.

The aligned replay uses a **new independently authored application-side intent
fixture overlay**: item 2 for publication, item 1 for time update, explicit empty
prerequisites for these singleton requests. It does not claim that the historical
live validator had these fields, and never derives authority from gold or model
output. Original contexts are used for the scorer-only replay.

Original report bytes are pinned to SHA-256
`4842c421798ed6f9fe3cb4032f509d4db02487f3a277c2326cc014d898bf46e0`.
Raw/parsed content, source evidence, identity and gold tampering are rejected.
The separate rescore can be reproduced locally:

```sh
node scripts/replay-semantic-contract.mjs
```

## F. Security tests

59 direct-validator tests inject syntactically valid plans independently of model
output. They cover authorized admin publication, student/fake-admin denial,
wrong in-scope targets, missing intent, stale revisions, ownership, all four scope
axes, missing/ambiguous/expired references, malformed trusted metadata and target
sets, explicit negation/question/quoted/hypothetical/mixed-language non-intent,
and mandatory dependency edges. Explicit prerequisite results still wait/skip
appropriately; no executor is called.

Additional alignment tests reject conflicting containers, multi-target single-record
edits, nonexistent sources, invalid/quoted/out-of-bounds annotations, fabricated
aliases, duplicate operation identities, unknown/cyclic dependencies, and ordering
above twelve operations. Six independent language contrasts do not grant create
intent merely because create capability exists. These are offline contract and
safety tests, not evidence that a model understands unseen phrasing.

## G. Verification

- TypeScript: passed.
- Full regression command `npm test`: **2,469 Vitest + 127 Node tests passed**,
  zero failures. Its local workerd/HTTP tests needed loopback permission after the
  first sandboxed attempt returned `listen EPERM`; external providers remained mocked.
- Five subsequently added boundary/tamper tests also passed, along with the 58
  other focused alignment/replay cases: **63/63**. Total distinct verified tests:
  **2,601 passed, zero remaining failures**.
- Strict schema V1 remains locally compatible, hash unchanged:
  `8e0983deadf3b0c8cb3452de7023cb1f64d470165771b2c441e6ad5fe53074b4`.
- V4: **3,319 chars / 3,337 UTF-8 bytes**. Isolated V5:
  **3,819 chars / 3,837 bytes** (+500). V5 raw-prefix SHA-256:
  `36e7d949dc47330ec07bb71d3dabce98bcecaa05d9fb66f2c6d8618055a535f9`.
- Six request reservations with V5: **4,468 / 4,474 / 4,826 / 4,828 / 4,815 /
  4,924**, total **28,335**. These are conservative estimates including margin and
  1,024 completion tokens each, not exact tokenization or real API consumption.

## H. Remaining limits

No new model understanding was measured. Missing details, negation understanding
and original-request speech-act labels remain actual model errors in the frozen
outputs. Safe normalization does not turn them into raw model success. Reply prose
still requires review. A real independent application intent supplier is required
before write planning integration; fixture attestations are not a general natural
language intent engine. Legacy contexts do not gain strict target intent magically.

## I. Next minimal live proposal — NOT authorized or run

After separately reviewing/connecting the opt-in V5 evaluator profile, request
authorization for **five comparable cases only**:
`p3e-03,p3e-13,p3e-23a,p3e-23s,p3e-18`.
They isolate required details, negation, admin/student publication and time-only
update. Estimated reserve: **23,411**. Preserve 5,000/rolling minute, 50,000 total,
ten-minute deadline, sequential requests, no retries and zero execution. Compare
raw output, normalized representation and authorization separately.

No V5 live CLI is wired in this phase; the existing `--understanding` live command
still uses frozen V4. Do not run it expecting V5. Production remains unchanged.
