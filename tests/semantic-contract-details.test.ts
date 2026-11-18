import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finalContractCase } from '../eval/semantic-final-contract';
import { normalizeFinalContractModelPlan, normalizeAlignedModelPlan } from '../src/semantic-contract-alignment';
import { isModelPlanDraft, MODEL_PLAN_DRAFT_JSON_SCHEMA, normalizeModelPlan } from '../src/semantic-draft';
import { validateSemanticPlan } from '../src/semantic-validator';
import { mockDraftFromGold } from './helpers/semantic-eval-mocks';

const fixture=(id='p3e-03')=>{const c=finalContractCase(id);return {c,draft:mockDraftFromGold(c.expectedPlan)};};
const absentDetails=()=>{const x=fixture();x.draft.operations[0]!.fields=x.draft.operations[0]!.fields!.filter(f=>f.name!=='details');return x;};
beforeEach(()=>vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Network forbidden in details tests');})));
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();});

describe('V5 optional user details with source-backed canonical text',()=>{
  it.each(['absent_entry','explicit_null'] as const)('accepts %s only by preserving exact current source text',kind=>{
    const {c,draft}=absentDetails(),op=draft.operations[0]!;
    if(kind==='explicit_null')op.fields!.push({name:'details',mode:'set',value:null,dateKind:null,evidence:{...op.evidence}});
    const before=structuredClone(draft),contextBefore=structuredClone(c.context);
    expect(isModelPlanDraft(draft)).toBe(true);
    const result=normalizeFinalContractModelPlan(draft,c.context);
    expect(result.ok).toBe(true);if(!result.ok)throw Error('Valid source-backed details should normalize');
    const create=result.plan.operations[0]!;if(create.action!=='create')throw Error('Expected create');
    expect(create.data.details).toEqual({value:c.context.originalText.slice(op.evidence.start,op.evidence.end),evidence:op.evidence});
    expect(create.data.course?.value).toBe('mobile');expect(create.data.kind.value).toBe('quiz');
    expect(create.data.date?.value).toEqual({kind:'relative',text:'باچر'});
    for(const optional of ['time','audience','coverage','component','claimedCertainty'])expect(create.data).not.toHaveProperty(optional);
    expect(validateSemanticPlan(result.plan,c.context).ok).toBe(true);
    expect(result.adjustments.some(a=>a.kind==='verbatim_details')).toBe(true);
    expect(draft).toEqual(before);expect(c.context).toEqual(contextBefore);
  });

  it('preserves explicitly supplied real details and their original evidence',()=>{
    const {c,draft}=fixture(),supplied=structuredClone(draft.operations[0]!.fields!.find(f=>f.name==='details')!);
    const result=normalizeFinalContractModelPlan(draft,c.context);
    expect(result.ok).toBe(true);if(!result.ok)throw Error('Real details should normalize');
    const op=result.plan.operations[0]!;if(op.action!=='create')throw Error('Expected create');
    expect(op.data.details).toEqual({value:supplied.value,evidence:supplied.evidence});
    expect(result.adjustments.some(a=>a.kind==='verbatim_details')).toBe(false);
  });

  it('still rejects a missing required value property even though its explicit null is valid',()=>{
    const {c,draft}=fixture(),field=draft.operations[0]!.fields!.find(f=>f.name==='details')!;
    delete (field as unknown as Record<string,unknown>).value;
    expect(isModelPlanDraft(draft)).toBe(false);
    expect(normalizeFinalContractModelPlan(draft,c.context)).toMatchObject({ok:false,reason:'invalid_model_draft'});
    const schema=MODEL_PLAN_DRAFT_JSON_SCHEMA as {properties:{operations:{items:{properties:{fields:{anyOf:{items?:{required?:string[]}}[]}}}}}};
    expect(schema.properties.operations.items.properties.fields.anyOf[0]!.items!.required).toContain('value');
  });

  it('does not reinterpret fabricated non-null details as absent information',()=>{
    const {c,draft}=fixture();draft.operations[0]!.fields!.find(f=>f.name==='details')!.value='UNSUPPORTED_CONTENT';
    const result=normalizeFinalContractModelPlan(draft,c.context);
    if(result.ok){const checked=validateSemanticPlan(result.plan,c.context);expect(checked.ok).toBe(false);if(!checked.ok)expect(checked.issues.map(i=>i.reason)).toContain('ungrounded_value');}
    else expect(result.reason).not.toBe('missing_information');
  });

  it.each(['unknown_source','outside_bounds','quoted_source','overlap_quote','empty_source','oversized_source'] as const)('refuses %s instead of inventing fallback details',kind=>{
    const {c,draft}=absentDetails(),op=draft.operations[0]!;
    if(kind==='unknown_source')op.evidence.sourceId='missing';
    if(kind==='outside_bounds')op.evidence.end=c.context.originalText.length+1;
    if(kind==='quoted_source'){
      c.context.sources=[...c.context.sources,{id:'untrusted',kind:'reply',text:c.context.originalText,messageStart:null}];
      op.evidence.sourceId='untrusted';
    }
    if(kind==='overlap_quote')c.context.sources=[...c.context.sources,{id:'quoted',kind:'quote',text:c.context.originalText,messageStart:0}];
    if(kind==='empty_source'||kind==='oversized_source'){
      const text=kind==='empty_source'?'   ':'Create كوز Mobile Applications باچر.'+' '.repeat(2401);
      c.context.originalText=text;c.input.originalText=text;c.context.sources=[{id:'message',kind:'current',text,messageStart:0}];
      op.evidence={sourceId:'message',start:0,end:text.length};
      c.context.instructions=c.context.instructions.map(i=>({...i,evidence:{...op.evidence}}));
    }
    const result=normalizeFinalContractModelPlan(draft,c.context);
    expect(result.ok).toBe(false);expect(draft.operations[0]!.fields!.some(f=>f.name==='details')).toBe(false);
  });

  it('does not fill missing kind or course with details text or create authority from a model request',()=>{
    for(const missing of ['kind','course']){
      const {c,draft}=absentDetails();draft.operations[0]!.fields=draft.operations[0]!.fields!.filter(f=>f.name!==missing);
      const result=normalizeFinalContractModelPlan(draft,c.context);
      if(result.ok)expect(validateSemanticPlan(result.plan,c.context).ok).toBe(false);else expect(result.reason).toBe('missing_information');
    }
    const {c,draft}=absentDetails();c.context.instructions=[];
    expect(normalizeFinalContractModelPlan(draft,c.context)).toMatchObject({ok:false,reason:'intent_not_established'});
  });

  it('does not change the strict legacy normalizer or Phase F default details requirement',()=>{
    const {c,draft}=absentDetails();
    expect(normalizeModelPlan(draft,c.context.sources)).toMatchObject({ok:false,reason:'missing_information',missing:['details']});
    expect(normalizeAlignedModelPlan(draft,c.context)).toMatchObject({ok:false,reason:'missing_information',missing:['details']});
  });

  it('preserves omitted update fields and keeps null separate from explicit clear',()=>{
    const {c,draft}=fixture('p3e-18'),op=draft.operations[0]!;
    op.targets=[op.target!];op.target=null;
    const result=normalizeFinalContractModelPlan(draft,c.context);
    expect(result.ok).toBe(true);if(!result.ok)throw Error('Expected time-only update');
    const update=result.plan.operations[0]!;if(update.action!=='update')throw Error('Expected update');
    expect(Object.keys(update.patch)).toEqual(['time']);expect(update.patch.time).toMatchObject({mode:'set',value:'09:45'});
    expect(update.patch).not.toHaveProperty('details');
    op.fields![0]!.value=null;
    expect(normalizeFinalContractModelPlan(draft,c.context).ok).toBe(false);
    const other=fixture('p3e-18');other.draft.operations[0]!.fields!.push({name:'details',mode:'clear',value:null,dateKind:null,evidence:{...other.draft.operations[0]!.evidence}});
    const clear=normalizeFinalContractModelPlan(other.draft,other.c.context);
    if(clear.ok)expect(validateSemanticPlan(clear.plan,other.c.context).ok).toBe(false);
    else expect(clear.ok).toBe(false);
  });
});
