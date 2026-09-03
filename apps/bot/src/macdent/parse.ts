export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of [
      "items",
      "list",
      "data",
      "doctors",
      "patients",
      "zapisi",
      "rasps",
      "schedules",
      "times",
      "slots",
    ]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
    return Object.entries(obj)
      .filter(([key, v]) =>
        v &&
        typeof v === "object" &&
        !["response", "reponse", "error"].includes(key)
      )
      .map(([, v]) => v);
  }
  return [];
}

export function pickString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = row[key];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return null;
}

export function pickNumber(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = row[key];
    if (v == null || v === "") continue;
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

export function extractId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "string") {
    const s = String(value).trim();
    return s && s !== "0" ? s : null;
  }
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    const id =
      pickNumber(row, ["id", "zapis_id", "patient_id", "pacient_id", "doctor_id"]) ??
      pickString(row, ["id", "zapis_id"]);
    if (id != null) return String(id);
    for (const key of ["patient", "zapis", "doctor", "rasp"]) {
      if (row[key] && typeof row[key] === "object") {
        const nested = extractId(row[key]);
        if (nested) return nested;
      }
    }
  }
  return null;
}

function normalizeTime(raw: string): string | null {
  const m = String(raw).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

export function extractTimes(value: unknown): string[] {
  const out: string[] = [];
  const visit = (item: unknown) => {
    if (item == null) return;
    if (typeof item === "string" || typeof item === "number") {
      const text = String(item);
      const range = text.match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);
      if (range) {
        const t = normalizeTime(range[1]);
        if (t) out.push(t);
        return;
      }
      const t = normalizeTime(text);
      if (t) out.push(t);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item === "object") {
      const row = item as Record<string, unknown>;
      const t = pickString(row, [
        "time",
        "start",
        "from",
        "hour",
        "nachalo",
        "time_start",
        "dateWhen",
        "begin",
      ]);
      if (t) {
        const n = normalizeTime(t);
        if (n) out.push(n);
      } else {
        Object.values(row).forEach(visit);
      }
    }
  };
  visit(value);
  return [...new Set(out)].sort();
}

export function doctorDisplayName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]} ${parts[1]}`;
  return fullName.trim();
}

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

export function phoneDigits(phone: string): string {
  let d = phone.replace(/\D/g, "");
  if (d.startsWith("8") && d.length === 11) d = `7${d.slice(1)}`;
  if (d.startsWith("00")) d = d.slice(2);
  return d;
}

export function phonesMatch(a: string, b: string): boolean {
  const da = phoneDigits(a);
  const db = phoneDigits(b);
  if (da.length < 10 || db.length < 10) return da.length > 0 && da === db;
  return da.slice(-10) === db.slice(-10);
}

export function nameTokens(name: string): string[] {
  return normalizeName(name)
    .split(" ")
    .filter((w) => w.length > 1);
}

/** Same person: overlapping surname+given name, order-independent. */
export function patientNamesMatch(a: string, b: string): boolean {
  const wa = nameTokens(a);
  const wb = nameTokens(b);
  if (!wa.length || !wb.length) return false;
  const overlap = wa.filter((w) =>
    wb.some((x) => x === w || (w.length >= 4 && x.startsWith(w)) || (x.length >= 4 && w.startsWith(x)))
  );
  const need = Math.min(wa.length, wb.length, 2);
  return overlap.length >= need;
}

export function formatPatientFio(raw: string): string {
  const parts = raw
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) =>
      part
        .split("-")
        .map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p))
        .join("-")
    );
  return parts.join(" ");
}

/** Match "Масенов Ансар" to "Ансар Масенов" / "Масенов Ансар Алмазович". */
export function namesMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const words = na.split(" ").filter((w) => w.length > 1);
  return words.length > 0 && words.every((w) => nb.includes(w));
}

export function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

const MACDENT_DT =
  /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;

/** Wall-clock from MacDent `24.08.2026 18:30:00` in the given IANA zone. */
export function parseMacdentWallClock(
  value: unknown,
  toZonedDate: (
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number
  ) => Date
): Date | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(String(value).trim()))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return null;
    return new Date(n > 1e12 ? n : n * 1000);
  }
  const m = String(value).trim().match(MACDENT_DT);
  if (m) {
    return toZonedDate(
      Number(m[3]),
      Number(m[2]),
      Number(m[1]),
      Number(m[4] ?? 0),
      Number(m[5] ?? 0)
    );
  }
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function extractScheduleWindows(
  value: unknown
): { open_time: string; close_time: string }[] {
  const windows: { open_time: string; close_time: string }[] = [];
  for (const row of asArray(value)) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const from = pickString(rec, ["from", "start", "nachalo"]);
    const to = pickString(rec, ["to", "end", "konec"]);
    const open = from ? from.match(/(\d{1,2}):(\d{2})/) : null;
    const close = to ? to.match(/(\d{1,2}):(\d{2})/) : null;
    if (open && close) {
      windows.push({
        open_time: `${open[1].padStart(2, "0")}:${open[2]}`,
        close_time: `${close[1].padStart(2, "0")}:${close[2]}`,
      });
    }
  }
  return windows;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return value;
  try {
    return JSON.parse(t);
  } catch {
    return value;
  }
}

function dayFromPerDayData(perDayData: unknown, dayOfMonth: number): unknown {
  const data = jsonValue(perDayData);
  if (data == null) return null;
  if (Array.isArray(data)) {
    const byDay = data.find(
      (item) =>
        item &&
        typeof item === "object" &&
        Number((item as Record<string, unknown>).day ?? (item as Record<string, unknown>).d) ===
          dayOfMonth
    );
    if (byDay) return byDay;
    return data[dayOfMonth] ?? data[dayOfMonth - 1] ?? null;
  }
  if (typeof data !== "object") return data;
  const rec = data as Record<string, unknown>;
  const keys = [String(dayOfMonth), String(dayOfMonth).padStart(2, "0"), `d${dayOfMonth}`];
  for (const key of keys) {
    if (rec[key] != null) return rec[key];
  }
  for (const [key, val] of Object.entries(rec)) {
    if (new RegExp(`(^|[-_.])${String(dayOfMonth).padStart(2, "0")}($|[-_.])`).test(key)) {
      return val;
    }
    if (key === String(dayOfMonth) || key.startsWith(`${String(dayOfMonth).padStart(2, "0")}.`)) {
      return val;
    }
  }
  return null;
}

function windowsFromIntervalValue(value: unknown): { open_time: string; close_time: string }[] {
  const hours = extractWorkHours(value);
  if (hours) return [hours];
  if (typeof value === "string") {
    const m = value.match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/);
    if (m) {
      return [
        {
          open_time: `${m[1].padStart(2, "0")}:${m[2]}`,
          close_time: `${m[3].padStart(2, "0")}:${m[4]}`,
        },
      ];
    }
  }
  return [];
}

export function extractRaspDayWindows(
  raspRows: unknown,
  doctorId: string,
  isoDate: string
): { raspId: string | null; cabinet: string | null; windows: { open_time: string; close_time: string }[] } {
  const day = Number(isoDate.split("-")[2]);
  const windows: { open_time: string; close_time: string }[] = [];
  let raspId: string | null = null;
  let cabinet: string | null = null;

  for (const row of asArray(raspRows)) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const rowDoctor = extractId(rec.doctor) ?? pickString(rec, ["doctor", "doctor_id"]);
    if (rowDoctor && String(rowDoctor) !== String(doctorId)) continue;
    raspId = extractId(rec) ?? raspId;
    cabinet = pickString(rec, ["cabinet"]) ?? cabinet;

    const dayVal = dayFromPerDayData(rec.perDayData ?? rec.per_day_data, day);
    const found =
      dayVal != null
        ? windowsFromIntervalValue(dayVal)
        : extractWorkHours(rec)
          ? [extractWorkHours(rec)!]
          : [];
    if (found.length) windows.push(...found);
  }

  return { raspId, cabinet, windows };
}

export function toMacdentDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  if (!year || !month || !day) return isoDate;
  return `${day}.${month}.${year}`;
}

function isCancelledStatus(status: unknown): boolean {
  if (status == null || status === "") return false;
  if (status === 2 || status === "2") return true;
  const s = String(status);
  return /cancel|отмен|удал|delete|declined|отклон/i.test(s);
}

export function extractWorkHours(
  value: unknown
): { open_time: string; close_time: string } | null {
  const rows = asArray(value);
  const source =
    rows.length > 0 ? rows : value && typeof value === "object" ? [value] : [];
  let open: string | null = null;
  let close: string | null = null;
  for (const row of source) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const start = pickString(rec, [
      "open_time",
      "start",
      "from",
      "time_start",
      "nachalo",
      "start_time",
      "time_from",
    ]);
    const end = pickString(rec, [
      "close_time",
      "end",
      "to",
      "time_end",
      "konec",
      "end_time",
      "time_to",
    ]);
    const ns = start ? normalizeTime(start) : null;
    const ne = end ? normalizeTime(end) : null;
    if (ns && (!open || ns < open)) open = ns;
    if (ne && (!close || ne > close)) close = ne;
  }
  if (!open || !close) return null;
  return { open_time: open, close_time: close };
}

export function extractBusyWindows(
  value: unknown
): { start: string; durationMinutes: number }[] {
  const busy: { start: string; durationMinutes: number }[] = [];
  for (const row of asArray(value)) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (isCancelledStatus(rec.status ?? rec.sostoyanie ?? rec.state)) {
      continue;
    }
    const startRaw = pickString(rec, [
      "time",
      "from",
      "nachalo",
      "time_start",
      "start_time",
      "hour",
    ]);
    const endRaw = pickString(rec, ["to", "konec", "time_end", "end_time"]);
    const start = startRaw ? normalizeTime(startRaw) : null;
    if (!start) continue;
    let durationMinutes = 30;
    const end = endRaw ? normalizeTime(endRaw) : null;
    if (end) {
      const [sh, sm] = start.split(":").map(Number);
      const [eh, em] = end.split(":").map(Number);
      durationMinutes = Math.max(eh * 60 + em - (sh * 60 + sm), 15);
    }
    busy.push({ start, durationMinutes });
  }
  return busy;
}

export function extractBusyDateWindows(
  value: unknown,
  toZonedDate: (
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number
  ) => Date
): { starts_at: Date; ends_at: Date; raspId: string | null }[] {
  const busy: { starts_at: Date; ends_at: Date; raspId: string | null }[] = [];
  for (const row of asArray(value)) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (isCancelledStatus(rec.status ?? rec.sostoyanie ?? rec.state)) continue;

    const start =
      parseMacdentWallClock(rec.start, toZonedDate) ??
      parseMacdentWallClock(rec.nachalo, toZonedDate) ??
      parseMacdentWallClock(rec.time_start, toZonedDate) ??
      parseMacdentWallClock(rec.from, toZonedDate);
    let end =
      parseMacdentWallClock(rec.end, toZonedDate) ??
      parseMacdentWallClock(rec.konec, toZonedDate) ??
      parseMacdentWallClock(rec.time_end, toZonedDate) ??
      parseMacdentWallClock(rec.to, toZonedDate);

    if (!start) continue;

    // MacDent иногда отдаёт только начало — без конца запись «пропадает» из занятости
    if (!end || end <= start) {
      const durationField = pickNumber(rec, [
        "duration",
        "duration_minutes",
        "dlitelnost",
        "minutes",
        "len",
        "time_len",
        "interval",
      ]);
      let durationMinutes = 30;
      if (durationField != null && durationField > 0) {
        // секунды vs минуты
        durationMinutes =
          durationField >= 24 * 60 ? Math.round(durationField / 60) : durationField;
        durationMinutes = Math.max(durationMinutes, 15);
      }
      end = new Date(start.getTime() + durationMinutes * 60_000);
    }

    if (end > start) {
      busy.push({
        starts_at: start,
        ends_at: end,
        raspId: extractId(rec.rasp) ?? pickString(rec, ["rasp"]),
      });
    }
  }
  return busy;
}
