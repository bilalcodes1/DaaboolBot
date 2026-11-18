import { SEMANTIC_GOLD_CASES, GOLD_DATASET_VERSION } from './semantic-gold';
import type { SemanticGoldCase } from '../src/semantic-eval';
import type { SemanticTarget } from '../src/semantic-plan';

export const QUALITY_GOLD_VERSION='daaboul-synthetic-gold-v2';
export const QUALITY_PROFILE='quality-v3' as const;
export interface GoldCorrection { id:string; dimension:string; reason:string; before:unknown; after:unknown }
const corrections:GoldCorrection[]=[];
const revised=structuredClone(SEMANTIC_GOLD_CASES) as SemanticGoldCase[];
const get=(id:string)=>{const c=revised.find(c=>c.id===id);if(!c)throw Error('Missing audited gold ID');return c;};
function revise(id:string,dimension:string,reason:string,edit:(c:SemanticGoldCase)=>void) {
  const c=get(id), before=structuredClone(c);edit(c);
  corrections.push({id,dimension,reason,before,after:structuredClone(c)});
}
const commands=['iraqi_anbari-04','iraqi_anbari-07','msa-01','msa-03','msa-06','msa-08',
  'english-01','english-03','english-04','english-05','english-06','english-07','english-08',
  'mixed-01','mixed-03','mixed-04','mixed-06','mixed-08','iraqi_typos-03','multi_turn-05','multi_turn-06','old_list_reply-01'];
for(const id of commands)revise(id,'speechAct','Explicit display/list/show/give imperative; read intent is independent of command force.',c=>{
  c.expectedPlan.operations.forEach(op=>{op.speechAct='command';});
});
for(const id of ['multiple_announcements-02','multiple_announcements-06'])revise(id,'speechAct','Descriptive assessment notification (عدنا), with independently supplied save attestation; not an imperative.',c=>{
  c.expectedPlan.operations.forEach(op=>{op.speechAct='statement';});
  c.context.instructions=c.context.instructions.map(i=>({...i,speechAct:'statement'}));
});
const target=(position:number):SemanticTarget=>({type:'previous_list',listId:'synthetic-list',position});
for(const id of ['unauthorized_actions-04','unauthorized_actions-06','fake_admin_claim-03','fake_admin_claim-05'])
  revise(id,'target','Whole/plural supplied two-item list includes both records; denial remains independent of target.',c=>{
    const op=c.expectedPlan.operations[0]!;if(op.action!=='publish')throw Error('Gold action drift');op.targets=[target(1),target(2)];
  });
for(const id of ['unauthorized_actions-05','correction_previous-03'])revise(id,'target',id==='unauthorized_actions-05'
  ?'Literal الثاني selects item 2.':'Prior list item 2 is Thursday; item 1 is Sunday. The explicit Thursday correction selects item 2.',c=>{
  const op=c.expectedPlan.operations[0]!;if(!('target'in op))throw Error('Gold target drift');op.target=target(2);
});
for(const id of ['correction_previous-02','correction_previous-04','correction_previous-05','correction_previous-06',
  'dependent_update_publish-03','dependent_update_publish-04','dependent_update_publish-05','dependent_update_publish-06','dependent_update_publish-08'])
  revise(id,'target/clarification','Two live records and no singular selection. Temporal أولاً means first do X, not item 1. Ask for target; do not invent one.',c=>{
    const prior=c.expectedPlan.operations[0]!;
    c.expectedPlan={version:1,operations:[{id:'a',action:'reply',subject:'clarification',speechAct:prior.speechAct,evidence:prior.evidence,dependsOn:[],text:'حدد التبليغ المقصود.'}]};
    c.context.instructions=[];c.context.allowedActions=['read'];c.ambiguity=true;c.abstentionExpected=true;
  });
for(const id of ['old_list_reply-05','old_list_reply-06','old_list_reply-07','old_list_reply-08'])
  revise(id,'trusted_context','Expired/foreign conversation must not leave an active own reference list that resolves the supposedly stale selection.',c=>{
    const expired=id.endsWith('05')||id.endsWith('06');
    c.context.sources=c.context.sources.filter(s=>s.kind==='current');
    c.context.announcementReferences=c.context.announcementReferences.map(r=>({...r,...(expired?{expiresAt:c.context.originalTimestamp-1}:{scope:{...r.scope,userId:r.scope.userId+77}})}));
    c.context.targetBindings=c.context.targetBindings.map(b=>({...b,...(expired?{expiresAt:c.context.originalTimestamp-1}:{scope:{...b.scope,userId:b.scope.userId+77}})}));
  });
revise('old_list_reply-05','speechAct','Explicit اريده is a request, consistent with the other imperative/request read labels.',c=>{c.expectedPlan.operations[0]!.speechAct='command';});

/** Independent audit limitations, not silent corrections or exemptions from scoring. */
export const GOLD_REVIEW_REQUIRED = [
  ...['short-05','short-06','short-07','short-08','multi_turn-07','multi_turn-08','old_list_reply-03','old_list_reply-04','old_list_reply-06','old_list_reply-07','old_list_reply-08']
    .map(id=>({id,reason:'Elliptical/affirmative force needs independent annotation; statement reads currently are not supported. Excluded from next smoke.'})),
  ...['fake_admin_claim-01','fake_admin_claim-02','fake_admin_claim-04','fake_admin_claim-07','fake_admin_claim-08','unauthorized_actions-07','unauthorized_actions-08']
    .map(id=>({id,reason:'Primary target/state is underdetermined; safe refusal alternative does not establish target understanding. Excluded from next smoke.'})),
];
for(const c of revised){c.datasetVersion=QUALITY_GOLD_VERSION;c.evaluationProfile=QUALITY_PROFILE;}
export const SEMANTIC_GOLD_V2:readonly SemanticGoldCase[]=revised;
export const GOLD_CORRECTIONS:readonly GoldCorrection[]=corrections;
export const GOLD_AUDIT=SEMANTIC_GOLD_V2.map(c=>({id:c.id,categories:c.categories,originalTimestamp:c.context.originalTimestamp,
  corrections:corrections.filter(x=>x.id===c.id).map(x=>({dimension:x.dimension,reason:x.reason})),
  reviewRequired:GOLD_REVIEW_REQUIRED.filter(x=>x.id===c.id).map(x=>x.reason)}));
export const QUALITY_GOLD_PARENT=GOLD_DATASET_VERSION;
export const isQualitySelection=(cases:readonly SemanticGoldCase[])=>cases.length>0&&cases.every(c=>c.datasetVersion===QUALITY_GOLD_VERSION&&c.evaluationProfile===QUALITY_PROFILE);
