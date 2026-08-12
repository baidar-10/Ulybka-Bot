import fs from "node:fs";
import { google, type calendar_v3 } from "googleapis";
import { env } from "../config/env.js";
import { CLINIC } from "../config/hours.js";
import type { Appointment } from "../db/types.js";

export interface GoogleCalendarClient {
  enabled: boolean;
  defaultCalendarId: string | null;
  createEvent(params: {
    calendarId: string;
    appointment: Appointment;
  }): Promise<string>;
  updateEvent(params: {
    calendarId: string;
    eventId: string;
    appointment: Appointment;
  }): Promise<void>;
  cancelEvent(params: {
    calendarId: string;
    eventId: string;
  }): Promise<void>;
}

function buildEventBody(appointment: Appointment): calendar_v3.Schema$Event {
  const doctor = appointment.doctor_name ?? `Врач #${appointment.doctor_id}`;
  const service = appointment.service_name ?? "Приём";
  const summary = `${doctor}: ${appointment.patient_name} — ${service}`;
  const description = [
    `Пациент: ${appointment.patient_name}`,
    `Телефон: +${appointment.phone}`,
    `Услуга: ${service}`,
    `Врач: ${doctor}`,
    `Статус: ${appointment.status}`,
    `Источник: WhatsApp AI`,
    appointment.comment ? `Комментарий: ${appointment.comment}` : null,
    `ID записи: ${appointment.id}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    summary,
    description,
    start: {
      dateTime: appointment.starts_at.toISOString(),
      timeZone: CLINIC.timezone,
    },
    end: {
      dateTime: appointment.ends_at.toISOString(),
      timeZone: CLINIC.timezone,
    },
    extendedProperties: {
      private: {
        appointmentId: String(appointment.id),
        source: "whatsapp_ai",
        status: appointment.status,
        phone: appointment.phone,
      },
    },
  };
}

function disabledClient(): GoogleCalendarClient {
  return {
    enabled: false,
    defaultCalendarId: env.GOOGLE_CALENDAR_ID || null,
    async createEvent() {
      return "";
    },
    async updateEvent() {},
    async cancelEvent() {},
  };
}

function wrapCalendar(
  calendar: calendar_v3.Calendar
): GoogleCalendarClient {
  return {
    enabled: true,
    defaultCalendarId: env.GOOGLE_CALENDAR_ID || null,

    async createEvent({ calendarId, appointment }) {
      const res = await calendar.events.insert({
        calendarId,
        requestBody: buildEventBody(appointment),
      });
      if (!res.data.id) {
        throw new Error("Google Calendar did not return event id");
      }
      return res.data.id;
    },

    async updateEvent({ calendarId, eventId, appointment }) {
      await calendar.events.patch({
        calendarId,
        eventId,
        requestBody: buildEventBody(appointment),
      });
    },

    async cancelEvent({ calendarId, eventId }) {
      await calendar.events.delete({
        calendarId,
        eventId,
      });
    },
  };
}

export function createGoogleCalendarClient(): GoogleCalendarClient {
  if (!env.GOOGLE_CALENDAR_ENABLED) {
    console.log("Google Calendar: disabled (GOOGLE_CALENDAR_ENABLED=false)");
    return disabledClient();
  }

  const saPath = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (saPath && fs.existsSync(saPath)) {
    const auth = new google.auth.GoogleAuth({
      keyFile: saPath,
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });
    console.log("Google Calendar: service account auth");
    return wrapCalendar(google.calendar({ version: "v3", auth }));
  }

  const tokenPath = env.GOOGLE_OAUTH_TOKEN_PATH;
  if (
    env.GOOGLE_OAUTH_CLIENT_ID &&
    env.GOOGLE_OAUTH_CLIENT_SECRET &&
    tokenPath &&
    fs.existsSync(tokenPath)
  ) {
    const oauth2 = new google.auth.OAuth2(
      env.GOOGLE_OAUTH_CLIENT_ID,
      env.GOOGLE_OAUTH_CLIENT_SECRET,
      "http://127.0.0.1:53682/oauth2callback"
    );
    const tokens = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
    oauth2.setCredentials(tokens);
    oauth2.on("tokens", (fresh) => {
      const merged = { ...tokens, ...fresh };
      fs.writeFileSync(tokenPath, JSON.stringify(merged, null, 2));
    });
    console.log("Google Calendar: OAuth auth");
    return wrapCalendar(google.calendar({ version: "v3", auth: oauth2 }));
  }

  console.warn(
    "Google Calendar enabled, but no credentials. Run: npm run google:auth"
  );
  return disabledClient();
}

/** Resolve calendar for a doctor: per-doctor id, else shared GOOGLE_CALENDAR_ID */
export function resolveCalendarId(doctorCalendarId: string | null): string | null {
  return doctorCalendarId || env.GOOGLE_CALENDAR_ID || null;
}
