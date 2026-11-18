import { createHash } from 'node:crypto';
import { UNDERSTANDING_CASES, UNDERSTANDING_SMOKE_IDS } from './semantic-understanding-fixtures';
import { UnderstandingContextBuilder, UNDERSTANDING_INSTRUCTIONS } from './semantic-understanding-prompt';
import { CONTRACT_INSTRUCTIONS, CONTRACT_PROMPT_VERSION, ContractContextBuilder } from './semantic-contract-prompt';
import { SemanticCompiler } from '../src/semantic-compiler';
import { GroqPlanner, type PlannerTransport } from '../src/groq-planner';
import { compareMeaning, scoreEvaluation, semanticPlanMeaning } from '../src/semantic-eval';
import { normalizeAlignedModelPlan, orderSemanticProposals } from '../src/semantic-contract-alignment';
import { estimateEvalReservation } from '../src/semantic-eval-guard';
import { evalSchemaPreflight } from './semantic-preflight';
import type { SemanticTarget } from '../src/semantic-plan';
import { plainReadObject } from '../src/read-tool-contracts';

export const FROZEN_V4_EVIDENCE_HASH='26948d0819f42e0203359228b809984575e8e8d5b63116187001c89a36b7729d';

// Independently authored application-side intent fixtures, NOT inferred from
// model output, expectedPlan or arbitrary model IDs. This is a NEW offline
// context overlay, never a claim about what the historical live validator saw.
const requested:Readonly<Record<string,readonly SemanticTarget[]>>={
  'p3e-23a':[{type:'previous_list',listId:'phase3e-list',position:2}],
  'p3e-23s':[{type:'previous_list',listId:'phase3e-list',position:2}],
  'p3e-18':[{type:'previous_list',listId:'phase3e-list',position:1}],
};
export function contractReplayCase(id:string) {
  const original=UNDERSTANDING_CASES.find(c=>c.id===id);
  if(!original||!UNDERSTANDING_SMOKE_IDS.includes(id as typeof UNDERSTANDING_SMOKE_IDS[number]))throw Error('Unknown frozen replay case');
  const c=structuredClone(original);
  c.context.requireTargetIntent=true;
  c.context.instructions=c.context.instructions.map(i=>({...i,requiredDependencies:[],
    ...(requested[id]?{requestedTargets:structuredClone(requested[id])}:{})}));
  return c;
}

/** No fetch, DB, bot, executor, environment credential or live transport exists here. */
export async function replayContractResults(report:unknown) {
  if(!plainReadObject(report)||report.mode!=='live'||report.evaluationProfile!=='understanding-v4'||!Array.isArray(report.records)
    ||report.records.length!==6||JSON.stringify(report.records.map(r=>plainReadObject(r)?r.caseId:null))!==JSON.stringify(UNDERSTANDING_SMOKE_IDS))throw Error('Incomplete or unexpected live evidence');
  if(createHash('sha256').update(JSON.stringify(report)).digest('hex')!==FROZEN_V4_EVIDENCE_HASH)throw Error('Historical evaluation evidence changed');
  const results=[];
  for(const originalRow of report.records) {
    if(!plainReadObject(originalRow)||!plainReadObject(originalRow.evidence))throw Error('Missing evaluation evidence');
    const e=originalRow.evidence,c=contractReplayCase(String(originalRow.caseId));
    if(e.complete!==true||e.redacted!==false||e.raw_truncated!==false||typeof e.raw_model_content!=='string'
      ||e.original_message!==c.input.originalText||JSON.stringify(JSON.parse(e.raw_model_content))!==JSON.stringify(e.parsed_model_plan)
      ||JSON.stringify(e.expected_gold_plan)!==JSON.stringify(c.expectedPlan))throw Error('Unreliable or changed replay evidence');
    const raw=JSON.parse(e.raw_model_content),usage=originalRow.usage;
    const transport:PlannerTransport=async()=>({status:200,body:{choices:[{finish_reason:'stop',message:{content:e.raw_model_content}}]}});
    const legacyGold=structuredClone(UNDERSTANDING_CASES.find(g=>g.id===c.id)!);
    const legacy=await new SemanticCompiler(new GroqPlanner(transport),new UnderstandingContextBuilder()).compile(legacyGold.input,legacyGold.context);
    const rescored=scoreEvaluation(legacyGold,legacy,raw,'offline_mock',true,true,200);
    const aligned=normalizeAlignedModelPlan(raw,c.context);
    const compiled=await new SemanticCompiler(new GroqPlanner(transport),new ContractContextBuilder(),normalizeAlignedModelPlan).compile(c.input,c.context);
    if(legacy.metrics.contextError||legacy.metrics.planner?.error||compiled.metrics.contextError||compiled.metrics.planner?.error)throw Error('Offline replay pipeline failed');
    const comparison=compiled.plan?compareMeaning(semanticPlanMeaning(c.expectedPlan),semanticPlanMeaning(compiled.plan)):null;
    const writes=compiled.plan?.operations.filter(o=>o.action!=='read'&&o.action!=='reply')??[];
    const accepted=compiled.validation?.ok===true;
    results.push({caseId:c.id,originalMessage:c.input.originalText,
      rawModelContent:e.raw_model_content,parsedModelPlan:raw,expectedGoldPlan:c.expectedPlan,
      originalLive:{usage,latencyMs:originalRow.latencyMs,validator:e.validator,normalization:e.normalization},
      offlineRawRescore:{exact:rescored.rawExact,comparison:rescored.comparison,unnecessaryClarification:rescored.unnecessaryClarification,
        failures:rescored.failures,legacyValidator:rescored.validator,legacyNormalization:legacy.metrics.normalizationError},
      alignedContract:{ok:aligned.ok,reason:aligned.ok?null:aligned.reason,missing:aligned.ok?[]:aligned.missing,
        adjustments:aligned.adjustments,normalizedPlan:compiled.plan,normalizedComparison:comparison,
        validator:compiled.validation,status:compiled.status,proposedOrder:compiled.plan&&accepted?orderSemanticProposals(compiled.plan).map(o=>o.id):[],
        contextOverlay:'independent_app_intent_fixture_v1_not_historical_context'},
      safety:{acceptedWriteProposal:accepted&&writes.length>0,
        unsafeWriteAccepted:accepted&&writes.length>0&&(c.expectedValidator==='deny'||comparison?.target===false||comparison?.action===false),
        toolsExecuted:0,telegramSends:0,productionWrites:0},
      diagnostics:{modelErrors:rescored.failures.filter(f=>['wrong_entity','wrong_speech_act','wrong_action','unnecessary_clarification'].includes(f)),
        rawContractError:legacy.metrics.normalizationError,remainingContractError:aligned.ok?null:aligned.reason,
        validatorReached:compiled.validation!==null,validatorReasons:compiled.validation?.issues.map(i=>i.reason)??[],
        validatorFalseRejection:compiled.validation?.ok===false&&comparison?.exact===true&&c.expectedValidator==='allow'},
    });
  }
  const schema=evalSchemaPreflight();
  const next=UNDERSTANDING_SMOKE_IDS.map(id=>{const c=contractReplayCase(id);return {id,reservation:estimateEvalReservation(new ContractContextBuilder().build(c.input,c.context).messages)};});
  return {mode:'offline_recorded_replay',liveRequests:0,toolsExecuted:0,sourceExperimentIdentity:report.identity,
    sourceEvidenceHash:createHash('sha256').update(JSON.stringify(report)).digest('hex'),
    goldFrozen:true,rawOutputsUnchanged:true,results,
    summary:{cases:6,rawExactGoldMatches:results.filter(r=>r.offlineRawRescore.exact).length,
      rawUnnecessaryClarifications:results.filter(r=>r.offlineRawRescore.unnecessaryClarification).length,
      alignedNormalizedGoldMatches:results.filter(r=>r.alignedContract.normalizedComparison?.exact).length,
      alignedValidatorAccepted:results.filter(r=>r.alignedContract.validator?.ok).length,
      acceptedAuthorizedWriteProposals:results.filter(r=>r.safety.acceptedWriteProposal&&!r.safety.unsafeWriteAccepted).length,
      unsafeWriteProposalsAccepted:results.filter(r=>r.safety.unsafeWriteAccepted).length,
      provenValidatorFalseRejections:results.filter(r=>r.diagnostics.validatorFalseRejection).length,
      executionSuccessMeasured:false,modelImprovementMeasured:false},
    prompt:{version:CONTRACT_PROMPT_VERSION,oldCharacters:UNDERSTANDING_INSTRUCTIONS.length,newCharacters:CONTRACT_INSTRUCTIONS.length,
      oldBytes:Buffer.byteLength(UNDERSTANDING_INSTRUCTIONS),newBytes:Buffer.byteLength(CONTRACT_INSTRUCTIONS),
      sha256:createHash('sha256').update(CONTRACT_INSTRUCTIONS).digest('hex')},schema,
    proposedReservations:next,totalProposedReserved:next.reduce((n,c)=>n+c.reservation.totalReserved,0),
    note:'Offline replay only. Raw model accuracy is unchanged. Aligned validation uses new independently authored trusted intent fixtures, not historical live authorization. Replayed API usage/latency is historical, not newly consumed.'};
}
