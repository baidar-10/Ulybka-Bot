/**
 * MacDent: all doctors + free slots for main 3 doctors tomorrow.
 * Run: docker cp scripts/test-macdent-doctors.mjs ulybka-bot-bot-1:/app/ && docker compose exec -T bot node /app/test-macdent-doctors.mjs
 */
import { createMacdentClient } from "./apps/bot/dist/macdent/client.js";
import { MacdentSchedule } from "./apps/bot/dist/macdent/schedule.js";

const MAIN_DOCTORS = [
  "Абдикаримова Асель",
  "Абдикаримов Ержан",
  "Масенов Ансар",
];

const macdent = createMacdentClient();
const schedule = new MacdentSchedule(macdent);

const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const iso = tomorrow.toISOString().slice(0, 10);

console.log("=== MacDent doctor/find (полный список) ===\n");
const doctors = await macdent.call("doctor/find", {});
const list = Array.isArray(doctors) ? doctors : [];

console.log(`Всего врачей в MacDent: ${list.length}\n`);
for (const d of list) {
  const specs = Array.isArray(d.specialnosti)
    ? d.specialnosti.map((s) => s.name?.trim()).filter(Boolean).join(", ")
    : "";
  console.log(`  id=${d.id}  ${d.name}${specs ? `  [${specs}]` : ""}`);
}

console.log(`\n=== Свободные слоты на ${iso} (завтра) ===\n`);
for (const target of MAIN_DOCTORS) {
  const doc = list.find((d) => String(d.name).includes(target.split(" ")[1]));
  if (!doc) {
    console.log(`❌ ${target}: не найден в MacDent`);
    continue;
  }
  try {
    const { slots } = await schedule.getDayAvailability(
      String(doc.id),
      iso,
      30
    );
    const preview =
      slots.length > 0
        ? `${slots.length} шт. → ${slots.slice(0, 5).join(", ")}${slots.length > 5 ? "..." : ""}`
        : "нет свободных слотов";
    console.log(`✅ ${doc.name} (id=${doc.id}): ${preview}`);
  } catch (e) {
    console.log(`❌ ${doc.name}: ${e.message}`);
  }
}

console.log("\n=== Примечание ===");
console.log(
  "Бот в диалоге использует только 3 врачей из локальной БД (seed),"
);
console.log(
  "но MacDent API отдаёт всех врачей клиники, привязанных к филиалу."
);
