import { env } from "./env.js";

export const CLINIC_HOURS_FALLBACK = {
  weekday: { open: "10:00", close: "20:00" },
  weekend: { open: "10:00", close: "14:00" },
} as const;

export const SLOT_STEP_MINUTES = 30;

/** After this hour (clinic TZ) same-day booking is not offered. */
export const SAME_DAY_CUTOFF_HOUR = 13;

/** Before this hour, same-day slots start no earlier than SAME_DAY_EVENING_START_HOUR. */
export const MORNING_CONTACT_CUTOFF_HOUR = 12;

/** Earliest slot on today when client contacts before MORNING_CONTACT_CUTOFF_HOUR. */
export const SAME_DAY_EVENING_START_HOUR = 16;

export const CLINIC = {
  name: env.CLINIC_NAME,
  address: env.CLINIC_ADDRESS,
  timezone: env.TIMEZONE,
} as const;
