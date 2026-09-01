import { pool } from "../db/pool.js";
import type { ConversationMessage } from "../db/types.js";
import { todayIso } from "../booking/policy.js";

const MAX_MESSAGES = 40;

export interface ConversationRecord {
  messages: ConversationMessage[];
  last_greeted_date: string | null;
}

export async function loadConversation(
  phone: string
): Promise<ConversationMessage[]> {
  const record = await loadConversationRecord(phone);
  return record.messages;
}

export async function loadConversationRecord(
  phone: string
): Promise<ConversationRecord> {
  const { rows } = await pool.query(
    `SELECT messages, last_greeted_date::text
     FROM conversations WHERE phone = $1`,
    [phone]
  );
  if (!rows[0]) {
    return { messages: [], last_greeted_date: null };
  }
  const lastGreeted = rows[0].last_greeted_date as string | null;
  return {
    messages: (rows[0].messages as ConversationMessage[]) ?? [],
    last_greeted_date: lastGreeted ? lastGreeted.slice(0, 10) : null,
  };
}

export async function saveConversation(
  phone: string,
  messages: ConversationMessage[]
): Promise<void> {
  const trimmed = messages.slice(-MAX_MESSAGES);
  await pool.query(
    `INSERT INTO conversations (phone, messages, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (phone) DO UPDATE
       SET messages = EXCLUDED.messages, updated_at = NOW()`,
    [phone, JSON.stringify(trimmed)]
  );
}

export async function markGreetedToday(phone: string): Promise<void> {
  const today = todayIso();
  await pool.query(
    `INSERT INTO conversations (phone, messages, last_greeted_date, updated_at)
     VALUES ($1, '[]'::jsonb, $2::date, NOW())
     ON CONFLICT (phone) DO UPDATE
       SET last_greeted_date = EXCLUDED.last_greeted_date, updated_at = NOW()`,
    [phone, today]
  );
}

export async function isReturningClient(phone: string): Promise<boolean> {
  const today = todayIso();
  const { rows } = await pool.query(
    `SELECT
       EXISTS(SELECT 1 FROM appointments WHERE phone = $1) AS has_appointments,
       (SELECT last_greeted_date::text FROM conversations WHERE phone = $1) AS last_greeted,
       (SELECT jsonb_array_length(messages) FROM conversations WHERE phone = $1) AS msg_count`,
    [phone]
  );
  const row = rows[0] as {
    has_appointments: boolean;
    last_greeted: string | null;
    msg_count: number | null;
  };
  if (row.has_appointments) return true;
  if (row.last_greeted && row.last_greeted.slice(0, 10) < today) return true;
  if ((row.msg_count ?? 0) > 2) return true;
  return false;
}

export function isFirstContactToday(
  lastGreetedDate: string | null,
  now = new Date()
): boolean {
  return lastGreetedDate !== todayIso(now);
}

export async function clearConversation(phone: string): Promise<void> {
  await pool.query(`DELETE FROM conversations WHERE phone = $1`, [phone]);
}
