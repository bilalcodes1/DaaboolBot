import { getBaghdadNow, type BaghdadNow } from "./calendar";

/** User-approved temporary assumptions. Update this one object when official times arrive. */
export const PROVISIONAL_TIMES = {
  temporary: true,
  label: "الأوقات مؤقتة وتقديرية بتوقيت بغداد، لحد ما نعتمد التوقيت الرسمي.",
  slots: [
    { slot: 1, startMinute: 8 * 60 + 30, endMinute: 9 * 60 + 30 },
    { slot: 2, startMinute: 9 * 60 + 30, endMinute: 10 * 60 + 30 },
    { slot: 3, startMinute: 10 * 60 + 30, endMinute: 11 * 60 + 30 },
  ],
} as const;

export type SlotNumber = typeof PROVISIONAL_TIMES.slots[number]["slot"];
export type SlotPhase = "before" | "current" | "ended";
export interface SlotTiming {
  readonly slot: SlotNumber;
  readonly startMinute: number;
  readonly endMinute: number;
}

export interface DayTiming {
  readonly calendar: BaghdadNow;
  readonly currentSlot: SlotNumber | null;
  /** A slot whose start is strictly in the future; excludes the active slot. */
  readonly nextSlot: SlotNumber | null;
  /** Includes the active slot and slots that have not started. */
  readonly remainingSlots: readonly SlotNumber[];
}

export function getSlotTiming(slot: number): SlotTiming {
  const timing = PROVISIONAL_TIMES.slots.find(value => value.slot === slot);
  if (!timing) throw new RangeError("Unknown lecture slot.");
  return timing;
}

export function formatMinuteOfDay(minute: number): string {
  if (!Number.isInteger(minute) || minute < 0 || minute > 24 * 60) {
    throw new RangeError("Expected an integer minute from 00:00 through 24:00.");
  }
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function phase(timing: SlotTiming, millisecondOfDay: number): SlotPhase {
  if (millisecondOfDay < timing.startMinute * 60_000) return "before";
  if (millisecondOfDay < timing.endMinute * 60_000) return "current";
  return "ended";
}

/** Slots are half-open intervals: a start is included, an end is excluded. */
export function getSlotPhase(slot: number, now: Date = new Date()): SlotPhase {
  return phase(getSlotTiming(slot), getBaghdadNow(now).millisecondOfDay);
}

/** Clock only: callers must intersect these slots with the official day's lectures. */
export function getDayTiming(now: Date = new Date()): DayTiming {
  const calendar = getBaghdadNow(now);
  return {
    calendar,
    currentSlot: PROVISIONAL_TIMES.slots.find(slot => phase(slot, calendar.millisecondOfDay) === "current")?.slot ?? null,
    nextSlot: PROVISIONAL_TIMES.slots.find(slot => slot.startMinute * 60_000 > calendar.millisecondOfDay)?.slot ?? null,
    remainingSlots: PROVISIONAL_TIMES.slots.filter(slot => phase(slot, calendar.millisecondOfDay) !== "ended").map(slot => slot.slot),
  };
}
