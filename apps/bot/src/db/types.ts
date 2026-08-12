export type AppointmentStatus = "booked" | "rescheduled" | "cancelled";

export interface Doctor {
  id: number;
  full_name: string;
  specialization: string;
  google_calendar_id: string | null;
  color: string | null;
  active: boolean;
}

export interface Service {
  id: number;
  name: string;
  doctor_id: number | null;
  duration_minutes: number;
  description: string | null;
  active: boolean;
  doctor_name?: string;
}

export interface ClinicHour {
  day_of_week: number;
  open_time: string;
  close_time: string;
}

export interface Appointment {
  id: number;
  patient_name: string;
  phone: string;
  doctor_id: number;
  service_id: number;
  starts_at: Date;
  ends_at: Date;
  status: AppointmentStatus;
  comment: string | null;
  source: string;
  google_event_id: string | null;
  doctor_name?: string;
  service_name?: string;
}

export interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: unknown;
  name?: string;
}
