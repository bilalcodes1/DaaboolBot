import { createHash } from 'node:crypto';
import { UNDERSTANDING_CASES, UNDERSTANDING_GOLD_VERSION, UNDERSTANDING_PROFILE, UNDERSTANDING_SMOKE_IDS } from './semantic-understanding-fixtures';
import { UNDERSTANDING_INSTRUCTIONS, UNDERSTANDING_PROMPT_VERSION, UnderstandingContextBuilder } from './semantic-understanding-prompt';
import { estimateEvalReservation, type EvalAccountLimits } from '../src/semantic-eval-guard';
import { validateSemanticPlan } from '../src/semantic-validator';
import type { SemanticGoldCase } from '../src/semantic-eval';
import { evalSchemaPreflight } from './semantic-preflight';

export const UNDERSTANDING_LIMITS={requests:6,totalReservedTokens:50000,minuteTokens:5000,durationMs:600000} as const;
export const isUnderstandingSelection=(cases:readonly SemanticGoldCase[])=>cases.length>0&&cases.every(c=>c.evaluationProfile===UNDERSTANDING_PROFILE&&c.datasetVersion===UNDERSTANDING_GOLD_VERSION);
export function prepareUnderstandingSmoke(ids:readonly string[]=UNDERSTANDING_SMOKE_IDS,account:EvalAccountLimits={}) {
  if(ids.length<1||ids.length>6||new Set(ids).size!==ids.length)throw Error('Understanding selection requires 1–6 distinct frozen cases');
  if(Object.values(account).some(n=>!Number.isSafeInteger(n)||n<0))throw Error('Invalid understanding account limits');
  const cases=ids.map(id=>{const c=UNDERSTANDING_CASES.find(c=>c.id===id);if(!c)throw Error('Unknown understanding case ID');return structuredClone(c);});
  const schema=evalSchemaPreflight(),builder=new UnderstandingContextBuilder();
  if(!schema.localCompatible||schema.model!=='openai/gpt-oss-120b'||schema.schemaHash!=='8e0983deadf3b0c8cb3452de7023cb1f64d470165771b2c441e6ad5fe53074b4')throw Error('Understanding schema/model preflight failed');
  const selected=cases.map(c=>{
    const built=builder.build(c.input,c.context),checked=validateSemanticPlan(c.expectedPlan,built.context);
    const matched=c.expectedValidator==='allow'?checked.ok:c.expectedValidator==='deny'?!checked.ok&&checked.issues.some(i=>i.reason==='permission_denied')
      :!checked.ok&&['conflict','clarification_required'].includes(checked.status);
    if(!c.synthetic||!matched)throw Error('Understanding gold/context preflight failed');
    const reservation=estimateEvalReservation(built.messages);return {id:c.id,tokens:reservation.totalReserved,reservation};
  });
  const minuteCap=Math.min(5000,account.tokensPerMinute??Infinity),totalReserved=selected.reduce((sum,c)=>sum+c.tokens,0);
  if(selected.some(c=>!Number.isFinite(c.tokens)||c.tokens>minuteCap||c.tokens>(account.remainingTokens??Infinity))||totalReserved>50000
    ||(account.remainingRequests??Infinity)<cases.length)throw Error('Understanding reservation budget preflight failed');
  return {cases,selection:{selected,count:cases.length,totalReserved,minuteCap,reserveCeiling:50000,blocker:null},schema,
    promptVersion:UNDERSTANDING_PROMPT_VERSION,promptHash:createHash('sha256').update(UNDERSTANDING_INSTRUCTIONS).digest('hex')};
}
