import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { Boom } from "@hapi/boom";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import QRCode from "qrcode";
import qrcode from "qrcode-terminal";
import { env } from "../config/env.js";
import type { DialogOrchestrator } from "../ai/orchestrator.js";
import { normalizePhone } from "../booking/service.js";
import type { WhatsAppProvider } from "./provider.js";

export type { WhatsAppProvider } from "./provider.js";

const waLogger = pino({ level: "silent" });

export function createBaileysProvider(
  orchestrator: DialogOrchestrator
): WhatsAppProvider {
  let sock: WASocket | null = null;
  let stopping = false;
  const processing = new Set<string>();

  async function handleIncoming(phone: string, text: string, jid: string) {
    const key = `${phone}:${text}`;
    if (processing.has(key)) return;
    processing.add(key);
    try {
      const reply = await orchestrator.handleMessage({ phone, text });
      if (sock) {
        await sock.sendMessage(jid, { text: reply });
      }
    } catch (err) {
      console.error("Failed to handle WhatsApp message", err);
      if (sock) {
        await sock.sendMessage(jid, {
          text: "Произошла ошибка. Попробуйте ещё раз чуть позже.",
        });
      }
    } finally {
      processing.delete(key);
    }
  }

  async function connect(): Promise<void> {
    fs.mkdirSync(env.WHATSAPP_AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(
      env.WHATSAPP_AUTH_DIR
    );
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, waLogger),
      },
      logger: waLogger,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log("\n=== Отсканируйте QR-код в WhatsApp (Связанные устройства) ===\n");
        qrcode.generate(qr, { small: true });
        const qrPath = path.join(path.dirname(path.resolve(env.WHATSAPP_AUTH_DIR)), "whatsapp-qr.png");
        QRCode.toFile(qrPath, qr, { width: 480, margin: 2 })
          .then(() => console.log(`QR также сохранён в файл: ${qrPath}`))
          .catch((err) => console.error("Failed to save QR png", err));
      }
      if (connection === "open") {
        console.log("WhatsApp connected");
      }
      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output
          ?.statusCode;
        const shouldReconnect =
          !stopping && statusCode !== DisconnectReason.loggedOut;
        console.log(
          `WhatsApp disconnected (code=${statusCode}), reconnect=${shouldReconnect}`
        );
        if (statusCode === DisconnectReason.loggedOut) {
          console.log(
            "Logged out. Clearing auth and waiting for new QR on restart..."
          );
          try {
            fs.rmSync(env.WHATSAPP_AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(env.WHATSAPP_AUTH_DIR, { recursive: true });
          } catch {
            /* ignore */
          }
        }
        if (shouldReconnect) {
          setTimeout(() => {
            connect().catch((err) =>
              console.error("WhatsApp reconnect failed", err)
            );
          }, 3000);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") {
          continue;
        }

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          "";

        if (!text) continue;

        const phone = normalizePhone(jid.split("@")[0] || "");
        if (!phone) continue;

        await handleIncoming(phone, text, jid);
      }
    });
  }

  return {
    async start() {
      stopping = false;
      await connect();
    },
    async stop() {
      stopping = true;
      try {
        sock?.end(undefined);
      } catch {
        /* ignore */
      }
      sock = null;
    },
    async sendText(phone: string, text: string) {
      if (!sock) throw new Error("WhatsApp not connected");
      const jid = `${normalizePhone(phone)}@s.whatsapp.net`;
      await sock.sendMessage(jid, { text });
    },
  };
}

/** No-op provider for local API-only testing */
export function createNullWhatsAppProvider(): WhatsAppProvider {
  return {
    async start() {
      console.log("WhatsApp disabled (WHATSAPP_ENABLED=false)");
    },
    async stop() {},
    async sendText(phone, text) {
      console.log(`[whatsapp:null] to=${phone} text=${text}`);
    },
  };
}
