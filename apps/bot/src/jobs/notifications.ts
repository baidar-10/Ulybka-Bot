import { pool } from "../db/pool.js";
import { CLINIC } from "../config/hours.js";
import { formatDateInTz, formatTimeInTz } from "../booking/slots.js";
import { doctorDisplayName } from "../macdent/parse.js";
import type { Appointment } from "../db/types.js";

function formatDateDotted(date: Date, timeZone: string): string {
  const iso = formatDateInTz(date, timeZone);
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function mapRow(row: Record<string, unknown>): Appointment {
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

const APPT_SELECT = `
  SELECT a.*, d.full_name AS doctor_name, s.name AS service_name
  FROM appointments a
  JOIN doctors d ON d.id = a.doctor_id
  JOIN services s ON s.id = a.service_id
`;

export async function findAppointmentsFor24hReminder(): Promise<Appointment[]> {
  const { rows } = await pool.query(
    `${APPT_SELECT}
     WHERE a.status IN ('booked', 'rescheduled')
       AND a.reminder_24h_sent_at IS NULL
       AND a.starts_at > NOW()
       AND a.starts_at <= NOW() + INTERVAL '24 hours 5 minutes'
       AND a.starts_at > NOW() + INTERVAL '23 hours 55 minutes'`
  );
  return rows.map(mapRow);
}

export async function findAppointmentsFor2hReminder(): Promise<Appointment[]> {
  const { rows } = await pool.query(
    `${APPT_SELECT}
     WHERE a.status IN ('booked', 'rescheduled')
       AND a.reminder_2h_sent_at IS NULL
       AND a.starts_at > NOW()
       AND a.starts_at <= NOW() + INTERVAL '2 hours 5 minutes'
       AND a.starts_at > NOW() + INTERVAL '1 hour 55 minutes'`
  );
  return rows.map(mapRow);
}

export async function findAppointmentsForFollowup(): Promise<Appointment[]> {
  const { rows } = await pool.query(
    `${APPT_SELECT}
     WHERE a.status IN ('booked', 'rescheduled')
       AND a.followup_sent_at IS NULL
       AND a.ends_at <= NOW() - INTERVAL '23 hours 55 minutes'
       AND a.ends_at > NOW() - INTERVAL '24 hours 5 minutes'`
  );
  return rows.map(mapRow);
}

export async function markReminder24hSent(id: number): Promise<void> {
  await pool.query(
    `UPDATE appointments SET reminder_24h_sent_at = NOW() WHERE id = $1`,
    [id]
  );
}

export async function markReminder2hSent(id: number): Promise<void> {
  await pool.query(
    `UPDATE appointments SET reminder_2h_sent_at = NOW() WHERE id = $1`,
    [id]
  );
}

export async function markFollowupSent(id: number): Promise<void> {
  await pool.query(
    `UPDATE appointments SET followup_sent_at = NOW() WHERE id = $1`,
    [id]
  );
}

export async function resetReminderFlags(id: number): Promise<void> {
  await pool.query(
    `UPDATE appointments
     SET reminder_24h_sent_at = NULL,
         reminder_2h_sent_at = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [id]
  );
}

export function formatReminder24h(appt: Appointment): string {
  const date = formatDateDotted(appt.starts_at, CLINIC.timezone);
  const time = formatTimeInTz(appt.starts_at, CLINIC.timezone);
  const doctor = appt.doctor_name
    ? doctorDisplayName(appt.doctor_name)
    : "—";
  return `Напоминаем, что завтра у вас приём в клинике «${CLINIC.name}» 💚

📅 ${date} в ${time}
👩‍⚕️ Врач: ${doctor}
🦷 Услуга: ${appt.service_name ?? "—"}

Будем рады видеть вас! Если нужно перенести или отменить — просто напишите нам.`;
}

export function formatReminder2h(appt: Appointment): string {
  const time = formatTimeInTz(appt.starts_at, CLINIC.timezone);
  const doctor = appt.doctor_name
    ? doctorDisplayName(appt.doctor_name)
    : "—";
  const address = CLINIC.address
    ? `\n\nЖдём вас по адресу: ${CLINIC.address}`
    : "";
  return `Через 2 часа у вас приём в клинике «${CLINIC.name}» 💚

Сегодня в ${time}
Врач: ${doctor}${address}`;
}

export function formatFollowup(appt: Appointment): string {
  const date = formatDateInTz(appt.starts_at, CLINIC.timezone);
  return `Здравствуйте! ${date} вы были у нас в клинике «${CLINIC.name}».
Как всё прошло? Если есть вопросы или нужна повторная запись — напишите, мы поможем.`;
}
