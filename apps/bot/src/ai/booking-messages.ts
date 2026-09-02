import { CLINIC } from "../config/hours.js";
import { formatDateInTz, formatTimeInTz } from "../booking/slots.js";
import { doctorNameInDative } from "./doctor-names.js";

const MONTHS_GENITIVE = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
] as const;

export function formatDateHumanRu(isoDate: string): string {
  const [, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MONTHS_GENITIVE[month - 1]}`;
}

export function formatBookingConfirmation(params: {
  doctorName: string;
  date: string;
  time: string;
}): string {
  const doctor = doctorNameInDative(params.doctorName);
  const dateHuman = formatDateHumanRu(params.date);
  const addressLine = CLINIC.address
    ? `\n\nБудем ждать вас по адресу ${CLINIC.address}`
    : "";

  return `Вы успешно записаны на консультацию к ${doctor}, ${dateHuman} в ${params.time}.${addressLine}

Если у вас возникнут вопросы или понадобится помощь, не стесняйтесь обращаться! Ждем вас в нашей клинике! 🦷✨`;
}

export function formatRescheduleConfirmation(params: {
  doctorName: string;
  date: string;
  time: string;
}): string {
  const doctor = doctorNameInDative(params.doctorName);
  const dateHuman = formatDateHumanRu(params.date);
  const addressLine = CLINIC.address
    ? `\n\nБудем ждать вас по адресу ${CLINIC.address}`
    : "";

  return `Готово! 😊

Перенесли вашу запись к ${doctor} на ${dateHuman} в ${params.time}.${addressLine}

Если понадобится помощь — просто напишите нам!`;
}

export function formatAppointmentLookupReply(
  appointments: {
    doctor_name?: string;
    starts_at: Date;
  }[],
  targetDate?: string | null
): string {
  if (!appointments.length) {
    if (targetDate) {
      return `Посмотрел расписание — на ${formatDateHumanRu(targetDate)} активных записей не нашёл 🤔

Могу помочь записаться на удобное время — напишите, когда вам удобно!`;
    }
    return `Сейчас у вас нет предстоящих записей.

Если хотите — с радостью подберём удобное время! 😊`;
  }

  if (appointments.length === 1) {
    const a = appointments[0];
    const date = formatDateInTz(a.starts_at, CLINIC.timezone);
    const time = formatTimeInTz(a.starts_at, CLINIC.timezone);
    const doctor = doctorNameInDative(a.doctor_name ?? "врачу");
    const dateHuman = formatDateHumanRu(date);
    const addressLine = CLINIC.address
      ? `\n\nЖдём вас по адресу: ${CLINIC.address}`
      : "";

    return `Конечно, нашёл! 😊

Вы записаны к ${doctor}, ${dateHuman} в ${time}.${addressLine}

Если нужно перенести или отменить — напишите, с удовольствием поможем!`;
  }

  const lines = appointments.map((a) => {
    const date = formatDateInTz(a.starts_at, CLINIC.timezone);
    const time = formatTimeInTz(a.starts_at, CLINIC.timezone);
    const doctor = doctorNameInDative(a.doctor_name ?? "врачу");
    return `• ${formatDateHumanRu(date)} в ${time} — к ${doctor}`;
  });
  return `Вот ваши предстоящие записи 😊

${lines.join("\n")}

Если нужно что-то изменить — напишите, поможем!`;
}
