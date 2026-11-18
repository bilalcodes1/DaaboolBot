import { UNDERSTANDING_INSTRUCTIONS, UnderstandingContextBuilder } from './semantic-understanding-prompt';
import type { CompilerInput } from '../src/semantic-compiler';
import type { ReadExecutionContext } from '../src/read-tools';

export const CONTRACT_PROMPT_VERSION = 'semantic-brain-v5-contract-alignment';
/** New isolated evaluation prefix. Historical V4 and its live request hashes stay frozen. */
export const CONTRACT_INSTRUCTIONS = UNDERSTANDING_INSTRUCTIONS
  .replace(
    'SpeechAct labels the ORIGINAL USER request, not your reply: interrogatives including wellbeing=question; requests/imperative reads=command; non-question greetings/thanks/banter=chitchat. Preserve correction, negation and example force.',
    'SpeechAct labels ORIGINAL USER force, not your reply: negation=negation; hypothetical/quoted examples=example; edits of existing records=correction. Prioritize these over reply-question grammar. Otherwise question=question, request=command, greetings/thanks=chitchat. Questions alone grant no write intent; independent trusted intent is required.',
  )
  .replace('A question/command may read; mentioning a course or عدنا alone does not establish a save.',
    'Questions/commands may read; course mentions/عدنا never establish save intent.')
  .replace(
    'Create requires evidenced fields kind,course,details, no target.',
    'Create requires evidenced kind,course,details; no targets. details is a literal event excerpt (kind/course phrase suffices), never invented. Missing details is invalid, not optional.',
  )
  .replace('Update uses target and only requested fields:', 'Update uses one selector and only requested fields:')
  .replace(
    'Publish uses targets, no fields.',
    'Target-bearing actions update/cancel/undo/publish use targets[], even for one; target=null. update/cancel/undo need one selector; publish allows many, no fields. previous_list: listId+position; text/evidence/sourceId=null. Action evidence is current.',
  )
  .replace(
    'Bare البرمجة means visual; explicit Mobile Applications means mobile.',
    'Use canonical course IDs: bare البرمجة=visual; explicit Mobile Applications=mobile.',
  )
  .replace('All execution is disabled.', 'Operation id is a free label, no authority. All execution is disabled.');

export class ContractContextBuilder extends UnderstandingContextBuilder {
  override build(input: CompilerInput, context: ReadExecutionContext) {
    const built = super.build(input, context);
    built.messages[0]!.content = CONTRACT_INSTRUCTIONS;
    return built;
  }
}
