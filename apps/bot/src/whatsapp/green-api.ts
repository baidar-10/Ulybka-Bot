import { env } from "../config/env.js";
import type { DialogOrchestrator } from "../ai/orchestrator.js";
import { normalizePhone } from "../booking/service.js";
import type { WhatsAppProvider } from "./provider.js";

export type { WhatsAppProvider } from "./provider.js";

/** Ignore queued/old messages older than this (ms) */
const MAX_MESSAGE_AGE_MS = 2 * 60 * 1000;

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

  async function receiveOnce(timeoutSec = 1): Promise<GreenNotification | null> {
    const url = `${instanceBase()}/receiveNotification/${token()}?receiveTimeout=${timeoutSec}`;
    const res = await fetch(url);
    if (res.status !== 200) return null;
    const data = (await res.json()) as GreenNotification | null;
    if (!data || data.receiptId == null) return null;
    return data;
  }

  /** Clear backlog so bot does not reply to old queued chats on startup */
  async function flushQueue(): Promise<number> {
    let cleared = 0;
    for (let i = 0; i < 200; i++) {
      const n = await receiveOnce(1);
      if (!n) break;
      await deleteNotification(n.receiptId);
      cleared += 1;
    }
    return cleared;
  }

  async function ensureHttpApiMode(): Promise<void> {
    const url = `${instanceBase()}/setSettings/${token()}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        webhookUrl: "",
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
      console.log("GREEN-API: incoming via receiveNotification (HTTP API)");
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

  function extractText(n: GreenNotification): string | null {
    const md = n.body.messageData;
    if (!md) return null;
    // Ignore non-chat noise
    if (
      md.typeMessage &&
      ![
        "textMessage",
        "extendedTextMessage",
        "quotedMessage",
      ].includes(md.typeMessage)
    ) {
      return null;
    }
    if (md.typeMessage === "textMessage") {
      return md.textMessageData?.textMessage?.trim() || null;
    }
    if (
      md.typeMessage === "extendedTextMessage" ||
      md.typeMessage === "quotedMessage"
    ) {
      return md.extendedTextMessageData?.text?.trim() || null;
    }
    return null;
  }

  function shouldSkip(n: GreenNotification): string | null {
    const type = n.body.typeWebhook;
    if (type !== "incomingMessageReceived") {
      return `skip type=${type}`;
    }

    const chatId = n.body.senderData?.chatId || "";
    if (chatId.endsWith("@g.us")) return "skip group";
    if (chatId.includes("status@broadcast")) return "skip status";

    const wid = n.body.instanceData?.wid || "";
    const sender = n.body.senderData?.sender || "";
    // Don't treat own account echoes as patient messages
    if (wid && sender && wid === sender) return "skip self";

    const idMessage = n.body.idMessage;
    if (idMessage && processedIds.has(idMessage)) {
      return `skip duplicate ${idMessage}`;
    }

    const ts = n.body.timestamp ? n.body.timestamp * 1000 : 0;
    if (ts && Date.now() - ts > MAX_MESSAGE_AGE_MS) {
      return `skip old message age=${Math.round((Date.now() - ts) / 1000)}s`;
    }
    // Also ignore anything that arrived before we finished startup flush
    if (readyAt && ts && ts < readyAt - 5000) {
      return "skip pre-start message";
    }

    return null;
  }

  async function handleNotification(n: GreenNotification): Promise<void> {
    const skip = shouldSkip(n);
    if (skip) {
      console.log(`GREEN-API ${skip}`);
      return;
    }

    const text = extractText(n);
    if (!text) {
      console.log(
        `GREEN-API skip non-text type=${n.body.messageData?.typeMessage}`
      );
      return;
    }

    const raw =
      n.body.senderData?.sender || n.body.senderData?.chatId || "";
    const phone = normalizePhone(raw.split("@")[0] || "");
    if (!phone) return;

    const idMessage = n.body.idMessage || `${phone}:${n.receiptId}`;
    const key = idMessage;
    if (processing.has(key)) return;
    processing.add(key);
    processedIds.add(idMessage);
    // keep set bounded
    if (processedIds.size > 2000) {
      const first = processedIds.values().next().value;
      if (first) processedIds.delete(first);
    }

    try {
      console.log(`GREEN-API incoming from ${phone}: ${text.slice(0, 80)}`);
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
      processing.delete(key);
    }
  }

  async function pollLoop(): Promise<void> {
    while (!stopping) {
      try {
        const data = await receiveOnce(10);
        if (data) {
          try {
            await handleNotification(data);
          } finally {
            await deleteNotification(data.receiptId);
          }
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
      readyAt = Date.now();
      console.log(
        `GREEN-API: cleared ${cleared} old notification(s), now listening for new messages only`
      );

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
