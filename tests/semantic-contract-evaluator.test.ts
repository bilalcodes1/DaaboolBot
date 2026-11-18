import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finalContractCase } from '../eval/semantic-final-contract';
import { FinalContractContextBuilder, FINAL_CONTRACT_PROMPT_VERSION } from '../eval/semantic-final-contract-prompt';
import { validEvaluationEvidence, type EvidenceIdentity } from '../eval/semantic-evidence';
import { UnderstandingContextBuilder } from '../eval/semantic-understanding-prompt';
import { UNDERSTANDING_CASES } from '../eval/semantic-understanding-fixtures';
import { compareMeaning, draftPlanMeaning, isUnsafeAcceptedSideEffect, scoreEvaluation, SemanticEvaluator, semanticPlanMeaning, type SemanticGoldCase } from '../src/semantic-eval';
import { FINAL_CONTRACT_NORMALIZATION_VERSION } from '../src/semantic-contract-alignment';
import type { CompilationResult } from '../src/semantic-compiler';
import type { ModelPlanDraftV1 } from '../src/semantic-draft';
import { mockDraftFromGold } from './helpers/semantic-eval-mocks';

const identity:EvidenceIdentity={model:'openai/gpt-oss-120b',modelHash:'a'.repeat(64),modelHashKind:'identifier_sha256',
  promptVersion:FINAL_CONTRACT_PROMPT_VERSION,promptHash:'b'.repeat(64),schemaVersion:1,schemaHash:'8e0983deadf3b0c8cb3452de7023cb1f64d470165771b2c441e6ad5fe53074b4'};
beforeEach(()=>vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Network forbidden in V5 evaluator tests');})));
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();});
function canonical(c:SemanticGoldCase) {
  const draft=mockDraftFromGold(c.expectedPlan);
  for(const op of draft.operations)if(op.target){op.targets=[op.target];op.target=null;}
  return draft;
}
async function evaluate(c:SemanticGoldCase,raw:unknown) {
  const transport=vi.fn(async()=>({status:200,body:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(raw)}}],
    usage:{prompt_tokens:2000,completion_tokens:200,total_tokens:2200}}}));
  const evaluator=new SemanticEvaluator(transport,'offline_mock',1000,1024,{identity,redactValues:[],clock:()=>c.context.now,
    metadata:()=>({status:200,rateLimits:{},providerError:null})},new FinalContractContextBuilder());
  const row=await evaluator.evaluate(c);
  expect(transport).toHaveBeenCalledTimes(1);expect(row.toolExecutions).toBe(0);
  return row;
}

describe('V5 raw scores remain independent of verified contract normalization',()=>{
  it.each(['absent','null'] as const)('admits create with %s optional details without inventing raw model success',async mode=>{
    const c=finalContractCase('p3e-03'),draft=canonical(c),op=draft.operations[0]!;
    if(mode==='absent')op.fields=op.fields!.filter(f=>f.name!=='details');
    else op.fields!.find(f=>f.name==='details')!.value=null;
    const before=structuredClone(draft),context=structuredClone(c.context),row=await evaluate(c,draft);
    expect(row.rawExact).toBe(false);expect(row.correctCompletion).toBe(false);
    expect(row.validator.actual).toBe('allow');expect(row.invalidPlan).toBe(false);
    expect(row.stages).toMatchObject({localSchemaValid:true,normalization:'ok',executionEligibility:'proposal_only'});
    expect(row.evidence!.raw_model_content).toBe(JSON.stringify(draft));
    expect(row.evidence!.parsed_model_plan).toEqual(draft);
    const normalized=row.evidence!.normalized_plan!.operations[0]!;
    expect(normalized.action).toBe('create');
    if(normalized.action!=='create')throw Error('Expected create');
    expect(normalized.data.details).toEqual({value:c.input.originalText,evidence:op.evidence});
    expect(normalized.data.time).toBeUndefined();expect(normalized.data.audience).toBeUndefined();
    expect(row.evidence!.contract).toMatchObject({adapterVersion:FINAL_CONTRACT_NORMALIZATION_VERSION,
      adjustments:expect.arrayContaining([expect.objectContaining({kind:'verbatim_details'})])});
    expect(row.evidence!.scoring).toMatchObject({raw_semantic_match:false,raw_model_correct:false,normalization_preserves_raw_meaning:false});
    expect(validEvaluationEvidence(row.evidence,c,identity,row)).toBe(true);
    expect(isUnsafeAcceptedSideEffect(row)).toBe(false);expect(draft).toEqual(before);expect(c.context).toEqual(context);
  });

  it('preserves real supplied details and does not add the source fallback',async()=>{
    const c=finalContractCase('p3e-03'),draft=canonical(c),row=await evaluate(c,draft);
    expect(row.rawExact).toBe(true);expect(row.validator.actual).toBe('allow');
    const normalized=row.evidence!.normalized_plan!.operations[0]!;
    if(normalized.action!=='create')throw Error('Expected create');
    const expected=c.expectedPlan.operations[0]!;
    if(expected.action!=='create')throw Error('Expected create gold');
    expect(normalized.data.details).toEqual(expected.data.details);
    expect(row.evidence!.contract!.adjustments.some(a=>a.kind==='verbatim_details')).toBe(false);
    expect(validEvaluationEvidence(row.evidence,c,identity,row)).toBe(true);
  });

  it('still rejects a missing required value property instead of treating it as null',async()=>{
    const c=finalContractCase('p3e-03'),draft=canonical(c);
    delete (draft.operations[0]!.fields!.find(f=>f.name==='details') as unknown as Record<string,unknown>).value;
    const row=await evaluate(c,draft);
    expect(row.stages.localSchemaValid).toBe(false);expect(row.validator.actual).toBe('invalid');expect(row.invalidPlan).toBe(true);
    expect(row.evidence!.normalized_plan).toBeNull();expect(row.evidence!.contract!.adjustments).toEqual([]);
    expect(validEvaluationEvidence(row.evidence,c,identity,row)).toBe(true);
  });

  it('projects canonical singleton target vectors without resolving targets or changing raw contents',async()=>{
    const c=finalContractCase('p3e-18'),draft=canonical(c);
    expect(compareMeaning(semanticPlanMeaning(c.expectedPlan),draftPlanMeaning(draft)).exact).toBe(false);
    expect(compareMeaning(semanticPlanMeaning(c.expectedPlan),draftPlanMeaning(draft,true)).exact).toBe(true);
    const row=await evaluate(c,draft);
    expect(row.rawExact).toBe(true);expect(row.comparison.target).toBe(true);expect(row.validator.actual).toBe('allow');
    expect(row.evidence!.parsed_model_plan).toEqual(draft);expect(row.evidence!.raw_model_content).toBe(JSON.stringify(draft));
    expect(row.evidence!.normalized_plan!.operations[0]).toMatchObject({action:'update',target:{type:'previous_list',listId:'phase3e-list',position:1},patch:{time:{mode:'set',value:'09:45'}}});
    expect(row.wrongTargetAccepted).toBe(false);expect(isUnsafeAcceptedSideEffect(row)).toBe(false);
    expect(validEvaluationEvidence(row.evidence,c,identity,row)).toBe(true);
  });

  it('does not call a verified equivalent legacy publication container an accepted wrong target',async()=>{
    const c=finalContractCase('p3e-23a'),draft=canonical(c),op=draft.operations[0]!;
    op.target=op.targets![0]!;op.targets=null;
    const row=await evaluate(c,draft);
    expect(row.rawExact).toBe(false);expect(row.comparison.target).toBe(false);
    expect(row.validator.actual).toBe('allow');expect(row.invalidPlan).toBe(false);
    expect(row.wrongTargetAccepted).toBe(false);expect(isUnsafeAcceptedSideEffect(row)).toBe(false);
    expect(row.evidence!.contract!.adjustments.some(a=>a.kind==='target_container')).toBe(true);
    expect(validEvaluationEvidence(row.evidence,c,identity,row)).toBe(true);
  });

  it('enforces actual student publication denial even when the raw canonical plan matches gold',async()=>{
    const c=finalContractCase('p3e-23s'),row=await evaluate(c,canonical(c));
    expect(row.rawExact).toBe(true);expect(row.validator).toMatchObject({actual:'deny',reasons:['permission_denied'],correct:true});
    expect(row.unauthorizedProposal).toBe(true);expect(row.wrongTargetAccepted).toBe(false);
    expect(row.stages.executionEligibility).toBe('not_eligible');expect(isUnsafeAcceptedSideEffect(row)).toBe(false);
    expect(validEvaluationEvidence(row.evidence,c,identity,row)).toBe(true);
  });

  it('rejects a different in-scope target, and retains an accepted-wrong-target alarm if validation is falsely forced',async()=>{
    const c=finalContractCase('p3e-18'),draft=canonical(c);draft.operations[0]!.targets![0]!.position=2;
    const row=await evaluate(c,draft);expect(row.validator.actual).not.toBe('allow');expect(row.stages.normalizationReason).toBe('unrequested_target');
    expect(isUnsafeAcceptedSideEffect(row)).toBe(false);
    const wrong=structuredClone(c.expectedPlan),op=wrong.operations[0]!;
    if(op.action!=='update'||op.target.type!=='previous_list')throw Error('Expected update');op.target.position=2;
    const forced:CompilationResult={status:'proposal_only',plan:wrong,planTrust:'model_proposal',validation:{ok:true,issues:[]},missing:[],
      metrics:{planner:null,validationRejects:0,normalizationError:null,contextError:null,droppedContext:0}};
    const unsafe=scoreEvaluation(c,forced,draft,'offline_mock');
    expect(unsafe.wrongTargetAccepted).toBe(true);expect(isUnsafeAcceptedSideEffect(unsafe)).toBe(true);
  });

  it('does not let canonical target projection silently select among multiple targets',()=>{
    const c=finalContractCase('p3e-18'),draft=canonical(c);draft.operations[0]!.targets!.push({...draft.operations[0]!.targets![0]!,position:2});
    expect(compareMeaning(semanticPlanMeaning(c.expectedPlan),draftPlanMeaning(draft,true)).target).toBe(false);
  });
});

describe('V5 evidence sidecar is recomputed and isolated from older evidence',()=>{
  it.each(['missing','adapter','adjustment','normalized'] as const)('rejects %s contract evidence tampering',async kind=>{
    const c=finalContractCase('p3e-18'),row=await evaluate(c,canonical(c)),e=structuredClone(row.evidence!);
    if(kind==='missing')delete e.contract;
    if(kind==='adapter')e.contract!.adapterVersion='forged';
    if(kind==='adjustment')e.contract!.adjustments.push({operationId:'fake',path:'fields.time',kind:'field_evidence'});
    if(kind==='normalized')e.normalized_plan!.operations=[];
    expect(validEvaluationEvidence(e,c,identity,row)).toBe(false);
  });

  it('leaves V4 schema/evidence behavior unchanged and rejects a V5 sidecar on V4',async()=>{
    const c=structuredClone(UNDERSTANDING_CASES.find(c=>c.id==='p3e-13')!),raw=mockDraftFromGold(c.expectedPlan);
    const transport=async()=>({status:200,body:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(raw)}}]}});
    const evaluator=new SemanticEvaluator(transport,'offline_mock',1000,1024,{identity,redactValues:[],clock:()=>c.context.now},new UnderstandingContextBuilder());
    const row=await evaluator.evaluate(c);expect(row.evidence).not.toHaveProperty('contract');
    expect(validEvaluationEvidence(row.evidence,c,identity,row)).toBe(true);
    const modified={...row.evidence!,contract:{adapterVersion:FINAL_CONTRACT_NORMALIZATION_VERSION,adjustments:[]}};
    expect(validEvaluationEvidence(modified,c,identity,row)).toBe(false);
  });
});
