import type { SemanticGoldCase } from '../src/semantic-eval';
import { createHash } from 'node:crypto';
import { ContextBuilder, SEMANTIC_BRAIN_PROMPT_VERSION, SEMANTIC_BRAIN_INSTRUCTIONS } from '../src/semantic-compiler';
import { validateSemanticPlan } from '../src/semantic-validator';
import { estimateEvalReservation, type EvalAccountLimits } from '../src/semantic-eval-guard';
import { SEMANTIC_GOLD_CASES } from './semantic-gold';
import { SEMANTIC_CONTRASTIVE_FIXTURES } from '../tests/fixtures/semantic-contrastive-fixtures';
import { evalSchemaPreflight } from './semantic-preflight';

export const CONTRAST_CASE_IDS = ['iraqi_anbari-01', 'english-tomorrow', 'social-wellbeing'] as const;
export const CONTRAST_LIMITS = { requests: 3, totalReservedTokens: 20000, minuteTokens: 5000, durationMs: 600000 } as const;
export function isContrastSelection(cases: readonly SemanticGoldCase[]): boolean {
  return cases.length === 3 && new Set(cases.map(c => c.id)).size === 3 && CONTRAST_CASE_IDS.every(id => cases.some(c => c.id === id));
}

/** Resolve only the frozen experiment's labels. Never derive gold from a model output. */
export function explicitContrastCases(ids: readonly string[]): SemanticGoldCase[] {
  if (ids.some(id => !(CONTRAST_CASE_IDS as readonly string[]).includes(id))) throw Error('Unknown or unsupported explicit case ID');
  if (ids.length !== 3 || new Set(ids).size !== 3) throw Error('Explicit contrast requires exactly three distinct case IDs');
  const original = SEMANTIC_GOLD_CASES.find(c => c.id === 'iraqi_anbari-01');
  if (!original) throw Error('Frozen Iraqi fixture missing');
  return ids.map(id => {
    if (id === original.id) return structuredClone(original);
    const fixture = SEMANTIC_CONTRASTIVE_FIXTURES.find(c => c.id === id);
    if (!fixture) throw Error('Frozen contrast fixture missing');
    if (id === 'english-tomorrow' && (fixture.text !== "What's tomorrow's schedule?" || fixture.action !== 'read' || fixture.tool !== 'get_schedule' || fixture.period !== 'tomorrow')
      || id === 'social-wellbeing' && (fixture.text !== 'شلونك دعبول؟' || fixture.action !== 'reply' || fixture.subject !== 'conversation' || fixture.tool || fixture.period)
      || fixture.speechAct !== 'question' || fixture.previous || fixture.quote) throw Error('Frozen contrast label mismatch');
    // The contrast fixture specifies meaning; the application supplies the same synthetic
    // scope, clock and verified read grant used by its existing offline regression.
    const c = structuredClone(original);
    c.id = id; c.categories = ['semantic_contrast_v2']; c.input = { originalText: fixture.text };
    c.context.originalText = fixture.text;
    c.context.sources = [{ id: 'message', kind: 'current', text: fixture.text, messageStart: 0 }];
    const evidence = { sourceId: 'message', start: 0, end: fixture.text.length };
    c.expectedPlan = { version: 1, operations: [fixture.action === 'read'
      ? { id: 'a', action: 'read', speechAct: fixture.speechAct, subject: 'schedule', evidence, dependsOn: [],
        query: { value: fixture.text, evidence }, tool: { name: 'get_schedule', version: 1, input: { period: fixture.period! } } }
      : { id: 'a', action: 'reply', speechAct: fixture.speechAct, subject: fixture.subject!, evidence, dependsOn: [], text: 'رد اجتماعي قصير.' }] };
    return c;
  });
}

export function prepareExplicitContrast(ids: readonly string[], account: EvalAccountLimits = {}) {
  if (Object.values(account).some(n => !Number.isSafeInteger(n) || n < 0)) throw Error('Invalid contrast account limits');
  const cases = explicitContrastCases(ids), schema = evalSchemaPreflight();
  if (SEMANTIC_BRAIN_PROMPT_VERSION !== 'semantic-brain-v2'
    || createHash('sha256').update(SEMANTIC_BRAIN_INSTRUCTIONS).digest('hex') !== '536a4f6fb939901db2edec93e238b3f2719236ce840481bd6549df43f6aed4f1'
    || schema.model !== 'openai/gpt-oss-120b' || schema.schemaVersion !== 1
    || schema.schemaHash !== '8e0983deadf3b0c8cb3452de7023cb1f64d470165771b2c441e6ad5fe53074b4' || !schema.localCompatible) throw Error('Contrast prompt/model/schema preflight failed');
  const selected = cases.map(c => {
    // Validate app-owned context and gold evidence before credentials or network access.
    if (!c.synthetic || c.expectedValidator !== 'allow' || !validateSemanticPlan(c.expectedPlan, c.context).ok) throw Error('Contrast gold/context/evidence preflight failed');
    const reservation = estimateEvalReservation(new ContextBuilder().build(c.input, c.context).messages);
    return { id: c.id, tokens: reservation.totalReserved, reservation };
  });
  const minuteCap = Math.min(CONTRAST_LIMITS.minuteTokens, account.tokensPerMinute ?? Infinity);
  const totalReserved = selected.reduce((sum, c) => sum + c.tokens, 0);
  if (selected.some(c => !Number.isFinite(c.tokens) || c.tokens > minuteCap || c.tokens > (account.remainingTokens ?? Infinity))
    || totalReserved > CONTRAST_LIMITS.totalReservedTokens || (account.remainingRequests ?? Infinity) < 3) throw Error('Contrast reservation budget preflight failed');
  return { cases, selection: { selected, count: 3, totalReserved, minuteCap, reserveCeiling: CONTRAST_LIMITS.totalReservedTokens, blocker: null }, schema };
}
