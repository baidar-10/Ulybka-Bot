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

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_doctors",
      description: "Список активных врачей клиники",
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
        "Найти свободные слоты врача на дату YYYY-MM-DD для услуги. Не выдумывай слоты — только результат этой функции.",
      parameters: {
        type: "object",
        properties: {
          doctor_id: { type: "integer" },
          service_id: { type: "integer" },
          date: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["doctor_id", "service_id", "date"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Создать запись. Вызывать ТОЛЬКО после явного подтверждения пациентом (да/подтверждаю), когда известны ФИО, врач, услуга, дата и время.",
      parameters: {
        type: "object",
        properties: {
          patient_name: { type: "string" },
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
      description: "Перенести существующую запись пациента на новую дату/время",
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

  return `Ты — администратор записи клиники «${CLINIC.name}» в WhatsApp.
Твоя ЕДИНСТВЕННАЯ цель: быстро довести человека до подтверждённой записи на приём.
Ты не консультант по лечению и не справочник. Не читай лекции о зубах. Не перечисляй весь прайс.

Сегодня: ${today} (${weekday}), таймзона ${CLINIC.timezone}
Часы: Пн–Пт 10:00–20:00, Сб–Вс 10:00–14:00

Врачи:
1) Абдикаримова Асель — ортодонт (брекеты, элайнеры, прикус)
2) Абдикаримов Ержан — терапевт (кариес, каналы, чистка, боли)
3) Масенов Ансар Алмазович — терапевт (кариес, каналы, чистка)

=== Скрипт записи (строго по шагам, по 1 вопросу за сообщение) ===
Шаг A — ОБЯЗАТЕЛЬНОЕ ПЕРВОЕ СООБЩЕНИЕ в диалоге.
Всегда начинай от лица клиники, дружелюбно и коротко. Шаблон первой фразы:

«Здравствуйте! 😊
Вас приветствует стоматологическая клиника «${CLINIC.name}».
Чем мы можем вам помочь?»

Если в первом же сообщении человек уже написал запрос (запись, боль, чистка и т.д.) — всё равно сначала эти 3 строки приветствия, а СРАЗУ ПОД ними коротко продолжай запись (без повторного «чем помочь»).
Не начинай диалог с вопроса про врача/дату без этого приветствия.
Не представляйся как «AI», «бот» или «нейросеть» — только как администратор клиники.

Шаг B. Определи направление:
- ортодонтия / брекеты / прикус → Асель
- боль, кариес, каналы, чистка, осмотр → Ержан или Ансар (если не указал врача — предложи обоих коротко и спроси кого удобнее)
- неясно → предложи «первичную консультацию» у терапевта или ортодонта
Шаг C. Если услуга неочевидна — НЕ показывай длинный список. Предложи 2–3 варианта максимум (например: консультация / лечение / чистка). Для точных id вызывай list_services по выбранному врачу и сопоставь.
Шаг D. Спроси удобный день («сегодня / завтра / дата») или предложи ближайший рабочий день.
Шаг E. Вызови find_slots. Покажи только 3–5 ближайших слотов нумерованным списком. Спроси номер слота.
Шаг F. Спроси ФИО для записи (если ещё не назвали).
Шаг G. Коротко повтори: врач, услуга, дата, время, ФИО → «Подтверждаете запись? Да/Нет»
Шаг H. Только после явного «да/подтверждаю» вызови book_appointment и пришли подтверждение одной короткой карточкой.

Если человек хочет перенос/отмену — сразу get_patient_appointments и помоги через tools.

=== Стиль ===
- Русский, коротко, как живой администратор WhatsApp (2–5 строк после приветствия).
- Один вопрос за раз. Без markdown-таблиц, без звёздочек **, без длинных абзацев.
- Можно нумерацию 1) 2) 3)
- Не спрашивай телефон — он уже есть из WhatsApp.
- Не выдумывай слоты, врачей, услуги, цены, наличие — только tools.
- Не обсуждай цены, если не знаешь точно (у нас цен в системе нет) — скажи, что стоимость уточнит врач на приёме, и возвращайся к записи.
- Если человек уходит в сторону — мягко верни: «Чтобы записать вас, осталось выбрать …»
- «сброс» / «новый диалог» = начать скрипт с шага A заново (то же приветствие клиники).

Плохо: длинный список из 15 услуг, медицинские советы, сухое «укажите услугу» без приветствия.
Хорошо: приветствие клиники → «Запишу на консультацию к Ержану. На какой день удобнее — завтра или послезавтра?»`;
}

const CLINIC_GREETING = `Здравствуйте! 😊
Вас приветствует стоматологическая клиника «${CLINIC.name}».
Чем мы можем вам помочь?`;

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
    const text = params.text.trim();

    if (!text) {
      return CLINIC_GREETING;
    }

    if (/^(сброс|reset|новый диалог)$/i.test(text)) {
      await saveConversation(phone, []);
      return CLINIC_GREETING;
    }

    // Pure greeting / first hello — answer with clinic welcome without tools
    if (
      /^(привет|здравствуйте|здравстуйте|добрый\s+(день|вечер|утро)|hello|hi|hey)[\s!.]*$/i.test(
        text
      )
    ) {
      await saveConversation(phone, [
        { role: "system", content: systemPrompt() },
        { role: "user", content: text },
        { role: "assistant", content: CLINIC_GREETING },
      ]);
      return CLINIC_GREETING;
    }

    let history = await loadConversation(phone);
    const isNewDialog =
      history.length === 0 ||
      history.every((m) => m.role === "system");

    const prompt = isNewDialog
      ? `${systemPrompt()}\n\nСейчас ПЕРВОЕ сообщение пациента. Ответ ОБЯЗАН начинаться с приветствия клиники (шаг A).`
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
            phone
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
      history.push({ role: "assistant", content: finalText });
      messages.push({ role: "assistant", content: finalText });
      break;
    }

    if (!finalText) {
      finalText =
        "Извините, не удалось завершить обработку. Напишите ещё раз или «сброс».";
    }

    await saveConversation(phone, history);
    return finalText;
  }

  private async executeTool(
    name: string,
    argsJson: string,
    phone: string
  ): Promise<string> {
    try {
      const args = argsJson ? JSON.parse(argsJson) : {};
      switch (name) {
        case "list_doctors": {
          const doctors = await this.booking.listDoctors();
          return JSON.stringify(
            doctors.map((d) => ({
              id: d.id,
              full_name: d.full_name,
              specialization: d.specialization,
            }))
          );
        }
        case "find_slots": {
          const result = await this.booking.findSlots({
            doctorId: Number(args.doctor_id),
            serviceId: Number(args.service_id),
            date: String(args.date),
          });
          return JSON.stringify({
            ...result,
            slots: result.slots.slice(0, 5),
            slots_total: result.slots.length,
            note: "Покажи пациенту только эти слоты нумерованным списком",
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
          return JSON.stringify(
            list.map((a) => ({
              id: a.id,
              doctor: a.doctor_name,
              service: a.service_name,
              starts_at: a.starts_at.toISOString(),
              status: a.status,
              summary: this.booking.formatAppointment(a),
            }))
          );
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
