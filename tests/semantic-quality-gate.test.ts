import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SEMANTIC_GOLD_CASES } from '../eval/semantic-gold';
import { SEMANTIC_GOLD_V2, GOLD_CORRECTIONS, GOLD_AUDIT, GOLD_REVIEW_REQUIRED, QUALITY_GOLD_VERSION } from '../eval/semantic-gold-v2';
import { QUALITY_CANDIDATES, QUALITY_SMOKE_IDS, prepareQualitySmoke, qualityCase, summarizeQualityGate } from '../eval/semantic-quality-gate';
import { QUALITY_INSTRUCTIONS, QUALITY_PROMPT_VERSION, QualityContextBuilder } from '../eval/semantic-quality-prompt';
import { ContextBuilder, SEMANTIC_BRAIN_INSTRUCTIONS } from '../src/semantic-compiler';
import { validateSemanticPlan } from '../src/semantic-validator';
import { SemanticEvaluator, type SemanticGoldCase } from '../src/semantic-eval';
import { GuardedGroqEvaluation, EVAL_COMPLETION_TOKENS, assertEvalRequest } from '../src/semantic-eval-guard';
import type { GroqPlanRequest } from '../src/groq-planner';
import { checkpointIdentity, validateCheckpoint, type EvalCheckpoint } from '../eval/semantic-checkpoint';
import { evidenceIdentity } from '../eval/semantic-evidence';
import { parseLabArgs, runLab } from '../eval/run-semantic-lab';
import { mockDraftFromGold } from './helpers/semantic-eval-mocks';

const epoch=Date.parse('2026-10-30T07:00:00Z'), selected=QUALITY_SMOKE_IDS.join(','),flags=['--quality','--live','--smoke','--cases',selected];
const environment={DAABOUL_EVAL_LIVE:'1',GROQ_API_KEY:'synthetic-key'};
const envelope=(draft:unknown)=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(draft)}}],usage:{prompt_tokens:2000,completion_tokens:200,total_tokens:2200}});
function evaluator(draft:unknown) {return new SemanticEvaluator(async()=>({status:200,body:envelope(draft)}),'offline_mock',1000,1024,
  {identity:evidenceIdentity(checkpointIdentity(prepareQualitySmoke().cases)),redactValues:[]},new QualityContextBuilder());}
function harness(ids:readonly string[]=QUALITY_SMOKE_IDS) {
  let time=epoch;const cases=prepareQualitySmoke(ids).cases,checkpoints:EvalCheckpoint[]=[],controller=new AbortController(),calls:GroqPlanRequest[]=[];
  const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
    const request=JSON.parse(String(init!.body)) as GroqPlanRequest;assertEvalRequest(request,'quality-v3');calls.push(request);
    const text=JSON.parse(request.messages[1]!.content).user_instruction[0].text, gold=cases.find(c=>c.input.originalText===text)!;
    return Response.json(envelope(mockDraftFromGold(gold.expectedPlan)));
  });
  return {fetcher,calls,checkpoints,controller,clock:()=>time,runtime:{clock:()=>time,signal:controller.signal,sleep:async(ms:number)=>{time+=ms;},persist:async(cp:EvalCheckpoint)=>{checkpoints.push(structuredClone(cp));}}};
}
beforeEach(()=>vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Network forbidden in quality tests');})));
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('independent versioned gold/taxonomy audit',()=>{
  it('keeps v1 historical labels and raw prompt intact, with a separate versioned overlay',()=>{
    expect(SEMANTIC_GOLD_CASES).toHaveLength(160);expect(SEMANTIC_GOLD_V2).toHaveLength(160);expect(GOLD_AUDIT).toHaveLength(160);
    expect(SEMANTIC_GOLD_CASES.find(c=>c.id==='english-01')!.expectedPlan.operations[0]!.speechAct).toBe('question');
    expect(SEMANTIC_GOLD_V2.find(c=>c.id==='english-01')!.expectedPlan.operations[0]!.speechAct).toBe('command');
    expect(SEMANTIC_GOLD_V2.every(c=>c.datasetVersion===QUALITY_GOLD_VERSION)).toBe(true);
    expect(createHash('sha256').update(SEMANTIC_BRAIN_INSTRUCTIONS).digest('hex')).toBe('536a4f6fb939901db2edec93e238b3f2719236ce840481bd6549df43f6aed4f1');
    expect(new ContextBuilder().build(SEMANTIC_GOLD_CASES[0]!.input,SEMANTIC_GOLD_CASES[0]!.context).messages[0]!.content).toBe(SEMANTIC_BRAIN_INSTRUCTIONS);
    expect(QUALITY_PROMPT_VERSION).toBe('semantic-brain-v3-taxonomy');expect(QUALITY_INSTRUCTIONS).toContain('including wellbeing');
  });
  it.each(SEMANTIC_GOLD_V2)('preflights app-owned context, original Baghdad date, grounded gold and policy for $id',c=>{
    const original=SEMANTIC_GOLD_CASES.find(old=>old.id===c.id)!;
    expect(c.input.originalText).toBe(original.input.originalText);expect(c.context.originalTimestamp).toBe(original.context.originalTimestamp);
    expect(new Date(c.context.originalTimestamp).toISOString()).toBe('2026-10-29T22:30:00.000Z');
    const built=new QualityContextBuilder().build(c.input,c.context),metadata=JSON.parse(built.messages[1]!.content).trusted_metadata;
    expect(metadata.baghdadDate).toBe('2026-10-30');
    const checked=validateSemanticPlan(c.expectedPlan,built.context);
    if(c.expectedValidator==='allow')expect(checked,c.id).toMatchObject({ok:true});
    else {expect(checked.ok).toBe(false);if(!checked.ok)expect(checked.issues.some(i=>i.reason==='permission_denied')).toBe(true);}
  });
  it('logs every changed field and retains independently justified statement save attestations',()=>{
    expect(GOLD_CORRECTIONS).toHaveLength(44);expect(new Set(GOLD_CORRECTIONS.map(c=>c.id)).size).toBe(43);
    for(const change of GOLD_CORRECTIONS){expect(change.reason).not.toBe('');expect(change.after).not.toEqual(change.before);}
    const amended=GOLD_CORRECTIONS.find(c=>c.id==='correction_previous-02')!;
    expect((amended.before as SemanticGoldCase).abstentionExpected).toBe(false);expect((amended.after as SemanticGoldCase).abstentionExpected).toBe(true);
    const c=SEMANTIC_GOLD_V2.find(c=>c.id==='multiple_announcements-02')!;
    expect(c.expectedPlan.operations.every(op=>op.speechAct==='statement')).toBe(true);expect(c.context.instructions.every(i=>i.speechAct==='statement')).toBe(true);
  });
  it('corrects explicit targets and clarifies missing targets without broadening grants',()=>{
    for(const id of ['unauthorized_actions-05','correction_previous-03']){
      const op=SEMANTIC_GOLD_V2.find(c=>c.id===id)!.expectedPlan.operations[0]!;expect('target'in op&&op.target).toMatchObject({position:2});
    }
    for(const id of ['unauthorized_actions-04','unauthorized_actions-06','fake_admin_claim-03','fake_admin_claim-05']){
      const c=SEMANTIC_GOLD_V2.find(c=>c.id===id)!,op=c.expectedPlan.operations[0]!;
      expect(op.action==='publish'&&op.targets).toHaveLength(2);expect(c.context.allowedActions).toEqual(['read']);
    }
    const missing=SEMANTIC_GOLD_V2.find(c=>c.id==='dependent_update_publish-03')!;
    expect(missing.expectedPlan.operations[0]).toMatchObject({action:'reply',subject:'clarification'});expect(missing.context.instructions).toEqual([]);expect(missing.ambiguity).toBe(true);
  });
  it.each(['old_list_reply-05','old_list_reply-06','old_list_reply-07','old_list_reply-08'])('actually removes stale/foreign selection data from %s',id=>{
    const c=SEMANTIC_GOLD_V2.find(c=>c.id===id)!,dynamic=JSON.parse(new QualityContextBuilder().build(c.input,c.context).messages[1]!.content);
    expect(c.context.sources.every(s=>s.kind==='current')).toBe(true);expect(dynamic.references).toEqual([]);expect(dynamic.target_selectors).toEqual([]);
  });
  it('keeps social question gold and locally verified synthetic roles, never a claimed admin name',()=>{
    const social=qualityCase('social-wellbeing');expect(social.expectedPlan.operations[0]).toMatchObject({action:'reply',subject:'conversation',speechAct:'question'});
    for(const [id,role] of [['fake_admin_claim-06','student'],['dependent_update_publish-01','admin']] as const){
      const c=qualityCase(id),dynamic=JSON.parse(new QualityContextBuilder().build(c.input,c.context).messages[1]!.content);expect(dynamic.trusted_metadata.actorRole).toBe(role);
    }
    expect(GOLD_REVIEW_REQUIRED).toHaveLength(18);expect(()=>qualityCase('short-05')).toThrow();
  });
});

describe('separate semantic, policy and execution quality',()=>{
  it('never calls a safe denial or refusal proof of task execution/primary intent',async()=>{
    const c=qualityCase('fake_admin_claim-06'),denied=await evaluator(mockDraftFromGold(c.expectedPlan)).evaluate(c);
    const refusal=await evaluator(mockDraftFromGold(c.alternatives![0]!.plan)).evaluate(c);
    const d=summarizeQualityGate([denied],[c]),r=summarizeQualityGate([refusal],[c]);
    expect(d.intent.correct).toBe(1);expect(d.validatorAccepted).toBe(0);expect(d.unsafePlanAcceptance).toBe(0);
    expect(r.intent.correct).toBe(0);expect(r.acceptedSafeAlternatives).toBe(1);expect(r.validatorAccepted).toBe(1);
    expect(d.taskCompletion).toMatchObject({measured:false,value:null});expect(r.taskCompletion.value).toBeNull();
    expect(r.performance).not.toHaveProperty('tokensPerCorrectPlan');
  });
  it('distinguishes arbitrary model IDs from wrong semantic meaning without repairing trusted attestations',async()=>{
    const c=qualityCase('questions_commands-05'),draft=mockDraftFromGold(c.expectedPlan);draft.operations[0]!.id='op1';
    const row=await evaluator(draft).evaluate(c),q=summarizeQualityGate([row],[c]);
    expect(q.primaryGoldMatches).toBe(1);expect(q.intent.correct).toBe(1);expect(q.validatorAccepted).toBe(0);
    expect(row.validator.reasons).toContain('intent_not_established');expect(row.validator.correct).toBeNull();expect(row.failures).not.toContain('validator_false_reject');
    expect((row.evidence!.parsed_model_plan as typeof draft).operations[0]!.id).toBe('op1');expect(c.context.instructions[0]!.operationId).toBe('a');
  });
  it('scores speech act independently from correct social intent',async()=>{
    const c=qualityCase('social-wellbeing'),draft=mockDraftFromGold(c.expectedPlan);draft.operations[0]!.speechAct='chitchat';
    const q=summarizeQualityGate([await evaluator(draft).evaluate(c)],[c]);
    expect(q.intent.correct).toBe(1);expect(q.speechAct.correct).toBe(0);expect(q.primaryGoldMatches).toBe(0);expect(q.validatorAccepted).toBe(1);
  });
  it('does not score API failure or missing model output as wrong intent',async()=>{
    const c=qualityCase('questions_commands-05'),row=await new SemanticEvaluator(async()=>({status:429,body:{}})).evaluate(c);
    const q=summarizeQualityGate([row],[c]);expect(q.attemptedCases).toBe(1);expect(q.total).toBe(0);
    expect(q.intent).toEqual({correct:0,total:0,unscored:1});expect(q.records[0]!.primaryGoldMatch).toBeNull();
    expect(q.performance.totalTokens.value).toBeNull();expect(q.records[0]!.alignment).toBe('no_model_output');
  });
  it('includes tool in intent, while a sole question force remains separately scorable',async()=>{
    const c=SEMANTIC_GOLD_V2.find(c=>c.id==='iraqi_anbari-05')!,draft=mockDraftFromGold(c.expectedPlan);
    draft.operations[0]!.tool='get_cohort_info';
    const row=await evaluator(draft).evaluate(c),q=summarizeQualityGate([row],[c]);
    expect(row.comparison.action).toBe(true);expect(q.intent.correct).toBe(0);expect(q.speechAct.correct).toBe(1);expect(q.entitySlots.correct).toBe(1);
  });
  it('does not manufacture independent alignment scores for repeated intents',async()=>{
    const c=SEMANTIC_GOLD_V2.find(c=>c.id==='multiple_announcements-01')!;
    const q=summarizeQualityGate([await evaluator(mockDraftFromGold(c.expectedPlan)).evaluate(c)],[c]);
    expect(q.primaryGoldMatches).toBe(1);expect(q.speechAct.unscored).toBe(1);expect(q.records[0]!.alignment).toBe('unscorable_or_wrong_intent');
  });
  it('preserves real dependencies and reports missing dependency as a separate failure',async()=>{
    const c=qualityCase('dependent_update_publish-01'),draft=mockDraftFromGold(c.expectedPlan);draft.operations[1]!.dependsOn=[];
    const q=summarizeQualityGate([await evaluator(draft).evaluate(c)],[c]);expect(q.intent.correct).toBe(1);expect(q.dependency.correct).toBe(0);
  });
});

describe('bounded opt-in quality profile, existing runner and offline CLI',()=>{
  it('prepares every requested scenario, selects only three, and keeps 5000/20000/10m limits',()=>{
    const p=prepareQualitySmoke();expect(p.selection.totalReserved).toBe(14402);expect(p.selection.selected.map(c=>c.tokens)).toEqual([4731,4727,4944]);
    expect(QUALITY_CANDIDATES).toHaveLength(11);for(const c of QUALITY_CANDIDATES)expect(prepareQualitySmoke([c.id]).selection.totalReserved).toBeLessThanOrEqual(5000);
    expect(()=>prepareQualitySmoke([...QUALITY_SMOKE_IDS,'english-01'])).toThrow();expect(()=>prepareQualitySmoke(['unknown'])).toThrow();
    expect(()=>prepareQualitySmoke(undefined,{tokensPerMinute:4700})).toThrow('budget');
  });
  it('runs only three sequential mocked proposals, records V3/V2 identity and no task completion',async()=>{
    const h=harness(),result=await runLab(flags,environment,h.fetcher as typeof fetch,h.runtime);if(result.mode!=='live')throw Error('mode');
    expect(h.calls).toHaveLength(3);expect(result.guard.requests).toBe(3);expect(result.guard.reportedTokens).toBe(6600);
    expect(result.identity).toMatchObject({promptVersion:QUALITY_PROMPT_VERSION,datasetVersion:QUALITY_GOLD_VERSION,executionLimits:{requests:3,totalReservedTokens:20000,minuteTokens:5000,durationMs:600000}});
    expect(result.summary).toMatchObject({profile:'quality-v3',primaryGoldMatches:3,unsafePlanAcceptance:0,taskCompletion:{measured:false,value:null},productionReady:false});
    expect(result.records.every(r=>r.toolExecutions===0)).toBe(true);expect(validateCheckpoint(h.checkpoints.at(-1),prepareQualitySmoke().cases,h.clock())).toMatchObject({ok:true});
  });
  it('resumes only unfinished quality cases and refuses switching back to the historical contrast profile',async()=>{
    const h=harness();h.runtime.sleep=async()=>{h.controller.abort();throw Error('cancel');};
    await runLab(flags,environment,h.fetcher as typeof fetch,h.runtime);const cp=h.checkpoints.at(-1)!,next=harness();
    const result=await runLab([...flags,'--resume','synthetic.json'],environment,next.fetcher as typeof fetch,{...next.runtime,checkpointData:cp});
    if(result.mode!=='live')throw Error('mode');expect(result.requestsThisInvocation).toBe(2);expect(result.records).toHaveLength(3);
    await expect(runLab(['--live','--smoke','--resume','synthetic.json'],environment,vi.fn(),{clock:h.clock,checkpointData:cp})).rejects.toThrow('mismatch');
  });
  it('the independent guard rejects a fourth quality call and a V2 prompt in the quality profile',async()=>{
    const h=harness(),g=new GuardedGroqEvaluation({promptProfile:'quality-v3',clock:h.clock,pacing:{deadlineAt:epoch+600000,limits:{requests:3,totalReservedTokens:20000}}});
    g.state.requests=3;await expect(g.waitForCapacity(new QualityContextBuilder().build(qualityCase('english-01').input,qualityCase('english-01').context).messages)).rejects.toThrow('request_cap');
    expect(h.fetcher).not.toHaveBeenCalled();
    const run=harness(['english-01']);await runLab(['--quality','--live','--smoke','--cases','english-01'],environment,run.fetcher as typeof fetch,run.runtime);
    const request=structuredClone(run.calls[0]!);request.messages[0]!.content=SEMANTIC_BRAIN_INSTRUCTIONS;
    expect(()=>assertEvalRequest(request,'quality-v3')).toThrow();expect(()=>assertEvalRequest(run.calls[0]!)).toThrow();
  });
  it('the exact later command is verified offline without credentials or native network',()=>{
    expect(parseLabArgs(['--cases',selected,'--quality']).quality).toBe(true);expect(()=>parseLabArgs(['--quality','--quality'])).toThrow();
    const child=spawnSync(process.execPath,['scripts/eval-semantic.mjs','--quality','--cases',selected],{encoding:'utf8',env:{PATH:process.env.PATH!}});
    expect(child.status,child.stderr).toBe(0);expect(JSON.parse(child.stdout)).toMatchObject({mode:'offline',liveRequests:0,cases:[...QUALITY_SMOKE_IDS],totalReservedTokens:14402});
  });
  it('historical live results keep their frozen scores and never acquire new labels',()=>{
    const path='output/semantic-eval/paced-smoke-2026-10-30T14-52-25-304Z.json',old=JSON.parse(readFileSync(path,'utf8'));
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe('072e8dd4463e9fb34e37b0aff470c5d6e226d6f7630bb62ce9aab968055f212a');
    expect(old.records.map((r:{rawExact:boolean})=>r.rawExact)).toEqual([true,true,false]);expect(old.identity.promptVersion).toBe('semantic-brain-v2');
    expect(old.identity.datasetVersion).toBe('daaboul-synthetic-gold-v1');
    expect(createHash('sha256').update(readFileSync('output/semantic-eval/smoke-2026-10-30T07-11-04-821Z.json')).digest('hex')).toBe('afbeb7795b686277f18a70d5ea257914f55449dbba076a1d401bd4126093f718');
  });
});
