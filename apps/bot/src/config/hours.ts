import { env } from "./env.js";

export const CLINIC_HOURS_FALLBACK = {
  weekday: { open: "10:00", close: "20:00" },
  weekend: { open: "10:00", close: "14:00" },
} as const;

export const SLOT_STEP_MINUTES = 30;

export const CLINIC = {
  name: env.CLINIC_NAME,
  timezone: env.TIMEZONE,
} as const;
