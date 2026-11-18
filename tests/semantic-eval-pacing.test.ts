import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runLab } from '../eval/run-semantic-lab';
import { checkpointIdentity, sealCheckpoint, validateCheckpoint, type EvalCheckpoint } from '../eval/semantic-checkpoint';
import { SEMANTIC_GOLD_CASES } from '../eval/semantic-gold';
import { SMOKE_CANDIDATE_IDS } from '../eval/semantic-preflight';
import { ContextBuilder } from '../src/semantic-compiler';
import { GuardedGroqEvaluation, EVAL_COMPLETION_TOKENS, PACED_EVAL_LIMITS, estimateEvalReservation, abortableEvalSleep } from '../src/semantic-eval-guard';
import { GroqPlanner, type GroqPlanRequest } from '../src/groq-planner';
import { mockDraftFromGold } from './helpers/semantic-eval-mocks';

const cases = SMOKE_CANDIDATE_IDS.map(id => SEMANTIC_GOLD_CASES.find(c => c.id === id)!);
const flags = ['--live','--smoke'], environment = { DAABOUL_EVAL_LIVE: '1', GROQ_API_KEY: 'synthetic-key' };
const epoch = Date.parse('2026-10-30T07:00:00Z');
const envelope = (content: unknown, total = 2101) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
  usage: { prompt_tokens: total - 196, completion_tokens: 196, total_tokens: total } });
async function request(index = 0) {
  let captured!: GroqPlanRequest;
  await new GroqPlanner(async r => { captured = r; return { status: 200, body: envelope({ version: 1, operations: [] }) }; }, 2000, Date.now, EVAL_COMPLETION_TOKENS)
    .plan(new ContextBuilder().build(cases[index]!.input, cases[index]!.context).messages);
  return captured;
}
function lab() {
  let time = epoch;
  const controller = new AbortController(), persisted: EvalCheckpoint[] = [], calls: { at: number; text: string }[] = [];
  const clock = () => time, sleep = vi.fn(async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw Error('cancelled'); time += ms;
  });
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const r = JSON.parse(String(init!.body)) as GroqPlanRequest;
    const text = JSON.parse(r.messages[1]!.content).user_instruction[0].text;
    const c = cases.find(c => c.input.originalText === text)!;
    calls.push({ at: time, text }); time += 5;
    return Response.json(envelope(mockDraftFromGold(c.expectedPlan)), { headers: { 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '5807', 'x-ratelimit-reset-tokens': '16.447s', 'x-ratelimit-remaining-requests': '999' } });
  });
  return { clock, sleep, controller, calls, fetcher, persisted,
    runtime: { clock, sleep, signal: controller.signal, persist: async (c: EvalCheckpoint) => { persisted.push(structuredClone(c)); } },
    advance: (ms: number) => { time += ms; } };
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw Error('Network forbidden in pacing tests'); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('bounded pacing outside planner deadline', () => {
  it('reserves the current prompt first, waits before the second, runs only six sequential mock requests within every rolling window', async () => {
    const s = lab(), result = await runLab(flags, environment, s.fetcher as typeof fetch, s.runtime);
    expect(result.mode).toBe('live'); if (result.mode !== 'live') throw Error('mode');
    expect(result.records).toHaveLength(6); expect(result.stop).toBeNull(); expect(s.fetcher).toHaveBeenCalledTimes(6);
    expect(result.guard.estimates[0]!.totalReserved).toBe(4609); expect(result.pacing.waitedMs).toBe(300000);
    for (let i = 1; i < s.calls.length; i++) expect(s.calls[i]!.at - s.calls[i-1]!.at).toBeGreaterThanOrEqual(60005);
    const cp = s.persisted.at(-1)!; expect(cp.completedCaseIds).toEqual([...SMOKE_CANDIDATE_IDS]);
    for (const receipt of cp.receipts) {
      const reserved = cp.receipts.filter(r => r.admittedAt <= receipt.admittedAt && r.settledAt > receipt.admittedAt - 60000)
        .reduce((sum, r) => sum + r.reservedTokens, 0);
      expect(reserved).toBeLessThanOrEqual(5000);
    }
    expect(validateCheckpoint(cp, cases, s.clock())).toMatchObject({ ok: true, remainingCaseIds: [] });
    expect(result.guard.reportedTokens).toBe(12606);
  });
  it('holds the entire reservation after cheap usage, not merely the reported cost', async () => {
    let time = epoch; const fetcher = vi.fn(async () => Response.json(envelope({}, 300)));
    const sleep = vi.fn(async (ms: number) => { time += ms; });
    const g = new GuardedGroqEvaluation({ liveFlag: true, environmentOptIn: '1', credential: 'synthetic-key', fetcher: fetcher as typeof fetch,
      syntheticPromptAllowed: () => true, clock: () => time, pacing: { deadlineAt: epoch + 600000, sleep } });
    const r = await request(); await g.waitForCapacity(r.messages); await g.transport(r, new AbortController().signal);
    expect(g.snapshot().window[0]!.tokens).toBe(4609); expect(g.state.reportedTokens).toBe(300);
    await g.waitForCapacity((await request(1)).messages); expect(time).toBe(epoch + 60000); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([429,400,401,403])('stops permanently on HTTP %s without any retry', async status => {
    const s = lab(), fetcher = vi.fn(async () => Response.json({ error: { message: 'synthetic provider failure' } }, { status }));
    const result = await runLab(flags, environment, fetcher as typeof fetch, s.runtime);
    expect(fetcher).toHaveBeenCalledTimes(1); if (result.mode !== 'live') throw Error('mode');
    expect(result.stop).toBe(status === 429 ? 'rate_limited' : status === 400 ? 'schema_or_request_400' : 'authentication_error');
    const resumed = validateCheckpoint(s.persisted.at(-1), cases, s.clock()); expect(resumed.ok).toBe(false);
  });
  it('stops an impossible single request immediately instead of waiting forever', async () => {
    const s = lab(), g = new GuardedGroqEvaluation({ clock: s.clock, accountLimits: { tokensPerMinute: 4000 }, pacing: { deadlineAt: epoch + 600000, sleep: s.sleep } });
    await expect(g.waitForCapacity((await request()).messages)).rejects.toThrow('single_request_minute_cap'); expect(s.sleep).not.toHaveBeenCalled();
  });
  it('has a hard total duration and detects a non-advancing mock clock', async () => {
    const s = lab();
    // A mocked admission establishes a genuine rolling-window entry.
    const h = new GuardedGroqEvaluation({ clock: s.clock, liveFlag:true,environmentOptIn:'1',credential:'synthetic-key',fetcher:s.fetcher as typeof fetch,
      syntheticPromptAllowed:()=>true, pacing:{deadlineAt:epoch+10000,sleep:s.sleep} });
    await h.transport(await request(), new AbortController().signal);
    await expect(h.waitForCapacity((await request(1)).messages)).rejects.toThrow('evaluation_duration_limit');
    expect(s.sleep).not.toHaveBeenCalled();
    const frozen = new GuardedGroqEvaluation({clock:s.clock,liveFlag:true,environmentOptIn:'1',credential:'synthetic-key',fetcher:s.fetcher as typeof fetch,syntheticPromptAllowed:()=>true,
      pacing:{deadlineAt:s.clock()+600000,sleep:async()=>{}}});
    await frozen.transport(await request(), new AbortController().signal);
    await expect(frozen.waitForCapacity((await request(1)).messages)).rejects.toThrow('pacing_clock_not_advancing');
  });
  it('enforces total reported budget and six-request cap before network', async () => {
    const s = lab(), g = new GuardedGroqEvaluation({clock:s.clock,pacing:{deadlineAt:epoch+600000,sleep:s.sleep}});
    g.state.reportedTokens = 49000;
    await expect(g.waitForCapacity((await request()).messages)).rejects.toThrow('total_token_budget');
    const h = new GuardedGroqEvaluation({clock:s.clock,pacing:{deadlineAt:epoch+600000,sleep:s.sleep}}); h.state.requests = 6;
    await expect(h.waitForCapacity((await request()).messages)).rejects.toThrow('request_cap'); expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('honors stricter actual token headers until their reset without extra API probes', async () => {
    let time = epoch;
    const fetcher = vi.fn(async () => Response.json(envelope({}, 2101), { headers: { 'x-ratelimit-limit-tokens':'4800','x-ratelimit-remaining-tokens':'1','x-ratelimit-reset-tokens':'90s' } }));
    const g = new GuardedGroqEvaluation({clock:()=>time,liveFlag:true,environmentOptIn:'1',credential:'synthetic-key',fetcher:fetcher as typeof fetch,syntheticPromptAllowed:()=>true,
      pacing:{deadlineAt:epoch+600000,sleep:async ms=>{time+=ms;}}});
    await g.transport(await request(),new AbortController().signal); await g.waitForCapacity((await request(1)).messages);
    expect(time).toBe(epoch+90000); expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(g.waitForCapacity((await request(4)).messages)).rejects.toThrow('single_request_minute_cap');
  });
  it('does not raise a previously inspected account limit on resume', async () => {
    const s=lab(), original=new GuardedGroqEvaluation({clock:s.clock,accountLimits:{tokensPerMinute:4800},pacing:{deadlineAt:epoch+600000}});
    const resumed=new GuardedGroqEvaluation({clock:s.clock,accountLimits:{tokensPerMinute:5000},pacing:{deadlineAt:epoch+600000,snapshot:original.snapshot()}});
    expect(resumed.snapshot().accountLimits!.tokensPerMinute).toBe(4800);
    await expect(resumed.waitForCapacity((await request(4)).messages)).rejects.toThrow('single_request_minute_cap');
  });
  it('cancels an in-flight HTTP request at the evaluation deadline, preserving unknown cost', async () => {
    vi.useFakeTimers(); let time=epoch;
    const fetcher=vi.fn(()=>new Promise<Response>(()=>{}));
    const g=new GuardedGroqEvaluation({clock:()=>time,liveFlag:true,environmentOptIn:'1',credential:'synthetic-key',fetcher:fetcher as typeof fetch,syntheticPromptAllowed:()=>true,
      pacing:{deadlineAt:epoch+100}});
    const pending=g.transport(await request(),new AbortController().signal).catch(e=>e);
    time+=100; await vi.advanceTimersByTimeAsync(100);
    expect((await pending).message).toBe('evaluation_duration_limit'); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(g.state.reservedUnknownTokens).toBe(4609);
  });
});

describe('cancellation and reliable checkpoints', () => {
  async function cancelledBeforeSecond() {
    const s = lab(); s.sleep.mockImplementation(async () => { s.controller.abort(); throw Error('cancelled'); });
    const result = await runLab(flags, environment, s.fetcher as typeof fetch, s.runtime);
    if (result.mode !== 'live') throw Error('mode');
    expect(result.stop).toBe('evaluation_cancelled'); expect(s.fetcher).toHaveBeenCalledTimes(1);
    return { s, checkpoint: s.persisted.at(-1)! };
  }
  it('resumes unfinished cases only and carries usage, duration and current window forward', async () => {
    const { s, checkpoint } = await cancelledBeforeSecond(), resumed = lab(); resumed.advance(s.clock()-epoch);
    const checked = validateCheckpoint(checkpoint, cases, resumed.clock()); expect(checked).toMatchObject({ok:true,remainingCaseIds:SMOKE_CANDIDATE_IDS.slice(1)});
    const result = await runLab([...flags,'--resume','synthetic.json'], environment, resumed.fetcher as typeof fetch, { ...resumed.runtime,checkpointData:checkpoint });
    if(result.mode!=='live')throw Error('mode');
    expect(resumed.fetcher).toHaveBeenCalledTimes(5); expect(resumed.calls[0]!.text).toBe(cases[1]!.input.originalText);
    expect(result.guard.requests).toBe(6); expect(result.guard.reportedTokens).toBe(12606); expect(result.records).toHaveLength(6);
    expect(result.pacing.startedAt).toBe(checkpoint.startedAt); expect(result.pacing.deadlineAt).toBe(checkpoint.deadlineAt);
    expect(result.requestsThisInvocation).toBe(5);
  });
  it('never replays an already complete checkpoint', async () => {
    const s=lab(); await runLab(flags,environment,s.fetcher as typeof fetch,s.runtime);
    const checkpoint=s.persisted.at(-1)!, fetcher=vi.fn();
    const result=await runLab([...flags,'--resume','synthetic.json'],environment,fetcher as typeof fetch,{...s.runtime,checkpointData:checkpoint});
    if(result.mode!=='live')throw Error('mode'); expect(result.requestsThisInvocation).toBe(0); expect(fetcher).not.toHaveBeenCalled();
    expect(result.records).toHaveLength(6);
  });
  it.each(['model','schemaHash','promptHash','promptVersion','goldAndContextHash'])('blocks mismatched identity %s before any network', async field => {
    const { checkpoint } = await cancelledBeforeSecond();
    const changed = structuredClone(checkpoint); (changed.identity as Record<string, unknown>)[field] = 'changed';
    const { integrity: _, ...unsigned } = changed, bad = sealCheckpoint(unsigned), fetcher = vi.fn();
    await expect(runLab([...flags,'--resume','synthetic.json'],environment,fetcher as typeof fetch,{checkpointData:bad,clock:()=>bad.savedAt})).rejects.toThrow('checkpoint_model_schema_prompt_or_gold_mismatch');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses an in-flight crash marker and uncertain accounting, never guessing whether to repeat', async () => {
    const { s, checkpoint } = await cancelledBeforeSecond();
    const marked = s.persisted.find(c=>c.inFlightCaseId!==null)!;
    expect(validateCheckpoint(marked,cases,s.clock())).toMatchObject({ok:false,reason:'checkpoint_inflight_outcome_unknown_no_replay'});
    const changed=structuredClone(checkpoint); changed.guard.state.reservedUnknownTokens=4282;
    const {integrity:_,...unsigned}=changed;
    expect(validateCheckpoint(sealCheckpoint(unsigned),cases,s.clock())).toMatchObject({ok:false,reason:'checkpoint_accounting_uncertain'});
  });
  it('checks receipt/window integrity, record schema and expired deadlines', async () => {
    const {s,checkpoint}=await cancelledBeforeSecond();
    const changed=structuredClone(checkpoint); changed.guard.window=[];
    const {integrity:_,...unsigned}=changed;
    expect(validateCheckpoint(sealCheckpoint(unsigned),cases,s.clock())).toMatchObject({ok:false,reason:'checkpoint_window_receipt_mismatch'});
    const malformed=structuredClone(checkpoint); (malformed.records[0] as any).toolExecutions=1;
    const {integrity:__,...recordUnsigned}=malformed;
    expect(validateCheckpoint(sealCheckpoint(recordUnsigned),cases,s.clock())).toMatchObject({ok:false,reason:'checkpoint_records_invalid'});
    expect(validateCheckpoint(checkpoint,cases,checkpoint.deadlineAt)).toMatchObject({ok:false,reason:'checkpoint_duration_expired'});
  });
  it('persists a write-ahead marker; persistence failure before dispatch sends nothing', async () => {
    const s=lab(); let writes=0;
    await expect(runLab(flags,environment,s.fetcher as typeof fetch,{...s.runtime,persist:async()=>{if(++writes===2)throw Error('disk unavailable');}})).rejects.toThrow('disk unavailable');
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('blocks replay when persistence fails after receiving an API response', async () => {
    const s=lab(); let writes=0;
    await expect(runLab(flags,environment,s.fetcher as typeof fetch,{...s.runtime,persist:async cp=>{
      if(++writes===3)throw Error('disk unavailable'); s.persisted.push(structuredClone(cp));
    }})).rejects.toThrow('disk unavailable');
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(validateCheckpoint(s.persisted.at(-1),cases,s.clock())).toMatchObject({ok:false,reason:'checkpoint_inflight_outcome_unknown_no_replay'});
  });
  it('cancels during HTTP without automatic retry or an unsafe resume', async () => {
    const s=lab(), fetcher=vi.fn((_u: unknown, init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
      init!.signal!.addEventListener('abort',()=>reject(Error('abort')),{once:true}); s.controller.abort();
    }));
    const result=await runLab(flags,environment,fetcher as typeof fetch,s.runtime);
    if(result.mode!=='live')throw Error('mode'); expect(result.stop).toBe('evaluation_cancelled'); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(validateCheckpoint(s.persisted.at(-1),cases,s.clock()).ok).toBe(false);
  });
  it('supports aborting the native bounded sleep without leaving a timer running', async () => {
    vi.useFakeTimers(); const controller=new AbortController(), pending=abortableEvalSleep(1000,controller.signal);
    controller.abort(); await expect(pending).rejects.toThrow('evaluation_cancelled'); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects the actual legacy live report without reconstructing a checkpoint from file time or labels', async () => {
    const legacy=JSON.parse(readFileSync('output/semantic-eval/smoke-2026-10-30T07-11-04-821Z.json','utf8'));
    const fetcher=vi.fn(), result=await runLab(['--check-resume','legacy.json'],{},fetcher as typeof fetch,{checkpointData:legacy});
    expect(result).toMatchObject({mode:'offline_checkpoint_check',liveRequests:0,resumable:false,reason:'legacy_report_missing_reliable_checkpoint'});
    expect(fetcher).not.toHaveBeenCalled();
    const cli=spawnSync(process.execPath,['scripts/eval-semantic.mjs','--check-resume','output/semantic-eval/smoke-2026-10-30T07-11-04-821Z.json'],{encoding:'utf8',env:{PATH:process.env.PATH!}});
    expect(cli.status).toBe(2); expect(JSON.parse(cli.stdout)).toMatchObject({liveRequests:0,resumable:false});
  });
});
