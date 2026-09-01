ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_greeted_date DATE;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reminder_24h_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_2h_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS followup_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_appointments_starts_reminders
  ON appointments (starts_at)
  WHERE status IN ('booked', 'rescheduled');

CREATE INDEX IF NOT EXISTS idx_appointments_ends_followup
  ON appointments (ends_at)
  WHERE status IN ('booked', 'rescheduled');
