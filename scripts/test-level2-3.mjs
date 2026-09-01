/**
 * Automated checks for test plan levels 2–3.
 * Run: docker cp scripts/test-level2-3.mjs ulybka-bot-bot-1:/tmp/ && docker compose exec -T bot node /tmp/test-level2-3.mjs
 */
import { createMacdentClient } from "./apps/bot/dist/macdent/client.js";
import { MacdentSchedule } from "./apps/bot/dist/macdent/schedule.js";
import { BookingService } from "./apps/bot/dist/booking/service.js";
import {
  generateSlots,
  zonedDateTime,
} from "./apps/bot/dist/booking/slots.js";

const TZ = "Asia/Almaty";
let passed = 0;
let failed = 0;

function ok(label) {
  passed++;
  console.log(`  ✅ ${label}`);
}
function fail(label, detail) {
  failed++;
  console.log(`  ❌ ${label}: ${detail}`);
}

// --- Level 3.1: slot generation ---
console.log("\n=== Уровень 3.1 — Генерация слотов ===");
try {
  const slots = generateSlots({
    dateStr: "2026-09-03",
    durationMinutes: 30,
    hours: { day_of_week: 4, open_time: "10:00", close_time: "20:00" },
    busy: [],
    timeZone: TZ,
    now: zonedDateTime(2026, 9, 3, 9, 0, TZ),
  });
  if (slots[0] === "10:00" && slots.at(-1) === "19:30") ok("Будни 10:00–19:30");
  else fail("Будни", `got ${slots[0]}..${slots.at(-1)}`);

  const sat = generateSlots({
    dateStr: "2026-09-05",
    durationMinutes: 60,
    hours: { day_of_week: 6, open_time: "10:00", close_time: "14:00" },
    busy: [],
    timeZone: TZ,
    now: zonedDateTime(2026, 9, 5, 9, 0, TZ),
  });
  if (sat.includes("13:00") && !sat.includes("14:00")) ok("Суббота до 13:00");
  else fail("Суббота", sat.join(", "));
} catch (e) {
  fail("slot generation", e.message);
}

// --- Level 2.1: MacDent doctors ---
console.log("\n=== Уровень 2.1 — MacDent doctor/find ===");
const macdent = createMacdentClient();
if (!macdent.enabled) {
  fail("MacDent client", "not enabled");
} else {
  try {
    const doctors = await macdent.call("doctor/find", {});
    const list = Array.isArray(doctors) ? doctors : [];
    if (list.length > 0) {
      ok(`Врачей в MacDent: ${list.length}`);
      list.slice(0, 5).forEach((d) =>
        console.log(`     • id=${d.id} name=${d.name || d.full_name}`)
      );
    } else {
      fail("doctor/find", `пустой ответ: ${JSON.stringify(doctors).slice(0, 200)}`);
    }
  } catch (e) {
    fail("doctor/find", e.message);
  }
}

// --- Level 2.2: MacDent free time ---
console.log("\n=== Уровень 2.2 — MacDent свободные слоты ===");
if (macdent.enabled) {
  try {
    const schedule = new MacdentSchedule(macdent);
    const doctors = await macdent.call("doctor/find", {});
    const list = Array.isArray(doctors) ? doctors : [];
    if (list.length > 0) {
      const doc = list[0];
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const iso = tomorrow.toISOString().slice(0, 10);
      const { slots } = await schedule.getDayAvailability(
        String(doc.id),
        iso,
        30
      );
      if (Array.isArray(slots) && slots.length > 0) {
        ok(`Слоты на ${iso} для ${doc.name}: ${slots.length} шт. (${slots.slice(0, 3).join(", ")}...)`);
      } else if (Array.isArray(slots) && slots.length === 0) {
        ok(`Слоты на ${iso}: пусто (врач не работает или всё занято)`);
      } else {
        fail("getDaySlots", JSON.stringify(slots).slice(0, 200));
      }
    }
  } catch (e) {
    fail("getDaySlots", e.message);
  }
}

// --- Level 3.2: Booking CRUD (local DB, no MacDent write) ---
console.log("\n=== Уровень 3.2 — Booking CRUD (локальная БД) ===");
try {
  const b = new BookingService();
  const date = "2026-09-10";
  const slots = await b.findSlots({ doctorId: 1, date, serviceId: 1 });
  if (slots.slots.length > 0) ok(`findSlots: ${slots.slots.length} слотов для врача #1`);
  else fail("findSlots", "нет слотов");

  const time = slots.slots[2] || slots.slots[0];
  const appt = await b.bookAppointment({
    patientName: "Тестов Тест Тестович",
    phone: "77009990001",
    doctorId: 1,
    serviceId: 1,
    date,
    time,
  });
  ok(`book: id=${appt.id} ${date} ${time}`);

  const newTime = slots.slots[5] || slots.slots[1];
  const moved = await b.rescheduleAppointment({
    appointmentId: appt.id,
    phone: "77009990001",
    date,
    time: newTime,
  });
  ok(`reschedule → ${newTime}`);

  try {
    await b.bookAppointment({
      patientName: "Другой Пациент Тестович",
      phone: "77009990002",
      doctorId: 1,
      serviceId: 1,
      date,
      time: newTime,
    });
    fail("double-book", "не заблокировало");
  } catch {
    ok("double-book заблокирован");
  }

  const cancelled = await b.cancelAppointment({
    appointmentId: appt.id,
    phone: "77009990001",
  });
  if (cancelled.status === "cancelled") ok("cancel: cancelled");
  else fail("cancel", cancelled.status);
} catch (e) {
  fail("booking CRUD", e.message);
}

console.log(`\n=== Итог: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
