# Phase 3G — final contract gate (offline, 2026-11-01)

No Groq, Telegram, production D1, deployment, push, migration, credential access,
or production routing changes. No live evaluation was activated. Historical
reports, gold labels, V4 and the Phase 3F proposed V5 prefix remain unchanged.

## A. Details decision and evidence

**Additional details from the user/model are optional business information.**
The earlier semantic rule was stricter than the existing create flow:

- `src/academic-ai.ts:180` accepts an empty details string; `:188` replaces it
  with already validated nonempty **verbatim item evidence**.
- `src/event-types.ts:54` initializes details empty; `src/event-extract.ts:376`
  does not list details among missing event requirements.
- `src/event-format.ts:65` can render an event without extra details.
- `migrations/0005_academic_ai.sql:21` stores the announcement in `body_json`.
  There is no details-specific column or nonempty-details DB check. The existing
  academic writer serializes the item into that JSON.

The normalized `SemanticPlanV1` still carries nonempty display/provenance text.
Only opt-in V5 accepts an absent **details entry**, or a present entry with
`value:null`, on create. It copies valid, current, unquoted action evidence exactly,
with its real source span and a 2,400-character bound. No paraphrase, truncation,
extra requirements, clock time, group or source is invented. Real supplied details
remain unchanged. Missing optional details no longer produces clarification.

The wire format is `fields[]`, not an object with a mandatory `details` property.
Every present entry still requires `name/mode/value/dateKind/evidence`; the existing
strict schema already permits `value:null`. Removing required `value` or another
JSON key rejects. An omitted optional entry is different from a missing required
JSON property. Legacy normalization is unchanged. No database schema changed.

No frozen gold was relabelled. The old p3e-03 details excerpt exists verbatim;
the normalized reference remains valid. A raw exact-match metric can still flag
an omitted optional extraction field; normalized validity and source-backed text
are reported separately, rather than calling that an execution failure.

## B. Exact contract changes

New explicit evaluation profile `contract-v5` selects:

- `FinalContractContextBuilder` / `semantic-brain-v5-final-contract-gate`.
- Phase 3F verified target alignment plus the create-only source-text fallback.
- Independent app-owned target/prerequisite fixtures, never model authorization.
- Separate raw scoring and actual aligned normalization/validator evidence.

Canonical singleton `targets[]` on update/cancel/undo projects to the existing
internal single-target semantic representation for comparison only. Business
fields are not filled into raw model scores. Accepted-target safety checks use
the normalized target actually validated, avoiding a false alarm for equivalent
legacy containers. V5 evidence adds a verified adapter-version/adjustments trace;
older evidence/checkpoints keep their prior shape and behavior.

Model/schema/prompt/context/normalization identities and limits are pinned across
checkpoint resume. Changed versions, tampered evidence, uncertain in-flight calls,
unknown cases, duplicate cases or more than five requests fail closed.

Modified files: `src/semantic-contract-alignment.ts`, `src/semantic-eval.ts`,
`src/semantic-eval-guard.ts`, `eval/semantic-evidence.ts`,
`eval/semantic-checkpoint.ts`, `eval/run-semantic-lab.ts`,
`eval/semantic-quality-gate.ts`, `scripts/eval-semantic.mjs`.
Added: `eval/semantic-final-contract.ts`,
`eval/semantic-final-contract-prompt.ts`, three `semantic-contract-*` test files
(`details`, `cli`, `evaluator`), this report and
`output/semantic-eval/contract-v5-readiness.json`.

## C. Security and domain verification

Offline mocks/direct validator injection confirm:

- Admin publication accepted for planning; student and fake-admin publication
  denied by trusted identity, including syntactically valid plans.
- Wrong targets, ownership/scope violations and stale/ambiguous references reject.
  Complete independently requested selector sets and versions remain enforced.
- Real source spans/current-versus-quote provenance remain enforced. Model IDs
  never create intent, permission, a record reference, or a version.
- Negated create is blocked; a capability alone is not command intent.
- Updates change only independently requested fields. Omission preserves fields;
  null is not implicit clear and does not trigger create-text fallback on update.
- Course aliases use existing evidenced matching. Original Baghdad metadata stays
  **2026-10-30 09:00** even when evaluation runs in November. `باچر` retains its
  relative source expression (meaning Oct 31 from that clock); no new absolute-date
  resolver or wall-clock substitution was introduced.
- No tool executor, publication, Telegram send or production write runs.

An in-memory production-entry bundle contains zero semantic/evaluation modules.
Default production and legacy evaluator selection remain unchanged.

## D. Tests

- TypeScript passed.
- **2,463 Vitest tests passed, zero failures**, across all 53 test files that do
  not require local network services.
- **30 standalone Node tests passed, zero failures**, using injected transports
  and local files only. Total verified offline tests: **2,493**.
- New V5 coverage: 14 details tests, 13 CLI/checkpoint tests, 14 evaluator/evidence
  tests. These are included above, not added again to inflate the total.

Four workerd/Miniflare Vitest files were excluded because they require local
sockets. Two additional Node local-D1 suites were attempted and blocked by
`listen EPERM 127.0.0.1`; they did not complete. Their socket restrictions were not
escalated during this no-network phase. The full socket-dependent suite is **not
claimed as rerun or passed here** (it passed in Phase 3F).

## E. V5 CLI readiness

**READY for the limited synthetic evaluation, subject to later live authorization.**
V5 requires `--prompt-version v5`. Unknown versions, mixed profile flags and
unknown/sixth case IDs reject; no silent fallback to V4. Existing `--understanding`
still selects frozen V4. Offline readiness writes a distinct file; future live
reports get new timestamped filenames, preserving historical experiments.

Model remains `openai/gpt-oss-120b`; strict JSON schema V1 hash remains:
`8e0983deadf3b0c8cb3452de7023cb1f64d470165771b2c441e6ad5fe53074b4`.
Local strict-schema compatibility passed; this is not new provider acceptance.

Prompt: **3,939 UTF-16 chars / 3,957 UTF-8 bytes**, +120 over the isolated Phase 3F
V5 prefix. Raw UTF-8 prefix hash:
`d01905fd94e67222cf5133877b0d4e1402d6c203261d87143d2a3f63ef948759`.
Checkpoint prompt hash (SHA-256 of JSON-stringified prefix):
`79dbd9072b964e6620cee8e63818778699fdb0ecd57e4c1eaf626aef96a16450`.
Adapter: `semantic-contract-v5-optional-details-v1`.

## F–G. Frozen five-case gold and budget

| Case | Expected gold/policy | Input estimate + margin + completion = reserved |
|---|---|---:|
| p3e-03 | create/command; mobile quiz, relative باچر; no invented time/group; extra details optional under V5, normalized display text required | 3,034 + 456 + 1,024 = **4,514** |
| p3e-13 | reply/conversation, negation; no create | 3,040 + 456 + 1,024 = **4,520** |
| p3e-23a | publish/command; trusted list item 2; verified admin permitted | 3,346 + 502 + 1,024 = **4,872** |
| p3e-23s | same publish intent/item; verified student denied; safe refusal tracked separately | 3,347 + 503 + 1,024 = **4,874** |
| p3e-18 | update/correction; item 1, only time=09:45 | 3,336 + 501 + 1,024 = **4,861** |

All five have reviewed, unambiguous frozen labels; expected policy checks passed.
Context overlay is the independently authored Phase 3F fixture context, not model
output and not a claim about historical live authorization.

Total reserved estimate **23,641**. Hard limits: **five requests**, **5,000 reserved
tokens per rolling 60 seconds**, **50,000 total reserved/reported tokens**, **ten
minutes**, sequential, no retries/fallback, no execution. Lower actual account/API
limits are respected when supplied/observed. No account API was queried here.

## H. Remaining limits

V5 understanding and provider acceptance are unmeasured; mocks do not prove live
accuracy. Socket-dependent regressions remain unverified in this phase. Production
write integration and a general independent natural-language intent supplier are
still outside scope. No remaining blocker was found in the five-case offline gate.

## I. Exact later command — NOT run

With the credential already in the process environment, and only after separate
explicit live authorization:

```sh
DAABOUL_EVAL_LIVE=1 node scripts/eval-semantic.mjs \
  --prompt-version v5 --live --smoke \
  --cases p3e-03,p3e-13,p3e-23a,p3e-23s,p3e-18
```

Verified without network using the same arguments minus live flags and with live
environment/key variables removed. Live request count in this phase: **zero**.
