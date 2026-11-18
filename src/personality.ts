/** User-authored wording. Fixed templates, never model-generated conversation. */
export const WAKE_REPLIES = [
  'خير شكو 😒 ماتخلون احد ينام ؟',
  'اهوووو مو نايم شتريد/ين هسه ؟',
  'خير يم خضير شتريد/ين ؟',
] as const;

export function wakeReply(index: number): string {
  return WAKE_REPLIES[((index % WAKE_REPLIES.length) + WAKE_REPLIES.length) % WAKE_REPLIES.length]!;
}

/** Only an invocation at the beginning counts; quoted references stay silent. */
export function stripWakeWord(text: string): string | null {
  const marks = '[\\u0610-\\u061a\\u064b-\\u065f\\u0670\\u0640]*';
  const name = [...'دعبول'].map(letter => `${letter}${marks}`).join('');
  const match = new RegExp(`^[\\s\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]*(?:يا\\s+)?${name}(?=$|[\\s\\p{P}\\p{S}])`, 'u').exec(text);
  return match ? text.slice(match[0].length).replace(/^[\s\p{P}\p{S}]+/u, '').trim() : null;
}
