import { BookingService } from "../apps/bot/src/booking/service.js";

async function main() {
  const b = new BookingService();
  const date = "2026-08-11"; // Tue
  const slots = await b.findSlots({ doctorId: 1, date, serviceId: 1 });
  console.log(
    "SLOTS",
    slots.doctor,
    "|",
    slots.service,
    "|",
    slots.slots.slice(0, 5).join(", "),
    `| total ${slots.slots.length}`
  );

  const time = slots.slots[2];
  const appt = await b.bookAppointment({
    patientName: "Тест Пациент",
    phone: "77001112233",
    doctorId: 1,
    serviceId: 1,
    date,
    time,
  });
  console.log("BOOKED", b.formatAppointment(appt));

  const moved = await b.rescheduleAppointment({
    appointmentId: appt.id,
    phone: "77001112233",
    date,
    time: slots.slots[5],
  });
  console.log("RESCHEDULED", b.formatAppointment(moved));

  // double-book should fail
  try {
    await b.bookAppointment({
      patientName: "Другой",
      phone: "77009998877",
      doctorId: 1,
      serviceId: 1,
      date,
      time: slots.slots[5],
    });
    console.log("DOUBLE_BOOK unexpected success");
  } catch (err) {
    console.log("DOUBLE_BOOK blocked:", (err as Error).message);
  }

  const cancelled = await b.cancelAppointment({
    appointmentId: appt.id,
    phone: "77001112233",
  });
  console.log("CANCELLED", cancelled.status);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
