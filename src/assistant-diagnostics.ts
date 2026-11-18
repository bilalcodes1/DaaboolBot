/** Operational metadata only. Never include prompts, responses, URLs or keys. */
export type AssistantFailure = 'local_capacity'|'provider_capacity'|'timeout'|'transport'|'provider_auth'|'provider_error'
  |'invalid_output'|'invalid_evidence'|'storage_error'|'input_too_large'|'not_configured'|'refused';
export function isAssistantFailure(value:unknown):value is AssistantFailure {
  return typeof value==='string'&&['local_capacity','provider_capacity','timeout','transport','provider_auth','provider_error','invalid_output','invalid_evidence','storage_error','input_too_large','not_configured','refused'].includes(value);
}
export interface AiDiagnostic {
  reason:AssistantFailure|'ready'|'cache_ready'; provider?:'groq'|'gemini'; modelMs?:number; estimatedTokens?:number; status?:number;
}
export interface TurnDiagnostic {
  version:1; reason:string; lookupMs:number; modelMs:number; waitMs:number;
  waitStartedAt?:number; estimatedTokens?:number; provider?:string; status?:number;
  replyAdjusted?:boolean;
  waitReason?:string;
}
export function turnDiagnostic(raw:string|null|undefined):TurnDiagnostic {
  try {const value=JSON.parse(raw??'null') as TurnDiagnostic|null;if(value?.version===1&&typeof value.waitMs==='number'&&typeof value.modelMs==='number')return value;}catch{}
  return {version:1,reason:'processing',lookupMs:0,modelMs:0,waitMs:0};
}
export function failureMessage(reason:string,academic:boolean):string {
  const suffix=academic?' ما انحفظ تبليغ جديد من هالطلب.':'';
  if(reason==='invalid_evidence')return 'وصلني تحليل ما اجتاز تدقيق النص أو الموعد. دز التبليغ بصياغة أوضح حتى أحفظه مضبوط.'+suffix;
  if(reason==='invalid_output')return 'جواب خدمة الذكاء طلع بصيغة ناقصة؛ جرّب تعيد الطلب.'+suffix;
  if(reason==='local_capacity'||reason==='provider_capacity')return 'الحصة المجانية مستخدمة هسه؛ جرّب بعد ما تتجدد.'+suffix;
  if(reason==='provider_auth'||reason==='not_configured')return 'ربط خدمة الذكاء يحتاج مراجعة من المطوّر.'+suffix;
  if(reason==='refused')return 'خدمة الذكاء ما وافقت تجاوب هالطلب. وضّح المطلوب بصياغة ثانية.'+suffix;
  if(reason==='input_too_large')return 'سياق الطلب طويل؛ قسّم التفاصيل على رسالتين.'+suffix;
  if(reason==='storage_error')return 'صار تعثر بالتخزين؛ ما أگدر أؤكد إكمال الطلب هسه.';
  return 'خدمة الذكاء متعثرة هسه؛ جرّب بعد شوي.'+suffix;
}
