import { pool } from "./pool.js";
import { formatPatientFio } from "../macdent/parse.js";
import { normalizePhone } from "../booking/phone.js";

function isFullFio(name: string): boolean {
  return name.trim().split(/\s+/).filter(Boolean).length >= 3;
}

export interface KnownPatient {
  phone: string;
  patient_name: string;
  macdent_patient_id: string | null;
}

export async function getKnownPatient(
  phone: string
): Promise<KnownPatient | null> {
  const normalized = normalizePhone(phone);
  const { rows } = await pool.query(
    `SELECT phone, patient_name, macdent_patient_id
     FROM patients WHERE phone = $1`,
    [normalized]
  );
  if (rows[0]) {
    const row = rows[0] as KnownPatient;
    if (isFullFio(row.patient_name)) return row;
  }

  const { rows: apptRows } = await pool.query(
    `SELECT patient_name
     FROM appointments
     WHERE phone = $1
       AND array_length(string_to_array(trim(patient_name), ' '), 1) >= 3
     ORDER BY created_at DESC
     LIMIT 1`,
    [normalized]
  );
  if (apptRows[0]) {
    return {
      phone: normalized,
      patient_name: String(apptRows[0].patient_name),
      macdent_patient_id: null,
    };
  }
  return null;
}

export async function upsertKnownPatient(params: {
  phone: string;
  patientName: string;
  macdentPatientId?: string | null;
}): Promise<void> {
  const phone = normalizePhone(params.phone);
  const patientName = formatPatientFio(params.patientName);
  await pool.query(
    `INSERT INTO patients (phone, patient_name, macdent_patient_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (phone) DO UPDATE SET
       patient_name = CASE
         WHEN array_length(string_to_array(trim(EXCLUDED.patient_name), ' '), 1)
           >= array_length(string_to_array(trim(patients.patient_name), ' '), 1)
         THEN EXCLUDED.patient_name
         ELSE patients.patient_name
       END,
       macdent_patient_id = COALESCE(EXCLUDED.macdent_patient_id, patients.macdent_patient_id),
       updated_at = NOW()`,
    [phone, patientName, params.macdentPatientId ?? null]
  );
}
