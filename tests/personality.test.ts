import { describe, expect, it } from 'vitest';
import { stripWakeWord, wakeReply } from '../src/personality';

describe('the exact user-authored Daabool personality', () => {
  it('rotates the three exact greetings without changing the letters', () => {
    expect([0, 1, 2, 3].map(wakeReply)).toEqual([
      'خير شكو 😒 ماتخلون احد ينام ؟', 'اهوووو مو نايم شتريد/ين هسه ؟',
      'خير يم خضير شتريد/ين ؟', 'خير شكو 😒 ماتخلون احد ينام ؟',
    ]);
  });
  it.each(['دعبول', 'دَعـبول!', 'يا دعبول 😂'])('accepts a bare wake %s', text => expect(stripWakeWord(text)).toBe(''));
  it('preserves the note text and exclusions', () => expect(stripWakeWord('دعبول، الاثنين الجاي لحد الليكسل مو داخله')).toBe('الاثنين الجاي لحد الليكسل مو داخله'));
  it.each(['شنو عدنا باچر', 'قال دعبول امتحان', 'دعبولية', '@OtherBot', ''])('does not invoke on %s', text => expect(stripWakeWord(text)).toBeNull());
});
