import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FINAL_CONTRACT_IDS, FINAL_CONTRACT_LIMITS, prepareFinalContractSmoke, finalContractCase } from '../eval/semantic-final-contract';
import { FINAL_CONTRACT_INSTRUCTIONS, FINAL_CONTRACT_PROMPT_VERSION } from '../eval/semantic-final-contract-prompt';
import { parseLabArgs, runLab } from '../eval/run-semantic-lab';
import { checkpointIdentity, sealCheckpoint, validateCheckpoint, type EvalCheckpoint } from '../eval/semantic-checkpoint';
import { assertEvalRequest, EVAL_COMPLETION_TOKENS, GuardedGroqEvaluation } from '../src/semantic-eval-guard';
import type { GroqPlanRequest } from '../src/groq-planner';
import type { ModelPlanDraftV1 } from '../src/semantic-draft';
import type { SemanticGoldCase } from '../src/semantic-eval';
import { UNDERSTANDING_CASES } from '../eval/semantic-understanding-fixtures';
import { mockDraftFromGold } from './helpers/semantic-eval-mocks';

beforeEach(()=>vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Network forbidden in V5 CLI tests');})));
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();});
const liveEnv={DAABOUL_EVAL_LIVE:'1',GROQ_API_KEY:'synthetic-key'};
const cli=['--prompt-version','v5','--live','--smoke'];
function canonicalDraft(c:SemanticGoldCase):ModelPlanDraftV1 {
  const draft=mockDraftFromGold(c.expectedPlan),ids=new Map(draft.operations.map((op,i)=>[op.id,`op${i+1}`]));
  for(const op of draft.operations){op.id=ids.get(op.id)!;op.dependsOn=op.dependsOn.map(id=>ids.get(id)!);if(op.target){op.targets=[op.target];op.target=null;}}
  return draft;
}
function harness(proposed:(c:SemanticGoldCase)=>ModelPlanDraftV1=canonicalDraft) {
  let now=Date.parse('2026-11-01T09:00:00Z'),active=0,maxActive=0;
  const cases=prepareFinalContractSmoke().cases,checkpoints:EvalCheckpoint[]=[],requests:GroqPlanRequest[]=[],sleeps:number[]=[];
  const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
    const request=JSON.parse(String(init!.body)) as GroqPlanRequest;assertEvalRequest(request,'contract-v5');requests.push(request);
    const dynamic=JSON.parse(request.messages[1]!.content),role=dynamic.trusted_metadata.actorRole;
    const c=cases.find(c=>c.input.originalText===dynamic.user_instruction[0].text&&(c.context.actor.userId===c.context.actor.ownerUid?'admin':'student')===role);
    if(!c)throw Error('Unexpected synthetic request');
    active++;maxActive=Math.max(maxActive,active);await Promise.resolve();active--;
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(proposed(c))}}],usage:{prompt_tokens:2000,completion_tokens:200,total_tokens:2200}},
      {headers:{'x-ratelimit-limit-tokens':'8000'}});
  });
  const runtime={clock:()=>now,sleep:async(ms:number)=>{sleeps.push(ms);now+=ms;},persist:async(cp:EvalCheckpoint)=>{checkpoints.push(structuredClone(cp));}};
  return {cases,checkpoints,requests,fetcher,sleeps,runtime,clock:()=>now,maxActive:()=>maxActive};
}

describe('explicit V5 selection and frozen five-case preflight',()=>{
  it('requires explicit v5 and never silently substitutes V4 or another profile',()=>{
    expect(parseLabArgs(['--prompt-version','v5']).promptVersion).toBe('v5');
    expect(parseLabArgs(['--cases',FINAL_CONTRACT_IDS.join(','),'--prompt-version','v5']).promptVersion).toBe('v5');
    for(const args of [
      ['--prompt-version'],['--prompt-version','v4'],['--prompt-version','unknown'],['--prompt-version','v5','--prompt-version','v5'],
      ['--prompt-version','v5','--understanding'],['--quality','--prompt-version','v5'],
    ])expect(()=>parseLabArgs(args)).toThrow();
    expect(parseLabArgs(['--understanding']).understanding).toBe(true);
    expect(parseLabArgs([]).promptVersion).not.toBe('v5');
  });

  it('admits exactly the audited pool without relabelling original gold or mutating its trusted context',()=>{
    const original=JSON.stringify(UNDERSTANDING_CASES),prepared=prepareFinalContractSmoke();
    expect(prepared.cases.map(c=>c.id)).toEqual(['p3e-03','p3e-13','p3e-23a','p3e-23s','p3e-18']);
    for(const c of prepared.cases){
      expect(c.evaluationProfile).toBe('contract-v5');
      expect(c.expectedPlan).toEqual(UNDERSTANDING_CASES.find(g=>g.id===c.id)!.expectedPlan);
      expect(c.context.requireTargetIntent).toBe(true);
    }
    prepared.cases[0]!.context.instructions=[];expect(JSON.stringify(UNDERSTANDING_CASES)).toBe(original);
    expect(finalContractCase('p3e-23a').context.actor.userId).toBe(finalContractCase('p3e-23a').context.actor.ownerUid);
    expect(finalContractCase('p3e-23s').context.actor.userId).not.toBe(finalContractCase('p3e-23s').context.actor.ownerUid);
    for(const ids of [[],['unknown'],['p3e-03','p3e-03'],[...FINAL_CONTRACT_IDS,'p3e-30']])expect(()=>prepareFinalContractSmoke(ids)).toThrow();
    expect(()=>finalContractCase('p3e-30')).toThrow();
  });

  it('reserves full completions conservatively and pins unchanged strict schema plus V5 identity',()=>{
    const p=prepareFinalContractSmoke();
    expect(FINAL_CONTRACT_LIMITS).toEqual({requests:5,totalReservedTokens:50000,minuteTokens:5000,durationMs:600000});
    expect(p.selection.count).toBe(5);expect(p.selection.totalReserved).toBeLessThanOrEqual(50000);
    expect(p.selection.selected.every(c=>Number.isFinite(c.tokens)&&c.tokens<=5000&&c.reservation.outputReserved===1024)).toBe(true);
    expect(p.schema).toMatchObject({model:'openai/gpt-oss-120b',strict:true,tools:false,streaming:false,localCompatible:true,
      schemaHash:'8e0983deadf3b0c8cb3452de7023cb1f64d470165771b2c441e6ad5fe53074b4'});
    const identity=checkpointIdentity(p.cases);
    expect(identity).toMatchObject({promptVersion:FINAL_CONTRACT_PROMPT_VERSION,executionLimits:FINAL_CONTRACT_LIMITS});
    expect(identity.datasetVersion).toBe(p.cases[0]!.datasetVersion);
    expect(identity.promptHash).toBe(createHash('sha256').update(JSON.stringify(FINAL_CONTRACT_INSTRUCTIONS)).digest('hex'));
    expect(()=>prepareFinalContractSmoke(undefined,{tokensPerMinute:100})).toThrow();
    expect(()=>prepareFinalContractSmoke(undefined,{remainingRequests:4})).toThrow();
  });

  it('does not require credentials or invoke a transport in offline readiness',async()=>{
    const fetcher=vi.fn(),result=await runLab(['--prompt-version','v5'],{},fetcher as typeof fetch);
    expect(result).toMatchObject({mode:'offline',evaluationProfile:'contract-v5',datasetCases:5,liveRequests:0,realModelAccuracy:null});
    expect(fetcher).not.toHaveBeenCalled();
    await expect(runLab(['--prompt-version','v5','--live','--smoke','--cases','unknown'],liveEnv,fetcher as typeof fetch)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const old=await runLab(['--understanding'],{},fetcher as typeof fetch);
    expect(old).toMatchObject({mode:'offline',evaluationProfile:'understanding-v4',datasetCases:6});
  });
});

describe('five sequential mocked V5 requests with real local policy boundaries',()=>{
  it('accepts authorized admin planning, denies student publication and preserves complete checkpoints',async()=>{
    const h=harness(),result=await runLab(cli,liveEnv,h.fetcher as typeof fetch,h.runtime);
    if(result.mode!=='live')throw Error('Wrong simulated mode');
    expect(h.fetcher).toHaveBeenCalledTimes(5);expect(result.requestsThisInvocation).toBe(5);expect(result.stop).toBeNull();
    expect(h.maxActive()).toBe(1);expect(result.records.map(r=>r.caseId)).toEqual(FINAL_CONTRACT_IDS);
    expect(h.requests.every(r=>r.messages[0]!.content===FINAL_CONTRACT_INSTRUCTIONS)).toBe(true);
    expect(result.datasetVersion).toBe(h.cases[0]!.datasetVersion);
    expect(result.identity.datasetVersion).toBe(result.datasetVersion);
    for(const request of h.requests){
      const metadata=JSON.parse(request.messages[1]!.content).trusted_metadata;
      expect(metadata.timezone).toBe('Asia/Baghdad');expect(metadata.baghdadDate).toBe('2026-10-30');
    }
    expect(result.records.find(r=>r.caseId==='p3e-23a')!.validator.actual).toBe('allow');
    const student=result.records.find(r=>r.caseId==='p3e-23s')!;
    expect(student.validator.actual).toBe('deny');expect(student.validator.reasons).toContain('permission_denied');
    expect(result.records.every(r=>r.toolExecutions===0)).toBe(true);
    expect(result.records.some(r=>r.wrongTargetAccepted||r.falseWritePassingValidator)).toBe(false);
    expect(result.guard.estimates.every(e=>e.totalReserved<=5000)).toBe(true);
    expect(result.guard.estimates.reduce((n,e)=>n+e.totalReserved,0)).toBeLessThanOrEqual(50000);
    expect(h.sleeps.reduce((n,s)=>n+s,0)).toBeGreaterThanOrEqual(4*60000);
    expect(h.checkpoints.filter(c=>c.inFlightCaseId!==null)).toHaveLength(5);
    const last=h.checkpoints.at(-1)!;
    expect(validateCheckpoint(last,h.cases,h.clock())).toMatchObject({ok:true,remainingCaseIds:[]});
    expect(last.identity.promptVersion).toBe(FINAL_CONTRACT_PROMPT_VERSION);
    expect(last.records.every(r=>r.evidence?.complete)).toBe(true);
  });

  it('does not treat verified singleton publication compatibility as wrong-target acceptance',async()=>{
    const h=harness(c=>{
      const draft=canonicalDraft(c);
      if(c.id==='p3e-23a'){draft.operations[0]!.target=draft.operations[0]!.targets![0]!;draft.operations[0]!.targets=null;}
      return draft;
    });
    const result=await runLab(cli,liveEnv,h.fetcher as typeof fetch,h.runtime);if(result.mode!=='live')throw Error('Wrong mode');
    const admin=result.records.find(r=>r.caseId==='p3e-23a')!,update=result.records.find(r=>r.caseId==='p3e-18')!;
    expect(admin.rawExact).toBe(false);expect(admin.validator.actual).toBe('allow');expect(admin.wrongTargetAccepted).toBe(false);
    expect(admin.evidence!.normalized_plan!.operations[0]).toMatchObject({action:'publish',targets:[{type:'previous_list',listId:'phase3e-list',position:2}]});
    expect(update.rawExact).toBe(true);expect(update.comparison.target).toBe(true);
    expect(result.stop).toBeNull();expect(h.fetcher).toHaveBeenCalledTimes(5);
    expect(validateCheckpoint(h.checkpoints.at(-1)!,h.cases,h.clock()).ok).toBe(true);
  });

  it('keeps raw omission visible while source-backed normalization permits a complete create',async()=>{
    const h=harness(c=>{const draft=canonicalDraft(c);if(c.id==='p3e-03')draft.operations[0]!.fields=draft.operations[0]!.fields!.filter(f=>f.name!=='details');return draft;});
    const result=await runLab(cli,liveEnv,h.fetcher as typeof fetch,h.runtime);if(result.mode!=='live')throw Error('Wrong mode');
    const row=result.records.find(r=>r.caseId==='p3e-03')!;
    expect(row.rawExact).toBe(false);expect(row.comparison.slots).toBe(false);expect(row.validator.actual).toBe('allow');
    expect(row.evidence!.parsed_model_plan).toEqual(JSON.parse(row.evidence!.raw_model_content!));
    const plan=row.evidence!.normalized_plan!;const op=plan.operations[0]!;if(op.action!=='create')throw Error('Expected create');
    expect(op.data.details.value).toBe(h.cases[0]!.input.originalText);
    expect(row.toolExecutions).toBe(0);
    expect(validateCheckpoint(h.checkpoints.at(-1)!,h.cases,h.clock()).ok).toBe(true);
  });

  it.each(['wrong_target','stale_reference','negated_create'] as const)('never admits %s for execution even with structurally valid output',async kind=>{
    const h=harness(c=>{
      const draft=canonicalDraft(c);
      if(kind==='wrong_target'&&c.id==='p3e-23a')draft.operations[0]!.targets![0]!.position=1;
      if(kind==='negated_create'&&c.id==='p3e-13'){
        const from=canonicalDraft(finalContractCase('p3e-03'));
        const evidence={sourceId:'message',start:0,end:c.input.originalText.length};
        from.operations[0]!.evidence=evidence;from.operations[0]!.fields=from.operations[0]!.fields!.map(f=>({...f,evidence}));return from;
      }
      return draft;
    });
    if(kind==='stale_reference')for(const c of h.cases)if(c.id==='p3e-23a')c.context.targetBindings[1]!.snapshots[0]!.currentRevision=2;
    // The stale-context fixture is tested directly; runner reconstructs trusted fixtures by design.
    if(kind==='stale_reference'){
      const {normalizeFinalContractModelPlan}=await import('../src/semantic-contract-alignment');
      const c=h.cases.find(c=>c.id==='p3e-23a')!,n=normalizeFinalContractModelPlan(canonicalDraft(c),c.context);
      expect(n.ok).toBe(false);if(!n.ok)expect(n.reason).toBe('stale_reference');return;
    }
    const result=await runLab(cli,liveEnv,h.fetcher as typeof fetch,h.runtime);if(result.mode!=='live')throw Error('Wrong mode');
    const row=result.records.find(r=>r.caseId===(kind==='wrong_target'?'p3e-23a':'p3e-13'))!;
    expect(row.validator.actual).not.toBe('allow');expect(row.wrongTargetAccepted).toBe(false);expect(row.toolExecutions).toBe(0);
    if(kind==='negated_create'){expect(row.falseWriteProposal).toBe(true);expect(result.stop).toBe('semantic_failure');}
  });

  it('refuses resume across prompt/normalization identities and never repeats completed mocked calls',async()=>{
    const h=harness(),controller=new AbortController();
    const first=await runLab(cli,liveEnv,h.fetcher as typeof fetch,{...h.runtime,signal:controller.signal,
      persist:async(cp:EvalCheckpoint)=>{await h.runtime.persist(cp);if(cp.completedCaseIds.length===1&&cp.inFlightCaseId===null)controller.abort();}});
    if(first.mode!=='live')throw Error('Wrong mode');expect(h.fetcher).toHaveBeenCalledTimes(1);
    const checkpoint=h.checkpoints.at(-1)!;
    expect(validateCheckpoint(checkpoint,h.cases,h.clock()).ok).toBe(true);
    for(const field of ['promptVersion','normalizationVersion'] as const){
      const changed=structuredClone(checkpoint);changed.identity[field]='wrong-version';
      const {integrity:_integrity,...unsigned}=changed;
      expect(validateCheckpoint(sealCheckpoint(unsigned),h.cases,h.clock()).ok).toBe(false);
    }
    const changedTrace=structuredClone(checkpoint);
    Object.assign(changedTrace.records[0]!.evidence!.contract!,{adapterVersion:'wrong-adapter'});
    const {integrity:_traceIntegrity,...unsignedTrace}=changedTrace;
    expect(validateCheckpoint(sealCheckpoint(unsignedTrace),h.cases,h.clock()).ok).toBe(false);
    const resumed=await runLab([...cli,'--resume','synthetic-checkpoint.json'],liveEnv,h.fetcher as typeof fetch,{...h.runtime,checkpointData:checkpoint});
    if(resumed.mode!=='live')throw Error('Wrong mode');expect(h.fetcher).toHaveBeenCalledTimes(5);expect(resumed.requestsThisInvocation).toBe(4);
    expect(resumed.records.map(r=>r.caseId)).toEqual(FINAL_CONTRACT_IDS);
  });

  it('enforces five-request cap and rejects foreign prompt/schema before an injected transport',async()=>{
    const h=harness();await runLab(cli,liveEnv,h.fetcher as typeof fetch,h.runtime);
    const request=h.requests[0]!;
    expect(()=>assertEvalRequest(request,'understanding-v4')).toThrow();expect(()=>assertEvalRequest(request)).toThrow();
    const bad=structuredClone(request);bad.response_format.json_schema.strict=false as true;
    expect(()=>assertEvalRequest(bad,'contract-v5')).toThrow();
    const guard=new GuardedGroqEvaluation({clock:h.clock,promptProfile:'contract-v5',pacing:{deadlineAt:h.clock()+600000,limits:FINAL_CONTRACT_LIMITS}});
    guard.state.requests=5;await expect(guard.waitForCapacity(request.messages)).rejects.toThrow('request_cap');
  });
});

it('preserves the original V4 report bytes during offline V5 preflight',()=>{
  const path='output/semantic-eval/paced-smoke-2026-10-30T18-44-20-305Z.json',before=readFileSync(path);
  expect(createHash('sha256').update(before).digest('hex')).toBe('4842c421798ed6f9fe3cb4032f509d4db02487f3a277c2326cc014d898bf46e0');
  prepareFinalContractSmoke();expect(readFileSync(path).equals(before)).toBe(true);expect(EVAL_COMPLETION_TOKENS).toBe(1024);
});
