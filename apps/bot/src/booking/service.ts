import type { PoolClient } from "pg";
import { CLINIC } from "../config/hours.js";
import { pool, withTransaction } from "../db/pool.js";
import type {
  Appointment,
  ClinicHour,
  Doctor,
  Service,
} from "../db/types.js";
import {
  formatDateInTz,
  formatTimeInTz,
  generateSlots,
  slotToRange,
} from "./slots.js";
import type { GoogleCalendarClient } from "../calendar/google.js";
import { resolveCalendarId } from "../calendar/google.js";

export class BookingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingError";
  }
}

function mapAppointment(row: Record<string, unknown>): Appointment {
  return {
    id: Number(row.id),
    patient_name: String(row.patient_name),
    phone: String(row.phone),
    doctor_id: Number(row.doctor_id),
    service_id: Number(row.service_id),
    starts_at: new Date(row.starts_at as string | Date),
    ends_at: new Date(row.ends_at as string | Date),
    status: row.status as Appointment["status"],
    comment: (row.comment as string | null) ?? null,
    source: String(row.source ?? "whatsapp_ai"),
    google_event_id: (row.google_event_id as string | null) ?? null,
    doctor_name: row.doctor_name ? String(row.doctor_name) : undefined,
    service_name: row.service_name ? String(row.service_name) : undefined,
  };
}

export class BookingService {
  constructor(private readonly calendar?: GoogleCalendarClient) {}

  async listDoctors(): Promise<Doctor[]> {
    const { rows } = await pool.query(
      `SELECT id, full_name, specialization, google_calendar_id, color, active
       FROM doctors WHERE active = TRUE ORDER BY id`
    );
    return rows as Doctor[];
  }

  async listServices(doctorId?: number): Promise<Service[]> {
    const params: number[] = [];
    let where = "WHERE s.active = TRUE";
    if (doctorId != null) {
      params.push(doctorId);
      where += ` AND (s.doctor_id = $1 OR s.doctor_id IS NULL)`;
    }
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.doctor_id, s.duration_minutes, s.description, s.active,
              d.full_name AS doctor_name
       FROM services s
       LEFT JOIN doctors d ON d.id = s.doctor_id
       ${where}
       ORDER BY s.doctor_id NULLS LAST, s.name`,
      params
    );
    return rows as Service[];
  }

  async getDoctor(id: number): Promise<Doctor | null> {
    const { rows } = await pool.query(
      `SELECT id, full_name, specialization, google_calendar_id, color, active
       FROM doctors WHERE id = $1`,
      [id]
    );
    return (rows[0] as Doctor) ?? null;
  }

  async getService(id: number): Promise<Service | null> {
    const { rows } = await pool.query(
      `SELECT id, name, doctor_id, duration_minutes, description, active
       FROM services WHERE id = $1`,
      [id]
    );
    return (rows[0] as Service) ?? null;
  }

  private async getHoursForDate(dateStr: string): Promise<ClinicHour | undefined> {
    const probe = new Date(`${dateStr}T12:00:00Z`);
    const map: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    const weekdayLabel = new Intl.DateTimeFormat("en-US", {
      timeZone: CLINIC.timezone,
      weekday: "short",
    }).format(probe);
    const dow = map[weekdayLabel] ?? 0;

    const { rows } = await pool.query(
      `SELECT day_of_week, open_time::text, close_time::text
       FROM clinic_hours WHERE day_of_week = $1`,
      [dow]
    );
    return rows[0] as ClinicHour | undefined;
  }

  async findSlots(params: {
    doctorId: number;
    date: string;
    serviceId: number;
  }): Promise<{
    date: string;
    doctor: string;
    service: string;
    duration_minutes: number;
    slots: string[];
    timezone: string;
  }> {
    const doctor = await this.getDoctor(params.doctorId);
    if (!doctor || !doctor.active) {
      throw new BookingError("Врач не найден или неактивен");
    }
    const service = await this.getService(params.serviceId);
    if (!service || !service.active) {
      throw new BookingError("Услуга не найдена");
    }
    if (service.doctor_id != null && service.doctor_id !== params.doctorId) {
      throw new BookingError("Эта услуга недоступна у выбранного врача");
    }

    const hours = await this.getHoursForDate(params.date);
    const dayStart = slotToRange({
      dateStr: params.date,
      timeStr: "00:00",
      durationMinutes: 24 * 60,
      timeZone: CLINIC.timezone,
    });

    const { rows } = await pool.query(
      `SELECT starts_at, ends_at FROM appointments
       WHERE doctor_id = $1
         AND status IN ('booked', 'rescheduled')
         AND starts_at < $3
         AND ends_at > $2`,
      [params.doctorId, dayStart.startsAt, dayStart.endsAt]
    );

    const slots = generateSlots({
      dateStr: params.date,
      durationMinutes: service.duration_minutes,
      hours,
      busy: rows.map((r) => ({
        starts_at: new Date(r.starts_at),
        ends_at: new Date(r.ends_at),
      })),
      timeZone: CLINIC.timezone,
    });

    return {
      date: params.date,
      doctor: doctor.full_name,
      service: service.name,
      duration_minutes: service.duration_minutes,
      slots,
      timezone: CLINIC.timezone,
    };
  }

  async bookAppointment(params: {
    patientName: string;
    phone: string;
    doctorId: number;
    serviceId: number;
    date: string;
    time: string;
    comment?: string;
  }): Promise<Appointment> {
    const doctor = await this.getDoctor(params.doctorId);
    if (!doctor?.active) throw new BookingError("Врач не найден");
    const service = await this.getService(params.serviceId);
    if (!service?.active) throw new BookingError("Услуга не найдена");
    if (service.doctor_id != null && service.doctor_id !== params.doctorId) {
      throw new BookingError("Услуга недоступна у этого врача");
    }

    const hours = await this.getHoursForDate(params.date);
    if (!hours) throw new BookingError("Клиника закрыта в этот день");

    const { startsAt, endsAt } = slotToRange({
      dateStr: params.date,
      timeStr: params.time,
      durationMinutes: service.duration_minutes,
      timeZone: CLINIC.timezone,
    });

    if (startsAt <= new Date()) {
      throw new BookingError("Нельзя записаться на прошедшее время");
    }

    // Verify chosen time is within generated free slots
    const availability = await this.findSlots({
      doctorId: params.doctorId,
      date: params.date,
      serviceId: params.serviceId,
    });
    if (!availability.slots.includes(params.time)) {
      throw new BookingError(
        `Время ${params.time} недоступно. Свободно: ${availability.slots.join(", ") || "нет слотов"}`
      );
    }

    try {
      const appointment = await withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO appointments
             (patient_name, phone, doctor_id, service_id, starts_at, ends_at, status, comment, source)
           VALUES ($1, $2, $3, $4, $5, $6, 'booked', $7, 'whatsapp_ai')
           RETURNING *`,
          [
            params.patientName.trim(),
            normalizePhone(params.phone),
            params.doctorId,
            params.serviceId,
            startsAt,
            endsAt,
            params.comment?.trim() || null,
          ]
        );
        return mapAppointment(rows[0]);
      });

      const enriched = await this.enrich(appointment);
      await this.syncCreate(enriched, doctor);
      return enriched;
    } catch (err: unknown) {
      if (isExclusionViolation(err)) {
        throw new BookingError(
          "Это время только что заняли. Выберите другой слот."
        );
      }
      throw err;
    }
  }

  async getPatientAppointments(phone: string): Promise<Appointment[]> {
    const { rows } = await pool.query(
      `SELECT a.*, d.full_name AS doctor_name, s.name AS service_name
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN services s ON s.id = a.service_id
       WHERE a.phone = $1
         AND a.status IN ('booked', 'rescheduled')
         AND a.starts_at >= NOW()
       ORDER BY a.starts_at`,
      [normalizePhone(phone)]
    );
    return rows.map((r) => mapAppointment(r));
  }

  async cancelAppointment(params: {
    appointmentId: number;
    phone: string;
  }): Promise<Appointment> {
    const { updated, doctor } = await withTransaction(async (client) => {
      const existing = await this.lockAppointment(
        client,
        params.appointmentId,
        params.phone
      );
      if (existing.status === "cancelled") {
        throw new BookingError("Запись уже отменена");
      }

      const { rows } = await client.query(
        `UPDATE appointments
         SET status = 'cancelled', updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [params.appointmentId]
      );
      const row = mapAppointment(rows[0]);
      const enriched = await this.enrich(row, client);
      const doc = await this.getDoctor(enriched.doctor_id);
      return { updated: enriched, doctor: doc };
    });

    if (doctor) {
      await this.syncCancel(updated, doctor);
    }
    return updated;
  }

  async rescheduleAppointment(params: {
    appointmentId: number;
    phone: string;
    date: string;
    time: string;
  }): Promise<Appointment> {
    try {
      const { updated, doctor, service } = await withTransaction(
        async (client) => {
          const existing = await this.lockAppointment(
            client,
            params.appointmentId,
            params.phone
          );
          if (existing.status === "cancelled") {
            throw new BookingError("Нельзя перенести отменённую запись");
          }

          const serviceRow = await this.getService(existing.service_id);
          if (!serviceRow) throw new BookingError("Услуга не найдена");

          const availability = await this.findSlots({
            doctorId: existing.doctor_id,
            date: params.date,
            serviceId: existing.service_id,
          });
          const filteredSlots = availability.slots;
          if (!filteredSlots.includes(params.time)) {
            const hours = await this.getHoursForDate(params.date);
            const dayStart = slotToRange({
              dateStr: params.date,
              timeStr: "00:00",
              durationMinutes: 24 * 60,
              timeZone: CLINIC.timezone,
            });
            const { rows: busyRows } = await client.query(
              `SELECT starts_at, ends_at FROM appointments
               WHERE doctor_id = $1
                 AND status IN ('booked', 'rescheduled')
                 AND id <> $2
                 AND starts_at < $4
                 AND ends_at > $3`,
              [
                existing.doctor_id,
                existing.id,
                dayStart.startsAt,
                dayStart.endsAt,
              ]
            );
            const slots = generateSlots({
              dateStr: params.date,
              durationMinutes: serviceRow.duration_minutes,
              hours,
              busy: busyRows.map((r) => ({
                starts_at: new Date(r.starts_at),
                ends_at: new Date(r.ends_at),
              })),
              timeZone: CLINIC.timezone,
            });
            if (!slots.includes(params.time)) {
              throw new BookingError(
                `Время ${params.time} недоступно. Свободно: ${slots.join(", ") || "нет слотов"}`
              );
            }
          }

          const { startsAt, endsAt } = slotToRange({
            dateStr: params.date,
            timeStr: params.time,
            durationMinutes: serviceRow.duration_minutes,
            timeZone: CLINIC.timezone,
          });

          const { rows } = await client.query(
            `UPDATE appointments
             SET starts_at = $1, ends_at = $2, status = 'rescheduled', updated_at = NOW()
             WHERE id = $3
             RETURNING *`,
            [startsAt, endsAt, existing.id]
          );
          const enriched = await this.enrich(mapAppointment(rows[0]), client);
          const doc = await this.getDoctor(enriched.doctor_id);
          return { updated: enriched, doctor: doc, service: serviceRow };
        }
      );

      if (doctor) {
        await this.syncUpdate(updated, doctor, service);
      }
      return updated;
    } catch (err: unknown) {
      if (isExclusionViolation(err)) {
        throw new BookingError(
          "Это время только что заняли. Выберите другой слот."
        );
      }
      throw err;
    }
  }

  private async lockAppointment(
    client: PoolClient,
    appointmentId: number,
    phone: string
  ): Promise<Appointment> {
    const { rows } = await client.query(
      `SELECT * FROM appointments WHERE id = $1 FOR UPDATE`,
      [appointmentId]
    );
    if (!rows[0]) throw new BookingError("Запись не найдена");
    const appt = mapAppointment(rows[0]);
    if (appt.phone !== normalizePhone(phone)) {
      throw new BookingError("Запись принадлежит другому номеру");
    }
    return appt;
  }

  private async enrich(
    appointment: Appointment,
    queryable: PoolClient | typeof pool = pool
  ): Promise<Appointment> {
    const { rows } = await queryable.query(
      `SELECT a.*, d.full_name AS doctor_name, s.name AS service_name
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       JOIN services s ON s.id = a.service_id
       WHERE a.id = $1`,
      [appointment.id]
    );
    return mapAppointment(rows[0] ?? appointment);
  }

  private async syncCreate(appointment: Appointment, doctor: Doctor) {
    const calendarId = resolveCalendarId(doctor.google_calendar_id);
    if (!this.calendar?.enabled || !calendarId) return;
    try {
      const eventId = await this.calendar.createEvent({
        calendarId,
        appointment,
      });
      await pool.query(
        `UPDATE appointments SET google_event_id = $1 WHERE id = $2`,
        [eventId, appointment.id]
      );
      appointment.google_event_id = eventId;
    } catch (err) {
      console.error("Google Calendar create failed", err);
    }
  }

  private async syncUpdate(
    appointment: Appointment,
    doctor: Doctor,
    service: Service
  ) {
    const calendarId = resolveCalendarId(doctor.google_calendar_id);
    if (!this.calendar?.enabled || !calendarId) return;
    try {
      if (appointment.google_event_id) {
        await this.calendar.updateEvent({
          calendarId,
          eventId: appointment.google_event_id,
          appointment: { ...appointment, service_name: service.name },
        });
      } else {
        await this.syncCreate(appointment, doctor);
      }
    } catch (err) {
      console.error("Google Calendar update failed", err);
    }
  }

  private async syncCancel(appointment: Appointment, doctor: Doctor) {
    const calendarId = resolveCalendarId(doctor.google_calendar_id);
    if (
      !this.calendar?.enabled ||
      !calendarId ||
      !appointment.google_event_id
    ) {
      return;
    }
    try {
      await this.calendar.cancelEvent({
        calendarId,
        eventId: appointment.google_event_id,
      });
    } catch (err) {
      console.error("Google Calendar cancel failed", err);
    }
  }

  formatAppointment(a: Appointment): string {
    const date = formatDateInTz(a.starts_at, CLINIC.timezone);
    const time = formatTimeInTz(a.starts_at, CLINIC.timezone);
    return [
      `#${a.id}`,
      a.patient_name,
      a.doctor_name ?? `doctor#${a.doctor_id}`,
      a.service_name ?? `service#${a.service_id}`,
      `${date} ${time}`,
      a.status,
    ].join(" | ");
  }
}

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("8") && digits.length === 11) {
    return `7${digits.slice(1)}`;
  }
  return digits;
}

function isExclusionViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23P01"
  );
}
