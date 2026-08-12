-- schema for Улыбка столицы booking bot

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS doctors (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  specialization TEXT NOT NULL,
  google_calendar_id TEXT,
  color TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS services (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  doctor_id INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clinic_hours (
  id SERIAL PRIMARY KEY,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  open_time TIME NOT NULL,
  close_time TIME NOT NULL,
  UNIQUE (day_of_week)
);

CREATE TYPE appointment_status AS ENUM ('booked', 'rescheduled', 'cancelled');

CREATE TABLE IF NOT EXISTS appointments (
  id SERIAL PRIMARY KEY,
  patient_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status appointment_status NOT NULL DEFAULT 'booked',
  comment TEXT,
  source TEXT NOT NULL DEFAULT 'whatsapp_ai',
  google_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at)
);

-- Prevent overlapping active appointments for the same doctor
ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
  WHERE (status IN ('booked', 'rescheduled'));

CREATE INDEX IF NOT EXISTS idx_appointments_phone ON appointments(phone);
CREATE INDEX IF NOT EXISTS idx_appointments_doctor_starts ON appointments(doctor_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_services_doctor ON services(doctor_id);

CREATE TABLE IF NOT EXISTS conversations (
  phone TEXT PRIMARY KEY,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
