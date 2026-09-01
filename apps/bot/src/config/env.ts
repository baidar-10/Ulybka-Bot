import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);
loadEnv({ path: path.join(repoRoot, ".env") });
loadEnv(); // optional apps/bot/.env override

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z
    .string()
    .default("postgres://ulybka:ulybka@localhost:5432/ulybka"),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  TIMEZONE: z.string().default("Asia/Almaty"),
  WHATSAPP_AUTH_DIR: z.string().default(path.join(repoRoot, "data/whatsapp-auth")),
  WHATSAPP_PROVIDER: z.enum(["baileys", "green-api", "none"]).default("green-api"),
  WHATSAPP_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  GREEN_API_URL: z.string().default("https://7201.api.green-api.com"),
  GREEN_API_ID_INSTANCE: z.string().default(""),
  GREEN_API_TOKEN_INSTANCE: z.string().default(""),
  CLINIC_NAME: z.string().default("Улыбка столицы"),
  CLINIC_ADDRESS: z.string().default(""),
  LOG_LEVEL: z.string().default("info"),
  MACDENT_API_URL: z.string().default("https://api-developer.macdent.kz"),
  MACDENT_API_KEY: z.string().default(""),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.parse(process.env);

export const env: Env = {
  ...parsed,
  WHATSAPP_AUTH_DIR: path.isAbsolute(parsed.WHATSAPP_AUTH_DIR)
    ? parsed.WHATSAPP_AUTH_DIR
    : path.resolve(repoRoot, parsed.WHATSAPP_AUTH_DIR),
};

export { repoRoot };
