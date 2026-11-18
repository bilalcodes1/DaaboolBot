import type { NluAiBinding } from './types';

/** One worker-wide allowance shared by timetable and contribution extraction. */
export class AiBudget {
  private minute = -1;
  private calls = 0;
  private pending = 0;

  wrap(binding: NluAiBinding): NluAiBinding {
    return { run: async (model, inputs, options) => {
      const minute = Math.floor(Date.now() / 60_000);
      if (minute !== this.minute) { this.minute = minute; this.calls = 0; }
      if (this.calls >= 12 || this.pending >= 2) throw new Error('Classification allowance reached');
      this.calls++;
      this.pending++;
      try { return await binding.run(model, inputs, options); }
      finally { this.pending--; }
    } };
  }
}
