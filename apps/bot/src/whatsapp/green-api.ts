import { env } from "../config/env.js";
import type { DialogOrchestrator } from "../ai/orchestrator.js";
import { normalizePhone } from "../booking/phone.js";
import { createDebouncedIngress, createPhoneQueue } from "./phone-queue.js";
import type { WhatsAppProvider } from "./provider.js";

export type { WhatsAppProvider } from "./provider.js";

/** Only handle journal messages newer than this (ms) after startup priming */
const JOURNAL_MAX_AGE_MS = 10 * 60 * 1000;
const JOURNAL_POLL_MS = 8000;
const JOURNAL_BACKOFF_MS = 30000;
/** Parallel dialogs across different phones */
const MAX_CONCURRENT_DIALOGS = 5;
/** Join rapid messages from the same phone into one turn */
const MESSAGE_COALESCE_MS = 1200;

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
  const queue = createPhoneQueue({ maxConcurrent: MAX_CONCURRENT_DIALOGS });
  const ingress = createDebouncedIngress<{
    idMessage: string;
    source: string;
  }>({
    queue,
    delayMs: MESSAGE_COALESCE_MS,
    combineTexts: (texts) => texts.join("\n").trim(),
    async run({ phone, text, metas }) {
      const sources = [...new Set(metas.map((m) => m.source))].join("+");
      try {
        console.log(
          `GREEN-API incoming (${sources}) from ${phone}: ${text.slice(0, 120)}`
        );
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
        for (const m of metas) {
          rememberId(m.idMessage);
          processing.delete(m.idMessage);
        }
      }
    },
  });

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
    if (res.status === 429) {
      console.warn("GREEN-API lastIncomingMessages 429 — пауза из‑за лимита");
      throw Object.assign(new Error("rate_limited"), { code: 429 });
    }
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

  /** Buffer + enqueue without waiting for LLM — poll loop stays free for other users. */
  function enqueueIncoming(params: {
    idMessage: string;
    phone: string;
    text: string;
    source: string;
  }): boolean {
    const { idMessage, phone, text, source } = params;
    if (!phone || !text) return false;
    if (processedIds.has(idMessage) || processing.has(idMessage)) return false;
    processing.add(idMessage);
    ingress.push(phone, text, { idMessage, source });
    return true;
  }

  function handleNotification(n: GreenNotification): void {
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
    enqueueIncoming({ idMessage, phone, text, source: "queue" });
  }

  async function pollJournalOnce(): Promise<number> {
    const list = await fetchJournal(15);
    let enqueued = 0;
    // Oldest first
    const ordered = [...list].reverse();
    for (const m of ordered) {
      if (!m.idMessage || processedIds.has(m.idMessage) || processing.has(m.idMessage)) {
        continue;
      }
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
        console.warn(
          `GREEN-API skip stale journal message ${m.idMessage} age=${Math.round((Date.now() - ts) / 1000)}s`
        );
        rememberId(m.idMessage);
        continue;
      }

      const phone = normalizePhone((m.senderId || chatId).split("@")[0] || "");
      if (
        enqueueIncoming({
          idMessage: m.idMessage,
          phone,
          text,
          source: "journal",
        })
      ) {
        enqueued += 1;
      }
    }
    return enqueued;
  }

  async function pollLoop(): Promise<void> {
    console.log(
      "GREEN-API: primary listen = lastIncomingMessages journal (queue often empty on this instance)"
    );
    let journalBackoffUntil = 0;
    let queueErrors = 0;
    while (!stopping) {
      try {
        if (Date.now() >= journalBackoffUntil) {
          try {
            await pollJournalOnce();
          } catch (err) {
            if ((err as { code?: number })?.code === 429) {
              journalBackoffUntil = Date.now() + JOURNAL_BACKOFF_MS;
            } else {
              throw err;
            }
          }
        }

        // Skip queue polling after repeated connect timeouts (journal is enough)
        if (queueErrors < 5) {
          try {
            const n = await receiveOnce(5);
            if (n) {
              queueErrors = 0;
              try {
                handleNotification(n);
              } finally {
                await deleteNotification(n.receiptId);
              }
            } else {
              await sleep(JOURNAL_POLL_MS);
            }
          } catch (err) {
            queueErrors += 1;
            const cause = err as { cause?: { code?: string }; code?: string };
            const code = cause?.cause?.code || cause?.code || "";
            if (code === "UND_ERR_CONNECT_TIMEOUT" || /fetch failed/i.test(String(err))) {
              console.warn(
                `GREEN-API queue poll timeout (${queueErrors}/5) — продолжаем через journal`
              );
            } else {
              console.error("GREEN-API queue poll error", err);
            }
            await sleep(JOURNAL_POLL_MS);
          }
        } else {
          await sleep(JOURNAL_POLL_MS);
        }
      } catch (err) {
        if (!stopping) {
          console.error("GREEN-API poll error", err);
          await sleep(5000);
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
      console.log(
        `GREEN-API: now listening for NEW messages only (up to ${MAX_CONCURRENT_DIALOGS} parallel dialogs)`
      );

      loopPromise = pollLoop();
    },
    async stop() {
      stopping = true;
      if (loopPromise) {
        await Promise.race([loopPromise, sleep(1500)]);
      }
      await ingress.drain(5000);
    },
    sendText,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
