import { CLINIC } from "../config/hours.js";
import { formatTimeInTz, generateSlots, slotToRange, zonedDateTime, type BusyInterval } from "../booking/slots.js";
import type { MacdentClient } from "./client.js";
import { MacdentError } from "./client.js";
import {
  asArray,
  extractBusyDateWindows,
  extractId,
  extractRaspDayWindows,
  formatPatientFio,
  namesMatch,
  patientNamesMatch,
  phonesMatch,
  pickString,
  toMacdentDate,
} from "./parse.js";

function timeToMinutesLocal(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m || 0);
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function mergeTimeWindows(
  windows: { open_time: string; close_time: string }[]
): { open_time: string; close_time: string }[] {
  const intervals = windows
    .map((w) => ({
      start: timeToMinutesLocal(w.open_time),
      end: timeToMinutesLocal(w.close_time),
    }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);

  if (!intervals.length) return [];

  const merged: { start: number; end: number }[] = [intervals[0]];
  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1];
    const cur = intervals[i];
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push(cur);
    }
  }

  return merged.map((w) => ({
    open_time: minutesToTime(w.start),
    close_time: minutesToTime(w.end),
  }));
}

function intersectTimeWindows(
  a: { open_time: string; close_time: string }[],
  b: { open_time: string; close_time: string }[]
): { open_time: string; close_time: string }[] {
  const out: { open_time: string; close_time: string }[] = [];
  for (const left of a) {
    const ls = timeToMinutesLocal(left.open_time);
    const le = timeToMinutesLocal(left.close_time);
    for (const right of b) {
      const rs = timeToMinutesLocal(right.open_time);
      const re = timeToMinutesLocal(right.close_time);
      const start = Math.max(ls, rs);
      const end = Math.min(le, re);
      if (end > start) {
        out.push({ open_time: minutesToTime(start), close_time: minutesToTime(end) });
      }
    }
  }
  return mergeTimeWindows(out);
}

export class MacdentSchedule {
  constructor(private readonly api: MacdentClient) {}

  get enabled() {
    return this.api.enabled;
  }

  private toZoned(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number
  ) {
    return zonedDateTime(year, month, day, hour, minute, CLINIC.timezone);
  }

  async findDoctorId(fullName: string): Promise<string | null> {
    const rows = asArray(await this.api.call("doctor.find"));
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      const name = pickString(rec, ["name", "fio", "full_name", "doctor_name", "title"]);
      const id = extractId(rec);
      if (name && id && namesMatch(fullName, name)) return id;
    }
    return null;
  }

  private dateWhen(isoDate: string) {
    const dmy = toMacdentDate(isoDate);
    return { dateWhen: dmy, date: dmy };
  }

  private slotsFromWindows(
    isoDate: string,
    durationMinutes: number,
    windows: { open_time: string; close_time: string }[],
    busy: BusyInterval[]
  ): string[] {
    const slots = new Set<string>();
    for (const w of windows) {
      for (const t of generateSlots({
        dateStr: isoDate,
        durationMinutes,
        hours: { day_of_week: 0, open_time: w.open_time, close_time: w.close_time },
        busy,
        timeZone: CLINIC.timezone,
      })) {
        slots.add(t);
      }
    }
    return [...slots].sort();
  }

  async getDayAvailability(
    doctorId: string,
    isoDate: string,
    durationMinutes: number,
    clinicHours?: { open_time: string; close_time: string } | null
  ): Promise<{ slots: string[]; raspId: string | null }> {
    const [y, m] = isoDate.split("-");
    let raspId: string | null = null;
    let workWindows: { open_time: string; close_time: string }[] = [];

    try {
      const rasp = await this.api.call("rasp.find", {
        doctor: doctorId,
        year: y,
        month: String(Number(m)),
      });
      let parsed = extractRaspDayWindows(rasp, doctorId, isoDate);
      if (!parsed.windows.length && !parsed.raspId) {
        const raspPad = await this.api.call("rasp.find", {
          doctor: doctorId,
          year: y,
          month: m,
        });
        parsed = extractRaspDayWindows(raspPad, doctorId, isoDate);
      }
      raspId = parsed.raspId;
      workWindows = parsed.windows;
      console.log(
        `MacDent rasp doctor=${doctorId} date=${isoDate} raspId=${raspId ?? "-"} windows=${workWindows.map((w) => `${w.open_time}-${w.close_time}`).join(",") || "(empty)"}`
      );
    } catch (err) {
      console.error("MacDent rasp.find failed", err);
    }

    let busy: BusyInterval[] = [];
    try {
      const zapis = await this.api.call("zapis.find", {
        doctor: doctorId,
        ...this.dateWhen(isoDate),
      });
      const rows = extractBusyDateWindows(zapis, this.toZoned.bind(this));
      busy = rows.map(({ starts_at, ends_at }) => ({ starts_at, ends_at }));
      raspId = raspId ?? rows.find((r) => r.raspId)?.raspId ?? null;
      const busyLabel = busy
        .map(
          (b) =>
            `${formatTimeInTz(b.starts_at, CLINIC.timezone)}-${formatTimeInTz(b.ends_at, CLINIC.timezone)}`
        )
        .join(",");
      console.log(
        `MacDent zapis doctor=${doctorId} date=${isoDate} busy=${busy.length}${busyLabel ? ` [${busyLabel}]` : ""}`
      );
    } catch (err) {
      console.error("MacDent zapis.find failed", err);
    }

    if (!workWindows.length && raspId) {
      try {
        const one = await this.api.call("rasp.get", { id: raspId, rasp: raspId });
        const parsedGet = extractRaspDayWindows(one, doctorId, isoDate);
        if (parsedGet.windows.length) workWindows = parsedGet.windows;
        console.log(
          `MacDent rasp.get id=${raspId} windows=${workWindows.map((w) => `${w.open_time}-${w.close_time}`).join(",") || "(empty)"}`
        );
      } catch (err) {
        console.error("MacDent rasp.get failed", err);
      }
    }

    // Рабочее окно врача: расписание MacDent, иначе часы клиники.
    // Свободность считаем сами: duration + busy (get_free_time не знает длительность нашей процедуры).
    if (!workWindows.length && clinicHours) {
      workWindows = [
        { open_time: clinicHours.open_time, close_time: clinicHours.close_time },
      ];
      console.log(
        `MacDent work windows from clinic hours ${clinicHours.open_time}-${clinicHours.close_time}`
      );
    }

    if (clinicHours && workWindows.length) {
      // Не выходим за часы клиники
      workWindows = intersectTimeWindows(workWindows, [
        { open_time: clinicHours.open_time, close_time: clinicHours.close_time },
      ]);
    }

    const slots = this.slotsFromWindows(
      isoDate,
      durationMinutes,
      workWindows,
      busy
    );
    console.log(
      `MacDent slots duration=${durationMinutes}min → ${slots.join(",") || "(none)"}`
    );

    return { slots, raspId };
  }

  async findPatientByPhone(phone: string): Promise<string | null> {
    const seen = new Set<string>();
    for (const params of [{ phone, tel: phone }]) {
      try {
        const data = await this.api.call("patient.find", params);
        for (const row of asArray(data)) {
          if (!row || typeof row !== "object") continue;
          const rec = row as Record<string, unknown>;
          const id = extractId(rec);
          const rowPhone = pickString(rec, ["phone", "tel", "mobile", "number"]);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          if (rowPhone && phonesMatch(phone, rowPhone)) {
            console.log(`MacDent patient found by phone id=${id}`);
            return id;
          }
        }
      } catch (err) {
        console.error("MacDent patient.find by phone failed", err);
      }
    }
    return null;
  }

  async findMatchingPatient(name: string, phone: string): Promise<string | null> {
    const fio = formatPatientFio(name);
    const seen = new Set<string>();
    const queries: Record<string, string>[] = [
      { phone, tel: phone },
      { name: fio, fio },
    ];

    for (const params of queries) {
      try {
        const data = await this.api.call("patient.find", params);
        for (const row of asArray(data)) {
          if (!row || typeof row !== "object") continue;
          const rec = row as Record<string, unknown>;
          const id = extractId(rec);
          const rowName = pickString(rec, ["name", "fio", "full_name"]);
          const rowPhone = pickString(rec, ["phone", "tel", "mobile", "number"]);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const nameOk = rowName ? patientNamesMatch(fio, rowName) : false;
          const phoneOk = rowPhone ? phonesMatch(phone, rowPhone) : false;
          console.log(
            `MacDent patient candidate id=${id} name=${rowName ?? "-"} phone=${rowPhone ?? "-"} nameOk=${nameOk} phoneOk=${phoneOk}`
          );
          if (nameOk && phoneOk) return id;
        }
      } catch (err) {
        console.error("MacDent patient.find failed", err);
      }
    }
    return null;
  }

  async addPatient(name: string, phone: string): Promise<string> {
    const fio = formatPatientFio(name);
    const data = await this.api.call("patient.add", {
      name: fio,
      fio,
      phone,
      tel: phone,
    });
    const id = extractId(data);
    if (!id) throw new MacdentError("MacDent patient.add не вернул id", "patient.add", data);
    console.log(`MacDent patient created id=${id} name=${fio}`);
    return id;
  }

  async ensurePatient(
    name: string,
    phone: string,
    cachedMacdentId?: string | null
  ): Promise<string> {
    if (cachedMacdentId) {
      console.log(`MacDent patient reused from cache id=${cachedMacdentId}`);
      return cachedMacdentId;
    }
    const byPhone = await this.findPatientByPhone(phone);
    if (byPhone) {
      console.log(`MacDent patient reused by phone id=${byPhone}`);
      return byPhone;
    }
    const existing = await this.findMatchingPatient(name, phone);
    if (existing) {
      console.log(`MacDent patient reused id=${existing}`);
      return existing;
    }
    return this.addPatient(name, phone);
  }

  async addZapis(params: {
    doctorId: string;
    patientId: string;
    date: string;
    time: string;
    durationMinutes: number;
    raspId?: string | null;
    comment?: string;
  }): Promise<string> {
    const { endsAt } = slotToRange({
      dateStr: params.date,
      timeStr: params.time,
      durationMinutes: params.durationMinutes,
      timeZone: CLINIC.timezone,
    });
    const data = await this.api.call("zapis.add", {
      doctor: params.doctorId,
      patient: params.patientId,
      rasp: params.raspId ?? undefined,
      start: `${toMacdentDate(params.date)} ${params.time}:00`,
      end: `${toMacdentDate(params.date)} ${this.formatTime(endsAt)}:00`,
      date: toMacdentDate(params.date),
      time: params.time,
      comment: params.comment,
      zhaloba: params.comment,
      status: 0,
    });
    const id = extractId(data);
    if (!id) throw new MacdentError("MacDent zapis.add не вернул id", "zapis.add", data);
    return id;
  }

  private formatTime(d: Date): string {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: CLINIC.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  }

  async updateZapis(params: {
    zapisId: string;
    date: string;
    time: string;
    durationMinutes: number;
  }): Promise<void> {
    const { endsAt } = slotToRange({
      dateStr: params.date,
      timeStr: params.time,
      durationMinutes: params.durationMinutes,
      timeZone: CLINIC.timezone,
    });
    await this.api.call("zapis.update", {
      id: params.zapisId,
      start: `${toMacdentDate(params.date)} ${params.time}:00`,
      end: `${toMacdentDate(params.date)} ${this.formatTime(endsAt)}:00`,
      date: toMacdentDate(params.date),
      time: params.time,
    });
  }

  async removeZapis(zapisId: string): Promise<void> {
    try {
      await this.api.call("zapis.remove", { id: zapisId, zapis_id: zapisId });
    } catch {
      await this.api.call("zapis.set_status", {
        id: zapisId,
        zapis_id: zapisId,
        status: "DECLINED",
      });
    }
  }
}
