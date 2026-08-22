import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { env } from "../config/env.js";
import { CLINIC } from "../config/hours.js";
import {
  BookingError,
  BookingService,
  normalizePhone,
} from "../booking/service.js";
import {
  loadConversation,
  saveConversation,
} from "../db/conversations.js";
import type { ConversationMessage } from "../db/types.js";
import { doctorDisplayName, nameTokens, normalizeName } from "../macdent/parse.js";
import { formatDateInTz, formatTimeInTz, nextIsoDateForWeekday } from "../booking/slots.js";

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_doctors",
      description:
        "Список всех врачей. Перед вопросом «какой врач» вызови этот метод и перечисли пациенту ВСЕХ из ответа, никого не пропускай.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_services",
      description:
        "Список услуг врача. Вызывай только для сопоставления выбранной услуги с id. Не выводи пациенту весь список целиком.",
      parameters: {
        type: "object",
        properties: {
          doctor_id: { type: "integer", description: "ID врача (опционально)" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_slots",
      description:
        "Проверка свободного времени врача на дату. После ответа предложи пациенту ОДНО время из suggested. Не перечисляй список слотов.",
      parameters: {
        type: "object",
        properties: {
          doctor_id: { type: "integer" },
          service_id: { type: "integer" },
          date: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["doctor_id", "date"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Создать запись. Вызывать ТОЛЬКО после явного подтверждения пациентом (да/подтверждаю), когда известны фамилия имя отчество, врач, услуга, дата и время.",
      parameters: {
        type: "object",
        properties: {
          patient_name: {
            type: "string",
            description: "Фамилия Имя Отчество пациента, как в документе",
          },
          doctor_id: { type: "integer" },
          service_id: { type: "integer" },
          date: { type: "string", description: "YYYY-MM-DD" },
          time: { type: "string", description: "HH:MM" },
          comment: { type: "string" },
        },
        required: [
          "patient_name",
          "doctor_id",
          "service_id",
          "date",
          "time",
        ],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_patient_appointments",
      description: "Список будущих записей текущего пациента",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reschedule_appointment",
      description:
        "Перенести запись. Вызывать только когда пациент согласился на конкретное время. Не предлагай перенос сам и не показывай список слотов.",
      parameters: {
        type: "object",
        properties: {
          appointment_id: { type: "integer" },
          date: { type: "string" },
          time: { type: "string" },
        },
        required: ["appointment_id", "date", "time"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_appointment",
      description: "Отменить запись пациента",
      parameters: {
        type: "object",
        properties: {
          appointment_id: { type: "integer" },
        },
        required: ["appointment_id"],
        additionalProperties: false,
      },
    },
  },
];

function systemPrompt(): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const weekday = new Intl.DateTimeFormat("ru-RU", {
    timeZone: CLINIC.timezone,
    weekday: "long",
  }).format(new Date());

  const upcoming = [
    `понедельник ${nextIsoDateForWeekday(1, CLINIC.timezone)}`,
    `вторник ${nextIsoDateForWeekday(2, CLINIC.timezone)}`,
    `среда ${nextIsoDateForWeekday(3, CLINIC.timezone)}`,
    `четверг ${nextIsoDateForWeekday(4, CLINIC.timezone)}`,
    `пятница ${nextIsoDateForWeekday(5, CLINIC.timezone)}`,
    `суббота ${nextIsoDateForWeekday(6, CLINIC.timezone)}`,
    `воскресенье ${nextIsoDateForWeekday(0, CLINIC.timezone)}`,
  ].join(", ");

  return `Ты — администратор записи клиники «${CLINIC.name}» в WhatsApp.
Цель: быстро записать на приём. Без лекций и без прайса.

Сегодня: ${today} (${weekday}), ${CLINIC.timezone}
Ближайшие дни (для find_slots.date): ${upcoming}
Часы: Пн–Пт 10:00–20:00, Сб–Вс 10:00–14:00

Врачи — ВСЕГДА все трое:
1) Абдикаримова Асель — ортодонт, терапевт
2) Абдикаримов Ержан — терапевт, хирург, ортопед
3) Масенов Ансар — терапевт, хирург, ортопед
Нельзя предлагать только двоих.

Направление:
- брекеты, элайнеры, прикус, ортодонтия → Асель
- удаление, имплант, хирургия, протез, коронка, ортопедия → Ержан или Ансар
- кариес, каналы, чистка, боль, консультация терапевта → любой из троих (Асель тоже терапевт)

=== Порядок записи (строго, не прыгай через шаги) ===
1) Пока врач не выбран — ТОЛЬКО список всех врачей и вопрос «К кому записать?». Не спрашивай дату. Не вызывай find_slots.
2) Врач выбран — тогда: «На какую дату вам будет удобно назначить запись?»
3) Дата есть — вызови find_slots. Если пациент уже назвал время — смотри requested_free.
   Свободно: «Вам подойдёт в {это время}?»
   Занято: «{время} занято. Вам подойдёт в {suggested}?» suggested — ближайшее к запросу, не первое утро, если вечером занято.
   Не показывай список. Не пиши «перенос» на новую запись.
   Если «да» и в ФИО только фамилия и имя — сначала отчество, потом подтверждение. book_appointment только с тремя словами.

Запрещено нумеровать слоты (1) 10:00 2) 10:30 …). Запрещено писать «подтверждаете перенос», если это новая запись.

«Консультация» без имени врача = шаг 1, не слоты Асель и не вопрос про дату.

Дальше Фамилия Имя Отчество → подтверждение → book_appointment.

Перенос существующей записи: find_slots, предложи одно время так же («Вам подойдёт в …?»), не список.
WhatsApp: без markdown. Телефон не спрашивай.
«сброс» = новый диалог.`;
}

const CLINIC_GREETING = `Здравствуйте! 😊
Вас приветствует стоматологическая клиника «${CLINIC.name}».
Чем мы можем вам помочь?`;

function stripRepeatedGreeting(text: string): string {
  const stripped = text
    .replace(/^здравствуйте[^\n]*\n+/i, "")
    .replace(/^вас приветствует стоматологическая клиника[^\n]*\n+/i, "")
    .replace(/^чем мы можем вам помочь[^\n?]*\??\s*/i, "")
    .trim();
  return stripped || text;
}

function stripWhatsAppMarkdown(text: string): string {
  let out = text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^[*-]\s+/gm, "")
    .replace(/`+/g, "");
  const slotLines = out.match(/^\s*\d+[).]\s*\d{1,2}:\d{2}\s*$/gm);
  if (slotLines && slotLines.length >= 3) {
    const first = slotLines[0].match(/(\d{1,2}:\d{2})/)?.[1];
    if (first) {
      out = out
        .replace(/^\s*\d+[).]\s*\d{1,2}:\d{2}\s*$/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (!/подойд/i.test(out)) {
        out = `Вам подойдёт в ${first}?`;
      }
    }
  }
  return out.trim();
}

function hasClinicGreeting(history: ConversationMessage[]): boolean {
  return history.some(
    (m) =>
      m.role === "assistant" &&
      /приветствует стоматологическая клиника/i.test(m.content || "")
  );
}

function parsePreferredTime(text: string): string | null {
  const colon = text.match(/\b(\d{1,2})[:.](\d{2})\b/);
  if (colon) {
    const h = Number(colon[1]);
    const m = Number(colon[2]);
    if (h <= 23 && m <= 59) {
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
  }
  const hourOnly = text.match(/(?:^|в|на)\s*(\d{1,2})\s*(?:час(?:а|ов)?|утра|дня|вечера)?\s*$/i)
    || text.match(/\b(?:в|на)\s+(\d{1,2})\b/i);
  if (hourOnly) {
    const h = Number(hourOnly[1]);
    if (h >= 8 && h <= 21) return `${String(h).padStart(2, "0")}:00`;
  }
  return null;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function pickSuggestedSlot(
  slots: string[],
  preferred: string | null
): { suggested: string | null; requested: string | null; requested_free: boolean | null } {
  if (!slots.length) {
    return { suggested: null, requested: preferred, requested_free: preferred ? false : null };
  }
  if (preferred && slots.includes(preferred)) {
    return { suggested: preferred, requested: preferred, requested_free: true };
  }
  if (preferred) {
    const p = timeToMinutes(preferred);
    const suggested = slots.reduce((best, t) =>
      Math.abs(timeToMinutes(t) - p) < Math.abs(timeToMinutes(best) - p) ? t : best
    );
    return { suggested, requested: preferred, requested_free: false };
  }
  return { suggested: slots[0], requested: null, requested_free: null };
}

function lastFindSlotsPayload(history: ConversationMessage[]): {
  slots: string[];
  date?: string;
  doctor?: string;
} | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "tool" || m.name !== "find_slots" || !m.content) continue;
    try {
      const json = JSON.parse(m.content) as {
        slots?: string[];
        date?: string;
        doctor?: string;
      };
      if (Array.isArray(json.slots)) {
        return { slots: json.slots, date: json.date, doctor: json.doctor };
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

function isTwoWordFio(text: string): boolean {
  if (/\d/.test(text)) return false;
  if (/да|нет|запис|консульт|подойд|сред|вторник|понедельник|врач|время|отмен/i.test(text)) {
    return false;
  }
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return (
    parts.length === 2 &&
    parts.every((w) => /^[A-Za-zА-Яа-яЁёІіҰұҚқҒғӨөҺһ-]+$/.test(w))
  );
}

function isOneWordPatronymic(text: string): boolean {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return (
    parts.length === 1 &&
    !/\d/.test(text) &&
    /^[A-Za-zА-Яа-яЁёІіҰұҚқҒғӨөҺһ-]+$/.test(parts[0]) &&
    !/^(да|нет|ок|хорошо)$/i.test(parts[0])
  );
}

function replyForRequestedTime(
  preferred: string,
  slots: string[]
): string {
  const pick = pickSuggestedSlot(slots, preferred);
  if (pick.requested_free) {
    return `В ${preferred} свободно. Вам подойдёт в ${preferred}?`;
  }
  if (pick.suggested) {
    return `${preferred} занято. Вам подойдёт в ${pick.suggested}?`;
  }
  return `${preferred} занято, на этот день свободных окон нет.`;
}

function textMentionsDoctor(
  text: string,
  doctors: { full_name: string }[]
): boolean {
  const n = normalizeName(text);
  return doctors.some((d) => {
    const tokens = nameTokens(d.full_name).filter((t) => t.length >= 4);
    return tokens.some((t) => n.includes(t));
  });
}

function historyHasChosenDoctor(
  history: ConversationMessage[],
  doctors: { full_name: string }[]
): boolean {
  const named = history.some(
    (m) => m.role === "user" && m.content && textMentionsDoctor(m.content, doctors)
  );
  if (named) return true;
  const listed = history.some(
    (m) => m.role === "assistant" && m.content && /к какому врачу/i.test(m.content)
  );
  if (!listed) return false;
  return history.some((m) => m.role === "user" && m.content && /^[123]$/.test(m.content.trim()));
}

function formatDoctorChoice(
  doctors: { full_name: string; specialization: string }[]
): string {
  const lines = doctors.map(
    (d, i) => `${i + 1}) ${doctorDisplayName(d.full_name)} — ${d.specialization}`
  );
  return `К какому врачу записать на консультацию?\n${lines.join("\n")}`;
}

function wantsNewBooking(text: string): boolean {
  if (/отмен|перенес|поменять|попозже|проверить запис/i.test(text)) return false;
  return /запис|консульт|к врачу|какой врач/i.test(text);
}

function looksLikeDateOnly(text: string): boolean {
  return /^(на\s+)?(понедельник|вторник|сред[ауы]?|четверг|пятниц|суббот|воскресень|сегодня|завтра)\b/i.test(
    text.trim()
  );
}

function historyAskedForBooking(history: ConversationMessage[]): boolean {
  return history.some(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      m.content &&
      /запис|консульт/i.test(m.content)
  );
}

export class DialogOrchestrator {
  private readonly openai: OpenAI;

  constructor(private readonly booking: BookingService) {
    this.openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }

  async handleMessage(params: {
    phone: string;
    text: string;
  }): Promise<string> {
    const phone = normalizePhone(params.phone);
    let text = params.text.trim();

    if (!text) {
      return CLINIC_GREETING;
    }

    if (/^(сброс|reset|новый диалог)$/i.test(text)) {
      await saveConversation(phone, [
        { role: "system", content: systemPrompt() },
        { role: "assistant", content: CLINIC_GREETING },
      ]);
      return CLINIC_GREETING;
    }

    let history = await loadConversation(phone);
    const greeted = hasClinicGreeting(history);

    if (
      /^(привет|здравствуйте|здравстуйте|добрый\s+(день|вечер|утро)|hello|hi|hey)[\s!.]*$/i.test(
        text
      )
    ) {
      if (greeted) {
        return stripWhatsAppMarkdown(
          "Чем могу помочь: запись, перенос или отмена?"
        );
      }
      await saveConversation(phone, [
        { role: "system", content: systemPrompt() },
        { role: "user", content: text },
        { role: "assistant", content: CLINIC_GREETING },
      ]);
      return CLINIC_GREETING;
    }

    const doctors = await this.booking.listDoctors();
    const doctorChosen =
      textMentionsDoctor(text, doctors) || historyHasChosenDoctor(history, doctors);
    const mustPickDoctor =
      !doctorChosen &&
      (wantsNewBooking(text) ||
        (looksLikeDateOnly(text) && historyAskedForBooking(history)));

    if (mustPickDoctor) {
      const reply = formatDoctorChoice(doctors);
      if (history.length === 0) {
        history = [{ role: "system", content: systemPrompt() }];
      }
      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: reply });
      await saveConversation(phone, history);
      return reply;
    }

    const lastUser = [...history].reverse().find((m) => m.role === "user" && m.content);
    if (isOneWordPatronymic(text) && lastUser?.content && isTwoWordFio(lastUser.content)) {
      text = `${lastUser.content.trim()} ${text.trim()}`;
    } else if (isTwoWordFio(text)) {
      const reply =
        "Напишите ещё отчество, как в удостоверении (три слова: фамилия, имя, отчество).";
      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: reply });
      await saveConversation(phone, history);
      return reply;
    }

    const askedTime = parsePreferredTime(text);
    const prevSlots = lastFindSlotsPayload(history);
    if (
      askedTime &&
      prevSlots?.slots?.length &&
      !/^(да|хорошо|ок|подойд)/i.test(text.trim())
    ) {
      const reply = replyForRequestedTime(askedTime, prevSlots.slots);
      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: reply });
      await saveConversation(phone, history);
      return reply;
    }

    const isNewDialog =
      !greeted &&
      (history.length === 0 || history.every((m) => m.role === "system"));

    const prompt = greeted
      ? `${systemPrompt()}\n\nВ этом диалоге ты УЖЕ поздоровался. Не пиши «Здравствуйте» и не повторяй шапку клиники.`
      : isNewDialog
        ? `${systemPrompt()}\n\nСейчас ПЕРВОЕ сообщение пациента. Один раз поприветствуй клинику (шаг A), затем сразу продолжай запись.`
        : systemPrompt();

    if (history.length === 0) {
      history.push({ role: "system", content: prompt });
    } else if (history[0]?.role === "system") {
      history[0] = { role: "system", content: prompt };
    } else {
      history = [{ role: "system", content: prompt }, ...history];
    }

    history.push({ role: "user", content: text });

    let messages = toOpenAIMessages(history);
    let finalText = "";

    for (let round = 0; round < 8; round++) {
      const completion = await this.openai.chat.completions.create({
        model: env.OPENAI_MODEL,
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0.2,
      });

      const choice = completion.choices[0]?.message;
      if (!choice) {
        finalText = "Не удалось получить ответ. Попробуйте ещё раз.";
        break;
      }

      if (choice.tool_calls?.length) {
        messages.push({
          role: "assistant",
          content: choice.content,
          tool_calls: choice.tool_calls,
        });
        history.push({
          role: "assistant",
          content: choice.content,
          tool_calls: choice.tool_calls,
        });

        for (const toolCall of choice.tool_calls) {
          if (toolCall.type !== "function") continue;
          const result = await this.executeTool(
            toolCall.function.name,
            toolCall.function.arguments,
            phone,
            text
          );
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
          });
          history.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
            name: toolCall.function.name,
          });
        }
        continue;
      }

      finalText =
        choice.content?.trim() ||
        "Готово. Если нужно что-то ещё — напишите.";
      if (greeted) {
        finalText = stripRepeatedGreeting(finalText);
      }
      history.push({ role: "assistant", content: finalText });
      messages.push({ role: "assistant", content: finalText });
      break;
    }

    if (!finalText) {
      finalText =
        "Извините, не удалось завершить обработку. Напишите ещё раз или «сброс».";
    }

    await saveConversation(phone, history);
    return stripWhatsAppMarkdown(
      greeted ? stripRepeatedGreeting(finalText) : finalText
    );
  }

  private async executeTool(
    name: string,
    argsJson: string,
    phone: string,
    userText: string
  ): Promise<string> {
    try {
      const args = argsJson ? JSON.parse(argsJson) : {};
      console.log(`tool ${name}`, args);
      switch (name) {
        case "list_doctors": {
          const doctors = await this.booking.listDoctors();
          return JSON.stringify(
            doctors.map((d) => ({
              id: d.id,
              full_name: d.full_name,
              name: doctorDisplayName(d.full_name),
              specialization: d.specialization,
            }))
          );
        }
        case "find_slots": {
          const result = await this.booking.findSlots({
            doctorId: Number(args.doctor_id),
            serviceId:
              args.service_id != null ? Number(args.service_id) : undefined,
            date: String(args.date),
          });
          const preferred = parsePreferredTime(userText);
          const pick = pickSuggestedSlot(result.slots, preferred);
          return JSON.stringify({
            ...result,
            ...pick,
            slots: result.slots,
            slots_total: result.slots.length,
            note: pick.requested_free
              ? `Пациент просил ${pick.requested}. Оно свободно. Спроси: «Вам подойдёт в ${pick.suggested}?» Без списка.`
              : pick.requested
                ? `${pick.requested} занято (или не влезает в окно). Предложи ближайшее: «${pick.requested} занято. Вам подойдёт в ${pick.suggested}?» Не предлагай 10:00, если suggested другое.`
                : `Одно время: «Вам подойдёт в ${pick.suggested}?» Без списка слотов.`,
          });
        }
        case "list_services": {
          const services = await this.booking.listServices(
            args.doctor_id != null ? Number(args.doctor_id) : undefined
          );
          // Prefer consultation-like services first for booking funnel
          const ranked = [...services].sort((a, b) => {
            const score = (name: string) =>
              /консульт|осмотр|диагност|гигиен|чистк|air ?flow|кариес/i.test(
                name
              )
                ? 0
                : 1;
            return score(a.name) - score(b.name);
          });
          return JSON.stringify(
            ranked.slice(0, 12).map((s) => ({
              id: s.id,
              name: s.name,
              doctor_id: s.doctor_id,
              doctor_name: s.doctor_name,
              duration_minutes: s.duration_minutes,
            }))
          );
        }
        case "book_appointment": {
          const appt = await this.booking.bookAppointment({
            patientName: String(args.patient_name),
            phone,
            doctorId: Number(args.doctor_id),
            serviceId: Number(args.service_id),
            date: String(args.date),
            time: String(args.time),
            comment: args.comment ? String(args.comment) : undefined,
          });
          return JSON.stringify({
            ok: true,
            appointment: {
              id: appt.id,
              patient_name: appt.patient_name,
              doctor: appt.doctor_name,
              service: appt.service_name,
              starts_at: appt.starts_at.toISOString(),
              ends_at: appt.ends_at.toISOString(),
              status: appt.status,
            },
          });
        }
        case "get_patient_appointments": {
          const list = await this.booking.getPatientAppointments(phone);
          const inMacdent = list.filter((a) => a.macdent_zapis_id);
          const shown = inMacdent.length ? inMacdent : list;
          return JSON.stringify({
            note: "Пациенту называй date и time. Если он говорит про один день — только этот день. Не выдумывай лишние записи.",
            appointments: shown.map((a) => ({
              id: a.id,
              doctor: a.doctor_name,
              service: a.service_name,
              date: formatDateInTz(a.starts_at, CLINIC.timezone),
              time: formatTimeInTz(a.starts_at, CLINIC.timezone),
              in_macdent: Boolean(a.macdent_zapis_id),
              status: a.status,
            })),
          });
        }
        case "reschedule_appointment": {
          const appt = await this.booking.rescheduleAppointment({
            appointmentId: Number(args.appointment_id),
            phone,
            date: String(args.date),
            time: String(args.time),
          });
          return JSON.stringify({
            ok: true,
            appointment: {
              id: appt.id,
              starts_at: appt.starts_at.toISOString(),
              status: appt.status,
              summary: this.booking.formatAppointment(appt),
            },
          });
        }
        case "cancel_appointment": {
          const appt = await this.booking.cancelAppointment({
            appointmentId: Number(args.appointment_id),
            phone,
          });
          return JSON.stringify({
            ok: true,
            appointment_id: appt.id,
            status: appt.status,
          });
        }
        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (err) {
      const message =
        err instanceof BookingError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Unknown error";
      return JSON.stringify({ error: message });
    }
  }
}

function toOpenAIMessages(
  history: ConversationMessage[]
): ChatCompletionMessageParam[] {
  return history.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool" as const,
        tool_call_id: m.tool_call_id || "",
        content: m.content || "",
      };
    }
    if (m.role === "assistant" && m.tool_calls) {
      return {
        role: "assistant" as const,
        content: m.content,
        tool_calls: m.tool_calls as ChatCompletionMessageParam extends never
          ? never
          : NonNullable<
              Extract<ChatCompletionMessageParam, { role: "assistant" }>["tool_calls"]
            >,
      };
    }
    if (m.role === "system") {
      return { role: "system" as const, content: m.content || "" };
    }
    if (m.role === "user") {
      return { role: "user" as const, content: m.content || "" };
    }
    return { role: "assistant" as const, content: m.content || "" };
  });
}
