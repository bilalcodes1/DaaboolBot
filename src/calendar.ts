export interface Tomorrow {
  /** Sunday is 0, Saturday is 6. */
  readonly weekday: number;
  /** A calendar date in Baghdad, as YYYY-MM-DD. */
  readonly date: string;
}

export interface BaghdadNow {
  /** Sunday is 0, Saturday is 6. */
  readonly weekday: number;
  readonly date: string;
  readonly minuteOfDay: number;
  readonly second: number;
  readonly millisecond: number;
  readonly secondOfDay: number;
  readonly millisecondOfDay: number;
}

const baghdadClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Baghdad",
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Calendar arithmetic on an explicit date; the host timezone is never used. */
export function addCalendarDays(date: string, days: number): Tomorrow {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(days)) {
    throw new RangeError("Expected an ISO calendar date and an integer number of days.");
  }
  const value = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) {
    throw new RangeError("Invalid calendar date.");
  }
  value.setUTCDate(value.getUTCDate() + days);
  if (!Number.isFinite(value.getTime()) || value.getUTCFullYear() < 0 || value.getUTCFullYear() > 9999) {
    throw new RangeError("Calendar date is out of range.");
  }
  return { weekday: value.getUTCDay(), date: value.toISOString().slice(0, 10) };
}

/** A single, precise Baghdad clock snapshot for all timing comparisons. */
export function getBaghdadNow(now: Date = new Date()): BaghdadNow {
  const parts = baghdadClock.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(value => value.type === type)!.value;
  const date = [
    part("year").padStart(4, "0"), part("month"), part("day"),
  ].join("-");
  const minuteOfDay = Number(part("hour")) * 60 + Number(part("minute"));
  const second = Number(part("second"));
  const millisecond = now.getUTCMilliseconds();
  const secondOfDay = minuteOfDay * 60 + second;
  return {
    weekday: addCalendarDays(date, 0).weekday, date,
    minuteOfDay, second, millisecond, secondOfDay,
    millisecondOfDay: secondOfDay * 1000 + millisecond,
  };
}

export function getTomorrow(now: Date = new Date()): Tomorrow {
  return addCalendarDays(getBaghdadNow(now).date, 1);
}

export interface CalendarWeek {
  /** Inclusive Sunday in Baghdad, as YYYY-MM-DD. */
  readonly fromDate: string;
  /** Inclusive Saturday in Baghdad, as YYYY-MM-DD. */
  readonly toDate: string;
}

/** A calendar week is Sunday through Saturday, independent of lecture days. */
export function getCalendarWeek(now: Date = new Date(), offset: number = 0): CalendarWeek {
  if (!Number.isInteger(offset)) throw new RangeError("Expected an integer week offset.");
  const today = getBaghdadNow(now);
  const fromDate = addCalendarDays(today.date, -today.weekday + offset * 7).date;
  return { fromDate, toDate: addCalendarDays(fromDate, 6).date };
}
