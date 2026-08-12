/**
 * One-time Google Calendar OAuth login.
 * Creates secrets/google-oauth-token.json
 *
 * Prerequisites:
 * 1) Google Cloud Console → enable Google Calendar API
 * 2) Create OAuth client "Desktop app"
 * 3) Put GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in .env
 * 4) Run: npm run google:auth
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import { config as loadEnv } from "dotenv";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
loadEnv({ path: path.join(repoRoot, ".env") });

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const tokenPath =
  process.env.GOOGLE_OAUTH_TOKEN_PATH ||
  path.join(repoRoot, "secrets/google-oauth-token.json");
const calendarId = process.env.GOOGLE_CALENDAR_ID;
const redirectUri = "http://127.0.0.1:53682/oauth2callback";
const scopes = ["https://www.googleapis.com/auth/calendar"];

async function main() {
  if (!clientId || !clientSecret) {
    console.error(
      "Заполните GOOGLE_OAUTH_CLIENT_ID и GOOGLE_OAUTH_CLIENT_SECRET в .env"
    );
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
  });

  const code = await waitForCode(authUrl);
  const { tokens } = await oauth2.getToken(code);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(`Token saved: ${tokenPath}`);

  oauth2.setCredentials(tokens);
  const calendar = google.calendar({ version: "v3", auth: oauth2 });

  if (calendarId) {
    const probe = await calendar.calendars.get({ calendarId });
    console.log(`Calendar OK: ${probe.data.summary || calendarId}`);

    const test = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary: "Тест бота Улыбка столицы",
        description: "Проверка записи из WhatsApp AI — можно удалить",
        start: {
          dateTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          timeZone: process.env.TIMEZONE || "Asia/Almaty",
        },
        end: {
          dateTime: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
          timeZone: process.env.TIMEZONE || "Asia/Almaty",
        },
      },
    });
    console.log(`Test event created: ${test.data.htmlLink}`);
  } else {
    console.log("GOOGLE_CALENDAR_ID не задан — токен сохранён без теста события");
  }

  console.log("\nДальше в .env поставьте GOOGLE_CALENDAR_ENABLED=true и перезапустите бота.");
  process.exit(0);
}

function waitForCode(authUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url || "/", redirectUri);
        const code = url.searchParams.get("code");
        const err = url.searchParams.get("error");
        if (err) {
          res.end("Authorization failed. Можно закрыть окно.");
          server.close();
          reject(new Error(err));
          return;
        }
        if (!code) {
          res.end("No code");
          return;
        }
        res.end("Успешно! Можно закрыть окно и вернуться в терминал.");
        server.close();
        resolve(code);
      } catch (e) {
        reject(e);
      }
    });
    server.listen(53682, "127.0.0.1", () => {
      console.log("Откройте ссылку в браузере и войдите в Google-аккаунт календаря:\n");
      console.log(authUrl);
      console.log("\nЖду подтверждение...");
      // macOS
      import("node:child_process").then(({ exec }) => {
        exec(`open '${authUrl}'`);
      });
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
