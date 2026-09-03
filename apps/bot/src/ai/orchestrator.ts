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
} from "../booking/service.js";
import { normalizePhone } from "../booking/phone.js";
import {
  clearConversation,
  isFirstContactToday,
  isReturningClient,
  loadConversationRecord,
  markGreetedToday,
  saveConversation,
} from "../db/conversations.js";
import { getKnownPatient } from "../db/patients.js";
import type { ConversationMessage } from "../db/types.js";
import { doctorNameInDative } from "./doctor-names.js";
import { doctorDisplayName, nameTokens, normalizeName } from "../macdent/parse.js";
import { formatDateInTz, formatTimeInTz, nextIsoDateForWeekday } from "../booking/slots.js";
import {
  buildDailyGreeting,
  buildNewClientGreeting,
  isGreetingOnly,
} from "./greeting.js";
import {
  formatAppointmentLookupReply,
  formatBookingConfirmation,
  formatDateHumanRu,
  formatRescheduleConfirmation,
} from "./booking-messages.js";
import {
  formatProcedureQuestion,
  listProcedures,
  PROCEDURES,
  resolveProcedureFromClientText,
  textDescribesProcedure,
} from "../booking/procedures.js";
import {
  bookingPolicyText,
  earliestBookableDateIso,
  isDateBookable,
  todayIso,
  tomorrowIso,
} from "../booking/policy.js";

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
      name: "list_procedures",
      description:
        "Внутренний справочник процедур с длительностью. НЕ перечисляй пациенту. Спроси открытым вопросом «на какую процедуру хотите записаться?», затем сопоставь ответ с procedure_type.",
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
        "Проверка свободного времени врача на дату. Вызывай после ответа клиента о процедуре (procedure_type + visit_reason). Не перечисляй слоты — предложи одно время.",
      parameters: {
        type: "object",
        properties: {
          doctor_id: { type: "integer" },
          procedure_type: {
            type: "string",
            description: "ID процедуры для расчёта слотов (consultation, treatment, …)",
          },
          visit_reason: {
            type: "string",
            description: "Причина обращения — формулировка клиента, попадает в MacDent",
          },
          service_id: { type: "integer", description: "Устарело, используй procedure_type" },
          date: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["doctor_id", "procedure_type", "visit_reason", "date"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Создать запись. Вызывать ТОЛЬКО после явного подтверждения пациентом (да/подтверждаю), когда известны ФИО, врач, тип процедуры, дата и время. В MacDent поле «Причина обращения» заполнится типом процедуры.",
      parameters: {
        type: "object",
        properties: {
          patient_name: {
            type: "string",
            description: "Полное ФИО пациента: фамилия, имя, отчество",
          },
          doctor_id: { type: "integer" },
          procedure_type: {
            type: "string",
            description: "ID процедуры для расчёта слотов",
          },
          visit_reason: {
            type: "string",
            description: "Причина обращения — слова клиента",
          },
          service_id: { type: "integer", description: "Устарело, используй procedure_type" },
          date: { type: "string", description: "YYYY-MM-DD" },
          time: { type: "string", description: "HH:MM" },
          comment: {
            type: "string",
            description: "То же, что visit_reason (причина обращения в MacDent)",
          },
        },
        required: [
          "patient_name",
          "doctor_id",
          "procedure_type",
          "visit_reason",
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

  return `Ты — живой и доброжелательный администратор клиники «${CLINIC.name}» в WhatsApp.
Цель: быстро и приятно записать на приём. Без лекций и без прайса.

=== Тон общения ===
- Тёплый, человечный, на «вы». Как администратор в хорошей клинике, не как робот.
- Коротко: «Отлично!», «Замечательно», «Хорошо», «Подскажите, пожалуйста…»
- ЗАПРЕЩЁН канцелярит и сухие формулировки.
- Плохо: «Фамилия, имя, отчество как в документе, пожалуйста.»
- Хорошо: «Отлично! Подскажите, пожалуйста, ваше полное имя — фамилию, имя и отчество — чтобы я оформил запись.»
- Плохо: «Укажите дату.» Хорошо: «Когда вам было бы удобно прийти?»

Сегодня: ${today} (${weekday}), ${CLINIC.timezone}
Ближайшие дни (для find_slots.date): ${upcoming}
Часы: Пн–Пт 10:00–20:00, Сб–Вс 10:00–14:00
${CLINIC.address ? `Адрес клиники (только этот, никогда не выдумывай другой): ${CLINIC.address}` : "Адрес клиники в системе не задан — при вопросе об адресе скажи, что уточните у администратора."}
${bookingPolicyText()}

Врачи — ВСЕГДА все трое (в списке — дательный падеж, т.к. «к какому врачу»):
1) Абдикаримовой Асель — ортодонт, терапевт
2) Абдикаримову Ержану — терапевт, хирург, ортопед
3) Масенову Ансару — терапевт, хирург, ортопед
Нельзя предлагать только двоих. После «к» всегда склоняй имя: к Абдикаримовой Асель, к Ержану, к Ансару.

Направление:
- брекеты, элайнеры, прикус, ортодонтия → Асель
- удаление, имплант, хирургия, протез, коронка, ортопедия → Ержан или Ансар
- кариес, каналы, чистка, боль, консультация терапевта → любой из троих (Асель тоже терапевт)

Типы процедур (list_procedures — только для тебя, пациенту НЕ перечисляй):
consultation, treatment, cleaning, correction, crowns, crown_correction, extraction, implantation, suture_removal, braces_install.
Длительность и ограничения по времени учитываются в find_slots автоматически.

=== Порядок записи (строго, не прыгай через шаги) ===
1) Пока врач не выбран — список врачей. Не спрашивай дату и процедуру. Не вызывай find_slots.
2) Врач выбран — спроси ОТКРЫТЫМ вопросом: «На какую процедуру вы хотите записаться?» Без списка вариантов. Не вызывай find_slots.
3) Клиент назвал процедуру — запомни его формулировку как visit_reason (причина обращения в MacDent). Сопоставь с procedure_type через list_procedures. Спроси дату.
4) Дата есть — find_slots с procedure_type и visit_reason. Слоты подбираются автоматически.
   Свободно: «Вам подойдёт в {время}?» Занято: предложи suggested. Без списка слотов.
   Не сообщай пациенту длительность и внутренние ограничения.
5) Время подтверждено — если ФИО уже в системе, не спрашивай. Иначе попроси ФИО.
6) ФИО известно — переспроси запись и жди «да» → book_appointment с procedure_type и visit_reason (comment = visit_reason).
   После успешной записи отправь пациенту confirmation_message из ответа tool без изменений.

Запрещено нумеровать слоты (1) 10:00 2) 10:30 …). Запрещено писать «подтверждаете перенос», если это новая запись.

«Консультация» без имени врача = шаг 1, не слоты Асель и не вопрос про дату.

Перенос существующей записи: find_slots, предложи одно время так же («Вам подойдёт в …?»), не список.
WhatsApp: без markdown. Телефон не спрашивай.
«сброс» = новый диалог. Приветствие отправляет система — не повторяй шапку клиники в каждом ответе.`;
}

function prependDailyGreeting(greeting: string, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return greeting;
  return `${greeting}\n\n${trimmed}`;
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


function stripRepeatedGreeting(text: string): string {
  const stripped = text
    .replace(/^доброе утро[!.\s]*/i, "")
    .replace(/^добрый день[!.\s]*/i, "")
    .replace(/^добрый вечер[!.\s]*/i, "")
    .replace(/^здравствуйте[^\n]*\n+/i, "")
    .replace(/^вас приветствует стоматологическая клиника[^\n]*\n+/i, "")
    .replace(/^вижу вы уже обращались к нам[^\n]*\n+/i, "")
    .replace(/^вы уже посещали нашу клинику[^\n]*\n+/i, "")
    .replace(/^могу вам чем-нибудь помочь[^\n?]*\??\s*/i, "")
    .replace(/^чем мы можем вам помочь[^\n?]*\??\s*/i, "")
    .replace(/^чем могу помочь[^\n?]*\??\s*/i, "")
    .trim();
  return stripped || text;
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
  const eveningCtx = /вечер|к вечеру|ближе к вечеру|поздн/i.test(text);
  const morningCtx = /утр/i.test(text);
  const hourMatch =
    text.match(/\b(?:в|на)\s+(\d{1,2})(?::(\d{2}))?\s*(?:час(?:а|ов)?|утра|дня|вечера)?/i) ||
    text.match(/\b(\d{1,2})\s*(?:час(?:а|ов)?)\s*(?:вечера)?/i) ||
    text.match(/(?:^|в|на)\s*(\d{1,2})\s*(?:час(?:а|ов)?|утра|дня|вечера)?\s*$/i);
  if (hourMatch) {
    let h = Number(hourMatch[1]);
    const m = hourMatch[2] ? Number(hourMatch[2]) : 0;
    // «в 6» без «утра» в контексте записи — обычно 18:00
    if (h >= 1 && h <= 7 && !morningCtx && (eveningCtx || h <= 9)) {
      h += 12;
    }
    if (h >= 8 && h <= 21 && m <= 59) {
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
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
  procedure_type?: string;
  procedure_label?: string;
  visit_reason?: string;
  reschedule_appointment_id?: number;
} | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "tool" || m.name !== "find_slots" || !m.content) continue;
    try {
      const json = JSON.parse(m.content) as {
        slots?: string[];
        date?: string;
        doctor?: string;
        procedure_type?: string;
        procedure_label?: string;
        visit_reason?: string;
        reschedule_appointment_id?: number;
      };
      if (Array.isArray(json.slots)) {
        return {
          slots: json.slots,
          date: json.date,
          doctor: json.doctor,
          procedure_type: json.procedure_type,
          procedure_label: json.procedure_label,
          visit_reason: json.visit_reason,
          reschedule_appointment_id: json.reschedule_appointment_id,
        };
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

function isTwoWordFio(text: string): boolean {
  if (/\d/.test(text)) return false;
  if (/^(к|у|на|в|о)\s+/i.test(text.trim())) return false;
  if (
    /да|нет|запис|консульт|подойд|сред|вторник|понедельник|врач|время|отмен|сегодня|завтра|можно|давайте|хочу|хотел|удобн|прийти|вечер|утр|передумал|асель|ержан|ансар|масенов|абдикаримов|лечение|чистк|имплант|брекет|корон|удален|шов|коррекц/i.test(
      text
    )
  ) {
    return false;
  }
  if (looksLikeDateOnly(text)) return false;
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return (
    parts.length === 2 &&
    parts.every((w) => w.length >= 3 && /^[A-Za-zА-Яа-яЁёІіҰұҚқҒғӨөҺһ-]+$/.test(w))
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

function parseTimeOfDayPreference(text: string): "evening" | "morning" | null {
  if (/вечер|ближе к вечеру|поближе к вечеру|к вечеру|хочется к вечеру|не хотелось бы ближе к вечеру|позднее|попозже/i.test(text)) {
    return "evening";
  }
  if (/утр|пораньше|поближе к утру|раньше/i.test(text)) {
    return "morning";
  }
  return null;
}

function pickEveningSlot(slots: string[]): string | null {
  const evening = slots.filter((t) => timeToMinutes(t) >= 16 * 60);
  return evening.at(-1) ?? slots.at(-1) ?? null;
}

function replyForTimePreference(
  preference: "evening" | "morning",
  slots: string[]
): string | null {
  if (!slots.length) return null;
  if (preference === "evening") {
    const evening = slots.filter((t) => timeToMinutes(t) >= 16 * 60);
    if (!evening.length) {
      if (slots.length === 1) {
        return `К сожалению, на этот день вечером свободных окон нет. Есть ${slots[0]} — вам подойдёт?`;
      }
      return `К сожалению, вечером свободных окон нет. Ближайшее время — ${slots.at(-1)}. Подойдёт?`;
    }
    return `Вам подойдёт в ${evening.at(-1)}?`;
  }
  return `Вам подойдёт в ${slots[0]}?`;
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

function historyAwaitingFinalConfirmation(history: ConversationMessage[]): boolean {
  const last = [...history]
    .reverse()
    .find((m) => m.role === "assistant" && m.content);
  if (!last?.content) return false;
  return /всё верно/i.test(last.content);
}

function historyAwaitingFio(history: ConversationMessage[]): boolean {
  const last = [...history]
    .reverse()
    .find((m) => m.role === "assistant" && m.content);
  if (!last?.content) return false;
  return /полное имя|фамилию|отчество|как вас зовут/i.test(last.content);
}

function historyShowedDoctorList(history: ConversationMessage[]): boolean {
  return history.some(
    (m) => m.role === "assistant" && m.content && /к какому врачу/i.test(m.content)
  );
}

function normalizeSlotTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${String(h).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}`;
}

function lastAssistantOfferedSlot(history: ConversationMessage[]): string | null {
  const last = [...history]
    .reverse()
    .find((m) => m.role === "assistant" && m.content);
  if (!last?.content) return null;
  const m =
    last.content.match(/подойдёт в (\d{1,2}:\d{2})/i) ||
    last.content.match(/предложить (\d{1,2}:\d{2})/i) ||
    last.content.match(/Могу предложить (\d{1,2}:\d{2})/i) ||
    last.content.match(/перенести[^?]*на (\d{1,2}:\d{2})/i) ||
    last.content.match(/на (\d{1,2}:\d{2})\?/i);
  return m ? normalizeSlotTime(m[1]) : null;
}

function pushDeterministicToolExchange(
  history: ConversationMessage[],
  userText: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  toolResult: string,
  assistantReply: string
): void {
  const toolCallId = `det-${Date.now()}`;
  history.push({ role: "user", content: userText });
  history.push({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: toolCallId,
        type: "function",
        function: {
          name: toolName,
          arguments: JSON.stringify(toolArgs),
        },
      },
    ],
  });
  history.push({
    role: "tool",
    tool_call_id: toolCallId,
    content: toolResult,
    name: toolName,
  });
  history.push({ role: "assistant", content: assistantReply });
}

function isSlotRejection(text: string): boolean {
  return /^(нет|неа|не подходит|не хочу|другое время|другой|позже)\b/i.test(
    text.trim()
  );
}

function isSlotConfirmation(text: string): boolean {
  return /^(да|ок|окей|ага|угу|хорошо|подойд|давайте|согласен|верно)\b/i.test(
    text.trim()
  );
}

function extractPatientFioFromHistory(
  history: ConversationMessage[],
  doctors: { full_name: string }[]
): string | null {
  const users = history
    .filter((m) => m.role === "user" && m.content)
    .map((m) => m.content!.trim());

  for (let i = users.length - 1; i >= 0; i--) {
    const parts = users[i].split(/\s+/);
    if (
      parts.length === 3 &&
      !textMentionsDoctor(users[i], doctors) &&
      parts.every((w) => /^[A-Za-zА-Яа-яЁё-]+$/.test(w))
    ) {
      return users[i];
    }
  }

  for (let i = users.length - 1; i >= 1; i--) {
    if (
      isOneWordPatronymic(users[i]) &&
      isTwoWordFio(users[i - 1]) &&
      !textMentionsDoctor(users[i - 1], doctors)
    ) {
      return `${users[i - 1]} ${users[i]}`;
    }
  }

  return null;
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
    (d, i) =>
      `${i + 1}) ${doctorNameInDative(d.full_name)} — ${d.specialization}`
  );
  return `Спасибо, что обратились и доверились нашей клинике 🫶🏻

У нас самые лучшие специалисты в городе.

Подскажите, к какому врачу вам удобнее записаться?

${lines.join("\n")}`;
}

function historyAskedProcedure(history: ConversationMessage[]): boolean {
  return history.some(
    (m) =>
      m.role === "assistant" &&
      m.content &&
      /на какую процедуру|какую процедуру/i.test(m.content)
  );
}

function historyAwaitingProcedureAnswer(
  history: ConversationMessage[]
): boolean {
  const last = [...history]
    .reverse()
    .find((m) => m.role === "assistant" && m.content);
  if (!last?.content) return false;
  return /на какую процедуру|какую процедуру/i.test(last.content);
}

function mentionsBookingDate(text: string): boolean {
  return /\b(сегодня|завтра|послезавтра|понедельник|вторник|сред[ауы]?|четверг|пятниц|суббот|воскресень|\d{1,2}[./]\d{1,2})\b/i.test(
    text
  );
}

function looksLikeProcedureAnswer(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 2) return false;
  if (looksLikeDateOnly(text) || mentionsBookingDate(text)) return false;
  if (/^(да|нет|ок|окей|ага|угу|хорошо|1|2|3)$/i.test(t)) return false;
  if (/^(можно|хочу|давайте)\s+(завтра|сегодня|в\s+)/i.test(t)) return false;
  return true;
}

function extractProcedureAnswerFromHistory(
  history: ConversationMessage[],
  currentText?: string
): string | null {
  // Only treat current message as procedure if we just asked for it
  if (
    currentText &&
    historyAwaitingProcedureAnswer(history) &&
    looksLikeProcedureAnswer(currentText)
  ) {
    return currentText.trim();
  }
  if (!historyAskedProcedure(history)) return null;
  let askedIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (
      m.role === "assistant" &&
      m.content &&
      /на какую процедуру|какую процедуру/i.test(m.content)
    ) {
      askedIdx = i;
      break;
    }
  }
  if (askedIdx < 0) return null;
  for (let i = askedIdx + 1; i < history.length; i++) {
    const m = history[i];
    if (m.role === "user" && m.content && looksLikeProcedureAnswer(m.content)) {
      return m.content.trim();
    }
  }
  return null;
}

function resolveProcedureIntent(
  text: string,
  history: ConversationMessage[]
): { procedureType: string; visitReason: string } | null {
  const answer =
    extractProcedureAnswerFromHistory(history, text) ??
    (looksLikeProcedureAnswer(text) ? text.trim() : null);
  if (!answer) {
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m.role === "tool" && m.name === "find_slots" && m.content) {
        try {
          const json = JSON.parse(m.content) as {
            procedure_type?: string;
            visit_reason?: string;
          };
          if (json.procedure_type && json.visit_reason) {
            return {
              procedureType: json.procedure_type,
              visitReason: json.visit_reason,
            };
          }
        } catch {
          /* skip */
        }
      }
    }
    return null;
  }
  const resolved = resolveProcedureFromClientText(answer);
  if (!resolved) return null;
  return {
    procedureType: resolved.procedure.id,
    visitReason: resolved.visitReason,
  };
}

function historyHasChosenProcedure(history: ConversationMessage[]): boolean {
  if (extractProcedureAnswerFromHistory(history)) return true;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "tool" && m.name === "find_slots" && m.content) {
      try {
        const json = JSON.parse(m.content) as { procedure_type?: string };
        if (json.procedure_type) return true;
      } catch {
        /* skip */
      }
    }
  }
  return false;
}

function inNewBookingFlow(history: ConversationMessage[]): boolean {
  return (
    history.some(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        m.content &&
        /запис|консульт|прием|приём/i.test(m.content)
    ) || historyShowedDoctorList(history)
  );
}

function looksLikeRescheduleRequest(text: string): boolean {
  return /изменить|перенест|перенос|поменять|на другое время|другое время/i.test(
    text.toLowerCase()
  );
}

function historyHasRescheduleIntent(history: ConversationMessage[]): boolean {
  return history.some(
    (m) => m.role === "user" && m.content && looksLikeRescheduleRequest(m.content)
  );
}

function looksLikeAppointmentLookup(text: string): boolean {
  const t = text.toLowerCase();
  if (
    /мои запис|какие запис|есть ли запись|у меня (была |есть )?запись|записывал|записан[аы]?|уже запис/i.test(
      t
    )
  ) {
    return true;
  }
  if (/проверить|посмотреть|уточнить|напомнить/i.test(t) && /запис|во сколько|когда/i.test(t)) {
    return true;
  }
  if (/во сколько|в какое время/i.test(t) && /запис|прием|приём|завтра|сегодня/i.test(t)) {
    return true;
  }
  return false;
}

function wantsNewBooking(text: string): boolean {
  if (looksLikeAppointmentLookup(text)) return false;
  if (looksLikeRescheduleRequest(text)) return false;
  if (/отмен|перенес|поменять|попозже/i.test(text)) return false;
  return /записаться|запишите|новую запись|хочу запис|можно запис|к врачу|какой врач|консульт/i.test(
    text
  );
}

function looksLikeDateOnly(text: string): boolean {
  const t = text.trim();
  if (
    /^(на\s+)?(понедельник|вторник|сред[ауы]?|четверг|пятниц|суббот|воскресень|сегодня|завтра|послезавтра)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (/\bна\s+(сегодня|завтра|послезавтра)\b/i.test(t)) return true;
  if (
    /\b(сегодня|завтра|послезавтра|понедельник|вторник|сред[ауы]?|четверг|пятниц|суббот|воскресень)\b/i.test(
      t
    ) &&
    /^(можно|хочу|на|давайте|запиш|удобн|прийти|могу|есть|в)\b/i.test(t)
  ) {
    return true;
  }
  // «можно в пятницу», «давайте в четверг»
  if (
    /^(можно|хочу|давайте|запишите)?\s*(в|на)?\s*(понедельник|вторник|сред[ауы]?|четверг|пятниц|суббот|воскресень|сегодня|завтра)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (/^\d{1,2}[./]\d{1,2}([./]\d{2,4})?$/.test(t)) return true;
  return false;
}

function weekdayNameToDow(name: string): number | null {
  const n = name.toLowerCase();
  if (n.startsWith("понедельник")) return 1;
  if (n.startsWith("вторник")) return 2;
  if (n.startsWith("сред")) return 3;
  if (n.startsWith("четверг")) return 4;
  if (n.startsWith("пятниц")) return 5;
  if (n.startsWith("суббот")) return 6;
  if (n.startsWith("воскресень")) return 0;
  return null;
}

function parseRequestedDate(text: string): string | null {
  const t = text.toLowerCase();
  if (/\bсегодня\b/.test(t)) return todayIso();
  if (/\bзавтра\b/.test(t)) return tomorrowIso();
  const wd = t.match(
    /\b(понедельник|вторник|сред[ауы]?|четверг|пятниц[ауы]?|суббот[ауы]?|воскресень[ея]?)\b/i
  );
  if (wd) {
    const dow = weekdayNameToDow(wd[1]);
    if (dow != null) return nextIsoDateForWeekday(dow, CLINIC.timezone);
  }
  return null;
}

function resolveDoctorId(
  text: string,
  history: ConversationMessage[],
  doctors: { id: number; full_name: string }[]
): number | null {
  const fromText = doctors.find((d) => textMentionsDoctor(text, [d]));
  if (fromText) return fromText.id;

  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "user" || !m.content) continue;
    const d = doctors.find((doc) => textMentionsDoctor(m.content!, [doc]));
    if (d) return d.id;
  }

  const numPick = [...history]
    .reverse()
    .find((m) => m.role === "user" && m.content && /^[123]$/.test(m.content.trim()));
  if (numPick?.content && historyHasChosenDoctor(history, doctors)) {
    const idx = Number(numPick.content.trim()) - 1;
    if (doctors[idx]) return doctors[idx].id;
  }

  return null;
}

function historyAskedForBooking(history: ConversationMessage[]): boolean {
  return history.some(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      m.content &&
      /запис|консульт/i.test(m.content)
  );
}

function looksLikeAddressQuestion(text: string): boolean {
  return /адрес|где\s+(вы|находитесь|клиника|расположен)|как\s+(добраться|найти)|где\s+вы\s+находитесь|ваш\s+адрес/i.test(
    text
  );
}

function replyWithClinicAddress(): string {
  if (CLINIC.address) {
    return `Мы находимся по адресу: ${CLINIC.address}. Ждём вас!`;
  }
  return "К сожалению, я не могу подсказать адрес в чате — уточните, пожалуйста, у администратора клиники.";
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
      return buildNewClientGreeting();
    }

    if (/^(сброс|reset|новый диалог)$/i.test(text)) {
      const greeting = buildNewClientGreeting();
      await clearConversation(phone);
      await saveConversation(phone, [
        { role: "system", content: systemPrompt() },
        { role: "assistant", content: greeting },
      ]);
      await markGreetedToday(phone);
      return greeting;
    }

    const record = await loadConversationRecord(phone);
    const knownPatient = await getKnownPatient(phone);
    const firstToday = isFirstContactToday(record.last_greeted_date);
    let dailyGreeting: string | null = null;

    if (firstToday) {
      const returning = await isReturningClient(phone);
      dailyGreeting = buildDailyGreeting(returning);
      await markGreetedToday(phone);

      if (isGreetingOnly(text)) {
        await saveConversation(phone, [
          { role: "system", content: systemPrompt() },
          { role: "user", content: text },
          { role: "assistant", content: dailyGreeting },
        ]);
        return dailyGreeting;
      }
    }

    const finalize = (body: string, stripGreeting = true): string => {
      const cleanedBody = stripGreeting ? stripRepeatedGreeting(body) : body;
      const combined = dailyGreeting
        ? prependDailyGreeting(dailyGreeting, cleanedBody)
        : cleanedBody;
      return stripWhatsAppMarkdown(combined);
    };

    let history = record.messages;
    const greetedToday = Boolean(dailyGreeting) || !firstToday;

    if (looksLikeAddressQuestion(text)) {
      const reply = replyWithClinicAddress();
      if (history.length === 0) {
        history = [{ role: "system", content: systemPrompt() }];
      }
      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: reply });
      await saveConversation(phone, history);
      return finalize(reply);
    }

    if (isGreetingOnly(text)) {
      const reply =
        "Чем могу помочь? Запишу на приём, проверю вашу запись или подскажу адрес клиники 😊";
      if (history.length === 0) {
        history = [{ role: "system", content: systemPrompt() }];
      }
      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: reply });
      await saveConversation(phone, history);
      return finalize(reply);
    }

    if (looksLikeAppointmentLookup(text)) {
      const list = await this.booking.getPatientAppointments(phone);
      const targetDate = parseRequestedDate(text);
      const filtered = targetDate
        ? list.filter(
            (a) => formatDateInTz(a.starts_at, CLINIC.timezone) === targetDate
          )
        : list;
      const reply = formatAppointmentLookupReply(filtered, targetDate);
      if (history.length === 0) {
        history = [{ role: "system", content: systemPrompt() }];
      }
      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: reply });
      await saveConversation(phone, history);
      return finalize(reply);
    }

    if (looksLikeRescheduleRequest(text)) {
      const list = await this.booking.getPatientAppointments(phone);
      if (!list.length) {
        const reply =
          "Не нашёл активных записей для переноса. Хотите записаться на приём?";
        if (history.length === 0) {
          history = [{ role: "system", content: systemPrompt() }];
        }
        history.push({ role: "user", content: text });
        history.push({ role: "assistant", content: reply });
        await saveConversation(phone, history);
        return finalize(reply);
      }

      const appt =
        list.find(
          (a) =>
            parseRequestedDate(text) &&
            formatDateInTz(a.starts_at, CLINIC.timezone) === parseRequestedDate(text)
        ) ?? list[0];
      const date = formatDateInTz(appt.starts_at, CLINIC.timezone);
      const oldTime = formatTimeInTz(appt.starts_at, CLINIC.timezone);
      const preferred = parsePreferredTime(text);

      try {
        const result = await this.booking.findSlots({
          doctorId: appt.doctor_id,
          date,
          serviceId: appt.service_id,
        });
        let reply: string;
        if (!result.slots.length) {
          reply = `К сожалению, на ${formatDateHumanRu(date)} нет свободных окон для переноса. Подобрать другой день?`;
        } else if (preferred) {
          const pick = pickSuggestedSlot(result.slots, preferred);
          if (pick.requested_free) {
            reply = `Конечно! Перенести вашу запись с ${oldTime} на ${preferred}?`;
          } else if (pick.suggested) {
            reply = `${preferred} занято. Могу перенести на ${pick.suggested} — подойдёт?`;
          } else {
            reply = `На этот день свободных окон нет. Подобрать другой день?`;
          }
        } else {
          reply = `Сейчас у вас запись в ${oldTime}. На какое время перенести?`;
        }

        const toolPayload = JSON.stringify({
          ...result,
          slots: result.slots,
          reschedule_appointment_id: appt.id,
        });
        if (history.length === 0) {
          history = [{ role: "system", content: systemPrompt() }];
        }
        pushDeterministicToolExchange(
          history,
          text,
          "find_slots",
          { doctor_id: appt.doctor_id, date, service_id: appt.service_id },
          toolPayload,
          reply
        );
        await saveConversation(phone, history);
        return finalize(reply);
      } catch (err) {
        console.error("deterministic reschedule find_slots failed", err);
      }
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
      return finalize(reply);
    }

    const prevSlots = lastFindSlotsPayload(history);

    if (
      textMentionsDoctor(text, doctors) &&
      !looksLikeDateOnly(text) &&
      !historyAwaitingFio(history) &&
      (historyShowedDoctorList(history) || /передумал|другого врача/i.test(text))
    ) {
      const doctorId = resolveDoctorId(text, history, doctors);
      const doc = doctors.find((d) => d.id === doctorId);
      if (doc) {
        if (textDescribesProcedure(text) && !looksLikeDateOnly(text)) {
          const reply = "Отлично! Когда вам было бы удобно прийти?";
          if (history.length === 0) {
            history = [{ role: "system", content: systemPrompt() }];
          }
          history.push({ role: "user", content: text });
          history.push({ role: "assistant", content: reply });
          await saveConversation(phone, history);
          return finalize(reply);
        }
        const reply = `Замечательно! ${formatProcedureQuestion()}`;
        if (history.length === 0) {
          history = [{ role: "system", content: systemPrompt() }];
        }
        history.push({ role: "user", content: text });
        history.push({ role: "assistant", content: reply });
        await saveConversation(phone, history);
        return finalize(reply);
      }
    }

    if (
      doctorChosen &&
      !historyHasChosenProcedure(history) &&
      !looksLikeDateOnly(text) &&
      !historyAwaitingFio(history) &&
      inNewBookingFlow(history) &&
      !looksLikeRescheduleRequest(text) &&
      !looksLikeAppointmentLookup(text) &&
      !resolveProcedureIntent(text, history)
    ) {
      const reply = formatProcedureQuestion();
      if (history.length === 0) {
        history = [{ role: "system", content: systemPrompt() }];
      }
      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: reply });
      await saveConversation(phone, history);
      return finalize(reply);
    }

    const procedureIntent = resolveProcedureIntent(text, history);
    if (
      doctorChosen &&
      procedureIntent &&
      !looksLikeDateOnly(text) &&
      !mentionsBookingDate(text) &&
      !historyAwaitingFio(history) &&
      !lastFindSlotsPayload(history)
    ) {
      const reply =
        "Отлично! Когда вам было бы удобно прийти? Можно назвать день недели или дату.";
      if (history.length === 0) {
        history = [{ role: "system", content: systemPrompt() }];
      }
      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: reply });
      await saveConversation(phone, history);
      return finalize(reply);
    }

    if (doctorChosen && (looksLikeDateOnly(text) || mentionsBookingDate(text))) {
      const doctorId = resolveDoctorId(text, history, doctors);
      const date = parseRequestedDate(text);
      const resolvedProcedure = resolveProcedureIntent(text, history);
      if (doctorId && date) {
        if (!resolvedProcedure) {
          const reply = formatProcedureQuestion();
          if (history.length === 0) {
            history = [{ role: "system", content: systemPrompt() }];
          }
          history.push({ role: "user", content: text });
          history.push({ role: "assistant", content: reply });
          await saveConversation(phone, history);
          return finalize(reply);
        }
        if (!isDateBookable(date)) {
          const reply = `К сожалению, на сегодня уже нельзя записаться — ближайшая дата ${earliestBookableDateIso()}. Какой день вам удобнее?`;
          if (history.length === 0) {
            history = [{ role: "system", content: systemPrompt() }];
          }
          history.push({ role: "user", content: text });
          history.push({ role: "assistant", content: reply });
          await saveConversation(phone, history);
          return finalize(reply);
        }
        try {
          const result = await this.booking.findSlots({
            doctorId,
            date,
            procedureType: resolvedProcedure.procedureType,
            visitReason: resolvedProcedure.visitReason,
          });
          const preferred = parsePreferredTime(text);
          const timePref = parseTimeOfDayPreference(text);
          let reply: string;
          if (!result.slots.length) {
            reply = `К сожалению, на этот день нет свободных окон. Подобрать другой день?`;
          } else if (timePref) {
            reply =
              replyForTimePreference(timePref, result.slots) ??
              `Вам подойдёт в ${result.slots[0]}?`;
          } else if (preferred) {
            reply = replyForRequestedTime(preferred, result.slots);
          } else {
            const pick = pickSuggestedSlot(result.slots, null);
            reply = `Вам подойдёт в ${pick.suggested}?`;
          }
          const toolPayload = JSON.stringify({
            ...result,
            slots: result.slots,
            slots_total: result.slots.length,
          });
          if (history.length === 0) {
            history = [{ role: "system", content: systemPrompt() }];
          }
          pushDeterministicToolExchange(
            history,
            text,
            "find_slots",
            { doctor_id: doctorId, date, procedure_type: resolvedProcedure.procedureType, visit_reason: resolvedProcedure.visitReason },
            toolPayload,
            reply
          );
          await saveConversation(phone, history);
          return finalize(reply);
        } catch (err) {
          console.error("deterministic find_slots failed", err);
        }
      }
    }

    const lastUser = [...history].reverse().find((m) => m.role === "user" && m.content);
    if (
      isOneWordPatronymic(text) &&
      lastUser?.content &&
      isTwoWordFio(lastUser.content) &&
      historyAwaitingFio(history)
    ) {
      text = `${lastUser.content.trim()} ${text.trim()}`;
    } else if (
      isTwoWordFio(text) &&
      !textMentionsDoctor(text, doctors) &&
      historyAwaitingFio(history)
    ) {
      const reply =
        "Спасибо! А подскажите ещё отчество — нужно для оформления записи.";
      if (history.length === 0) {
        history = [{ role: "system", content: systemPrompt() }];
      }
      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: reply });
      await saveConversation(phone, history);
      return finalize(reply);
    }

    const offeredSlot = lastAssistantOfferedSlot(history);
    if (isSlotRejection(text) && prevSlots?.slots?.length && offeredSlot) {
      const remaining = prevSlots.slots.filter(
        (t) => normalizeSlotTime(t) !== offeredSlot
      );
      const reply = remaining.length
        ? `Хорошо, понял. Тогда вам подойдёт в ${remaining[0]}?`
        : `На этот день других свободных окон нет. Подобрать другой день?`;
      if (history.length === 0) {
        history = [{ role: "system", content: systemPrompt() }];
      }
      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: reply });
      await saveConversation(phone, history);
      return finalize(reply);
    }

    if (isSlotConfirmation(text) && offeredSlot && prevSlots?.date) {
      const slotOk = prevSlots.slots.some(
        (t) => normalizeSlotTime(t) === offeredSlot
      );
      let apptId = prevSlots.reschedule_appointment_id;
      if (!apptId && historyHasRescheduleIntent(history)) {
        const list = await this.booking.getPatientAppointments(phone);
        const match = list.find(
          (a) => formatDateInTz(a.starts_at, CLINIC.timezone) === prevSlots.date
        );
        apptId = match?.id;
      }

      if (apptId && slotOk) {
        try {
          const moved = await this.booking.rescheduleAppointment({
            appointmentId: apptId,
            phone,
            date: prevSlots.date,
            time: offeredSlot,
          });
          const reply = formatRescheduleConfirmation({
            doctorName: moved.doctor_name ?? "врачу",
            date: prevSlots.date,
            time: offeredSlot,
          });
          if (history.length === 0) {
            history = [{ role: "system", content: systemPrompt() }];
          }
          history.push({ role: "user", content: text });
          history.push({ role: "assistant", content: reply });
          await saveConversation(phone, history);
          return finalize(reply);
        } catch (err) {
          const reply =
            err instanceof BookingError
              ? err.message
              : "Не удалось перенести запись. Попробуйте ещё раз.";
          if (history.length === 0) {
            history = [{ role: "system", content: systemPrompt() }];
          }
          history.push({ role: "user", content: text });
          history.push({ role: "assistant", content: reply });
          await saveConversation(phone, history);
          return finalize(reply);
        }
      }

      const fio =
        extractPatientFioFromHistory(history, doctors) ??
        knownPatient?.patient_name ??
        null;
      const doctorId = resolveDoctorId(text, history, doctors);
      const doc = doctors.find((d) => d.id === doctorId);
      const procedureLabel =
        prevSlots?.visit_reason ??
        prevSlots?.procedure_label ??
        (prevSlots?.procedure_type
          ? PROCEDURES.find((p) => p.id === prevSlots.procedure_type)?.label
          : null);
      if (fio && doc && slotOk && !historyAwaitingFinalConfirmation(history)) {
        const procedurePart = procedureLabel ? `, ${procedureLabel}` : "";
        const reply = `Отлично! Подтвердите, пожалуйста: ${fio}${procedurePart}, врач ${doctorDisplayName(doc.full_name)}, ${prevSlots.date} в ${offeredSlot}. Всё верно?`;
        if (history.length === 0) {
          history = [{ role: "system", content: systemPrompt() }];
        }
        history.push({ role: "user", content: text });
        history.push({ role: "assistant", content: reply });
        await saveConversation(phone, history);
        return finalize(reply);
      }

      if (
        fio &&
        doc &&
        doctorId &&
        slotOk &&
        historyAwaitingFinalConfirmation(history) &&
        prevSlots?.procedure_type
      ) {
        try {
          const appt = await this.booking.bookAppointment({
            patientName: fio,
            phone,
            doctorId,
            procedureType: prevSlots.procedure_type,
            visitReason: prevSlots.visit_reason ?? procedureLabel ?? undefined,
            date: prevSlots.date!,
            time: offeredSlot,
            comment: prevSlots.visit_reason ?? procedureLabel ?? undefined,
          });
          const reply = formatBookingConfirmation({
            doctorName: appt.doctor_name ?? "врачу",
            date: prevSlots.date!,
            time: offeredSlot,
          });
          if (history.length === 0) {
            history = [{ role: "system", content: systemPrompt() }];
          }
          history.push({ role: "user", content: text });
          history.push({ role: "assistant", content: reply });
          await saveConversation(phone, history);
          return finalize(reply);
        } catch (err) {
          const reply =
            err instanceof BookingError
              ? err.message
              : "Не удалось создать запись. Попробуйте ещё раз.";
          if (history.length === 0) {
            history = [{ role: "system", content: systemPrompt() }];
          }
          history.push({ role: "user", content: text });
          history.push({ role: "assistant", content: reply });
          await saveConversation(phone, history);
          return finalize(reply);
        }
      }

      if (!fio && doc && slotOk) {
        const reply =
          "Отлично! Подскажите, пожалуйста, ваше полное имя — фамилию, имя и отчество.";
        if (history.length === 0) {
          history = [{ role: "system", content: systemPrompt() }];
        }
        history.push({ role: "user", content: text });
        history.push({ role: "assistant", content: reply });
        await saveConversation(phone, history);
        return finalize(reply);
      }
    }

    const askedTime = parsePreferredTime(text);
    const timePref = parseTimeOfDayPreference(text);
    if (
      timePref &&
      prevSlots?.slots?.length &&
      !/^(да|хорошо|ок|подойд)/i.test(text.trim())
    ) {
      const reply = replyForTimePreference(timePref, prevSlots.slots);
      if (reply) {
        if (history.length === 0) {
          history = [{ role: "system", content: systemPrompt() }];
        }
        history.push({ role: "user", content: text });
        history.push({ role: "assistant", content: reply });
        await saveConversation(phone, history);
        return finalize(reply);
      }
    }
    if (
      askedTime &&
      prevSlots?.slots?.length &&
      !/^(да|хорошо|ок|подойд)/i.test(text.trim())
    ) {
      const reply = replyForRequestedTime(askedTime, prevSlots.slots);
      if (history.length === 0) {
        history = [{ role: "system", content: systemPrompt() }];
      }
      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: reply });
      await saveConversation(phone, history);
      return finalize(reply);
    }

    const prompt = greetedToday
      ? `${systemPrompt()}\n\nСегодня ты УЖЕ поздоровался с пациентом. Не повторяй приветствие и шапку клиники.${
          knownPatient
            ? `\n\nПациент уже в системе: ${knownPatient.patient_name}. Не спрашивай ФИО повторно — используй это имя в book_appointment.`
            : ""
        }`
      : `${systemPrompt()}${
          knownPatient
            ? `\n\nПациент уже в системе: ${knownPatient.patient_name}. Не спрашивай ФИО повторно — используй это имя в book_appointment.`
            : ""
        }`;

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

          if (toolCall.function.name === "book_appointment") {
            try {
              const parsed = JSON.parse(result) as {
                ok?: boolean;
                confirmation_message?: string;
              };
              if (parsed.ok && parsed.confirmation_message) {
                finalText = parsed.confirmation_message;
              }
            } catch {
              /* ignore */
            }
          }
          if (toolCall.function.name === "reschedule_appointment") {
            try {
              const parsed = JSON.parse(result) as {
                ok?: boolean;
                confirmation_message?: string;
              };
              if (parsed.ok && parsed.confirmation_message) {
                finalText = parsed.confirmation_message;
              }
            } catch {
              /* ignore */
            }
          }
        }

        if (finalText) {
          history.push({ role: "assistant", content: finalText });
          messages.push({ role: "assistant", content: finalText });
          break;
        }
        continue;
      }

      finalText =
        choice.content?.trim() ||
        "Готово. Если нужно что-то ещё — напишите.";
      if (greetedToday) {
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
    return finalize(finalText, false);
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
              name_dative: doctorNameInDative(d.full_name),
              specialization: d.specialization,
            }))
          );
        }
        case "list_procedures": {
          return JSON.stringify({
            note: "Только для сопоставления ответа клиента. Не перечисляй пациенту — спроси «на какую процедуру хотите записаться?»",
            procedures: listProcedures().map((p) => ({
              id: p.id,
              label: p.label,
              duration_minutes: p.durationMinutes,
              latest_end_time: p.latestEndTime ?? null,
            })),
          });
        }
        case "find_slots": {
          const date = String(args.date);
          if (!isDateBookable(date)) {
            const earliest = earliestBookableDateIso();
            return JSON.stringify({
              error: `Запись на ${date} недоступна. Ближайшая дата: ${earliest}.`,
              earliest_bookable_date: earliest,
            });
          }
          const procedureType = String(
            args.procedure_type ?? args.procedureType ?? ""
          );
          let visitReason = String(
            args.visit_reason ?? args.visitReason ?? args.comment ?? ""
          ).trim();
          if (!visitReason && userText) {
            visitReason =
              resolveProcedureFromClientText(userText)?.visitReason ?? "";
          }
          if (!procedureType) {
            return JSON.stringify({
              error: "Сначала узнай у клиента, на какую процедуру он хочет записаться.",
            });
          }
          if (!visitReason) {
            const proc = PROCEDURES.find((p) => p.id === procedureType);
            visitReason = proc?.label ?? procedureType;
          }
          const result = await this.booking.findSlots({
            doctorId: Number(args.doctor_id),
            serviceId:
              args.service_id != null ? Number(args.service_id) : undefined,
            procedureType,
            visitReason,
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
          const procedureType = String(
            args.procedure_type ?? args.procedureType ?? ""
          );
          const visitReason = String(
            args.visit_reason ??
              args.visitReason ??
              args.comment ??
              ""
          ).trim();
          const appt = await this.booking.bookAppointment({
            patientName: String(args.patient_name),
            phone,
            doctorId: Number(args.doctor_id),
            serviceId:
              args.service_id != null ? Number(args.service_id) : undefined,
            procedureType: procedureType || undefined,
            visitReason: visitReason || undefined,
            date: String(args.date),
            time: String(args.time),
            comment: visitReason || (args.comment ? String(args.comment) : undefined),
          });
          const confirmation_message = formatBookingConfirmation({
            doctorName: appt.doctor_name ?? "врачу",
            date: String(args.date),
            time: String(args.time),
          });
          return JSON.stringify({
            ok: true,
            confirmation_message,
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
          const confirmation_message = formatRescheduleConfirmation({
            doctorName: appt.doctor_name ?? "врачу",
            date: String(args.date),
            time: String(args.time),
          });
          return JSON.stringify({
            ok: true,
            confirmation_message,
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
  const out: ChatCompletionMessageParam[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role === "tool") {
      const prev = history[i - 1];
      if (!prev || prev.role !== "assistant" || !prev.tool_calls) {
        continue;
      }
      out.push({
        role: "tool",
        tool_call_id: m.tool_call_id || "",
        content: m.content || "",
      });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls) {
      out.push({
        role: "assistant",
        content: m.content,
        tool_calls: m.tool_calls as ChatCompletionMessageParam extends never
          ? never
          : NonNullable<
              Extract<ChatCompletionMessageParam, { role: "assistant" }>["tool_calls"]
            >,
      });
      continue;
    }
    if (m.role === "system") {
      out.push({ role: "system", content: m.content || "" });
      continue;
    }
    if (m.role === "user") {
      out.push({ role: "user", content: m.content || "" });
      continue;
    }
    out.push({ role: "assistant", content: m.content || "" });
  }
  return out;
}
