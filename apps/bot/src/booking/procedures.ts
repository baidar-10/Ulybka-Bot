export interface ProcedureType {
  id: string;
  label: string;
  durationMinutes: number;
  /** Приём должен полностью закончиться не позже этого времени (HH:MM). */
  latestEndTime?: string;
}

export const PROCEDURE_EVENING_CUTOFF = "19:00";

export const PROCEDURES: ProcedureType[] = [
  { id: "consultation", label: "Консультация", durationMinutes: 30 },
  {
    id: "treatment",
    label: "Лечение",
    durationMinutes: 90,
    latestEndTime: PROCEDURE_EVENING_CUTOFF,
  },
  { id: "cleaning", label: "Чистка", durationMinutes: 60 },
  { id: "correction", label: "Коррекция", durationMinutes: 30 },
  { id: "crowns", label: "Коронки", durationMinutes: 60 },
  { id: "crown_correction", label: "Коррекция коронки", durationMinutes: 30 },
  { id: "extraction", label: "Удаление", durationMinutes: 90 },
  {
    id: "implantation",
    label: "Имплантация",
    durationMinutes: 120,
    latestEndTime: PROCEDURE_EVENING_CUTOFF,
  },
  { id: "suture_removal", label: "Снятие швов", durationMinutes: 30 },
  {
    id: "braces_install",
    label: "Установка брекет системы",
    durationMinutes: 90,
  },
];

const PROCEDURE_BY_ID = new Map(PROCEDURES.map((p) => [p.id, p]));

const PROCEDURE_SERVICE_PATTERNS: Record<string, RegExp[]> = {
  consultation: [/консульт|осмотр|первичн/i],
  treatment: [/лечение/i],
  cleaning: [/чистк|гигиен|air ?flow/i],
  correction: [/коррекци|активация брекет/i],
  crowns: [/корон/i],
  crown_correction: [/корон/i],
  extraction: [/удален/i],
  implantation: [/имплант/i],
  suture_removal: [/шов/i],
  braces_install: [/брекет/i],
};

export function getProcedure(id: string): ProcedureType | null {
  return PROCEDURE_BY_ID.get(id) ?? null;
}

export function listProcedures(): ProcedureType[] {
  return [...PROCEDURES];
}

export function formatProcedureDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0 && mins > 0) return `${hours} ч ${mins} мин`;
  if (hours === 1) return "1 час";
  if (hours > 1) return `${hours} часа`;
  return `${minutes} мин`;
}

export function formatProcedureQuestion(): string {
  return "Подскажите, пожалуйста, на какую процедуру вы хотите записаться?";
}

/** @deprecated use formatProcedureQuestion */
export function formatProcedureChoice(): string {
  return formatProcedureQuestion();
}

export function normalizeVisitReason(text: string): string {
  let t = text
    .trim()
    .replace(/^(хочу|на|записаться на|записаться|можно|мне нужна?|мне нужно|нужна?|нужно)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) t = text.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function resolveProcedureFromClientText(text: string): {
  procedure: ProcedureType;
  visitReason: string;
} | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 2) return null;

  const visitReason = normalizeVisitReason(trimmed);
  const matched = matchProcedureFromText(trimmed, { allowNumberedChoice: false });
  if (matched) {
    return { procedure: matched, visitReason };
  }

  // Не распознали категорию — слоты как консультация, причина = слова клиента
  return {
    procedure: getProcedure("consultation")!,
    visitReason,
  };
}

export function matchProcedureFromText(
  text: string,
  options?: { allowNumberedChoice?: boolean }
): ProcedureType | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;

  if (options?.allowNumberedChoice) {
    const numbered = t.match(/^([1-9]|10)$/);
    if (numbered) {
      const idx = Number(numbered[1]) - 1;
      return PROCEDURES[idx] ?? null;
    }
  }

  if (/имплант/i.test(t)) return getProcedure("implantation")!;
  if (/брекет/i.test(t)) return getProcedure("braces_install")!;
  if (/коррекц/i.test(t) && /корон/i.test(t)) {
    return getProcedure("crown_correction")!;
  }
  if (/корон/i.test(t)) return getProcedure("crowns")!;
  if (/удален/i.test(t)) return getProcedure("extraction")!;
  if (/шов/i.test(t)) return getProcedure("suture_removal")!;
  if (/чистк|гигиен/i.test(t)) return getProcedure("cleaning")!;
  if (/консульт/i.test(t)) return getProcedure("consultation")!;
  if (/^коррекц/i.test(t) || /\bкоррекц/i.test(t)) {
    return getProcedure("correction")!;
  }
  if (
    /^лечение\b/i.test(t) ||
    /\bлечение\b/i.test(t) ||
    /кариес|канал|пломб|пульпит/i.test(t)
  ) {
    return getProcedure("treatment")!;
  }

  for (const procedure of PROCEDURES) {
    if (t === procedure.label.toLowerCase()) return procedure;
  }

  return null;
}

/** Явно названа процедура (не просто имя врача или «да»). */
export function textDescribesProcedure(text: string): boolean {
  const t = text.trim();
  if (t.length < 3) return false;
  if (matchProcedureFromText(t, { allowNumberedChoice: false })) return true;
  return /лечение|консульт|чистк|имплант|брекет|корон|удален|шов|коррекц|кариес|канал|гигиен|осмотр|пломб|протез|пульпит|отбелив/i.test(
    t
  );
}

export function servicePatternsForProcedure(
  procedure: ProcedureType
): RegExp[] {
  return (
    PROCEDURE_SERVICE_PATTERNS[procedure.id] ?? [/консульт/i]
  );
}

export function procedureRuleText(procedure: ProcedureType): string | null {
  if (procedure.latestEndTime !== PROCEDURE_EVENING_CUTOFF) return null;
  return `${procedure.label} можно записать только так, чтобы приём полностью завершился до ${PROCEDURE_EVENING_CUTOFF}.`;
}
