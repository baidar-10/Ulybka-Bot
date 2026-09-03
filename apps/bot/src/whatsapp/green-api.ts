import { env } from "../config/env.js";
import type { DialogOrchestrator } from "../ai/orchestrator.js";
import { normalizePhone } from "../booking/phone.js";
import type { WhatsAppProvider } from "./provider.js";

export type { WhatsAppProvider } from "./provider.js";

/** Only handle journal messages newer than this (ms) after startup priming */
const JOURNAL_MAX_AGE_MS = 10 * 60 * 1000;
const JOURNAL_POLL_MS = 3000;

interface JournalMessage {
  type?: string;
  idMessage?: string;
  timestamp?: number;
  typeMessage?: string;
  chatId?: string;
  textMessage?: string;
  extendedTextMessage?: string;
  senderId?: string;
  senderName?: string;
}

interface GreenNotification {
  receiptId: number;
  body: {
    typeWebhook?: string;
    timestamp?: number;
    idMessage?: string;
    instanceData?: { wid?: string };
    senderData?: {
      chatId?: string;
      sender?: string;
      chatName?: string;
    };
    messageData?: {
      typeMessage?: string;
      textMessageData?: { textMessage?: string };
      extendedTextMessageData?: { text?: string };
    };
  };
}

function instanceBase(): string {
  const apiUrl = env.GREEN_API_URL.replace(/\/$/, "");
  return `${apiUrl}/waInstance${env.GREEN_API_ID_INSTANCE}`;
}

function token(): string {
  return env.GREEN_API_TOKEN_INSTANCE;
}

export function createGreenApiProvider(
  orchestrator: DialogOrchestrator
): WhatsAppProvider {
  let stopping = false;
  let loopPromise: Promise<void> | null = null;
  let readyAt = 0;
  const processing = new Set<string>();
  const processedIds = new Set<string>();

  function rememberId(id: string): void {
    processedIds.add(id);
    if (processedIds.size > 3000) {
      const first = processedIds.values().next().value;
      if (first) processedIds.delete(first);
    }
  }

  async function sendText(phone: string, text: string): Promise<void> {
    const chatId = `${normalizePhone(phone)}@c.us`;
    const url = `${instanceBase()}/sendMessage/${token()}`;
    console.log(`GREEN-API send → ${chatId} (${text.slice(0, 60)}…)`);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message: text }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GREEN-API sendMessage failed: ${res.status} ${body}`);
    }
  }

  async function deleteNotification(receiptId: number): Promise<void> {
    const url = `${instanceBase()}/deleteNotification/${token()}/${receiptId}`;
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.text();
      console.error(`GREEN-API deleteNotification failed: ${res.status} ${body}`);
    }
  }

  async function receiveOnce(timeoutSec = 5): Promise<GreenNotification | null> {
    const wait = Math.min(60, Math.max(5, timeoutSec));
    const url = `${instanceBase()}/receiveNotification/${token()}?receiveTimeout=${wait}`;
    const res = await fetch(url);
    const raw = (await res.text()).trim();
    if (res.status !== 200) {
      if (res.status !== 400 || !/webhook url is set/i.test(raw)) {
        console.error(
          `GREEN-API receiveNotification HTTP ${res.status}: ${raw.slice(0, 200) || "(empty)"}`
        );
      }
      return null;
    }
    if (!raw || raw === "null") return null;
    try {
      const data = JSON.parse(raw) as GreenNotification | null;
      if (!data || data.receiptId == null) return null;
      return data;
    } catch {
      return null;
    }
  }

  async function flushQueue(): Promise<number> {
    let cleared = 0;
    for (let i = 0; i < 50; i++) {
      const n = await receiveOnce(5);
      if (!n) break;
      if (n.body.idMessage) rememberId(n.body.idMessage);
      await deleteNotification(n.receiptId);
      cleared += 1;
    }
    return cleared;
  }

  async function fetchJournal(minutes = 30): Promise<JournalMessage[]> {
    const url = `${instanceBase()}/lastIncomingMessages/${token()}?minutes=${minutes}`;
    const res = await fetch(url);
    const raw = await res.text();
    if (!res.ok) {
      console.warn(`GREEN-API lastIncomingMessages HTTP ${res.status}: ${raw.slice(0, 200)}`);
      return [];
    }
    try {
      const data = JSON.parse(raw || "[]") as unknown;
      return Array.isArray(data) ? (data as JournalMessage[]) : [];
    } catch {
      return [];
    }
  }

  /** Mark existing journal messages as seen so we only reply to new ones. */
  async function primeJournal(): Promise<number> {
    const list = await fetchJournal(60);
    let marked = 0;
    for (const m of list) {
      if (m.idMessage) {
        rememberId(m.idMessage);
        marked += 1;
      }
    }
    const privateTexts = list.filter(
      (m) =>
        m.typeMessage === "textMessage" &&
        m.chatId &&
        !m.chatId.endsWith("@g.us") &&
        (m.textMessage || "").trim()
    );
    console.log(
      `GREEN-API journal prime: ${marked} ids marked, ${privateTexts.length} private texts in last 60m (will not auto-reply to these)`
    );
    for (const m of privateTexts.slice(0, 3)) {
      console.log(
        `  · seen ${m.chatId}: ${(m.textMessage || "").slice(0, 50)}`
      );
    }
    return marked;
  }

  async function ensureHttpApiMode(): Promise<void> {
    const url = `${instanceBase()}/setSettings/${token()}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        webhookUrl: "",
        webhookUrlToken: "",
        incomingWebhook: "yes",
        outgoingWebhook: "no",
        outgoingAPIMessageWebhook: "no",
        outgoingMessageWebhook: "no",
        stateWebhook: "no",
        editedMessageWebhook: "no",
        deletedMessageWebhook: "no",
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`GREEN-API setSettings warning: ${res.status} ${body}`);
    } else {
      console.log("GREEN-API: webhookUrl cleared; listening via journal + receiveNotification");
    }

    try {
      const settingsRes = await fetch(`${instanceBase()}/getSettings/${token()}`);
      if (settingsRes.ok) {
        const settings = (await settingsRes.json()) as {
          webhookUrl?: string;
          incomingWebhook?: string;
        };
        console.log(
          `GREEN-API settings: webhookUrl="${settings.webhookUrl || ""}" incomingWebhook=${settings.incomingWebhook || "?"}`
        );
      }
    } catch (err) {
      console.warn("GREEN-API getSettings failed", err);
    }
  }

  async function checkState(): Promise<string> {
    const url = `${instanceBase()}/getStateInstance/${token()}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`getStateInstance failed: ${res.status} ${body}`);
    }
    const data = (await res.json()) as { stateInstance?: string };
    return data.stateInstance || "unknown";
  }

  async function handleIncoming(params: {
    idMessage: string;
    phone: string;
    text: string;
    source: string;
  }): Promise<void> {
    const { idMessage, phone, text, source } = params;
    if (!phone || !text) return;
    if (processedIds.has(idMessage) || processing.has(idMessage)) return;
    processing.add(idMessage);
    rememberId(idMessage);

    try {
      console.log(`GREEN-API incoming (${source}) from ${phone}: ${text.slice(0, 80)}`);
      const reply = await orchestrator.handleMessage({ phone, text });
      await sendText(phone, reply);
    } catch (err) {
      console.error("Failed to handle GREEN-API message", err);
      try {
        await sendText(
          phone,
          "Произошла ошибка. Попробуйте ещё раз чуть позже."
        );
      } catch {
        /* ignore */
      }
    } finally {
      processing.delete(idMessage);
    }
  }

  async function handleNotification(n: GreenNotification): Promise<void> {
    if (n.body.typeWebhook !== "incomingMessageReceived") return;
    const chatId = n.body.senderData?.chatId || "";
    if (chatId.endsWith("@g.us") || chatId.includes("status@broadcast")) return;

    const wid = n.body.instanceData?.wid || "";
    const sender = n.body.senderData?.sender || "";
    if (wid && sender && wid === sender) return;

    const md = n.body.messageData;
    let text: string | null = null;
    if (md?.typeMessage === "textMessage") {
      text = md.textMessageData?.textMessage?.trim() || null;
    } else if (
      md?.typeMessage === "extendedTextMessage" ||
      md?.typeMessage === "quotedMessage"
    ) {
      text = md.extendedTextMessageData?.text?.trim() || null;
    }
    if (!text) return;

    const raw = sender || chatId;
    const phone = normalizePhone(raw.split("@")[0] || "");
    const idMessage = n.body.idMessage || `${phone}:${n.receiptId}`;
    await handleIncoming({ idMessage, phone, text, source: "queue" });
  }

  async function pollJournalOnce(): Promise<number> {
    const list = await fetchJournal(15);
    let handled = 0;
    // Process oldest first
    const ordered = [...list].reverse();
    for (const m of ordered) {
      if (!m.idMessage || processedIds.has(m.idMessage)) continue;
      if (m.typeMessage !== "textMessage" && m.typeMessage !== "extendedTextMessage") {
        rememberId(m.idMessage);
        continue;
      }
      const chatId = m.chatId || m.senderId || "";
      if (!chatId || chatId.endsWith("@g.us") || chatId.includes("status@broadcast")) {
        rememberId(m.idMessage);
        continue;
      }
      const text = (m.textMessage || m.extendedTextMessage || "").trim();
      if (!text) {
        rememberId(m.idMessage);
        continue;
      }
      const ts = m.timestamp ? m.timestamp * 1000 : 0;
      // After priming, ignore very old journal noise; allow recent messages
      if (readyAt && ts && ts < readyAt - 15_000) {
        rememberId(m.idMessage);
        continue;
      }
      if (ts && Date.now() - ts > JOURNAL_MAX_AGE_MS) {
        rememberId(m.idMessage);
        continue;
      }

      const phone = normalizePhone((m.senderId || chatId).split("@")[0] || "");
      await handleIncoming({
        idMessage: m.idMessage,
        phone,
        text,
        source: "journal",
      });
      handled += 1;
    }
    return handled;
  }

  async function pollLoop(): Promise<void> {
    console.log("GREEN-API: primary listen = lastIncomingMessages journal (queue often empty on this instance)");
    while (!stopping) {
      try {
        // Drain notification queue if anything appears (bonus path)
        const n = await receiveOnce(5);
        if (n) {
          try {
            await handleNotification(n);
          } finally {
            await deleteNotification(n.receiptId);
          }
        }

        const handled = await pollJournalOnce();
        if (!handled && !n) {
          await sleep(JOURNAL_POLL_MS);
        }
      } catch (err) {
        if (!stopping) {
          console.error("GREEN-API poll error", err);
          await sleep(3000);
        }
      }
    }
  }

  return {
    async start() {
      if (!env.GREEN_API_ID_INSTANCE || !env.GREEN_API_TOKEN_INSTANCE) {
        throw new Error(
          "GREEN_API_ID_INSTANCE and GREEN_API_TOKEN_INSTANCE are required"
        );
      }
      stopping = false;
      await ensureHttpApiMode();
      const state = await checkState();
      console.log(`GREEN-API stateInstance=${state}`);
      if (state !== "authorized") {
        console.log(
          "Инстанс не авторизован. В кабинете GREEN-API нажмите Get QR code и отсканируйте WhatsApp → Связанные устройства."
        );
      } else {
        console.log("GREEN-API WhatsApp authorized");
      }

      const cleared = await flushQueue();
      console.log(`GREEN-API: cleared ${cleared} queue notification(s)`);
      await primeJournal();
      readyAt = Date.now();
      console.log("GREEN-API: now listening for NEW messages only");

      loopPromise = pollLoop();
    },
    async stop() {
      stopping = true;
      if (loopPromise) {
        await Promise.race([loopPromise, sleep(1500)]);
      }
    },
    sendText,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
