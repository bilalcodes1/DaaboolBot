import { isModelPlanDraft, normalizeModelPlan, type DraftNormalization, type DraftOperation, type DraftTarget } from './semantic-draft';
import type { EvidenceSpan, SemanticOperation, SemanticPlanV1, SemanticTarget, TrustedInstruction, ValidationContext } from './semantic-plan';
import { MAX_SEMANTIC_OPERATIONS } from './semantic-plan';
import { semanticCourseHint, sameSemanticTarget } from './semantic-validator';
import { sameReadScope } from './read-tools';
import { COURSE_ALIASES } from './nlu-schema';

export interface ContractAdjustment { operationId:string; path:string; kind:'target_container'|'list_annotation'|'course_alias'|'operation_id'|'field_evidence'|'verbatim_details' }
export type ContractNormalization = DraftNormalization & { adjustments:ContractAdjustment[] };
class AlignmentFault extends Error { constructor(readonly reason:string) { super(reason); } }
const fail=(reason:string):never=>{throw new AlignmentFault(reason);};
const sameSpan=(a:EvidenceSpan,b:EvidenceSpan)=>a.sourceId===b.sourceId&&a.start===b.start&&a.end===b.end;
const contains=(outer:EvidenceSpan,inner:EvidenceSpan)=>outer.sourceId===inner.sourceId&&outer.start<=inner.start&&outer.end>=inner.end;

/** A real original source range. This does not attest intent or authorization. */
function literal(e:EvidenceSpan,c:ValidationContext,current=true):string {
  const source=c.sources.find(s=>s.id===e.sourceId);
  if(!source||!Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<0||e.end<=e.start||e.end>source.text.length) return fail('invalid_evidence');
  if(current&&source.kind!=='current')return fail('quoted_instruction');
  if(source.kind==='current') {
    if(source.messageStart===null||c.originalText.slice(source.messageStart,source.messageStart+source.text.length)!==source.text)return fail('invalid_evidence');
    const start=source.messageStart+e.start,end=source.messageStart+e.end;
    if(c.sources.some(s=>s.kind==='quote'&&s.messageStart!==null&&start<s.messageStart+s.text.length&&end>s.messageStart))return fail('source_region_mismatch');
  }
  return source.text.slice(e.start,e.end);
}
function selector(t:DraftTarget):SemanticTarget {
  if(t.type==='previous_list'&&t.listId&&t.position&&t.text===null)return {type:'previous_list',listId:t.listId,position:t.position};
  if(t.type==='reply'&&t.sourceId&&t.position&&t.text===null&&t.evidence===null&&t.listId===null)return {type:'reply',sourceId:t.sourceId,position:t.position};
  if(t.type==='description'&&t.text&&t.evidence&&t.sourceId===null&&t.listId===null&&t.position===null)return {type:'description',text:t.text,evidence:t.evidence};
  return fail('invalid_target');
}
function exactTargets(expected:readonly SemanticTarget[],actual:readonly SemanticTarget[]):boolean {
  const rest=[...expected];
  if(rest.length!==actual.length)return false;
  return actual.every(t=>{const i=rest.findIndex(e=>sameSemanticTarget(e,t));if(i<0)return false;rest.splice(i,1);return true;});
}
function checkBinding(t:SemanticTarget,c:ValidationContext) {
  const matches=c.targetBindings.filter(b=>sameSemanticTarget(b.selector,t));
  if(matches.length===0)return fail('unresolved_target');
  if(matches.length!==1||matches[0]!.snapshots.length!==1)return fail('ambiguous_target');
  const binding=matches[0]!,snapshot=binding.snapshots[0]!;
  if(!sameReadScope(binding.scope,c.scope))return fail('scope_mismatch');
  if(!Number.isFinite(binding.expiresAt)||binding.expiresAt<=c.now)return fail('expired_reference');
  if(!Number.isSafeInteger(snapshot.currentRevision)||snapshot.currentRevision<1||snapshot.currentRevision!==snapshot.reference.revision
    ||binding.selector.expectedRevision!==undefined&&binding.selector.expectedRevision!==snapshot.currentRevision
    ||t.expectedRevision!==undefined&&t.expectedRevision!==snapshot.currentRevision)return fail('stale_reference');
  // Ownership, state, verified actor and permission are still checked by the validator.
}

/** Opt-in offline adapter. Never changes raw output, invents business fields,
 * selects among records, creates attestations, or grants permissions. The strict
 * wire schema and legacy normalizer remain unchanged. Every adjustment is logged.
 */
export function normalizeAlignedModelPlan(raw:unknown,c:ValidationContext,options:{optionalCreateDetails?:boolean}={}):ContractNormalization {
  const adjustments:ContractAdjustment[]=[];
  if(!isModelPlanDraft(raw))return {ok:false,reason:'invalid_model_draft',missing:[],adjustments};
  const draft=structuredClone(raw),ids=new Set(draft.operations.map(o=>o.id));
  if(ids.size!==draft.operations.length)return {ok:false,reason:'duplicate_operation',missing:[],adjustments};
  const mapping=new Map<string,string>(),used=new Set<string>();
  try {
    for(const op of draft.operations) {
      if(op.dependsOn.some(id=>!ids.has(id))||new Set(op.dependsOn).size!==op.dependsOn.length)fail('invalid_dependency');
      if(op.action==='read'||op.action==='reply')continue;
      literal(op.evidence,c);
      // Match only an already existing independent instruction; model IDs cannot
      // manufacture one. Ambiguous matches fail rather than choose an attestation.
      const matches=c.instructions.filter(i=>i.action===op.action&&sameSpan(i.evidence,op.evidence));
      const acts=op.action==='create'?['command','statement','correction']:['command','correction'];
      if(matches.length!==1||!acts.includes(matches[0]!.speechAct))fail('intent_not_established');
      const instruction=matches[0]!;
      if(used.has(instruction.operationId))fail('duplicate_operation');
      used.add(instruction.operationId);mapping.set(op.id,instruction.operationId);
      if(options.optionalCreateDetails&&op.action==='create') {
        const details=op.fields?.filter(f=>f.name==='details')??[];
        if(details.length>1)fail('duplicate_field');
        if(!details.length||details[0]!.mode==='set'&&details[0]!.value===null) {
          const value=literal(op.evidence,c);
          if(!value.trim()||value.length>2400)fail('invalid_details_evidence');
          // Existing academic business rule: preserve already evidenced text,
          // never invent extra requirements or ask the user to supply prose.
          const supplied=details[0];
          if(supplied&&(supplied.dateKind!==null||!sameSpan(supplied.evidence,op.evidence))) {
            literal(supplied.evidence,c);
            if(supplied.dateKind!==null||!contains(op.evidence,supplied.evidence))fail('invalid_evidence');
          }
          const field={name:'details' as const,mode:'set' as const,value,dateKind:null,evidence:{...op.evidence}};
          op.fields=details.length?op.fields!.map(f=>f.name==='details'?field:f):[...(op.fields??[]),field];
          adjustments.push({operationId:op.id,path:'fields.details',kind:'verbatim_details'});
        }
      }
      alignOperation(op,instruction,c,adjustments);
    }
    const finalIds=draft.operations.map(op=>mapping.get(op.id)??op.id);
    if(new Set(finalIds).size!==finalIds.length)fail('duplicate_operation');
    for(const op of draft.operations) {
      const id=mapping.get(op.id)??op.id;
      if(id!==op.id)adjustments.push({operationId:op.id,path:'id/dependsOn',kind:'operation_id'});
      op.id=id;op.dependsOn=op.dependsOn.map(id=>mapping.get(id)??id);
    }
    return {...normalizeModelPlan(draft,c.sources),adjustments};
  } catch(e) { return {ok:false,reason:e instanceof AlignmentFault?e.reason:'invalid_trusted_context',missing:[],adjustments}; }
}
export const FINAL_CONTRACT_NORMALIZATION_VERSION='semantic-contract-v5-optional-details-v1';
/** V5 only; older evaluators and historical replay retain their old policy. */
export const normalizeFinalContractModelPlan=(raw:unknown,c:ValidationContext):ContractNormalization=>normalizeAlignedModelPlan(raw,c,{optionalCreateDetails:true});
function alignOperation(op:DraftOperation,instruction:TrustedInstruction,c:ValidationContext,changes:ContractAdjustment[]) {
  const note=(path:string,kind:ContractAdjustment['kind'])=>changes.push({operationId:op.id,path,kind});
  if(['publish','update','cancel','undo'].includes(op.action)) {
    if(op.target!==null&&op.targets!==null)fail('conflicting_targets');
    const all=op.targets??(op.target?[op.target]:[]);
    if(!all.length)fail('missing_information');
    if(op.action!=='publish'&&all.length!==1)fail('ambiguous_target');
    const selectors=all.map(selector);
    if(!instruction.requestedTargets?.length||!exactTargets(instruction.requestedTargets,selectors))fail('unrequested_target');
    for(let i=0;i<all.length;i++) {
      const t=all[i]!;checkBinding(selectors[i]!,c);
      if(t.type==='previous_list'&&(t.evidence!==null||t.sourceId!==null)) {
        const annotation=t.evidence??op.evidence;
        literal(annotation,c);
        if(!contains(op.evidence,annotation)||t.sourceId!==null&&t.sourceId!==annotation.sourceId)fail('invalid_evidence');
        t.evidence=null;t.sourceId=null;note(`targets[${i}].annotation`,'list_annotation');
      }
    }
    if(op.action==='publish') {
      if(op.target!==null)note('target→targets','target_container');
      op.targets=all;op.target=null;
    } else {
      if(op.targets!==null)note('targets→target','target_container');
      op.target=all[0]!;op.targets=null;
    }
  }
  for(const field of op.fields??[]) {
    if(field.name==='course'&&field.mode==='set'&&field.value!==null) {
      const canonical=Object.hasOwn(COURSE_ALIASES,field.value)?field.value:semanticCourseHint(field.value);
      if(canonical!==field.value) {
        const proof=literal(field.evidence,c,false),source=c.sources.find(s=>s.id===field.evidence.sourceId)!;
        if(!canonical||semanticCourseHint(proof)!==canonical||source.kind!=='current'&&!instruction.adoptedSourceIds?.includes(source.id))fail('ungrounded_value');
        field.value=canonical;note('fields.course','course_alias');
      }
    }
    if(op.action==='update') {
      const requested=instruction.requestedChanges?.[field.name];
      if(requested&&requested.mode===field.mode&&(requested.mode==='clear'||JSON.stringify(requested.value)===JSON.stringify(field.name==='date'?{kind:field.dateKind,text:field.value}:field.value))
        &&!sameSpan(field.evidence,requested.evidence)) {
        literal(field.evidence,c);literal(requested.evidence,c);
        if(!contains(op.evidence,field.evidence)||!contains(field.evidence,requested.evidence))fail('invalid_evidence');
        field.evidence={...requested.evidence};note(`fields.${field.name}.evidence`,'field_evidence');
      }
    }
  }
}

/** Static proposal order only. No status/delivery result is fabricated. */
export function orderSemanticProposals(plan:SemanticPlanV1):readonly SemanticOperation[] {
  if(plan.operations.length>MAX_SEMANTIC_OPERATIONS)throw Error('Too many proposal operations');
  const ordered:SemanticOperation[]=[],remaining=[...plan.operations],known=new Set(remaining.map(o=>o.id));
  if(known.size!==remaining.length||remaining.some(o=>o.dependsOn.some(id=>!known.has(id))))throw Error('Invalid proposal dependency');
  while(remaining.length) {
    const index=remaining.findIndex(o=>o.dependsOn.every(id=>ordered.some(done=>done.id===id)));
    if(index<0)throw Error('Cyclic proposal dependency');
    ordered.push(remaining.splice(index,1)[0]!);
  }
  return structuredClone(ordered);
}
