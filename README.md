# AI-бот WhatsApp для клиники «Улыбка столицы»

Бот отвечает пациентам в WhatsApp 24/7, консультирует по услугам, записывает / переносит / отменяет приёмы и сохраняет их в PostgreSQL.

## Стек

- Node.js + TypeScript + Fastify
- PostgreSQL (источник правды по записям)
- OpenAI (`gpt-4o-mini` + tool calling)
- WhatsApp через GREEN-API или Baileys
- MacDent API (ключ клиники)

## MacDent

В `.env` укажите ключ из кабинета MacDent:

```env
MACDENT_API_URL=https://api-developer.macdent.kz
MACDENT_API_KEY=your_macdent_api_key
```

Пока ключ пустой, бот стартует без MacDent (`macdent: false` в `/health`). Если ключ задан, запись и слоты идут через API [документации MacDent](https://docs-developer.macdent.kz/methods).

Используемые методы:

| Метод | Назначение |
|-------|------------|
| `doctor/find` | Список врачей (`id`, `name`, `filials`) |
| `rasp/find` | Расписание врача на месяц (`perDayData` — интервалы по дням) |
| `zapis/find` | Занятые приёмы (`start`/`end`, статус `2` / DECLINED не занимает слот) |
| `doctor/get_free_time` | Запасной запрос свободных окон, если в `rasp` нет интервалов |
| `schedule/get` | Второй запасной запрос свободных окон |
| `patient/find` | Найти пациента по телефону |
| `patient/add` | Создать пациента, если его ещё нет |
| `zapis/add` | Создать запись (`doctor`, `rasp`, `patient`, `start`, `end`) |
| `zapis/update` | Перенести запись |
| `zapis/remove` | Удалить запись |
| `zapis/set_status` | Отмена, если `zapis/remove` недоступен |

`appointment.send` — это заявка в CRM (имя/телефон), не ячейка в таблице «Расписание». Бот пишет в расписание через `zapis`.

PDF из папки `docs/` в образ Docker не копируются (см. `.dockerignore`).

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

При первом запуске Baileys в логах появится **QR-код**. На телефоне с номером клиники:

WhatsApp → Связанные устройства → Привязать устройство → отсканировать QR.

Сессия сохранится в `data/whatsapp-auth/` — повторный QR не нужен, пока не разлогинитесь.

### 3. Проверка

```bash
curl -s http://localhost:3000/health
```

## Локальная разработка (без Docker для бота)

```bash
# поднять только Postgres
docker compose up -d postgres

cp .env.example .env
# DATABASE_URL=postgres://ulybka:ulybka@localhost:5432/ulybka

npm install
npm run db:migrate
npm run db:seed
npm run dev
```

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
apps/bot/          — Fastify + WhatsApp + OpenAI + booking
packages/db/       — миграции и seed
docker-compose.yml
data/whatsapp-auth — сессия WhatsApp (не в git)
```

## Добавление врача / услуги

Достаточно INSERT в таблицы `doctors` / `services`. Логику бота менять не нужно — GPT читает каталог через tools.

Принудительно пересоздать каталог из seed (сотрёт записи!):

```bash
FORCE_SEED=true npm run db:seed
```
