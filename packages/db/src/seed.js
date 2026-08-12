import pg from "pg";

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgres://ulybka:ulybka@localhost:5432/ulybka";

/** @type {Array<{full_name: string, specialization: string, color: string, services: Array<{name: string, duration_minutes: number, description?: string}>}>} */
const doctors = [
  {
    full_name: "Абдикаримова Асель",
    specialization: "Ортодонт",
    color: "#4A90D9",
    services: [
      { name: "Консультация ортодонта", duration_minutes: 30 },
      { name: "Диагностика", duration_minutes: 45 },
      { name: "Составление плана лечения", duration_minutes: 45 },
      { name: "Установка металлических брекетов", duration_minutes: 90 },
      { name: "Установка керамических брекетов", duration_minutes: 90 },
      { name: "Установка сапфировых брекетов", duration_minutes: 90 },
      { name: "Самолигирующие брекет-системы", duration_minutes: 90 },
      { name: "Установка лингвальных брекетов", duration_minutes: 120 },
      { name: "Установка элайнеров (кап)", duration_minutes: 60 },
      { name: "Исправление прикуса", duration_minutes: 60 },
      { name: "Лечение скученности зубов", duration_minutes: 60 },
      { name: "Исправление положения отдельных зубов", duration_minutes: 60 },
      {
        name: "Подготовка к имплантации и протезированию",
        duration_minutes: 45,
      },
      { name: "Контрольный осмотр", duration_minutes: 20 },
      { name: "Замена дуг", duration_minutes: 30 },
      { name: "Замена лигатур", duration_minutes: 20 },
      { name: "Активация брекет-систем", duration_minutes: 30 },
      { name: "Снятие брекетов", duration_minutes: 60 },
      { name: "Установка ретейнеров", duration_minutes: 45 },
      { name: "Изготовление ретенционных кап", duration_minutes: 45 },
      { name: "Ортодонтическое сопровождение", duration_minutes: 30 },
    ],
  },
  {
    full_name: "Абдикаримов Ержан",
    specialization: "Стоматолог-терапевт",
    color: "#2ECC71",
    services: [
      { name: "Первичная консультация", duration_minutes: 30 },
      { name: "Диагностика", duration_minutes: 30 },
      { name: "Осмотр полости рта", duration_minutes: 20 },
      { name: "Лечение кариеса", duration_minutes: 45 },
      { name: "Лечение среднего кариеса", duration_minutes: 45 },
      { name: "Лечение глубокого кариеса", duration_minutes: 60 },
      { name: "Эстетическая реставрация зубов", duration_minutes: 60 },
      { name: "Пломбирование", duration_minutes: 45 },
      { name: "Замена старых пломб", duration_minutes: 45 },
      { name: "Лечение пульпита", duration_minutes: 90 },
      { name: "Лечение периодонтита", duration_minutes: 90 },
      { name: "Эндодонтическое лечение", duration_minutes: 90 },
      { name: "Лечение корневых каналов", duration_minutes: 90 },
      { name: "Перелечивание каналов", duration_minutes: 90 },
      { name: "Профессиональная гигиена", duration_minutes: 60 },
      { name: "Удаление зубного камня", duration_minutes: 45 },
      { name: "Ультразвуковая чистка", duration_minutes: 45 },
      { name: "Air Flow", duration_minutes: 45 },
      { name: "Полировка зубов", duration_minutes: 30 },
      { name: "Реминерализация", duration_minutes: 30 },
      { name: "Фторирование", duration_minutes: 20 },
      { name: "Лечение повышенной чувствительности", duration_minutes: 30 },
      { name: "Профилактический осмотр", duration_minutes: 20 },
      { name: "Рентген-диагностика", duration_minutes: 15 },
    ],
  },
  {
    full_name: "Масенов Ансар Алмазович",
    specialization: "Стоматолог-терапевт",
    color: "#E67E22",
    services: [
      { name: "Консультация", duration_minutes: 30 },
      { name: "Диагностика", duration_minutes: 30 },
      { name: "Лечение кариеса", duration_minutes: 45 },
      { name: "Лечение пульпита", duration_minutes: 90 },
      { name: "Лечение периодонтита", duration_minutes: 90 },
      { name: "Лечение корневых каналов", duration_minutes: 90 },
      { name: "Реставрация зубов", duration_minutes: 60 },
      { name: "Пломбирование", duration_minutes: 45 },
      { name: "Профессиональная чистка", duration_minutes: 60 },
      { name: "Air Flow", duration_minutes: 45 },
      { name: "Снятие зубного камня", duration_minutes: 45 },
      { name: "Фторирование", duration_minutes: 20 },
      { name: "Профилактика заболеваний полости рта", duration_minutes: 30 },
      { name: "Контрольный осмотр", duration_minutes: 20 },
    ],
  },
];

const clinicHours = [
  { day_of_week: 1, open_time: "10:00", close_time: "20:00" },
  { day_of_week: 2, open_time: "10:00", close_time: "20:00" },
  { day_of_week: 3, open_time: "10:00", close_time: "20:00" },
  { day_of_week: 4, open_time: "10:00", close_time: "20:00" },
  { day_of_week: 5, open_time: "10:00", close_time: "20:00" },
  { day_of_week: 6, open_time: "10:00", close_time: "14:00" },
  { day_of_week: 0, open_time: "10:00", close_time: "14:00" },
];

async function seed() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const force = process.env.FORCE_SEED === "true";

  try {
    const { rows: existing } = await client.query(
      "SELECT COUNT(*)::int AS count FROM doctors"
    );
    if (existing[0].count > 0 && !force) {
      console.log("seed skipped: doctors already present (set FORCE_SEED=true to reset catalog)");
      return;
    }

    await client.query("BEGIN");

    if (force) {
      await client.query("DELETE FROM appointments");
      await client.query("DELETE FROM services");
      await client.query("DELETE FROM doctors");
      await client.query("DELETE FROM clinic_hours");
    }

    for (const hour of clinicHours) {
      await client.query(
        `INSERT INTO clinic_hours (day_of_week, open_time, close_time)
         VALUES ($1, $2, $3)
         ON CONFLICT (day_of_week) DO UPDATE
           SET open_time = EXCLUDED.open_time, close_time = EXCLUDED.close_time`,
        [hour.day_of_week, hour.open_time, hour.close_time]
      );
    }

    for (const doctor of doctors) {
      const { rows } = await client.query(
        `INSERT INTO doctors (full_name, specialization, color, active)
         VALUES ($1, $2, $3, TRUE)
         RETURNING id`,
        [doctor.full_name, doctor.specialization, doctor.color]
      );
      const doctorId = rows[0].id;

      for (const service of doctor.services) {
        await client.query(
          `INSERT INTO services (name, doctor_id, duration_minutes, description, active)
           VALUES ($1, $2, $3, $4, TRUE)`,
          [
            service.name,
            doctorId,
            service.duration_minutes,
            service.description || service.name,
          ]
        );
      }
    }

    await client.query("COMMIT");
    console.log(`seeded ${doctors.length} doctors, hours, and services`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
