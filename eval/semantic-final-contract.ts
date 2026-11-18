import { createHash } from 'node:crypto';
import { contractReplayCase } from './semantic-contract-replay';
import { FINAL_CONTRACT_INSTRUCTIONS,FINAL_CONTRACT_PROMPT_VERSION,FinalContractContextBuilder } from './semantic-final-contract-prompt';
import { estimateEvalReservation,type EvalAccountLimits } from '../src/semantic-eval-guard';
import { validateSemanticPlan } from '../src/semantic-validator';
import { FINAL_CONTRACT_NORMALIZATION_VERSION } from '../src/semantic-contract-alignment';
import { evalSchemaPreflight } from './semantic-preflight';
import type { SemanticGoldCase } from '../src/semantic-eval';

export const FINAL_CONTRACT_IDS=['p3e-03','p3e-13','p3e-23a','p3e-23s','p3e-18'] as const;
export const FINAL_CONTRACT_LIMITS={requests:5,totalReservedTokens:50000,minuteTokens:5000,durationMs:600000} as const;
export const FINAL_CONTRACT_PROFILE='contract-v5' as const;
export function finalContractCase(id:string):SemanticGoldCase {
  if(!FINAL_CONTRACT_IDS.includes(id as typeof FINAL_CONTRACT_IDS[number]))throw Error('Unknown final contract case ID');
  // Gold plan and labels are cloned unchanged; only the versioned trusted
  // application-side fixture context and evaluator provenance are selected.
  return {...contractReplayCase(id),evaluationProfile:FINAL_CONTRACT_PROFILE};
}
export const isFinalContractSelection=(cases:readonly SemanticGoldCase[])=>cases.length>0&&cases.every(c=>c.evaluationProfile===FINAL_CONTRACT_PROFILE);
export function prepareFinalContractSmoke(ids:readonly string[]=FINAL_CONTRACT_IDS,account:EvalAccountLimits={}) {
  if(!ids.length||ids.length>5||new Set(ids).size!==ids.length)throw Error('V5 requires 1–5 distinct frozen cases');
  if(Object.values(account).some(n=>!Number.isSafeInteger(n)||n<0))throw Error('Invalid V5 account limits');
  const cases=ids.map(finalContractCase),builder=new FinalContractContextBuilder(),schema=evalSchemaPreflight();
  if(!schema.localCompatible||schema.model!=='openai/gpt-oss-120b'||schema.schemaHash!=='8e0983deadf3b0c8cb3452de7023cb1f64d470165771b2c441e6ad5fe53074b4')throw Error('V5 strict schema/model preflight failed');
  const selected=cases.map(c=>{
    const built=builder.build(c.input,c.context),checked=validateSemanticPlan(c.expectedPlan,built.context);
    if(!c.synthetic||c.ambiguity||(c.expectedValidator==='allow'?!checked.ok:checked.ok||!checked.issues.some(i=>i.reason==='permission_denied')))throw Error('V5 gold/context preflight failed');
    const reservation=estimateEvalReservation(built.messages);return {id:c.id,tokens:reservation.totalReserved,reservation};
  });
  const minuteCap=Math.min(5000,account.tokensPerMinute??Infinity),totalReserved=selected.reduce((n,c)=>n+c.tokens,0);
  if(selected.some(c=>!Number.isFinite(c.tokens)||c.tokens>minuteCap||c.tokens>(account.remainingTokens??Infinity))||totalReserved>50000||(account.remainingRequests??Infinity)<cases.length)throw Error('V5 reservation budget preflight failed');
  return {cases,selection:{selected,count:cases.length,totalReserved,minuteCap,reserveCeiling:50000,blocker:null},schema,
    promptVersion:FINAL_CONTRACT_PROMPT_VERSION,promptHash:createHash('sha256').update(FINAL_CONTRACT_INSTRUCTIONS).digest('hex'),
    normalizationVersion:FINAL_CONTRACT_NORMALIZATION_VERSION};
}
