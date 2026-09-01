import Fastify from "fastify";
import { env } from "./config/env.js";
import { pool } from "./db/pool.js";
import { BookingService } from "./booking/service.js";
import { DialogOrchestrator } from "./ai/orchestrator.js";
import {
  createBaileysProvider,
  createNullWhatsAppProvider,
} from "./whatsapp/baileys.js";
import { createGreenApiProvider } from "./whatsapp/green-api.js";
import { createMacdentClient } from "./macdent/client.js";
import { MacdentSchedule } from "./macdent/schedule.js";
import { startNotificationScheduler } from "./jobs/scheduler.js";

async function main() {
  const macdent = createMacdentClient();
  const booking = new BookingService(
    macdent.enabled ? new MacdentSchedule(macdent) : undefined
  );
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
      whatsapp: env.WHATSAPP_ENABLED,
      provider: env.WHATSAPP_PROVIDER,
      macdent: macdent.enabled,
    };
  });

  let stopNotifications = () => {};

  const shutdown = async () => {
    app.log.info("Shutting down...");
    stopNotifications();
    await whatsapp.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  app.log.info(`HTTP listening on :${env.PORT}`);

  stopNotifications = startNotificationScheduler(whatsapp);
  app.log.info("Notification scheduler started (reminders + follow-up)");

  await whatsapp.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
