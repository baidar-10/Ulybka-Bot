# AI-бот WhatsApp для клиники «Улыбка столицы»

Бот отвечает пациентам в WhatsApp 24/7, консультирует по услугам, записывает / переносит / отменяет приёмы и сохраняет их в PostgreSQL + Google Calendar.

## Стек

- Node.js + TypeScript + Fastify
- PostgreSQL (источник правды по записям)
- OpenAI (`gpt-4o-mini` + tool calling)
- WhatsApp через Baileys (бесплатно, неофициально)
- Google Calendar API (по календарю на врача)

## Google Calendar

Календарь клиники уже прописан в `.env` (`GOOGLE_CALENDAR_ID`).

### Быстрый доступ через OAuth (рекомендуется для старта)

1. [Google Cloud Console](https://console.cloud.google.com/) → создайте проект
2. Включите **Google Calendar API**
3. APIs & Services → Credentials → Create Credentials → **OAuth client ID** → Application type: **Desktop app**
4. Скопируйте Client ID и Client Secret в `.env`:
   ```env
   GOOGLE_OAUTH_CLIENT_ID=...
   GOOGLE_OAUTH_CLIENT_SECRET=...
   GOOGLE_CALENDAR_ENABLED=true
   ```
5. Выполните:
   ```bash
   npm run google:auth
   ```
   Войдите в Google-аккаунт владельца календаря. Скрипт создаст тестовое событие и сохранит токен в `secrets/google-oauth-token.json`.
6. Перезапустите бота — новые записи из WhatsApp появятся в календаре.

### Альтернатива: Service Account

Скачайте JSON ключ сервисного аккаунта в `secrets/google-service-account.json`, расшарьте календарь на email сервисного аккаунта с правом «Изменение событий».

## WhatsApp через GREEN-API (рекомендуется)

1. Создайте инстанс на [console.green-api.com](https://console.green-api.com/).
2. В `.env` укажите:
   ```env
   WHATSAPP_PROVIDER=green-api
   GREEN_API_URL=https://7201.api.green-api.com
   GREEN_API_ID_INSTANCE=...
   GREEN_API_TOKEN_INSTANCE=...
   ```
3. В кабинете GREEN-API отсканируйте QR (**Link with QR code** → Get QR code).
4. Запустите бота — он сам забирает входящие через `receiveNotification` (туннель/ngrok не нужен).

Альтернатива: `WHATSAPP_PROVIDER=baileys` (неофициальный WhatsApp Web).

## Быстрый старт на VPS

### 1. Клонировать и настроить env

```bash
cd /opt/ulybka   # или ваш путь
cp .env.example .env
nano .env        # обязательно: OPENAI_API_KEY, пароль Postgres
```

### 2. Запуск через Docker Compose

```bash
docker compose up -d --build
docker compose logs -f bot
```

При первом запуске в логах появится **QR-код**. На телефоне с номером клиники:

WhatsApp → Связанные устройства → Привязать устройство → отсканировать QR.

Сессия сохранится в `data/whatsapp-auth/` — повторный QR не нужен, пока не разлогинитесь.

### 3. Проверка без WhatsApp

В `.env` можно временно поставить `WHATSAPP_ENABLED=false`, затем:

```bash
curl -s http://localhost:3000/health
curl -s -X POST http://localhost:3000/chat \
  -H 'content-type: application/json' \
  -d '{"phone":"77001234567","text":"Здравствуйте, хочу записаться к ортодонту"}'
```

## Локальная разработка (без Docker для бота)

```bash
# поднять только Postgres
docker compose up -d postgres

cp .env.example .env
# DATABASE_URL=postgres://ulybka:ulybka@localhost:5432/ulybka
# WHATSAPP_ENABLED=false для теста через /chat

npm install
npm run db:migrate
npm run db:seed
npm run dev
```

## Google Calendar

1. В Google Cloud создайте проект → включите **Google Calendar API**.
2. Создайте **Service Account**, скачайте JSON-ключ в `secrets/google-service-account.json`.
3. В Google Calendar создайте 3 календаря (по врачу) и расшарьте каждый на email service account с правом «Вносить изменения в события».
4. Узнайте Calendar ID каждого календаря (Настройки календаря → Идентификатор) и пропишите в БД:

```sql
UPDATE doctors SET google_calendar_id = 'asel@group.calendar.google.com' WHERE full_name = 'Абдикаримова Асель';
UPDATE doctors SET google_calendar_id = 'erzhan@group.calendar.google.com' WHERE full_name = 'Абдикаримов Ержан';
UPDATE doctors SET google_calendar_id = 'ansar@group.calendar.google.com' WHERE full_name = 'Масенов Ансар Алмазович';
```

5. В `.env`:

```env
GOOGLE_CALENDAR_ENABLED=true
GOOGLE_APPLICATION_CREDENTIALS=/secrets/google-service-account.json
```

В Docker путь уже смонтирован как `/secrets/...` — см. `docker-compose.yml`.

Пока `GOOGLE_CALENDAR_ENABLED=false`, записи работают только в PostgreSQL.

## Расписание клиники

| Дни | Часы |
|-----|------|
| Пн–Пт | 10:00–20:00 |
| Сб–Вс | 10:00–14:00 |

Таймзона по умолчанию: `Asia/Almaty`.

## API бота

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/health` | Healthcheck |
| POST | `/chat` | Тестовый диалог `{ phone, text }` |
| GET | `/doctors` | Список врачей |
| GET | `/services?doctor_id=` | Список услуг |

## Управление записями в чате

Пациент может написать боту, например:

- «Хочу записаться на чистку»
- «Мои записи»
- «Перенести запись на завтра в 11:00»
- «Отменить запись»
- «сброс» — начать диалог заново

## Важно про WhatsApp (Baileys)

Это неофициальный канал (WhatsApp Web). Для клиники лучше завести **отдельный номер**. Есть риск блокировки Meta — для продакшена позже можно заменить провайдер на Meta Cloud API без смены логики записи.

## Структура

```
apps/bot/          — Fastify + Baileys + OpenAI + booking
packages/db/       — миграции и seed
docker-compose.yml
secrets/           — google-service-account.json (не в git)
data/whatsapp-auth — сессия WhatsApp (не в git)
```

## Добавление врача / услуги

Достаточно INSERT в таблицы `doctors` / `services` (и calendar id). Логику бота менять не нужно — GPT читает каталог через tools.

Принудительно пересоздать каталог из seed (сотрёт записи!):

```bash
FORCE_SEED=true npm run db:seed
```
