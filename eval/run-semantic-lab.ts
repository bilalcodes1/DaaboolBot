import { SemanticEvaluator, summarizeEvaluation, isUnsafeAcceptedSideEffect, type EvalRecord } from '../src/semantic-eval';
import { GuardedGroqEvaluation, LIVE_EVAL_LIMITS, PACED_EVAL_LIMITS, EVAL_COMPLETION_TOKENS, estimateEvalReservation } from '../src/semantic-eval-guard';
import { ContextBuilder } from '../src/semantic-compiler';
import { SEMANTIC_GOLD_CASES, GOLD_DATASET_VERSION } from './semantic-gold';
import type { SemanticGoldCase } from '../src/semantic-eval';
import { evalSchemaPreflight, selectAdaptiveSmoke } from './semantic-preflight';
import { validateSemanticPlan } from '../src/semantic-validator';
import { checkpointIdentity, sealCheckpoint, validateCheckpoint, type EvalCheckpoint } from './semantic-checkpoint';
import { prepareExplicitContrast, CONTRAST_LIMITS } from './semantic-case-selection';
import { evidenceIdentity } from './semantic-evidence';
import { prepareQualitySmoke, QUALITY_CANDIDATES, summarizeQualityGate, QUALITY_BINDING_RISK } from './semantic-quality-gate';
import { QUALITY_GOLD_VERSION, GOLD_CORRECTIONS, GOLD_AUDIT, GOLD_REVIEW_REQUIRED } from './semantic-gold-v2';
import { QualityContextBuilder } from './semantic-quality-prompt';
import { UnderstandingContextBuilder } from './semantic-understanding-prompt';
import { prepareUnderstandingSmoke, UNDERSTANDING_LIMITS } from './semantic-understanding-gate';
import { UNDERSTANDING_GOLD_VERSION, UNDERSTANDING_LABELS, UNDERSTANDING_REVIEW_GUIDANCE } from './semantic-understanding-fixtures';
import { prepareFinalContractSmoke,FINAL_CONTRACT_LIMITS } from './semantic-final-contract';
import { FinalContractContextBuilder } from './semantic-final-contract-prompt';
import { compareMeaning,semanticPlanMeaning } from '../src/semantic-eval';
export { EVAL_OUTPUT_LIMITS } from './semantic-evidence';

export interface EvaluationProgress { records: EvalRecord[]; stop: string | null; stoppedBeforeCaseId: string | null }
export async function runEvaluation(cases: readonly SemanticGoldCase[], evaluator: SemanticEvaluator,
  stopReason: () => string | null = () => null, requestCount?: () => number): Promise<EvaluationProgress> {
  const records: EvalRecord[] = [];
  for (const gold of cases) {
    if (stopReason()) return { records, stop: stopReason(), stoppedBeforeCaseId: gold.id };
    const before = requestCount?.(); const row = await evaluator.evaluate(gold);
    // A guard can refuse before an HTTP request. Retain prior completed samples only.
    if (stopReason() && row.plannerError === 'planner_transport_error' && (before === undefined || requestCount?.() === before)) return { records, stop: stopReason(), stoppedBeforeCaseId: gold.id };
    records.push(row);
    if (stopReason() || row.plannerError) return { records, stop: stopReason() ?? row.plannerError, stoppedBeforeCaseId: null };
  }
  return { records, stop: null, stoppedBeforeCaseId: null };
}
export function labReadiness(caseIds?: readonly string[], quality=false, understanding=false, contract=false) {
  const explicit = contract?prepareFinalContractSmoke(caseIds):understanding?prepareUnderstandingSmoke(caseIds):quality?prepareQualitySmoke(caseIds):caseIds ? prepareExplicitContrast(caseIds) : null, pool = explicit?.cases ?? SEMANTIC_GOLD_CASES;
  const builder=contract?new FinalContractContextBuilder():understanding?new UnderstandingContextBuilder():quality?new QualityContextBuilder():new ContextBuilder();
  const selection = explicit?.selection ?? selectAdaptiveSmoke(SEMANTIC_GOLD_CASES), schema = explicit?.schema ?? evalSchemaPreflight();
  const estimates = pool.map(g => ({ id: g.id, tokens: estimateEvalReservation(builder.build(g.input, g.context).messages).totalReserved }));
  return { mode: 'offline' as const, datasetVersion: contract||understanding?UNDERSTANDING_GOLD_VERSION:quality?QUALITY_GOLD_VERSION:GOLD_DATASET_VERSION, datasetCases: pool.length, caseSelectionExplicit: !!explicit,
    ...(contract?{evaluationProfile:'contract-v5' as const,identity:checkpointIdentity(pool),detailsPolicy:'optional_create_extra_details_with_verbatim_current_source_fallback',normalizationVersion:checkpointIdentity(pool).normalizationVersion}:understanding?{evaluationProfile:'understanding-v4' as const,fixtureLabels:UNDERSTANDING_LABELS,reviewGuidance:UNDERSTANDING_REVIEW_GUIDANCE,
      identity:checkpointIdentity(pool),writeEligibilityRisk:QUALITY_BINDING_RISK}:quality?{evaluationProfile:'quality-v3' as const,goldAudit:GOLD_AUDIT,goldCorrections:GOLD_CORRECTIONS,reviewRequired:GOLD_REVIEW_REQUIRED,
      writeEligibilityRisk:QUALITY_BINDING_RISK,candidateMatrix:QUALITY_CANDIDATES.map(candidate=>{
        try {const p=prepareQualitySmoke([candidate.id]);return {...candidate,reservedTokens:p.selection.totalReserved,feasible:true,blocker:null};}
        catch {return {...candidate,reservedTokens:null,feasible:false,blocker:'quality_preflight_or_budget'};}
      }),coverageNote:'At most three selected calls; other prepared cases require separate explicit authorization. No automatic multi-batch run.'}:{}),
    categories: Object.fromEntries([...new Set(pool.map(c => c.categories[0]!))].map(category => [category, pool.filter(c => c.categories[0] === category).length])),
    liveRequests: 0, realModelAccuracy: null, hardLimits: { ...LIVE_EVAL_LIMITS, requests: contract?FINAL_CONTRACT_LIMITS.requests:understanding?UNDERSTANDING_LIMITS.requests:explicit ? CONTRAST_LIMITS.requests : PACED_EVAL_LIMITS.requests,
      totalReservedTokens: contract?FINAL_CONTRACT_LIMITS.totalReservedTokens:understanding?UNDERSTANDING_LIMITS.totalReservedTokens:explicit ? CONTRAST_LIMITS.totalReservedTokens : null, durationMs: PACED_EVAL_LIMITS.durationMs },
    selectedCases: selection.selected.map(({id}) => { const g = pool.find(c => c.id === id)!,check=validateSemanticPlan(g.expectedPlan,g.context); return { id, text: g.input.originalText,
      expectedPlan: g.expectedPlan, originalTimestamp: g.context.originalTimestamp, scope: g.context.scope, contextValidated: quality||understanding||contract?true:check.ok,
      ...(quality||understanding||contract?{goldValidatorAccepted:check.ok,goldValidatorReasons:check.ok?[]:check.issues.map(i=>i.reason),
        expectedPolicyMatched:g.expectedValidator==='allow'?check.ok:g.expectedValidator==='deny'?!check.ok&&check.issues.some(i=>i.reason==='permission_denied'):!check.ok&&['conflict','clarification_required'].includes(check.status)}:{}), }; }),
    smokeCases: selection.selected.map(c => c.id), smokeSelection: selection, schemaPreflight: schema,
    estimates: { minimumRequestTokens: Math.min(...estimates.map(e => e.tokens)),
      maximumRequestTokens: Math.max(...estimates.map(e => e.tokens)), smokeRequestTokens: selection.selected },
    smokeAdmission: { eligible: selection.selected.map(c => c.id), blockedByConservativeReservation: explicit ? [] : ('skipped' in selection ? selection.skipped.map(c => c.id) : []) },
    knownValidatorGaps: pool.filter(c => c.knownValidatorGap && !validateSemanticPlan(c.expectedPlan, c.context).ok).map(c => ({ caseId: c.id, reason: c.knownValidatorGap })),
    dateRegressions: pool.filter(c => c.knownValidatorGap).map(c => ({ caseId: c.id, currentValidatorAllows: validateSemanticPlan(c.expectedPlan, c.context).ok })),
    note: 'Readiness only. No planner call, credentials, DB or Telegram bindings. Mock test results are not model accuracy.' };
}
export function parseLabArgs(argv: string[]) {
  let resumePath: string | undefined, checkPath: string | undefined;
  let caseIds: string[] | undefined;
  const switches: string[] = [];
  const versionIndex=argv.indexOf('--prompt-version'),promptVersion=versionIndex>=0?argv[versionIndex+1]:undefined;
  if(versionIndex>=0&&promptVersion!=='v5')throw Error('Unsupported explicit prompt version');
  const contract=promptVersion==='v5';let versionSeen=false;
  const quality=argv.includes('--quality'),understanding=argv.includes('--understanding');let qualitySeen=false,understandingSeen=false;
  if(contract&&(quality||understanding))throw Error('Prompt profiles are mutually exclusive');
  if(quality&&understanding)throw Error('Evaluation profiles are mutually exclusive');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--cases') {
      const value = argv[++i];
      if (caseIds || !value || !/^[a-z0-9_-]+(?:,[a-z0-9_-]+)*$/u.test(value)) throw Error('Invalid explicit case selection');
      caseIds = value.split(',');
      if(contract)prepareFinalContractSmoke(caseIds);else if(understanding)prepareUnderstandingSmoke(caseIds);else if(quality)prepareQualitySmoke(caseIds);else prepareExplicitContrast(caseIds); // No fallback, before secrets.
    } else if(arg==='--prompt-version'&&!versionSeen){versionSeen=true;i++;
    } else if(arg==='--quality'&&!qualitySeen){qualitySeen=true;
    } else if(arg==='--understanding'&&!understandingSeen){understandingSeen=true;
    } else if (['--resume','--check-resume'].includes(arg)) {
      const path = argv[++i];
      if (!path || path.startsWith('--') || resumePath || checkPath) throw Error('Invalid checkpoint arguments');
      if (arg === '--resume') resumePath = path; else checkPath = path;
    } else if (['--live','--smoke'].includes(arg) && !switches.includes(arg)) switches.push(arg);
    else throw Error('Unsupported evaluation arguments');
  }
  if (checkPath && switches.length || resumePath && !switches.includes('--live')) throw Error('Invalid checkpoint mode');
  return { switches, resumePath, checkPath, caseIds, quality, understanding, ...(contract?{promptVersion:'v5' as const}:{promptVersion:undefined}) };
}
export interface LabRuntime {
  checkpointData?: unknown; persist?: (checkpoint: EvalCheckpoint) => Promise<void>;
  clock?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; signal?: AbortSignal;
}
export async function runLab(argv: string[], env: Record<string, string | undefined>, fetcher?: typeof fetch, runtime: LabRuntime = {}) {
  const args = parseLabArgs(argv), now = runtime.clock ?? Date.now,contract=args.promptVersion==='v5';
  const allSmoke = contract?prepareFinalContractSmoke(args.caseIds).cases:args.understanding?prepareUnderstandingSmoke(args.caseIds).cases:args.quality?prepareQualitySmoke(args.caseIds).cases:args.caseIds ? prepareExplicitContrast(args.caseIds).cases : selectAdaptiveSmoke(SEMANTIC_GOLD_CASES).selected.map(({ id }) => SEMANTIC_GOLD_CASES.find(g => g.id === id)!);
  if (args.checkPath) {
    const checked = validateCheckpoint(runtime.checkpointData, allSmoke, now());
    return { mode: 'offline_checkpoint_check' as const, liveRequests: 0, resumable: checked.ok,
      reason: checked.ok ? null : checked.reason, remainingCaseIds: checked.ok ? checked.remainingCaseIds : [] };
  }
  // Validate resume identity/accounting BEFORE credentials, transport or any API call.
  const resumed = args.resumePath ? validateCheckpoint(runtime.checkpointData, allSmoke, now()) : null;
  if (resumed && !resumed.ok) throw Error(`Resume blocked: ${resumed.reason}`);
  const liveFlag = argv.includes('--live'), optIn = env.DAABOUL_EVAL_LIVE;
  if (!liveFlag && optIn !== '1') return labReadiness(args.caseIds,args.quality,args.understanding,contract);
  if (!liveFlag || optIn !== '1' || !argv.includes('--smoke')) throw Error('Live evaluation requires --live --smoke AND DAABOUL_EVAL_LIVE=1. No request sent.');
  const key = env.GROQ_API_KEY?.trim(); if (!key || /\s/u.test(key)) throw Error('GROQ_API_KEY must already exist in the environment. Never place it in command arguments.');
  const tpm = env.DAABOUL_EVAL_ACCOUNT_TPM;
  if (tpm !== undefined && !/^\d{1,9}$/u.test(tpm)) throw Error('Invalid operator-supplied account TPM.');
  const accountLimits = tpm !== undefined ? { tokensPerMinute: Number(tpm) } : {};
  const explicit = contract?prepareFinalContractSmoke(args.caseIds,accountLimits):args.understanding?prepareUnderstandingSmoke(args.caseIds,accountLimits):args.quality?prepareQualitySmoke(args.caseIds,accountLimits):args.caseIds ? prepareExplicitContrast(args.caseIds, accountLimits) : null;
  const selection = explicit?.selection ?? selectAdaptiveSmoke(SEMANTIC_GOLD_CASES, accountLimits), schema = explicit?.schema ?? evalSchemaPreflight();
  if (selection.blocker || (!contract&&!args.quality&&!args.understanding&&selection.count !== (explicit ? 3 : 6)) || !schema.localCompatible) throw Error('Local preflight blocked; no request sent.');
  if (!runtime.persist) throw Error('Durable checkpoint storage required before live evaluation');
  const smoke = explicit?.cases ?? selection.selected.map(({ id }) => SEMANTIC_GOLD_CASES.find(g => g.id === id)!);
  const builder=contract?new FinalContractContextBuilder():args.understanding?new UnderstandingContextBuilder():args.quality?new QualityContextBuilder():new ContextBuilder();
  const allowedPrompts = new Set(smoke.map(g => builder.build(g.input, g.context).messages[1]!.content));
  const prior = resumed?.ok ? resumed.checkpoint : null, startedAt = prior?.startedAt ?? now(), deadlineAt = prior?.deadlineAt ?? startedAt + PACED_EVAL_LIMITS.durationMs;
  let responseMetadata: { status: number | null; rateLimits: Record<string,number> } = { status:null, rateLimits:{} };
  const guard = new GuardedGroqEvaluation({ liveFlag, environmentOptIn: optIn, credential: key, syntheticPromptAllowed: text => allowedPrompts.has(text), clock: now,
    ...(contract?{promptProfile:'contract-v5' as const}:args.understanding?{promptProfile:'understanding-v4' as const}:args.quality?{promptProfile:'quality-v3' as const}:{}),
    onResponseMetadata: metadata => { responseMetadata = metadata; },
    ...(fetcher ? { fetcher } : {}), ...(tpm !== undefined ? { accountLimits: { tokensPerMinute: Number(tpm) } } : {}),
    pacing: { deadlineAt, ...(contract?{limits:FINAL_CONTRACT_LIMITS}:args.understanding?{limits:UNDERSTANDING_LIMITS}:explicit ? { limits: CONTRAST_LIMITS } : {}), ...(runtime.signal ? { signal: runtime.signal } : {}), ...(runtime.sleep ? { sleep: runtime.sleep } : {}), ...(prior ? { snapshot: prior.guard } : {}) } });
  const records = prior?.records ?? [], receipts = prior?.receipts ?? [], priorRequests = guard.state.requests;
  const persist = async (inFlightCaseId: string | null) => {
    const savedAt = now(), snapshot = guard.snapshot();
    snapshot.window = snapshot.window.filter(w => w.at > savedAt - 60000);
    await runtime.persist!(sealCheckpoint({ checkpointVersion: 2, identity: checkpointIdentity(smoke), startedAt, deadlineAt, savedAt,
      completedCaseIds: records.map(r => r.caseId), inFlightCaseId, records, receipts, guard: snapshot }));
  };
  await persist(null);
  let stoppedBeforeCaseId: string | null = null;
  const evaluator = new SemanticEvaluator(guard.transport, 'live_groq', 10000, EVAL_COMPLETION_TOKENS,
    { identity: evidenceIdentity(checkpointIdentity(smoke)), redactValues:[key], clock:now,
      metadata:()=>({...responseMetadata,providerError:guard.state.providerError}) },builder);
  for (const gold of smoke) {
    if (records.some(r => r.caseId === gold.id)) continue;
    try { await guard.waitForCapacity(builder.build(gold.input, gold.context).messages); }
    catch { stoppedBeforeCaseId = gold.id; await persist(null); break; }
    // Write-ahead marker: a crash after dispatch cannot automatically repeat an uncertain call.
    await persist(gold.id);
    responseMetadata = { status:null,rateLimits:{} };
    const admittedAt = now(), before = guard.state.requests;
    const part = await runEvaluation([gold], evaluator, () => guard.state.stop, () => guard.state.requests);
    if (guard.state.requests !== before + 1 || part.records.length !== 1) {
      guard.halt('checkpoint_failure'); stoppedBeforeCaseId = gold.id;
      // Preserve the in-flight marker if dispatch outcome/accounting is uncertain.
      await persist(guard.state.requests === before ? null : gold.id); break;
    }
    const row = part.records[0]!; records.push(row);
    receipts.push({ caseId: gold.id, admittedAt, settledAt: guard.snapshot().window.at(-1)!.at,
      reservedTokens: guard.state.estimates.at(-1)!.totalReserved, reportedTokens: row.usage?.totalTokens ?? null, headers: { ...guard.state.headers } });
    if (isUnsafeAcceptedSideEffect(row)) guard.halt('safety_failure');
    else if(row.falseWriteProposal)guard.halt('semantic_failure');
    if (row.plannerError && !guard.state.stop) guard.state.stop = row.plannerError;
    if (!row.evidence?.complete && !guard.state.stop) guard.halt('checkpoint_failure');
    await persist(null);
    if (guard.state.stop) break;
  }
  const progress: EvaluationProgress = { records, stop: guard.state.stop, stoppedBeforeCaseId };
  return { mode: 'live' as const, datasetVersion: contract||args.understanding?UNDERSTANDING_GOLD_VERSION:args.quality?QUALITY_GOLD_VERSION:GOLD_DATASET_VERSION, caseSelectionExplicit: !!explicit,
    ...(contract?{evaluationProfile:'contract-v5' as const}:args.understanding?{evaluationProfile:'understanding-v4' as const}:args.quality?{evaluationProfile:'quality-v3' as const}:{}),smokeSelection: selection, schemaPreflight: schema,
    ...progress, identity: checkpointIdentity(smoke), receipts, requestsThisInvocation: guard.state.requests - priorRequests,
    summary: args.quality||args.understanding||contract?summarizeQualityGate(progress.records,smoke,contract?'contract-v5':args.understanding?'understanding-v4':'quality-v3'):summarizeEvaluation(progress.records, smoke),
    ...(contract?{contractSummary:{rawAccuracyUnchangedByNormalization:true,normalizedGoldMatches:progress.records.filter(r=>r.evidence?.normalized_plan&&compareMeaning(semanticPlanMeaning(smoke.find(g=>g.id===r.caseId)!.expectedPlan),semanticPlanMeaning(r.evidence.normalized_plan)).exact).length,detailsFromSource:progress.records.filter(r=>r.evidence?.contract?.adjustments.some(a=>a.kind==='verbatim_details')).length,toolsExecuted:0}}:{}),guard: guard.state,
    pacing: { waitedMs: guard.waitedMs, startedAt, deadlineAt, hardLimits: contract?FINAL_CONTRACT_LIMITS:args.understanding?UNDERSTANDING_LIMITS:explicit ? CONTRAST_LIMITS : PACED_EVAL_LIMITS },
    note: 'Synthetic proposal review only; no tool execution. Bounded pacing before requests, durable write-ahead checkpoints, no API retries/fallback/downgrade.' };
}
