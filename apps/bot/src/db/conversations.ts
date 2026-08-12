import { pool } from "../db/pool.js";
import type { ConversationMessage } from "../db/types.js";

const MAX_MESSAGES = 40;

export async function loadConversation(
  phone: string
): Promise<ConversationMessage[]> {
  const { rows } = await pool.query(
    `SELECT messages FROM conversations WHERE phone = $1`,
    [phone]
  );
  if (!rows[0]) return [];
  return (rows[0].messages as ConversationMessage[]) ?? [];
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

export async function clearConversation(phone: string): Promise<void> {
  await pool.query(`DELETE FROM conversations WHERE phone = $1`, [phone]);
}
