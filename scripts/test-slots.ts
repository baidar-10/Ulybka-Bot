import assert from "node:assert/strict";
import {
  generateSlots,
  slotToRange,
  zonedDateTime,
} from "../apps/bot/src/booking/slots.js";

const timeZone = "Asia/Almaty";

// Weekday 10-20, 30-min consultation, no busy
{
  const slots = generateSlots({
    dateStr: "2026-08-11", // Tuesday
    durationMinutes: 30,
    hours: { day_of_week: 2, open_time: "10:00", close_time: "20:00" },
    busy: [],
    timeZone,
    now: zonedDateTime(2026, 8, 11, 9, 0, timeZone),
  });
  assert.equal(slots[0], "10:00");
  assert.equal(slots.at(-1), "19:30");
  assert.ok(slots.length > 10);
}

// Weekend closes at 14:00
{
  const slots = generateSlots({
    dateStr: "2026-08-15", // Saturday
    durationMinutes: 60,
    hours: { day_of_week: 6, open_time: "10:00", close_time: "14:00" },
    busy: [],
    timeZone,
    now: zonedDateTime(2026, 8, 15, 9, 0, timeZone),
  });
  assert.ok(slots.includes("10:00"));
  assert.ok(slots.includes("13:00"));
  assert.ok(!slots.includes("13:30"));
  assert.ok(!slots.includes("14:00"));
}

// Busy blocks overlap
{
  const busy = slotToRange({
    dateStr: "2026-08-11",
    timeStr: "11:00",
    durationMinutes: 60,
    timeZone,
  });
  const slots = generateSlots({
    dateStr: "2026-08-11",
    durationMinutes: 30,
    hours: { day_of_week: 2, open_time: "10:00", close_time: "14:00" },
    busy: [{ starts_at: busy.startsAt, ends_at: busy.endsAt }],
    timeZone,
    now: zonedDateTime(2026, 8, 11, 9, 0, timeZone),
  });
  assert.ok(slots.includes("10:00"));
  assert.ok(slots.includes("10:30"));
  assert.ok(!slots.includes("11:00"));
  assert.ok(!slots.includes("11:30"));
  assert.ok(slots.includes("12:00"));
}

console.log("slot tests passed");
