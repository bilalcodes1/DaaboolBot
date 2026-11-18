import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLab } from '../eval/run-semantic-lab';
import { CONTRAST_CASE_IDS, explicitContrastCases } from '../eval/semantic-case-selection';
import { checkpointIdentity, sealCheckpoint, validateCheckpoint, type EvalCheckpoint } from '../eval/semantic-checkpoint';
import { captureContent, EVAL_OUTPUT_LIMITS, evidenceIdentity, evidenceRedactor } from '../eval/semantic-evidence';
import { SemanticEvaluator } from '../src/semantic-eval';
import { mockDraftFromGold } from './helpers/semantic-eval-mocks';

const cases = explicitContrastCases(CONTRAST_CASE_IDS), flags = ['--live','--smoke','--cases',CONTRAST_CASE_IDS.join(',')];
const credential = 'SYNTHETIC_CREDENTIAL_DO_NOT_PERSIST', env = {DAABOUL_EVAL_LIVE:'1',GROQ_API_KEY:credential};
const epoch = Date.parse('2026-10-30T07:00:00Z');
const envelope = (content:string) => ({choices:[{finish_reason:'stop',message:{content}}],
  usage:{prompt_tokens:1905,completion_tokens:196,total_tokens:2101,prompt_tokens_details:{cached_tokens:25}}});
const raw = (i:number) => ` \n${JSON.stringify(mockDraftFromGold(cases[i]!.expectedPlan),null,2)}\n`;
function lab(handler?: (index:number,init?:RequestInit)=>Promise<Response>) {
  let time=epoch,index=0;
  const checkpoints:EvalCheckpoint[]=[], controller=new AbortController();
  const fetcher=vi.fn(async (_url:unknown,init?:RequestInit)=>handler ? handler(index++,init) : Response.json(envelope(raw(index++)),
    {headers:{'x-ratelimit-limit-tokens':'8000','x-ratelimit-remaining-tokens':'5807','x-ratelimit-reset-tokens':'16.447s','authorization':'Bearer SYNTHETIC_HEADER','x-private-header':'PRIVATE_HEADER'}}));
  return {fetcher,checkpoints,controller,clock:()=>time,
    runtime:{clock:()=>time,signal:controller.signal,sleep:async(ms:number)=>{time+=ms;},persist:async(cp:EvalCheckpoint)=>{checkpoints.push(structuredClone(cp));}}};
}
beforeEach(()=>vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Network forbidden in evidence tests');})));
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});

describe('complete sanitized live evidence with mocked Groq only',()=>{
  it('persists exact raw JSON, full plans, spans, real reported usage and allowlisted metadata after each case',async()=>{
    const s=lab(), result=await runLab(flags,env,s.fetcher as typeof fetch,s.runtime);
    if(result.mode!=='live')throw Error('mode');
    expect(result.records).toHaveLength(3);expect(s.fetcher).toHaveBeenCalledTimes(3);
    result.records.forEach((row,i)=>{
      const e=row.evidence!;
      expect(e.case_id).toBe(cases[i]!.id);expect(e.original_message).toBe(cases[i]!.input.originalText);
      expect(e.expected_gold_plan).toEqual(cases[i]!.expectedPlan);expect(e.raw_model_content).toBe(raw(i));
      expect(e.parsed_model_plan).toEqual(JSON.parse(raw(i)));expect(e.normalized_plan?.operations[0]!.action).toBe(cases[i]!.expectedPlan.operations[0]!.action);
      expect(e.validator).toEqual({ok:true,issues:[]});expect(e.evidence_spans[0]?.checks.withinBounds).toBe(true);
      expect(e.source_regions[0]?.text).toBe(cases[i]!.input.originalText);expect(e.comparison.exact).toBe(true);
      expect(e.usage).toEqual({promptTokens:1905,completionTokens:196,totalTokens:2101,cachedTokens:25});
      expect(e.http_status).toBe(200);expect(e.rate_limit_headers).toEqual({limitTokens:8000,remainingTokens:5807,resetTokensMs:16447});
      expect(e.identity).toEqual(evidenceIdentity(checkpointIdentity(cases)));expect(e.timestamp).toBeGreaterThanOrEqual(epoch);
      expect(e.latency_ms).toBeGreaterThanOrEqual(0);expect(e.redacted).toBe(false);expect(e.complete).toBe(true);
      expect(e.scoring).toMatchObject({raw_model_correct:true,json_correct:true,schema_correct:true,normalization_preserves_raw_meaning:true,tools_executed:0,final_response_possible:null});
      expect(s.checkpoints.some(cp=>cp.completedCaseIds.length===i+1&&cp.inFlightCaseId===null&&cp.records[i]!.evidence?.raw_model_content===raw(i))).toBe(true);
    });
    expect(result.records[0]!.stages.executionEligibility).toBe('read_candidate_requires_runtime_checks');
    expect(validateCheckpoint(s.checkpoints.at(-1),cases,s.clock())).toMatchObject({ok:true,remainingCaseIds:[]});
    const saved=JSON.stringify(s.checkpoints);expect(saved).not.toContain(credential);expect(saved).not.toContain('SYNTHETIC_HEADER');expect(saved).not.toContain('PRIVATE_HEADER');
  });
  it('records wrong semantic action as model failure even when the validator permits a valid conversation',async()=>{
    const wrong=mockDraftFromGold(cases[0]!.expectedPlan),op=wrong.operations[0]!;
    op.action='reply';op.tool=null;op.arguments=null;op.reply={subject:'conversation',text:'هلا بيك'};
    const s=lab(async i=>Response.json(envelope(i===0?JSON.stringify(wrong):raw(i))));
    const result=await runLab(flags,env,s.fetcher as typeof fetch,s.runtime);if(result.mode!=='live')throw Error('mode');
    const row=result.records[0]!;expect(row.rawExact).toBe(false);expect(row.correctCompletion).toBe(false);
    expect(row.evidence!.comparison.action).toBe(false);expect(row.evidence!.scoring.raw_model_correct).toBe(false);
    expect(row.evidence!.validator?.ok).toBe(true);expect(row.validator.correct).toBeNull();
  });
  it('retains invalid evidence spans and the actual gate reason without treating rejection as model success',async()=>{
    const wrong=mockDraftFromGold(cases[2]!.expectedPlan);wrong.operations[0]!.evidence.end=999;
    const s=lab(async i=>Response.json(envelope(i===2?JSON.stringify(wrong):raw(i))));
    const result=await runLab(flags,env,s.fetcher as typeof fetch,s.runtime);if(result.mode!=='live')throw Error('mode');
    const row=result.records[2]!,e=row.evidence!;
    expect(row.rawExact).toBe(true);expect(e.scoring.raw_model_correct).toBe(false);expect(row.validator.correct).toBeNull();
    expect(e.validator).toMatchObject({ok:false,issues:[{reason:'invalid_evidence'}]});
    expect(e.evidence_spans[0]).toMatchObject({submitted:{end:999},checks:{withinBounds:false}});
    expect(e.normalized_plan).not.toBeNull();expect(e.scoring.read_execution_eligibility).toBe('not_eligible');
    expect(row.failures).not.toContain('validator_false_reject');
  });
  it('retains malformed raw JSON, null parsed/normalized plans, and stops with no retry',async()=>{
    const malformed=' {"version":1,"operations":[ ';
    const s=lab(async()=>Response.json(envelope(malformed))),result=await runLab(flags,env,s.fetcher as typeof fetch,s.runtime);
    if(result.mode!=='live')throw Error('mode');expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(result.records[0]!.evidence).toMatchObject({raw_model_content:malformed,parsed_model_plan:null,normalized_plan:null,json_status:'invalid',planner_error:'invalid_json',validator:null});
    expect(result.records[0]!.stages.normalization).toBe('not_observed');expect(s.checkpoints.at(-1)!.completedCaseIds).toEqual([cases[0]!.id]);
  });
  it.each([429,400,401])('persists HTTP %s and sanitized API error + usage without retry',async status=>{
    const s=lab(async()=>Response.json({error:{code:'synthetic_error',type:'test',message:`password=PRIVATE WITH SPACES ${credential}`},usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}},
      {status,headers:{'retry-after':'2','authorization':`Bearer ${credential}`}}));
    const result=await runLab(flags,env,s.fetcher as typeof fetch,s.runtime);if(result.mode!=='live')throw Error('mode');
    expect(s.fetcher).toHaveBeenCalledTimes(1);expect(result.records[0]!.evidence).toMatchObject({http_status:status,raw_model_content:null,usage:{totalTokens:5},complete:false,
      provider_error:{status,code:'synthetic_error'},rate_limit_headers:{retryAfterMs:2000}});
    expect(result.guard.reportedTokens).toBe(5);expect(JSON.stringify(result)).not.toMatch(/PRIVATE WITH SPACES|SYNTHETIC_CREDENTIAL_DO_NOT_PERSIST/u);
    expect(validateCheckpoint(s.checkpoints.at(-1),cases,s.clock()).ok).toBe(false);
  });
  it('preserves timeout/unknown usage and cannot be changed by a late transport completion',async()=>{
    vi.useFakeTimers();let resolve!:(v:{status:number;body:unknown})=>void;
    const evaluator=new SemanticEvaluator(()=>new Promise(r=>{resolve=r;}),'live_groq',10,1024,
      {identity:evidenceIdentity(checkpointIdentity(cases)),redactValues:[credential]});
    const pending=evaluator.evaluate(cases[0]!);await vi.advanceTimersByTimeAsync(11);
    const row=await pending,snapshot=JSON.stringify(row);
    expect(row.evidence).toMatchObject({planner_error:'planner_timeout',usage:null,http_status:null,raw_model_content:null,complete:false});
    resolve({status:200,body:envelope(raw(0))});await vi.advanceTimersByTimeAsync(1);expect(JSON.stringify(row)).toBe(snapshot);
  });
  it('checkpoints an interrupted request after headers with unknown response/cost, without replay',async()=>{
    vi.useFakeTimers();const s=lab();
    const fetcher=vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({start(){}}),{headers:{'x-ratelimit-limit-tokens':'8000'}}));
    const pending=runLab(flags,env,fetcher as typeof fetch,s.runtime);await vi.advanceTimersByTimeAsync(10001);
    const result=await pending;if(result.mode!=='live')throw Error('mode');
    expect(result.records).toHaveLength(1);expect(result.records[0]!.evidence).toMatchObject({http_status:200,raw_model_content:null,usage:null,complete:false,rate_limit_headers:{limitTokens:8000}});
    expect(result.guard.reservedUnknownTokens).toBeGreaterThan(0);expect(s.checkpoints.at(-1)!.inFlightCaseId).toBeNull();
    expect(validateCheckpoint(s.checkpoints.at(-1),cases,s.clock()).ok).toBe(false);expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('resumes only unfinished IDs, preserving original completed evidence and prompt identity',async()=>{
    const s=lab();s.runtime.sleep=async()=>{s.controller.abort();throw Error('cancelled');};
    await runLab(flags,env,s.fetcher as typeof fetch,s.runtime);const checkpoint=s.checkpoints.at(-1)!;
    expect(checkpoint.completedCaseIds).toEqual([cases[0]!.id]);const original=JSON.stringify(checkpoint.records[0]!.evidence);
    const resumed=lab(async i=>Response.json(envelope(raw(i+1))));
    const result=await runLab([...flags,'--resume','synthetic.json'],env,resumed.fetcher as typeof fetch,{...resumed.runtime,checkpointData:checkpoint});
    if(result.mode!=='live')throw Error('mode');expect(resumed.fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result.records[0]!.evidence)).toBe(original);expect(result.guard.requests).toBe(3);
  });
  it.each(['parsed_model_plan','normalized_plan','validator','json_status','usage','http_status'])('refuses missing checkpoint evidence field %s before any API call',async key=>{
    const s=lab();await runLab(flags,env,s.fetcher as typeof fetch,s.runtime);
    const cp=structuredClone(s.checkpoints.at(-1)!);delete (cp.records[0]!.evidence as unknown as Record<string,unknown>)[key];
    const {integrity:_,...unsigned}=cp;const fetcher=vi.fn();
    await expect(runLab([...flags,'--resume','synthetic.json'],env,fetcher as typeof fetch,{clock:s.clock,checkpointData:sealCheckpoint(unsigned)})).rejects.toThrow('checkpoint_evidence_invalid_or_incomplete');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not upgrade a prior evidence-free v1 checkpoint',async()=>{
    const s=lab();await runLab(flags,env,s.fetcher as typeof fetch,s.runtime);
    const old={...s.checkpoints.at(-1)!,checkpointVersion:1};
    expect(validateCheckpoint(old,cases,s.clock())).toMatchObject({ok:false,reason:'checkpoint_evidence_missing_no_automatic_upgrade'});
  });
  it('bounds UTF-8 content, marks truncation, preserves partial output and halts',async()=>{
    const oversized='ا'.repeat(20000),c=captureContent('a'+oversized);
    expect(c.truncated).toBe(true);expect(new TextEncoder().encode(c.content!).byteLength).toBeLessThanOrEqual(EVAL_OUTPUT_LIMITS.rawBytes);
    expect(c.content).not.toContain('\uFFFD');
    const s=lab(async()=>Response.json(envelope(oversized))),result=await runLab(flags,env,s.fetcher as typeof fetch,s.runtime);
    if(result.mode!=='live')throw Error('mode');
    expect(result.records[0]!.evidence).toMatchObject({raw_truncated:true,raw_content_bytes:40000,json_status:'size_limit',parsed_model_plan:null,complete:false});
    expect(Buffer.byteLength(JSON.stringify(result.records[0]!.evidence))).toBeLessThan(EVAL_OUTPUT_LIMITS.evidenceBytes);
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it('persists HTTP metadata and a body-limit failure without inventing missing raw content or tokens',async()=>{
    const s=lab(async()=>new Response('x'.repeat(65537),{headers:{'content-length':'65537'}}));
    const result=await runLab(flags,env,s.fetcher as typeof fetch,s.runtime);if(result.mode!=='live')throw Error('mode');
    expect(result.stop).toBe('provider_body_limit');expect(result.records[0]!.evidence).toMatchObject({http_status:200,raw_model_content:null,usage:null,complete:false});
    expect(s.fetcher).toHaveBeenCalledTimes(1);expect(result.guard.reportedTokens).toBe(0);expect(result.guard.reservedUnknownTokens).toBeGreaterThan(0);
  });
  it('redacts only persistence copies, including escaped credentials; raw semantic scores stay untouched',async()=>{
    const social=mockDraftFromGold(cases[2]!.expectedPlan);social.operations[0]!.reply!.text=credential;
    const content=JSON.stringify(social).replace(credential,[...credential].map(c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`).join(''));
    const s=lab(async i=>Response.json(envelope(i===2?content:raw(i)))),result=await runLab(flags,env,s.fetcher as typeof fetch,s.runtime);
    if(result.mode!=='live')throw Error('mode');const row=result.records[2]!;
    expect(row.rawExact).toBe(true);expect(row.evidence!.redacted).toBe(true);
    const persisted=JSON.stringify(s.checkpoints);expect(persisted).not.toContain(credential);expect(persisted).not.toContain('\\u0053\\u0059');
    expect((row.evidence!.parsed_model_plan as typeof social).operations[0]!.reply!.text).toBe('[REDACTED]');
    expect(social.operations[0]!.reply!.text).toBe(credential);
  });
  it.each(['{"api_key":"PRIVATE WITH SPACES','{"authorization":{"key":"PRIVATE"}}garbage','{"password":["PRIVATE PHRASE"]}broken',
    '{"proxy-authorization":{\n"key":"PRIVATE PHRASE"\n}}broken','{"proxy_authorization":{\n"key":"PRIVATE PHRASE"\n}}broken'])('fails closed on malformed sensitive raw: %s',input=>{
    const r=evidenceRedactor([]),saved=r.raw(input,null,false);
    expect(saved).toBe('[REDACTED_UNPARSEABLE_SENSITIVE_RESPONSE]');expect(saved).not.toContain('PRIVATE');expect(r.rawWithheld).toBe(true);
  });
  it('redacts escaped known secrets even in an unterminated non-sensitive string field',()=>{
    const escaped=[...credential].map(c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`).join('');
    const r=evidenceRedactor([credential]);
    expect(r.raw(`{"text":"${escaped}`,null,false)).toBe('{"text":"[REDACTED]');
    expect(r.clean('{"api_key":"PRIVATE WITH SPACES')).not.toContain('PRIVATE');
  });
  it('keeps sanitized valid raw JSON parseable and identical to the saved parsed plan',async()=>{
    const draft=mockDraftFromGold(cases[2]!.expectedPlan);draft.operations[0]!.reply!.text=`api_key: ${credential} PRIVATE WORDS`;
    const evaluator=new SemanticEvaluator(async()=>({status:200,body:envelope(JSON.stringify(draft,null,2))}),'offline_mock',1000,1024,
      {identity:evidenceIdentity(checkpointIdentity(cases)),redactValues:[credential]});
    const e=(await evaluator.evaluate(cases[2]!)).evidence!;
    expect(e.redacted).toBe(true);expect(e.json_status).toBe('valid');
    expect(JSON.parse(e.raw_model_content!)).toEqual(e.parsed_model_plan);
    expect(e.raw_model_content).not.toContain('PRIVATE WORDS');expect(e.raw_model_content).not.toContain(credential);
  });
  it('redacts malformed multiline provider-error bodies from both the guard and case evidence',async()=>{
    const s=lab(async()=>new Response('{"proxy-authorization":{\n"key":"PRIVATE PHRASE"\n}}broken',{status:400}));
    const result=await runLab(flags,env,s.fetcher as typeof fetch,s.runtime);if(result.mode!=='live')throw Error('mode');
    expect(JSON.stringify(result)).not.toContain('PRIVATE PHRASE');expect(JSON.stringify(s.checkpoints)).not.toContain('PRIVATE PHRASE');
    expect(result.records[0]!.evidence!.redacted).toBe(true);expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
});
