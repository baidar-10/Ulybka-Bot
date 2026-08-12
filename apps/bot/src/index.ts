import Fastify from "fastify";
import { env } from "./config/env.js";
import { pool } from "./db/pool.js";
import { BookingService } from "./booking/service.js";
import { createGoogleCalendarClient } from "./calendar/google.js";
import { DialogOrchestrator } from "./ai/orchestrator.js";
import {
  createBaileysProvider,
  createNullWhatsAppProvider,
} from "./whatsapp/baileys.js";
import { createGreenApiProvider } from "./whatsapp/green-api.js";
import { normalizePhone } from "./booking/service.js";

async function main() {
  const calendar = createGoogleCalendarClient();
  const booking = new BookingService(calendar);
  const orchestrator = new DialogOrchestrator(booking);

  const whatsapp = !env.WHATSAPP_ENABLED || env.WHATSAPP_PROVIDER === "none"
    ? createNullWhatsAppProvider()
    : env.WHATSAPP_PROVIDER === "green-api"
      ? createGreenApiProvider(orchestrator)
      : createBaileysProvider(orchestrator);

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
  });

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return {
      ok: true,
      clinic: env.CLINIC_NAME,
      googleCalendar: calendar.enabled,
      googleCalendarId: env.GOOGLE_CALENDAR_ID || null,
      whatsapp: env.WHATSAPP_ENABLED,
      provider: env.WHATSAPP_PROVIDER,
    };
  });

  /** Local/dev chat endpoint to test without WhatsApp */
  app.post<{
    Body: { phone?: string; text?: string };
  }>("/chat", async (req, reply) => {
    const phone = normalizePhone(req.body?.phone || "77001112233");
    const text = (req.body?.text || "").trim();
    if (!text) {
      return reply.code(400).send({ error: "text is required" });
    }
    const response = await orchestrator.handleMessage({ phone, text });
    return { phone, response };
  });

  app.get("/doctors", async () => booking.listDoctors());
  app.get("/services", async (req) => {
    const doctorId = (req.query as { doctor_id?: string }).doctor_id;
    return booking.listServices(
      doctorId ? Number(doctorId) : undefined
    );
  });

  const shutdown = async () => {
    app.log.info("Shutting down...");
    await whatsapp.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  app.log.info(`HTTP listening on :${env.PORT}`);

  await whatsapp.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
