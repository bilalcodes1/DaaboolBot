# Phase 3D — semantic quality gate

Offline analysis, versioned fixture corrections and mocked test preparation only.
No live Groq/Telegram calls, production D1, migrations, deployment, push or new
dependencies. Production routing and all historical live reports remain unchanged.

## A. Taxonomy decision

Keep SemanticPlanV1 and wire schema V1. Intent already has separate dimensions:
**action + subject + read tool**. SpeechAct expresses utterance force. Explicit
questions, including «شلونك دعبول؟», remain `question`; their social intent is
`reply/conversation`. Display/list/show imperatives are `command`, including reads.
Non-question greetings/thanks/banter are `chitchat`. Existing negation/example/
correction precedence and all mutation checks stay intact. Elliptical consent is
not blindly relabelled as a statement read: that form is not supported currently.

The old V2 prompt and historical question gold are frozen. The opt-in evaluation
profile `--quality` uses **semantic-brain-v3-taxonomy**, a short clarification of
the existing boundary. Default/contrast evaluation still uses the exact old V2
prompt. No new intent field or keyword router was added.

The validator still requires separate application permissions, current evidence,
trusted instruction attestation, target scope/ownership/revision and allowed
mutation speech acts. Model labels never grant authority. In the quality lab,
synthetic owner/student metadata is presented from the verified app-owned actor/
owner attestation, matching the validator; production account IDs are not copied
into synthetic fixtures and production role resolution is unchanged.

## B. Independent audit and versioned gold corrections

Reviewed all **160 fixtures / 20 categories**, actual contracts, validator,
normalizer, prompt, scorer and independent contrastive labels. New overlay:
`daaboul-synthetic-gold-v2`; original v1 source/labels are unchanged.

**44 correction entries across 43 cases**, justified by the original language and
supplied context, not by Groq predictions:

| Entries | Correction and independent reason |
|---:|---|
| 22 | Explicit read directives labelled question → command; equivalent existing contrast fixtures already use command. |
| 2 | Descriptive multiple-announcement «عدنا…» notifications → statement; matching synthetic statement attestations remain independent. |
| 1 | `old_list_reply-05` explicit «اريده» → command. |
| 4 | Whole/plural two-item publication lists include both targets, while publication remains denied. |
| 2 | Explicit second item, and correction of the list's Thursday item, select target 2 rather than 1. |
| 9 | Targetless corrections/dependent publications with two candidates ask clarification; arbitrary target 1 and write attestations are removed. Temporal «أولاً» is not an item selector. |
| 4 | Stale/foreign list fixtures now actually expire or scope the handles/bindings and remove the contradictory active own reply source. |

Every entry contains the full before/after gold (including abstention and policy
fields) and rationale. All 160 review entries, all 44 changes, the 18 unresolved
labels/targets, and the 11-case candidate matrix are in
`output/semantic-eval/quality-readiness.json`. Unresolved cases are excluded from
the allowlisted next evaluation; no hidden label exemptions affect scoring.

No independently demonstrated date errors were found. The original synthetic
timestamp is `2026-10-29T22:30:00Z` = **Friday 2026-10-30, 01:30 Baghdad**.
Original relative expressions and absolute date evidence remain unchanged;
evaluation wall time never replaces original Telegram time.

Historical three-case accuracy stays **2/3**, with no retrospective relabelling.
Historical three-case report SHA-256:
`072e8dd4463e9fb34e37b0aff470c5d6e226d6f7630bb62ce9aab968055f212a`.
The older one-case report hash also remains unchanged.

## C. Files changed

- New `eval/semantic-gold-v2.ts`: audited overlay, full correction ledger and review exclusions.
- New `eval/semantic-quality-prompt.ts`: opt-in taxonomy prompt and synthetic trusted-context presentation.
- New `eval/semantic-quality-gate.ts`: allowlisted candidates, capped preflight and separate quality metrics.
- `src/semantic-compiler.ts`: injectable system instructions; default remains exact V2.
- `src/semantic-eval.ts`: optional evaluation provenance/context builder; unbound quality-write attestations are unscored for validator correctness, not falsely labelled a validator bug.
- `src/semantic-eval-guard.ts`: exact opt-in V3 prompt check; existing schema/model/budget/network guards retained.
- `eval/semantic-checkpoint.ts`: V3/gold-v2/request identity and the same 3/20k limits on quality resume.
- `eval/run-semantic-lab.ts`: explicit `--quality` selection, readiness and quality summary, same sequential evaluator.
- `scripts/eval-semantic.mjs`: separate `quality-readiness.json` artifact.
- New `tests/semantic-quality-gate.test.ts`; this report and the offline readiness artifact.

## D. Tests

TypeScript passes. **982 tests pass, zero fail, across 17 relevant files**:
the previous 801 targeted regressions plus 181 new checks. This is the targeted
semantic/assistant/read-tool set, not a claim that all unrelated project suites ran.

New checks cover every revised fixture's trusted context, original Baghdad date,
grounded expected plan/policy, independent intent/speech/tool/slot/target/dependency
metrics, refusal vs primary intent, unmeasured completion, missing-output semantic
denominators, no legacy refusal-based efficiency metric, model ID attestation
mismatch without repair, all candidates' budgets, synthetic admin claims, profile
pinning, fourth-request rejection, resume identity and the real CLI offline.
Native fetch is forbidden; Groq, persistence and clocks are mocked for simulation.

## E. Prepared cases and next selection

Eleven existing fixtures are prepared: create `questions_commands-05`, negated
create `negation_quote-01`, information question `questions_commands-01`, existing
update `save_update_cancel-05`, ambiguous cancellation `ambiguous_targets-02`,
stale list `old_list_reply-05`, fake-admin publication `fake_admin_claim-06`,
dependent update then publish `dependent_update_publish-01`, English imperative
`english-01`, mixed imperative `mixed-01`, and social question `social-wellbeing`.
The social fixture retains its independent original question gold.

Next selected **three**, with explicit fake-admin target «الأول»:

| ID | Proposal to inspect | Reserved estimate |
|---|---|---:|
| `questions_commands-05` | Create announcement | 4,731 |
| `negation_quote-01` | Negated create → conversation/no write | 4,727 |
| `fake_admin_claim-06` | Fake admin publication request; local denial | 4,944 |
| **Total** | | **14,402** |

These three are Iraqi safety contrasts. They do **not** cover every prepared
scenario or language. English/mixed, update, stale/ambiguous selection and real
dependencies require separately authorized later selections. No automatic batch
expansion, concatenation of cases, or synthetic gold derived from model answers.

## F. Caps and metrics

Same limits: max **3 requests**, **5,000 reserved tokens / rolling 60 seconds**,
**20,000 cumulative reserved**, **50,000 actual reported-token hard cap**,
**10-minute original deadline**, sequential, no retries/fallback, lower actual
account limits respected. All 11 candidates individually fit 5,000 with current
estimates. Reservations include the existing input margin and full 1,024 output
allowance; they are not actual API usage. The exact offline CLI counterpart
returned the selected three only, reserve=14,402, liveRequests=0.

The quality summary measures primary-gold intent including tool, speech act,
structured entities/slots, target, dependency, validator acceptance, unsafe
acceptance, safe alternatives and unnecessary clarification separately. Missing
model output is unscored semantically; transport attempts remain counted. Actual
tokens/cache/latency retain API-reporting provenance when available. No real
measurements exist for the new prompt. Ambiguous repeated-intent operation
alignment is marked unscorable rather than paired arbitrarily. Free prose needs
review and is not claimed semantically exact. Safe refusal does not prove primary
publish-intent understanding, and **task completion stays unmeasured/null**: no
tools, backend reads, writes, publication or delivery run in the evaluator.

## G. Remaining risks

- Trusted write attestations bind app-owned `a/b` operation IDs and exact spans;
  a model's valid `op1` or refined span can cause `intent_not_established` despite
  correct raw meaning. Tests expose this. IDs/spans are not repaired, model
  proposals never generate authority, and checks are not weakened. This limits
  claims about write eligibility until a separately designed application binding
  exists. The next lab can measure understanding and rejection causes only.
- Eighteen ellipses/underdefined targets need independent annotation; free text
  and multi-operation repeated-intent alignment still need review.
- New V3/gold-v2 compatibility and mocks do not establish live quality or
  production readiness. Three cases cannot validate broad reliability.

## H. Exact later live command — not run

Under a subsequent explicit live authorization, with a credential already in the
process environment:

```sh
DAABOUL_EVAL_LIVE=1 node scripts/eval-semantic.mjs --quality --live --smoke --cases questions_commands-05,negation_quote-01,fake_admin_claim-06
```

The identical selection was verified via offline CLI and mocked execution only.
Use a new experiment, never relabel or resume the historical V2 live result as V3.

STOP. No live calls or production changes performed.
