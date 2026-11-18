import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SEMANTIC_GOLD_CASES } from '../eval/semantic-gold';
import { checkpointIdentity } from '../eval/semantic-checkpoint';
import { ContextBuilder, SemanticCompiler, SEMANTIC_BRAIN_INSTRUCTIONS, SEMANTIC_BRAIN_PROMPT_VERSION, type CompilerInput } from '../src/semantic-compiler';
import { GroqPlanner, type PlannerTransport } from '../src/groq-planner';
import { normalizeModelPlan, isModelPlanDraft, MODEL_PLAN_DRAFT_JSON_SCHEMA } from '../src/semantic-draft';
import { validateSemanticPlan } from '../src/semantic-validator';
import { SemanticEvaluator } from '../src/semantic-eval';
import { estimateEvalReservation } from '../src/semantic-eval-guard';
import { normalizeArabic } from '../src/input';
import type { ReadExecutionContext } from '../src/read-tools';
import { matchesReadSchema, type ReadSchema, type ReadToolInvocation } from '../src/read-tool-contracts';
import type { SemanticOperation, SemanticPlanV1, EvidenceSpan } from '../src/semantic-plan';
import { mockDraftFromGold } from './helpers/semantic-eval-mocks';
import { SEMANTIC_CONTRASTIVE_FIXTURES, type SemanticContrastiveFixture } from './fixtures/semantic-contrastive-fixtures';

const historical = JSON.parse(readFileSync('tests/fixtures/semantic-live-failure-2026-10-30.json','utf8'));
const base = () => structuredClone(SEMANTIC_GOLD_CASES.find(c=>c.id==='iraqi_anbari-01')!);
const envelope = (draft: unknown) => ({status:200,body:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(draft)}}]}});
const compile = async (plan: SemanticPlanV1, input: CompilerInput, context: ReadExecutionContext) => {
  const transport = vi.fn<PlannerTransport>(async()=>envelope(mockDraftFromGold(plan)));
  return { result: await new SemanticCompiler(new GroqPlanner(transport)).compile(input,context), transport };
};
function contrast(f: SemanticContrastiveFixture) {
  const c=base().context; c.originalText=f.text;
  c.sources=[{id:'message',kind:'current',text:f.text,messageStart:0}];
  if(f.quote)c.sources=[...c.sources,{id:'marked-quote',kind:'quote',text:f.quote.text,messageStart:f.quote.start}];
  const input:CompilerInput={originalText:f.text};
  if(f.previous)input.conversation={scope:c.scope,expiresAt:c.now+10000,turns:[{role:'assistant',text:f.previous}]};
  // All current instruction is before the quote. Preserve original characters and source-local offsets.
  const evidence:EvidenceSpan={sourceId:'message',start:0,end:f.quote?.start??f.text.length}, literal=f.text.slice(evidence.start,evidence.end);
  let op:SemanticOperation;
  if(f.action==='reply')op={id:'a',action:'reply',speechAct:f.speechAct,subject:f.subject!,evidence,dependsOn:[],text:'رد صناعي للاختبار.'};
  else {
    const tool:ReadToolInvocation=f.tool==='get_schedule'?{name:'get_schedule',version:1,input:{period:f.period!}}
      : f.tool==='get_courses'?{name:'get_courses',version:1,input:{}}:{name:'search_announcements',version:1,input:{query:literal}};
    op={id:'a',action:'read',speechAct:f.speechAct,subject:f.tool==='get_schedule'?'schedule':f.tool==='get_courses'?'cohort':'announcements',
      evidence,dependsOn:[],query:{value:literal,evidence},tool};
  }
  return {input,context:c,expected:{version:1 as const,operations:[op]}};
}
beforeEach(()=>vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Offline analysis: network forbidden');})));
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('frozen real failure: historical observation, not invented raw output',()=>{
  it('freezes original message, trusted context, gold, observations and report bytes',()=>{
    expect(base()).toEqual(historical.gold);
    expect(historical.gold.input.originalText).toBe('شعدنا باچر؟');
    expect(historical.gold.context.sources).toEqual([{id:'message',kind:'current',text:'شعدنا باچر؟',messageStart:0}]);
    expect(historical.gold.context.originalTimestamp).toBe(Date.parse('2026-10-29T22:30:00Z'));
    expect(historical.originalMessages[1].content).not.toContain('current_instruction_spans');
    expect(historical.observed.modelPlan.operations[0]).toMatchObject({action:'reply',speechAct:'question',subject:'conversation'});
    expect(historical.observed.validator.reasons).toEqual(['invalid_evidence']);
    expect(historical.rawGroqResponse).toBeNull(); expect(historical.normalizedPlan).toBeNull();
    expect(createHash('sha256').update(readFileSync(historical.originalReport)).digest('hex')).toBe(historical.originalReportSha256);
  });
  it('retains the historical 4282 reservation without relabelling it as the new prompt size',()=>{
    expect(estimateEvalReservation(historical.originalMessages).totalReserved).toBe(4282);
    const current=new ContextBuilder().build(base().input,base().context).messages;
    expect(estimateEvalReservation(current).totalReserved).toBe(4609);
    expect(estimateEvalReservation(current).totalReserved).toBeLessThan(5000);
    expect(checkpointIdentity([base()]).promptVersion).toBe('semantic-brain-v2');
    expect(SEMANTIC_BRAIN_PROMPT_VERSION).toBe('semantic-brain-v2');
  });
  it('isolates wrong action with VALID evidence: no deterministic academic keyword rerouting',async()=>{
    const g=base(), wrong:SemanticPlanV1={version:1,operations:[{id:'a',action:'reply',speechAct:'question',subject:'conversation',
      evidence:{sourceId:'message',start:0,end:11},dependsOn:[],text:'رد صناعي.'}]};
    const {result}=await compile(wrong,g.input,g.context);
    expect(result.status).toBe('conversation'); expect(result.validation?.ok).toBe(true);
    const row=await new SemanticEvaluator(async()=>envelope(mockDraftFromGold(wrong))).evaluate(g);
    expect(row.rawExact).toBe(false); expect(row.comparison.action).toBe(false); expect(row.failures).toContain('wrong_action');
    expect(row.validator.correct).toBeNull();
  });
  it.each([{sourceId:'invented',start:0,end:11},{sourceId:'message',start:0,end:12}])('isolates reply evidence failure %j without claiming it was the actual missing raw span',async evidence=>{
    const g=base(), plan:SemanticPlanV1={version:1,operations:[{id:'a',action:'reply',speechAct:'question',subject:'conversation',evidence,dependsOn:[],text:'رد صناعي.'}]};
    expect(normalizeModelPlan(mockDraftFromGold(plan),g.context.sources).ok).toBe(true);
    const {result}=await compile(plan,g.input,g.context);
    expect(result.validation?.issues).toEqual([{reason:'invalid_evidence',operationId:'a'}]);
    expect(result.status).toBe('rejected');
  });
  it('isolates correct routing with bad evidence; raw meaning is correct while normalization rejects',async()=>{
    const g=base(), draft=mockDraftFromGold(g.expectedPlan);draft.operations[0]!.evidence.sourceId='invented';
    const row=await new SemanticEvaluator(async()=>envelope(draft)).evaluate(g);
    expect(row.rawExact).toBe(true);expect(row.stages.normalization).toBe('rejected');
    expect(row.stages.normalizationReason).toBe('invalid_evidence');expect(row.correctCompletion).toBe(false);
  });
});

describe('44 independently labelled contrastive integrations; mocks are NOT improved Groq accuracy',()=>{
  it('contains genuine opposing labels for identical wording and distinguishes negative questions/imperatives',()=>{
    expect(SEMANTIC_CONTRASTIVE_FIXTURES.length).toBeGreaterThanOrEqual(30);
    const contexts=SEMANTIC_CONTRASTIVE_FIXTURES.filter(f=>f.text==='شنو عندك باچر؟');
    expect(contexts.map(f=>[f.action,f.subject??f.tool])).toEqual([['read','get_schedule'],['reply','conversation'],['reply','clarification']]);
    expect(SEMANTIC_CONTRASTIVE_FIXTURES.find(f=>f.id==='english-negative-question')!.action).toBe('read');
    expect(SEMANTIC_CONTRASTIVE_FIXTURES.find(f=>f.id==='negation-read-english')!.action).toBe('reply');
  });
  it.each(SEMANTIC_CONTRASTIVE_FIXTURES)('$id',async f=>{
    const {input,context,expected}=contrast(f), draft=mockDraftFromGold(expected), before=structuredClone({input,context,expected,draft});
    expect(isModelPlanDraft(draft)).toBe(true);
    expect(matchesReadSchema(draft,MODEL_PLAN_DRAFT_JSON_SCHEMA as ReadSchema)).toBe(true);
    expect(normalizeModelPlan(draft,context.sources)).toEqual({ok:true,plan:expected});
    expect(validateSemanticPlan(expected,context).ok).toBe(true);
    const {result,transport}=await compile(expected,input,context);
    expect(result.plan).toEqual(expected);expect(result.validation?.ok).toBe(true);
    expect(result.status).toBe(f.action==='read'?'ready':f.subject==='clarification'?'clarification_required':'conversation');
    const dynamic=JSON.parse(transport.mock.calls[0]![0].messages[1]!.content);
    expect(dynamic.user_instruction[0].text).toBe(f.text);expect(dynamic.trusted_metadata.actorRole).toBe('student');
    expect(dynamic.trusted_metadata.baghdadDate).toBe('2026-10-30');
    if(f.previous)expect(dynamic.conversation[0].text).toBe(f.previous);
    expect({input,context,expected,draft}).toEqual(before);expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('source-local UTF-16 evidence protocol, original whitespace and quote boundaries',()=>{
  it.each(['😀 شنو عدنا باچر؟','  شنو عدنا باچر؟\n','شِنُو عِدنا باچر؟','شلونك دعبول؟'])('supplies exact spans without normalizing or deciding action: %s',text=>{
    const f:SemanticContrastiveFixture={id:'unicode',text,action:'reply',speechAct:'question',subject:'conversation',labelNote:'Span protocol test only'};
    const {input,context}=contrast(f), dynamic=JSON.parse(new ContextBuilder().build(input,context).messages[1]!.content);
    expect(dynamic.current_instruction_spans).toEqual([{sourceId:'message',start:0,end:text.length}]);
    expect(dynamic.user_instruction[0].text).toBe(text);
    expect(context.sources[0]!.text.slice(0,text.length)).toBe(text);
  });
  it.each([{sourceId:'message',start:0,end:12},{sourceId:'Message',start:0,end:11},{sourceId:'user_instruction',start:0,end:11},
    {sourceId:'message',start:-1,end:11},{sourceId:'message',start:11,end:0}])('never repairs misleading evidence %j',evidence=>{
    const g=base(), draft=mockDraftFromGold(g.expectedPlan);draft.operations[0]!.evidence=evidence;
    const original=structuredClone(draft), result=normalizeModelPlan(draft,g.context.sources);
    expect(result.ok).toBe(false);expect(draft).toEqual(original);
  });
  it('keeps offsets local to a segmented source, not messageStart or serialized JSON',async()=>{
    const text='مقدمة: شعدنا باچر؟', sourceText='شعدنا باچر؟', c=base().context;c.originalText=text;
    c.sources=[{id:'chunk',kind:'current',text:sourceText,messageStart:text.indexOf(sourceText)}];
    const good=mockDraftFromGold(base().expectedPlan);good.operations[0]!.evidence={sourceId:'chunk',start:0,end:11};
    const dynamic=JSON.parse(new ContextBuilder().build({originalText:text},c).messages[1]!.content);
    expect(dynamic.current_instruction_spans).toEqual([{sourceId:'chunk',start:0,end:11}]);
    const n=normalizeModelPlan(good,c.sources);expect(n.ok).toBe(true);if(n.ok)expect(validateSemanticPlan(n.plan,c).ok).toBe(true);
    good.operations[0]!.evidence.end=text.length;
    expect(normalizeModelPlan(good,c.sources)).toMatchObject({ok:false,reason:'invalid_evidence'});
  });
  it('rejects normalized query text as literal evidence and never changes original offsets',()=>{
    const text='  شِنُو عدنا باچر؟ ', c=base().context;c.originalText=text;c.sources=[{id:'message',kind:'current',text,messageStart:0}];
    const plan=structuredClone(base().expectedPlan),op=plan.operations[0]!;if(op.action!=='read')throw Error('fixture');
    op.evidence={sourceId:'message',start:0,end:text.length};op.query={value:normalizeArabic(text),evidence:op.evidence};
    expect(validateSemanticPlan(plan,c)).toMatchObject({ok:false,issues:[{reason:'ungrounded_value',field:'query'}]});
  });
  it('subtracts multiple/overlapping marked quotes and keeps all offered spans within current source regions',()=>{
    const text='اعرض اليوم «انشر» ثم «احذف» بس.', c=base().context;c.originalText=text;
    c.sources=[{id:'message',kind:'current',text,messageStart:0},...['انشر','احذف'].map((literal,i)=>({id:`quote${i}`,kind:'quote' as const,text:literal,messageStart:text.indexOf(literal)}))];
    const spans=JSON.parse(new ContextBuilder().build({originalText:text},c).messages[1]!.content).current_instruction_spans as EvidenceSpan[];
    expect(spans).toHaveLength(3);
    for(const e of spans)for(const q of c.sources.filter(s=>s.kind==='quote'))expect(e.start<q.messageStart!+q.text.length&&e.end>q.messageStart!).toBe(false);
    const draft=mockDraftFromGold(base().expectedPlan);draft.operations[0]!.evidence={sourceId:'message',start:0,end:text.length};
    const n=normalizeModelPlan(draft,c.sources);expect(n.ok).toBe(true);if(n.ok)expect(validateSemanticPlan(n.plan,c)).toMatchObject({ok:false,issues:[{reason:'source_region_mismatch'}]});
  });
  it('offers no fabricated instruction evidence when the whole current source is a quote',()=>{
    const c=base().context,text=c.originalText;c.sources=[...c.sources,{id:'quote',kind:'quote',text,messageStart:0}];
    expect(JSON.parse(new ContextBuilder().build({originalText:text},c).messages[1]!.content).current_instruction_spans).toEqual([]);
    const n=normalizeModelPlan(mockDraftFromGold(base().expectedPlan),c.sources);if(!n.ok)throw Error('fixture');
    expect(validateSemanticPlan(n.plan,c).ok).toBe(false);
  });
  it('clips overlapping quotes to a nonzero messageStart using source-local UTF-16 offsets',()=>{
    const prefix='مقدمة: ', chunk='اعرض «انشر كله» وبس.', text=prefix+chunk, c=base().context;c.originalText=text;
    c.sources=[{id:'chunk',kind:'current',text:chunk,messageStart:prefix.length},
      ...['انشر','نشر كله'].map((literal,i)=>({id:`overlap${i}`,kind:'quote' as const,text:literal,messageStart:text.indexOf(literal)}))];
    const hints=JSON.parse(new ContextBuilder().build({originalText:text},c).messages[1]!.content).current_instruction_spans;
    expect(hints).toEqual([{sourceId:'chunk',start:0,end:chunk.indexOf('انشر')},
      {sourceId:'chunk',start:chunk.indexOf('كله')+'كله'.length,end:chunk.length}]);
  });
  it('keeps a known quoted source distinct from a missing source, and grants no model permissions',()=>{
    const g=base();g.context.sources=[...g.context.sources,{id:'quoted',kind:'reply',text:g.input.originalText,messageStart:null}];
    const draft=mockDraftFromGold(g.expectedPlan);draft.operations[0]!.evidence.sourceId='quoted';
    expect(normalizeModelPlan(draft,g.context.sources)).toMatchObject({ok:false,reason:'quoted_instruction'});
    Object.assign(draft,{actorRole:'admin'});expect(isModelPlanDraft(draft)).toBe(false);
    expect(g.context.actor.userId).toBe(900001);expect(g.context.allowedActions).toEqual(['read']);
  });
});
