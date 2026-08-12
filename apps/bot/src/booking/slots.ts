import { SLOT_STEP_MINUTES } from "../config/hours.js";
import type { ClinicHour } from "../db/types.js";

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m || 0);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format HH:MM in clinic timezone from a Date */
export function formatTimeInTz(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatDateInTz(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function getDayOfWeekInTz(date: Date, timeZone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[weekday] ?? date.getUTCDay();
}

/**
 * Build a Date for local wall-clock time in the given IANA timezone.
 */
export function zonedDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(utcGuess);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);

  let shownHour = get("hour");
  if (shownHour === 24) shownHour = 0;

  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    shownHour,
    get("minute"),
    get("second")
  );
  const offset = asUtc - utcGuess.getTime();
  return new Date(utcGuess.getTime() - offset);
}

export function parseDateString(dateStr: string): {
  year: number;
  month: number;
  day: number;
} {
  const [year, month, day] = dateStr.split("-").map(Number);
  if (!year || !month || !day) {
    throw new Error(`Invalid date: ${dateStr}. Use YYYY-MM-DD`);
  }
  return { year, month, day };
}

export interface BusyInterval {
  starts_at: Date;
  ends_at: Date;
}

export function generateSlots(params: {
  dateStr: string;
  durationMinutes: number;
  hours: ClinicHour | undefined;
  busy: BusyInterval[];
  timeZone: string;
  now?: Date;
  stepMinutes?: number;
}): string[] {
  const {
    dateStr,
    durationMinutes,
    hours,
    busy,
    timeZone,
    now = new Date(),
    stepMinutes = SLOT_STEP_MINUTES,
  } = params;

  if (!hours) return [];

  const { year, month, day } = parseDateString(dateStr);
  const openMin = parseTimeToMinutes(String(hours.open_time).slice(0, 5));
  const closeMin = parseTimeToMinutes(String(hours.close_time).slice(0, 5));
  const slots: string[] = [];

  for (let startMin = openMin; startMin + durationMinutes <= closeMin; startMin += stepMinutes) {
    const hour = Math.floor(startMin / 60);
    const minute = startMin % 60;
    const start = zonedDateTime(year, month, day, hour, minute, timeZone);
    const end = new Date(start.getTime() + durationMinutes * 60_000);

    if (start <= now) continue;

    const overlaps = busy.some(
      (b) => start < b.ends_at && end > b.starts_at
    );
    if (overlaps) continue;

    slots.push(`${pad(hour)}:${pad(minute)}`);
  }

  return slots;
}

export function slotToRange(params: {
  dateStr: string;
  timeStr: string;
  durationMinutes: number;
  timeZone: string;
}): { startsAt: Date; endsAt: Date } {
  const { year, month, day } = parseDateString(params.dateStr);
  const [hour, minute] = params.timeStr.split(":").map(Number);
  const startsAt = zonedDateTime(
    year,
    month,
    day,
    hour,
    minute,
    params.timeZone
  );
  const endsAt = new Date(startsAt.getTime() + params.durationMinutes * 60_000);
  return { startsAt, endsAt };
}
