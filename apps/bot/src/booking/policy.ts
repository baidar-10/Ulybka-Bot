import {
  CLINIC,
  MORNING_CONTACT_CUTOFF_HOUR,
  SAME_DAY_CUTOFF_HOUR,
  SAME_DAY_EVENING_START_HOUR,
} from "../config/hours.js";
import { PROCEDURE_EVENING_CUTOFF } from "./procedures.js";
import { formatDateInTz } from "./slots.js";

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m || 0);
}

export function todayIso(now = new Date()): string {
  return formatDateInTz(now, CLINIC.timezone);
}

export function tomorrowIso(now = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  return formatDateInTz(d, CLINIC.timezone);
}

export function currentHourInClinic(now = new Date()): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: CLINIC.timezone,
    hour: "2-digit",
    hour12: false,
  }).format(now);
  return Number(hour);
}

/** Earliest date allowed for new bookings (YYYY-MM-DD). */
export function earliestBookableDateIso(now = new Date()): string {
  const today = todayIso(now);
  if (currentHourInClinic(now) < SAME_DAY_CUTOFF_HOUR) {
    return today;
  }
  return tomorrowIso(now);
}

export function isDateBookable(dateIso: string, now = new Date()): boolean {
  return dateIso >= earliestBookableDateIso(now);
}

/** On today before noon: only evening slots (from 16:00). */
export function applySameDaySlotPolicy(
  slots: string[],
  dateIso: string,
  now = new Date()
): string[] {
  if (dateIso !== todayIso(now)) return slots;
  if (currentHourInClinic(now) >= MORNING_CONTACT_CUTOFF_HOUR) return slots;

  const minMinutes = SAME_DAY_EVENING_START_HOUR * 60;
  return slots.filter((t) => timeToMinutes(t) >= minMinutes);
}

export function isSlotTimeAllowed(
  dateIso: string,
  time: string,
  now = new Date()
): boolean {
  if (dateIso !== todayIso(now)) return true;
  if (currentHourInClinic(now) >= MORNING_CONTACT_CUTOFF_HOUR) return true;
  return timeToMinutes(time) >= SAME_DAY_EVENING_START_HOUR * 60;
}

export function applyProcedureSlotPolicy(
  slots: string[],
  durationMinutes: number,
  latestEndTime?: string
): string[] {
  if (!latestEndTime) return slots;
  const maxEnd = timeToMinutes(latestEndTime);
  return slots.filter((t) => timeToMinutes(t) + durationMinutes <= maxEnd);
}

export function isProcedureSlotAllowed(
  time: string,
  durationMinutes: number,
  latestEndTime?: string
): boolean {
  if (!latestEndTime) return true;
  return timeToMinutes(time) + durationMinutes <= timeToMinutes(latestEndTime);
}

export function procedureSlotRuleText(latestEndTime?: string): string | null {
  if (!latestEndTime) return null;
  return `Лечение и имплантация: приём должен ПОЛНОСТЬЮ закончиться не позже ${latestEndTime} (find_slots сам отфильтрует; пациенту не объясняй правило). Любая процедура: предлагай только время, куда целиком помещается её длительность без пересечения со следующей записью врача.`;
}

export function sameDayMorningSlotRuleText(now = new Date()): string | null {
  const hour = currentHourInClinic(now);
  if (hour >= MORNING_CONTACT_CUTOFF_HOUR) return null;
  const today = todayIso(now);
  return `Сейчас до ${MORNING_CONTACT_CUTOFF_HOUR}:00 — на сегодня (${today}) предлагай только слоты с ${SAME_DAY_EVENING_START_HOUR}:00 и позже. Утренние и дневные слоты не предлагай.`;
}

export function sameDayBookingRuleText(now = new Date()): string {
  const hour = currentHourInClinic(now);
  const today = todayIso(now);
  const earliest = earliestBookableDateIso(now);
  const morningRule = sameDayMorningSlotRuleText(now);
  if (morningRule) return morningRule;
  if (hour < SAME_DAY_CUTOFF_HOUR) {
    return `Сейчас до ${SAME_DAY_CUTOFF_HOUR}:00 — можно предлагать запись на сегодня (${today}), если find_slots показывает свободные слоты.`;
  }
  return `Сейчас после ${SAME_DAY_CUTOFF_HOUR}:00 — запись только начиная с ${earliest}. Не вызывай find_slots на сегодня (${today}).`;
}

export function bookingPolicyText(now = new Date()): string {
  const parts = [sameDayBookingRuleText(now)];
  const eveningRule = procedureSlotRuleText(PROCEDURE_EVENING_CUTOFF);
  if (eveningRule) parts.push(eveningRule);
  return parts.join("\n");
}
