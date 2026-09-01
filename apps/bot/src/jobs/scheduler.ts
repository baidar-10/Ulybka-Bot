import type { WhatsAppProvider } from "../whatsapp/provider.js";
import { pool } from "../db/pool.js";
import type { ConversationMessage } from "../db/types.js";
import {
  findAppointmentsFor24hReminder,
  findAppointmentsFor2hReminder,
  findAppointmentsForFollowup,
  formatFollowup,
  formatReminder24h,
  formatReminder2h,
  markFollowupSent,
  markReminder24hSent,
  markReminder2hSent,
} from "./notifications.js";

const TICK_MS = 60_000;

function hasPendingBotQuestion(messages: ConversationMessage[]): boolean {
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.content);
  if (!lastAssistant?.content) return false;
  const text = lastAssistant.content;
  if (!/\?/.test(text)) return false;
  return /подойд|перенест|подтверд|верно|согласн/i.test(text);
}

async function shouldDeferReminder(phone: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT messages FROM conversations WHERE phone = $1`,
    [phone]
  );
  const messages = (rows[0]?.messages ?? []) as ConversationMessage[];
  return hasPendingBotQuestion(messages);
}

export function startNotificationScheduler(
  whatsapp: WhatsAppProvider
): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await runNotificationTick(whatsapp);
    } catch (err) {
      console.error("Notification scheduler tick failed", err);
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function runNotificationTick(whatsapp: WhatsAppProvider): Promise<void> {
  for (const appt of await findAppointmentsFor24hReminder()) {
    try {
      if (await shouldDeferReminder(appt.phone)) {
        console.log(`Reminder 24h deferred for #${appt.id} — active dialog`);
        continue;
      }
      await whatsapp.sendText(appt.phone, formatReminder24h(appt));
      await markReminder24hSent(appt.id);
      console.log(`Reminder 24h sent for appointment #${appt.id}`);
    } catch (err) {
      console.error(`Reminder 24h failed for #${appt.id}`, err);
    }
  }

  for (const appt of await findAppointmentsFor2hReminder()) {
    try {
      if (await shouldDeferReminder(appt.phone)) {
        console.log(`Reminder 2h deferred for #${appt.id} — active dialog`);
        continue;
      }
      await whatsapp.sendText(appt.phone, formatReminder2h(appt));
      await markReminder2hSent(appt.id);
      console.log(`Reminder 2h sent for appointment #${appt.id}`);
    } catch (err) {
      console.error(`Reminder 2h failed for #${appt.id}`, err);
    }
  }

  for (const appt of await findAppointmentsForFollowup()) {
    try {
      await whatsapp.sendText(appt.phone, formatFollowup(appt));
      await markFollowupSent(appt.id);
      console.log(`Follow-up sent for appointment #${appt.id}`);
    } catch (err) {
      console.error(`Follow-up failed for #${appt.id}`, err);
    }
  }
}
