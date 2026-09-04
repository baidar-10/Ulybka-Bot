import type { PoolClient } from "pg";
import { CLINIC } from "../config/hours.js";
import { pool, withTransaction } from "../db/pool.js";
import { getKnownPatient, upsertKnownPatient } from "../db/patients.js";
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
import type { MacdentSchedule } from "../macdent/schedule.js";
import { MacdentError } from "../macdent/client.js";
import { formatPatientFio } from "../macdent/parse.js";
import {
  applyProcedureSlotPolicy,
  applySameDaySlotPolicy,
  earliestBookableDateIso,
  isDateBookable,
  isProcedureSlotAllowed,
  isSlotTimeAllowed,
} from "./policy.js";
import { normalizePhone } from "./phone.js";
import {
  getProcedure,
  matchProcedureFromText,
  servicePatternsForProcedure,
  type ProcedureType,
} from "./procedures.js";

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
    macdent_zapis_id: row.macdent_zapis_id
      ? String(row.macdent_zapis_id)
      : null,
    doctor_name: row.doctor_name ? String(row.doctor_name) : undefined,
    service_name: row.service_name ? String(row.service_name) : undefined,
  };
}

export class BookingService {
  constructor(private readonly macdent?: MacdentSchedule) {}

  async listDoctors(): Promise<Doctor[]> {
    const { rows } = await pool.query(
      `SELECT id, full_name, specialization, color, macdent_id, active
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
      `SELECT id, full_name, specialization, color, macdent_id, active
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

  async resolveService(doctorId: number, serviceId?: number): Promise<Service> {
    if (serviceId != null) {
      const service = await this.getService(serviceId);
      if (
        service?.active &&
        (service.doctor_id == null || service.doctor_id === doctorId)
      ) {
        return service;
      }
    }
    const list = await this.listServices(doctorId);
    const consult = list.find((s) => /консульт/i.test(s.name));
    if (consult) return consult;
    if (list[0]) return list[0];
    throw new BookingError("У этого врача нет услуг в каталоге");
  }

  private async resolveServiceForProcedure(
    doctorId: number,
    procedure: ProcedureType
  ): Promise<Service> {
    const patterns = servicePatternsForProcedure(procedure);
    const list = await this.listServices(doctorId);
    for (const pattern of patterns) {
      const match = list.find((s) => pattern.test(s.name));
      if (match) return match;
    }
    return this.resolveService(doctorId);
  }

  private async resolveBookingContext(params: {
    doctorId: number;
    serviceId?: number;
    procedureType?: string;
    visitReason?: string;
  }): Promise<{
    service: Service;
    durationMinutes: number;
    procedure: ProcedureType | null;
    reasonForVisit: string;
  }> {
    let procedure = params.procedureType
      ? getProcedure(params.procedureType)
      : null;
    if (params.procedureType && !procedure) {
      throw new BookingError("Неизвестный тип процедуры");
    }

    // Причина визита важнее ошибочного procedure_type=consultation:
    // длительность и отсечение по 19:00 берутся из реальной процедуры.
    const fromReason = params.visitReason?.trim()
      ? matchProcedureFromText(params.visitReason)
      : null;
    if (
      fromReason &&
      (!procedure ||
        (procedure.id === "consultation" && fromReason.id !== "consultation"))
    ) {
      procedure = fromReason;
    }

    const service = procedure
      ? await this.resolveServiceForProcedure(params.doctorId, procedure)
      : await this.resolveService(params.doctorId, params.serviceId);

    const durationMinutes = procedure?.durationMinutes ?? service.duration_minutes;
    const reasonForVisit =
      params.visitReason?.trim() || procedure?.label || service.name;

    return { service, durationMinutes, procedure, reasonForVisit };
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
    serviceId?: number;
    procedureType?: string;
    visitReason?: string;
  }): Promise<{
    date: string;
    doctor: string;
    service: string;
    procedure_type: string | null;
    procedure_label: string | null;
    visit_reason: string | null;
    duration_minutes: number;
    slots: string[];
    timezone: string;
  }> {
    const doctor = await this.getDoctor(params.doctorId);
    if (!doctor || !doctor.active) {
      throw new BookingError("Врач не найден или неактивен");
    }
    if (!isDateBookable(params.date)) {
      throw new BookingError(
        `Запись возможна начиная с ${earliestBookableDateIso()}`
      );
    }
    const ctx = await this.resolveBookingContext({
      doctorId: params.doctorId,
      serviceId: params.serviceId,
      procedureType: params.procedureType,
      visitReason: params.visitReason,
    });
    const { service, durationMinutes, procedure, reasonForVisit } = ctx;

    const hours = await this.getHoursForDate(params.date);
    const dayStart = slotToRange({
      dateStr: params.date,
      timeStr: "00:00",
      durationMinutes: 24 * 60,
      timeZone: CLINIC.timezone,
    });

    let slots: string[];
    if (this.macdent?.enabled) {
      const macdentDoctorId = await this.resolveMacdentDoctorId(doctor);
      const day = await this.macdent.getDayAvailability(
        macdentDoctorId,
        params.date,
        durationMinutes,
        hours
          ? { open_time: String(hours.open_time).slice(0, 5), close_time: String(hours.close_time).slice(0, 5) }
          : null
      );
      console.log(
        `MacDent day slots doctor=${macdentDoctorId} date=${params.date} duration=${durationMinutes} slots=${day.slots.join(",") || "(empty)"}`
      );
      slots = day.slots.filter((t) => {
        try {
          const { startsAt } = slotToRange({
            dateStr: params.date,
            timeStr: t,
            durationMinutes,
            timeZone: CLINIC.timezone,
          });
          return startsAt > new Date();
        } catch {
          return false;
        }
      });
    } else {
      const { rows } = await pool.query(
        `SELECT starts_at, ends_at FROM appointments
         WHERE doctor_id = $1
           AND status IN ('booked', 'rescheduled')
           AND starts_at < $3
           AND ends_at > $2`,
        [params.doctorId, dayStart.startsAt, dayStart.endsAt]
      );

      slots = generateSlots({
        dateStr: params.date,
        durationMinutes,
        hours,
        busy: rows.map((r) => ({
          starts_at: new Date(r.starts_at),
          ends_at: new Date(r.ends_at),
        })),
        timeZone: CLINIC.timezone,
      });
    }

    slots = applySameDaySlotPolicy(slots, params.date);
    slots = applyProcedureSlotPolicy(
      slots,
      durationMinutes,
      procedure?.latestEndTime
    );

    return {
      date: params.date,
      doctor: doctor.full_name,
      service: reasonForVisit,
      procedure_type: procedure?.id ?? null,
      procedure_label: procedure?.label ?? null,
      visit_reason: reasonForVisit,
      duration_minutes: durationMinutes,
      slots,
      timezone: CLINIC.timezone,
    };
  }

  async bookAppointment(params: {
    patientName: string;
    phone: string;
    doctorId: number;
    serviceId?: number;
    procedureType?: string;
    visitReason?: string;
    date: string;
    time: string;
    comment?: string;
  }): Promise<Appointment> {
    const doctor = await this.getDoctor(params.doctorId);
    if (!doctor?.active) throw new BookingError("Врач не найден");
    const ctx = await this.resolveBookingContext({
      doctorId: params.doctorId,
      serviceId: params.serviceId,
      procedureType: params.procedureType,
      visitReason: params.visitReason ?? params.comment,
    });
    const { service, durationMinutes, procedure, reasonForVisit } = ctx;
    const visitReason = params.comment?.trim() || reasonForVisit;

    if (!this.macdent?.enabled) {
      const hours = await this.getHoursForDate(params.date);
      if (!hours) throw new BookingError("Клиника закрыта в этот день");
    }

    if (!isDateBookable(params.date)) {
      throw new BookingError(
        `Запись возможна начиная с ${earliestBookableDateIso()}`
      );
    }

    if (!isSlotTimeAllowed(params.date, params.time)) {
      throw new BookingError(
        `До 12:00 запись на сегодня возможна только с 16:00`
      );
    }

    const { startsAt, endsAt } = slotToRange({
      dateStr: params.date,
      timeStr: params.time,
      durationMinutes,
      timeZone: CLINIC.timezone,
    });

    if (startsAt <= new Date()) {
      throw new BookingError("Нельзя записаться на прошедшее время");
    }

    if (
      !isProcedureSlotAllowed(
        params.time,
        durationMinutes,
        procedure?.latestEndTime
      )
    ) {
      throw new BookingError(
        `На ${params.time} записаться нельзя. Выберите другое время.`
      );
    }

    const patientFio = formatPatientFio(
      params.patientName ||
        (await getKnownPatient(params.phone))?.patient_name ||
        ""
    );
    if (patientFio.split(" ").length < 2) {
      throw new BookingError(
        "Подскажите, пожалуйста, фамилию и имя — чтобы оформить запись"
      );
    }

    // Verify chosen time is within generated free slots
    const availability = await this.findSlots({
      doctorId: params.doctorId,
      date: params.date,
      serviceId: service.id,
      procedureType: params.procedureType,
      visitReason: visitReason,
    });
    if (!availability.slots.includes(params.time)) {
      throw new BookingError(
        `К сожалению, на ${params.time} уже нельзя записаться — это время заняли. Подскажите другой день или время?`
      );
    }

    try {
      let macdentZapisId: string | null = null;
      let macdentPatientId: string | null = null;
      if (this.macdent?.enabled) {
        try {
          const macdentDoctorId = await this.resolveMacdentDoctorId(doctor);
          const known = await getKnownPatient(params.phone);
          macdentPatientId = await this.macdent.ensurePatient(
            patientFio,
            normalizePhone(params.phone),
            known?.macdent_patient_id
          );
          const day = await this.macdent.getDayAvailability(
            macdentDoctorId,
            params.date,
            durationMinutes
          );
          macdentZapisId = await this.macdent.addZapis({
            doctorId: macdentDoctorId,
            patientId: macdentPatientId,
            date: params.date,
            time: params.time,
            durationMinutes,
            raspId: day.raspId,
            comment: visitReason,
          });
        } catch (err) {
          const message =
            err instanceof MacdentError ? err.message : "не удалось создать запись в MacDent";
          throw new BookingError(`MacDent: ${message}`);
        }
      }

      const appointment = await withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO appointments
             (patient_name, phone, doctor_id, service_id, starts_at, ends_at, status, comment, source, macdent_zapis_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'booked', $7, 'whatsapp_ai', $8)
           RETURNING *`,
          [
            patientFio,
            normalizePhone(params.phone),
            params.doctorId,
            service.id,
            startsAt,
            endsAt,
            visitReason,
            macdentZapisId,
          ]
        );
        return mapAppointment(rows[0]);
      });

      await upsertKnownPatient({
        phone: params.phone,
        patientName: patientFio,
        macdentPatientId: macdentPatientId,
      });

      return this.enrich(appointment);
    } catch (err: unknown) {
      if (isExclusionViolation(err)) {
        throw new BookingError(
          "Это время только что заняли. Выберите другое время."
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
    const { updated } = await withTransaction(async (client) => {
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
      return { updated: enriched };
    });

    if (this.macdent?.enabled && updated.macdent_zapis_id) {
      try {
        await this.macdent.removeZapis(updated.macdent_zapis_id);
      } catch (err) {
        console.error("MacDent zapis.remove failed", err);
      }
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
      const { updated, durationMinutes } = await withTransaction(
        async (client) => {
          const existing = await this.lockAppointment(
            client,
            params.appointmentId,
            params.phone
          );
          if (existing.status === "cancelled") {
            throw new BookingError("Нельзя перенести отменённую запись");
          }

          if (!isDateBookable(params.date)) {
            throw new BookingError(
              `Запись возможна начиная с ${earliestBookableDateIso()}`
            );
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
                `К сожалению, на ${params.time} уже нельзя записаться — это время заняли. Подскажите другой день или время?`
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
          const hoursUntil =
            (startsAt.getTime() - Date.now()) / (1000 * 60 * 60);
          if (hoursUntil > 25) {
            await client.query(
              `UPDATE appointments
               SET reminder_24h_sent_at = NULL,
                   reminder_2h_sent_at = NULL,
                   updated_at = NOW()
               WHERE id = $1`,
              [existing.id]
            );
          } else {
            await client.query(
              `UPDATE appointments
               SET reminder_2h_sent_at = NULL,
                   updated_at = NOW()
               WHERE id = $1`,
              [existing.id]
            );
          }
          return { updated: enriched, durationMinutes: serviceRow.duration_minutes };
        }
      );

      if (this.macdent?.enabled) {
        try {
          const date = formatDateInTz(updated.starts_at, CLINIC.timezone);
          const time = formatTimeInTz(updated.starts_at, CLINIC.timezone);
          if (updated.macdent_zapis_id) {
            await this.macdent.updateZapis({
              zapisId: updated.macdent_zapis_id,
              date,
              time,
              durationMinutes,
            });
          } else {
            const doctor = await this.getDoctor(updated.doctor_id);
            if (doctor) {
              const macdentDoctorId = await this.resolveMacdentDoctorId(doctor);
              const patientId = await this.macdent.ensurePatient(
                updated.patient_name,
                updated.phone
              );
              const day = await this.macdent.getDayAvailability(
                macdentDoctorId,
                date,
                durationMinutes
              );
              const zapisId = await this.macdent.addZapis({
                doctorId: macdentDoctorId,
                patientId,
                date,
                time,
                durationMinutes,
                raspId: day.raspId,
                comment: updated.service_name,
              });
              await pool.query(
                `UPDATE appointments SET macdent_zapis_id = $1 WHERE id = $2`,
                [zapisId, updated.id]
              );
              updated.macdent_zapis_id = zapisId;
            }
          }
        } catch (err) {
          console.error("MacDent zapis.update failed", err);
        }
      }

      return updated;
    } catch (err: unknown) {
      if (isExclusionViolation(err)) {
        throw new BookingError(
          "Это время только что заняли. Выберите другое время."
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

  private async resolveMacdentDoctorId(doctor: Doctor): Promise<string> {
    if (!this.macdent?.enabled) {
      throw new BookingError("MacDent не подключен");
    }
    if (doctor.macdent_id) return doctor.macdent_id;
    const found = await this.macdent.findDoctorId(doctor.full_name);
    if (!found) {
      throw new BookingError(
        `Врач «${doctor.full_name}» не найден в MacDent`
      );
    }
    await pool.query(`UPDATE doctors SET macdent_id = $1 WHERE id = $2`, [
      found,
      doctor.id,
    ]);
    doctor.macdent_id = found;
    return found;
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

export { normalizePhone } from "./phone.js";

function isExclusionViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23P01"
  );
}
