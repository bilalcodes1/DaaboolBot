import { ContextBuilder, SEMANTIC_BRAIN_INSTRUCTIONS } from '../src/semantic-compiler';
import type { CompilerInput } from '../src/semantic-compiler';
import type { ReadExecutionContext } from '../src/read-tools';

export const QUALITY_PROMPT_VERSION = 'semantic-brain-v3-taxonomy';
export const QUALITY_INSTRUCTIONS = SEMANTIC_BRAIN_INSTRUCTIONS.replace('Static instructions end here.',
  'SpeechAct labels utterance force, not domain: explicit questions (including wellbeing) are question; imperative reads are command; non-question greetings/thanks/banter are chitchat. Keep negation/example/correction precedence. Conversation intent is reply+conversation.\nStatic instructions end here.');

/** Evaluation only. Role comes from the synthetic app-owned verified owner attestation,
 * matching the validator, rather than the production account-ID list. No model roles. */
export class QualityContextBuilder extends ContextBuilder {
  constructor() { super(QUALITY_INSTRUCTIONS); }
  override build(input: CompilerInput, context: ReadExecutionContext) {
    const built=super.build(input,context), dynamic=JSON.parse(built.messages[1]!.content);
    dynamic.trusted_metadata.actorRole=built.context.actor.verified && built.context.actor.userId===built.context.actor.ownerUid?'admin':'student';
    built.messages[1]!.content=JSON.stringify(dynamic);return built;
  }
}
