-- One canonical patient record per phone (WhatsApp number)

CREATE TABLE IF NOT EXISTS patients (
  phone TEXT PRIMARY KEY,
  patient_name TEXT NOT NULL,
  macdent_patient_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill: best name per phone (prefer full 3-word FIO, then most recent)
INSERT INTO patients (phone, patient_name)
SELECT phone, patient_name
FROM (
  SELECT
    phone,
    patient_name,
    ROW_NUMBER() OVER (
      PARTITION BY phone
      ORDER BY
        (array_length(string_to_array(trim(patient_name), ' '), 1) >= 3) DESC,
        created_at DESC
    ) AS rn
  FROM appointments
) ranked
WHERE rn = 1
ON CONFLICT (phone) DO NOTHING;
