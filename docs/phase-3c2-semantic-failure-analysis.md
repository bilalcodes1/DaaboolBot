# Phase 3C.2 — semantic failure analysis, offline only

No new Groq/model calls, Telegram, production D1, deploy, push, dependencies or
production routing changes. Model and wire schema are unchanged. Original live
history and the full 160-case gold dataset are preserved.

## A. Original message and trusted context

Exact message: **`شعدنا باچر؟`**, 11 UTF-16 code units, all BMP characters.
The original first fixture is frozen in
`tests/fixtures/semantic-live-failure-2026-10-30.json`; its gold/context is asserted
equal to the untouched `iraqi_anbari-01` entry. That file also records the old
ContextBuilder messages before modification. These messages are reconstructed
from the original code/fixture, not a recovered raw HTTP request.

- Source: `{id:"message",kind:"current",text:"شعدنا باچر؟",messageStart:0}` only.
- Original Telegram timestamp: 1793313000000 = 2026-10-29T22:30:00Z;
  Baghdad Friday 2026-10-30 01:30. Tomorrow means Saturday 2026-10-31.
- Synthetic scope: bot 990001, chat -1009900001, thread null, user 900001.
- Application actor: verified user 900001, owner UID 900000; role student.
- allowedActions=[read], no write attestations, target bindings, announcement or
  operation references. No conversation, pending request or quoted/read data.
- App-only read grant covers schedule/cohort/announcements/roster/own operations,
  scoped to the synthetic classroom and expiring at original time +60 seconds.
  The model receives role/scope/time metadata, not authority to modify grants.

## B. Expected vs observed

| | Gold | Stored observed meaning |
|---|---|---|
| Action / subject | read / schedule | reply / conversation |
| Speech act | question | question |
| Tool / arguments | get_schedule / period=tomorrow | absent |
| Whole-message evidence | message, start=0, end=11 | not retained |

Gold's query is the exact original message. The stored observation records HTTP
200, valid local draft schema, normalization=ok, validator invalid_evidence and
no execution. Input/output/total tokens were 1,905/196/2,101; latency 1,051 ms;
cached tokens were not reported.

**Actual raw Groq content and full normalized SemanticPlanV1 are unavailable.**
The previous evaluator discarded draft evidence, IDs and reply prose and retained
only sanitized canonical meaning. The frozen artifact uses null for unavailable
data. No mock response or guessed span is presented as historical raw output.
Original report SHA-256:
`afbeb7795b686277f18a70d5ea257914f55449dbba076a1d401bd4126093f718`.

## C. Routing cause and targeted repair

Confirmed protocol gap in the old prompt: it leads with conversation/reply rules,
lists read-tool signatures, and distinguishes questions from saves, but never
positively states that a supported information question must select action=read.
Its unqualified “mentioning ... عدنا ... establishes neither action nor
authorization” can overgeneralize an anti-write precaution. “Reads need ...
instruction evidence” can also be confused with requiring imperative grammar.

The flat schema legally permits a question/reply/conversation, as it must for
social questions. The normalizer already supports question/read and cannot infer
the intended tool without becoming a new deterministic intent router. Thus no
schema or keyword-routing workaround is appropriate. Exact internal model
reasoning remains unobservable; this prompt defect is not proof of its private cause.

Prompt v2 adds a compact general decision rule: identify the information needed;
classroom information uses the matching read tool, regardless of question/command
speech act. Personal/social questions remain reply. Context resolves genuinely
ambiguous wording; otherwise clarify. It explicitly documents the existing
read/tool/arguments representation and compiler-derived subject/query. The
anti-write/authority safeguard is preserved and qualified as WRITE. No few-shot
block, phrase matcher, new model or forced question→tool path is added.

## D. Independent evidence cause and repair

This is a separate failure. The observed proposal is a reply; reply normalization
copies its evidence, and a reply has no query/fields/targets requiring grounding.
Therefore the historical error is specifically **operation.evidence**.
In that code path invalid_evidence means one or both of:

1. Submitted sourceId did not identify the only supplied source, `message`.
2. Submitted end exceeded the source's length, 11.

Exact submitted sourceId/start/end were not logged, so the alternative cannot be
chosen. Passed local schema establishes nonnegative integer start and end>start.
A quote-region error would be source_region_mismatch; this fixture has no quotes.
There is no BMP/codepoint-versus-UTF16 length discrepancy in this message. No
specific Unicode, whitespace or source-ID mistake is invented as the actual cause.

No defect requiring weaker evidence authorization is established. Evidence remains
required for **every action, including conversation**. Prompt v2 clarifies exact
source ID, zero-based source-local UTF-16, start inclusive/end exclusive, original
source.text rather than normalized text, messageStart or serialized JSON escapes.
ContextBuilder supplies app-computed current_instruction_spans as copying hints.
It subtracts marked quote regions, preserves text/whitespace and grants neither
intent nor permission. The normalizer never fills or repairs invalid model spans.

One narrow diagnostic defect was found separately: an unknown source in a read
was mislabeled quoted_instruction. It now returns invalid_evidence; a known
noncurrent source still returns quoted_instruction. This does not explain or alter
the historical **reply** error. The Phase 1 validator and permission checks are unchanged.

## E. Files

- `src/semantic-compiler.ts`: versioned static prompt and bounded source-local hints.
- `src/semantic-draft.ts`: distinguish missing read source from known quoted source.
- `eval/semantic-checkpoint.ts`: use exported prompt version/hash; old identities
  cannot resume against a changed prompt.
- `tests/fixtures/semantic-contrastive-fixtures.ts`: 44 independently specified labels.
- `tests/fixtures/semantic-brain-v1.txt`: frozen original static prefix.
- `tests/fixtures/semantic-live-failure-2026-10-30.json`: immutable original
  fixture/context/messages/observations, explicit missing data and history hash.
- `tests/semantic-failure-analysis.test.ts`: contrastive pipeline/evidence/history tests.
- Two existing preflight/pacing test files: update current-profile reservation
  expectations and synthetic lower-limit samples; historical 4,282 is still tested.
- This report and `output/semantic-eval/phase-3c2-analysis.json`; regenerated
  offline readiness. No secrets or real student data in these artifacts.

## F. Tests and independent labels

44 contrasts cover Iraqi/MSA/English/mixed schedule questions, imperative reads,
personal/social talk, negative interrogatives vs prohibited reads, different
academic tools, and quoted commands/injections. Identical `شنو عندك باچر؟` has
academic, social and missing-context labels. Original failed gold is not rewritten.

Tests pass independently specified plans through the real wire/local schema, normalizer, validator
and compiler with injected mock transport. Separate regressions demonstrate:
wrong action with valid evidence; correct read meaning with invalid evidence;
reply with missing source/end overflow; raw whitespace/diacritics/emoji; nonzero
messageStart; overlapping inline quotes; query grounding and fake model permissions.
Quote hints do not cause authorization, and the wrong conversation plan is never
silently rerouted to a tool. Network fetch is forbidden in new tests.

TypeScript passes. **755 tests pass / 0 fail across 14 files**: the original 689
plus 66 new tests, including all 44 contrasts. Unrelated project suites were not
rerun. Mocked integration success proves the contracts and pipeline, **not improved
real Groq understanding**. Labels were independently specified/reviewed in this
coding task, not certified by an external human annotation panel or derived from
the evaluated Groq output.

## G. Old vs new size and token estimates

| Measurement | Before v1 | After v2 |
|---|---:|---:|
| Static prompt UTF-8 bytes | 3,253 | 4,021 |
| Static prompt characters | 3,044 | 3,812 |
| Static prompt + unchanged schema/framing input estimate | 2,630 | 2,887 |
| Wire schema bytes | 3,945 | 3,945 |
| Marginal schema token estimate | 1,314 | 1,314 |
| Full failed-case input estimate | 2,833 | 3,117 |
| Failed-case reservation incl. output + input margin | 4,282 | 4,609 |
| Six-case total reservation | 26,229 | 28,189 |

The estimator is script-aware, not an exact tokenizer. Output allowance stays
1,024 and input margin 15%; these are reservations, not new API consumption.
All six requests individually remain <=5,000 and total <=35,000 planned reserve.
Six-request/50,000 reported total/5,000 rolling/ten-minute hard caps are unchanged.

Schema version/hash are unchanged:
`8e0983deadf3b0c8cb3452de7023cb1f64d470165771b2c441e6ad5fe53074b4`.
New prompt version is semantic-brain-v2, hash:
`536a4f6fb939901db2edec93e238b3f2719236ce840481bd6549df43f6aed4f1`.
The static prefix is identical across requests; scoped dynamic context remains last.

## H–I. Uncertainty and proposed later test

Exact old raw content and evidence values cannot be recovered. The historical
internal routing cause and the new prompt's actual efficacy remain unproven.
Source-span hints reduce ambiguity but cannot guarantee correct copied evidence
or semantic intent. Broader 160-case gold-label limitations previously reported
remain; new contrastive labels are separate and independently authored.

After a separate explicit authorization, propose three synthetic calls only:
the frozen failed Iraqi question, its English schedule counterpart, and a social
question (`شلونك دعبول؟`). Use v2, the same strict schema/model and existing
limits, with no tool execution. Retain approved synthetic raw evidence metadata
and normalized plan so another failure is diagnosable; no missing historical
response may be synthesized. Review exact action/tool/period and evidence before
expanding. The current six-case runner is not silently changed to that proposed
selection; no such command or live evaluation ran here. The old report remains
non-resumable. STOP, offline only.
