-- After creating calendars in Google Calendar and sharing them
-- with the service account, set calendar IDs here.

-- UPDATE doctors SET google_calendar_id = 'CALENDAR_ID_ASEL' WHERE full_name = 'Абдикаримова Асель';
-- UPDATE doctors SET google_calendar_id = 'CALENDAR_ID_ERZHAN' WHERE full_name = 'Абдикаримов Ержан';
-- UPDATE doctors SET google_calendar_id = 'CALENDAR_ID_ANSAR' WHERE full_name = 'Масенов Ансар Алмазович';

SELECT id, full_name, specialization, google_calendar_id, color, active
FROM doctors
ORDER BY id;
