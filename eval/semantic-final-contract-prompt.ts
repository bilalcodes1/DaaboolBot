import { CONTRACT_INSTRUCTIONS,ContractContextBuilder } from './semantic-contract-prompt';
import type { CompilerInput } from '../src/semantic-compiler';
import type { ReadExecutionContext } from '../src/read-tools';

export const FINAL_CONTRACT_PROMPT_VERSION='semantic-brain-v5-final-contract-gate';
export const FINAL_CONTRACT_INSTRUCTIONS=CONTRACT_INSTRUCTIONS.replace(
  'Create requires evidenced kind,course,details; no targets. details is a literal event excerpt (kind/course phrase suffices), never invented. Missing details is invalid, not optional.',
  'Create requires evidenced kind/course; no targets. Extra details are optional: omit that fields entry or set value=null. Every present entry still requires all keys. The app retains literal current action evidence as display text when details are absent; never invent content or ask for optional prose.',
);
export class FinalContractContextBuilder extends ContractContextBuilder {
  override build(input:CompilerInput,context:ReadExecutionContext) {
    const built=super.build(input,context);built.messages[0]!.content=FINAL_CONTRACT_INSTRUCTIONS;return built;
  }
}
