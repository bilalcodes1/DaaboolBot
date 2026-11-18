import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseLabArgs, runLab } from '../eval/run-semantic-lab';
import { CONTRAST_CASE_IDS, CONTRAST_LIMITS, explicitContrastCases, prepareExplicitContrast } from '../eval/semantic-case-selection';
import { SEMANTIC_GOLD_CASES } from '../eval/semantic-gold';
import { SEMANTIC_CONTRASTIVE_FIXTURES } from './fixtures/semantic-contrastive-fixtures';
import { ContextBuilder } from '../src/semantic-compiler';
import { GroqPlanner, type GroqPlanRequest } from '../src/groq-planner';
import { GuardedGroqEvaluation, EVAL_COMPLETION_TOKENS, assertEvalRequest } from '../src/semantic-eval-guard';
import { validateCheckpoint, type EvalCheckpoint } from '../eval/semantic-checkpoint';
import { mockDraftFromGold } from './helpers/semantic-eval-mocks';

const value = CONTRAST_CASE_IDS.join(','), select = ['--cases',value], flags = ['--live','--smoke',...select];
const env = {DAABOUL_EVAL_LIVE:'1',GROQ_API_KEY:'synthetic-key'};
const epoch = Date.parse('2026-10-30T07:00:00Z');
const cases = explicitContrastCases(CONTRAST_CASE_IDS);
function harness() {
  let now = epoch;const requests:GroqPlanRequest[]=[],checkpoints:EvalCheckpoint[]=[],sentAt:number[]=[];
  const signal = new AbortController();
  const fetcher=vi.fn(async (_url:unknown, init?:RequestInit)=>{
    const request=JSON.parse(String(init!.body)) as GroqPlanRequest;
    assertEvalRequest(request);requests.push(request);sentAt.push(now);
    const text=JSON.parse(request.messages[1]!.content).user_instruction[0].text;
    const gold=cases.find(c=>c.input.originalText===text);if(!gold)throw Error('Unselected case reached HTTP mock');
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(mockDraftFromGold(gold.expectedPlan))}}],usage:{prompt_tokens:1905,completion_tokens:196,total_tokens:2101}});
  });
  return {fetcher,requests,checkpoints,sentAt,signal,clock:()=>now,runtime:{clock:()=>now,signal:signal.signal,
    sleep:async(ms:number)=>{now+=ms;},persist:async(cp:EvalCheckpoint)=>{checkpoints.push(structuredClone(cp));}}};
}
beforeEach(()=>vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Network forbidden in CLI selection tests');})));
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('explicit frozen three-case preflight',()=>{
  it('reuses exact text, original Iraqi context, and independent English/social labels',()=>{
    expect(cases[0]).toEqual(SEMANTIC_GOLD_CASES.find(c=>c.id==='iraqi_anbari-01'));
    expect(cases.map(c=>c.input.originalText)).toEqual(['شعدنا باچر؟',"What's tomorrow's schedule?",'شلونك دعبول؟']);
    for(const c of cases.slice(1)) {
      const fixture=SEMANTIC_CONTRASTIVE_FIXTURES.find(f=>f.id===c.id)!;
      expect(c.expectedPlan.operations[0]!.action).toBe(fixture.action);
      expect(c.expectedPlan.operations[0]!.speechAct).toBe(fixture.speechAct);
      expect(c.context.actor).toEqual(cases[0]!.context.actor);
      expect(c.context.allowedActions).toEqual(['read']);
    }
    for(const c of cases) {
      const dynamic=JSON.parse(new ContextBuilder().build(c.input,c.context).messages[1]!.content);
      expect(dynamic.trusted_metadata.actorRole).toBe('student');
      expect(dynamic.trusted_metadata.timezone).toBe('Asia/Baghdad');
      expect(dynamic.current_instruction_spans).toEqual([{sourceId:'message',start:0,end:c.input.originalText.length}]);
    }
  });
  it('pins v2/schema/model and preflights all three real regions with <=20k reserved',async()=>{
    const p=prepareExplicitContrast(CONTRAST_CASE_IDS);
    expect(p.selection.totalReserved).toBe(13827);expect(p.selection.selected.map(c=>c.tokens)).toEqual([4609,4608,4610]);
    expect(p.selection.selected.every(c=>c.tokens<=5000)).toBe(true);expect(p.schema.model).toBe('openai/gpt-oss-120b');
    const fetcher=vi.fn(), result=await runLab(select,{},fetcher as typeof fetch);
    if(result.mode!=='offline')throw Error('mode');
    expect(result.hardLimits).toMatchObject({requests:3,totalReservedTokens:20000,minuteTokens:5000,durationMs:600000});
    expect(result.selectedCases.map(c=>c.id)).toEqual([...CONTRAST_CASE_IDS]);expect(result.selectedCases.every(c=>c.contextValidated)).toBe(true);
    expect(result.liveRequests).toBe(0);expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ['--cases'],['--cases',''],['--cases','unknown,english-tomorrow,social-wellbeing'],
    ['--cases','iraqi_anbari-01,english-tomorrow'],['--cases','iraqi_anbari-01,english-tomorrow,english-tomorrow'],
    ['--cases',value,'--cases',value],['--cases',value+','],['--cases','english-02,english-tomorrow,social-wellbeing'],
  ].map(argv=>({argv})))('rejects malformed/unknown/unapproved selection without fallback $argv',async ({argv})=>{
    const fetcher=vi.fn();
    expect(()=>parseLabArgs(argv)).toThrow();
    await expect(runLab([...flags.slice(0,2),...argv],env,fetcher as typeof fetch)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
  });
  it('honors explicit order, never selecting the old six-case list',async()=>{
    const ids=[...CONTRAST_CASE_IDS].reverse(), result=await runLab(['--cases',ids.join(',')],{});
    if(result.mode!=='offline')throw Error('mode');expect(result.smokeCases).toEqual(ids);expect(result.datasetCases).toBe(3);
  });
  it('fails before HTTP if a stricter account cap cannot admit a selected case',async()=>{
    const fetcher=vi.fn();expect(()=>prepareExplicitContrast(CONTRAST_CASE_IDS,{tokensPerMinute:4600})).toThrow('budget');
    await expect(runLab(flags,{...env,DAABOUL_EVAL_ACCOUNT_TPM:'4600'},fetcher as typeof fetch,{persist:async()=>{}})).rejects.toThrow('budget');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('same runner/guard, three requests and total RESERVED budget across resumes',()=>{
  it('executes only the selected three with mocked API and retains six-case legacy mode separately',async()=>{
    const h=harness(),result=await runLab(flags,env,h.fetcher as typeof fetch,h.runtime);
    if(result.mode!=='live')throw Error('mode');
    expect(result.requestsThisInvocation).toBe(3);expect(h.requests).toHaveLength(3);expect(result.records.map(r=>r.caseId)).toEqual([...CONTRAST_CASE_IDS]);
    expect(result.guard.reportedTokens).toBe(6303);expect(result.guard.estimates.reduce((n,e)=>n+e.totalReserved,0)).toBe(13827);
    expect(h.sentAt).toEqual([epoch,epoch+60000,epoch+120000]);
    expect(result.pacing.hardLimits).toEqual(CONTRAST_LIMITS);
    expect(result.identity.executionLimits).toEqual(CONTRAST_LIMITS);
    expect(validateCheckpoint(h.checkpoints.at(-1),cases,h.clock())).toMatchObject({ok:true,remainingCaseIds:[]});
    const legacy=await runLab([],{});if(legacy.mode!=='offline')throw Error('mode');expect(legacy.smokeCases).toHaveLength(6);
  });
  it('enforces 20k cumulative reservations even when reported usage is low',async()=>{
    const h=harness();let request!:GroqPlanRequest;
    await new GroqPlanner(async r=>{request=r;return{status:200,body:{}};},2000,Date.now,EVAL_COMPLETION_TOKENS)
      .plan(new ContextBuilder().build(cases[0]!.input,cases[0]!.context).messages);
    const guard=new GuardedGroqEvaluation({liveFlag:true,environmentOptIn:'1',credential:'synthetic-key',fetcher:h.fetcher as typeof fetch,clock:h.clock,
      syntheticPromptAllowed:()=>true,pacing:{deadlineAt:epoch+600000,sleep:h.runtime.sleep,limits:CONTRAST_LIMITS}});
    // Seed the cumulative admission ledger at the boundary; this is not API-reported consumption.
    guard.state.estimates.push({inputEstimate:14367,inputSafetyMargin:0,outputReserved:1024,totalReserved:15391});
    await guard.waitForCapacity(request.messages);await guard.transport(request,new AbortController().signal);
    expect(guard.state.estimates.reduce((n,e)=>n+e.totalReserved,0)).toBe(20000);
    await expect(guard.waitForCapacity(request.messages)).rejects.toThrow('total_reserved_budget');expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it('the guard independently rejects a fourth request before HTTP',async()=>{
    const h=harness(),guard=new GuardedGroqEvaluation({clock:h.clock,pacing:{deadlineAt:epoch+600000,limits:CONTRAST_LIMITS}});
    guard.state.requests=3;
    await expect(guard.waitForCapacity(new ContextBuilder().build(cases[0]!.input,cases[0]!.context).messages)).rejects.toThrow('request_cap');
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it('resumes only unfinished selected IDs and cannot switch to six-case mode',async()=>{
    const h=harness();let waited=false;
    const first=await runLab(flags,env,h.fetcher as typeof fetch,{...h.runtime,sleep:async()=>{waited=true;h.signal.abort();throw Error('cancel');}});
    if(first.mode!=='live')throw Error('mode');expect(waited).toBe(true);expect(h.fetcher).toHaveBeenCalledTimes(1);
    const checkpoint=h.checkpoints.at(-1)!, fetcher=vi.fn();
    await expect(runLab(['--live','--smoke','--resume','cp.json'],env,fetcher as typeof fetch,{checkpointData:checkpoint,clock:h.clock})).rejects.toThrow('mismatch');
    expect(fetcher).not.toHaveBeenCalled();
    const next=harness(), result=await runLab([...flags,'--resume','cp.json'],env,next.fetcher as typeof fetch,{...next.runtime,checkpointData:checkpoint});
    if(result.mode!=='live')throw Error('mode');expect(result.requestsThisInvocation).toBe(2);expect(result.records).toHaveLength(3);
    expect(result.guard.estimates.reduce((n,e)=>n+e.totalReserved,0)).toBe(13827);
  });
});

describe('actual CLI case filtering offline',()=>{
  it('verifies the exact later live command through its offline counterpart',()=>{
    const child=spawnSync(process.execPath,['scripts/eval-semantic.mjs',...select],{encoding:'utf8',env:{PATH:process.env.PATH!}});
    expect(child.status).toBe(0);const result=JSON.parse(child.stdout);
    expect(result).toMatchObject({mode:'offline',datasetCases:3,liveRequests:0,cases:[...CONTRAST_CASE_IDS],totalReservedTokens:13827});
    const artifact=JSON.parse(readFileSync(result.output,'utf8'));
    expect(artifact.selectedCases.map((c:{id:string})=>c.id)).toEqual([...CONTRAST_CASE_IDS]);
  });
  it('unknown IDs fail the CLI, even with no credential, rather than running defaults',()=>{
    const child=spawnSync(process.execPath,['scripts/eval-semantic.mjs','--cases','missing,english-tomorrow,social-wellbeing'],{encoding:'utf8',env:{PATH:process.env.PATH!}});
    expect(child.status).toBe(1);expect(child.stdout).toBe('');expect(child.stderr).not.toContain('GROQ_API_KEY');
  });
});
