CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  current_term text NOT NULL DEFAULT 'Term 1',
  pass_mark numeric(5,2) NOT NULL DEFAULT 50 CHECK (pass_mark BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE schools ADD COLUMN IF NOT EXISTS school_type text NOT NULL DEFAULT 'public';
ALTER TABLE schools ADD COLUMN IF NOT EXISTS region text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS district text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS contact_name text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS contact_email text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS contact_phone text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE schools ADD COLUMN IF NOT EXISTS grade_scale jsonb NOT NULL DEFAULT '{"A":80,"B":70,"C":60}'::jsonb;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS cancellation_requested_at timestamptz;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS retention_until timestamptz;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS onboarding_mode text NOT NULL DEFAULT 'assisted';
ALTER TABLE schools ADD COLUMN IF NOT EXISTS trial_requested boolean NOT NULL DEFAULT false;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS trial_status text NOT NULL DEFAULT 'none';
ALTER TABLE schools ADD COLUMN IF NOT EXISTS trial_started_at timestamptz;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS estimated_student_count integer;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS billing_status text NOT NULL DEFAULT 'unpaid';
ALTER TABLE schools ADD COLUMN IF NOT EXISTS subscription_paid_until date;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS current_academic_year text;
UPDATE schools
SET current_academic_year = CASE
  WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= 8
    THEN EXTRACT(YEAR FROM CURRENT_DATE)::integer || '/' || RIGHT((EXTRACT(YEAR FROM CURRENT_DATE)::integer + 1)::text, 2)
  ELSE (EXTRACT(YEAR FROM CURRENT_DATE)::integer - 1) || '/' || RIGHT(EXTRACT(YEAR FROM CURRENT_DATE)::integer::text, 2)
END
WHERE current_academic_year IS NULL;
ALTER TABLE schools ALTER COLUMN current_academic_year SET NOT NULL;
ALTER TABLE schools ALTER COLUMN current_academic_year SET DEFAULT
  (CASE
    WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= 8
      THEN EXTRACT(YEAR FROM CURRENT_DATE)::integer || '/' || RIGHT((EXTRACT(YEAR FROM CURRENT_DATE)::integer + 1)::text, 2)
    ELSE (EXTRACT(YEAR FROM CURRENT_DATE)::integer - 1) || '/' || RIGHT(EXTRACT(YEAR FROM CURRENT_DATE)::integer::text, 2)
  END);

CREATE TABLE IF NOT EXISTS academic_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year text NOT NULL,
  term text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, academic_year, term)
);
CREATE UNIQUE INDEX IF NOT EXISTS academic_periods_one_active_idx
  ON academic_periods(school_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS academic_periods_school_idx
  ON academic_periods(school_id, created_at DESC);
INSERT INTO academic_periods(school_id,academic_year,term,status)
SELECT id,current_academic_year,current_term,'active' FROM schools
ON CONFLICT(school_id,academic_year,term) DO NOTHING;
CREATE OR REPLACE FUNCTION create_initial_academic_period()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO academic_periods(school_id,academic_year,term,status)
  VALUES(NEW.id,NEW.current_academic_year,NEW.current_term,'active')
  ON CONFLICT(school_id,academic_year,term) DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS schools_initial_academic_period ON schools;
CREATE TRIGGER schools_initial_academic_period
AFTER INSERT ON schools FOR EACH ROW EXECUTE FUNCTION create_initial_academic_period();

CREATE TABLE IF NOT EXISTS platform_subscription_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  amount_bututs bigint NOT NULL CHECK (amount_bututs > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('cash','wave','bank_transfer','card','other')),
  payment_reference text,
  paid_on date NOT NULL DEFAULT CURRENT_DATE,
  coverage_months integer NOT NULL DEFAULT 1 CHECK (coverage_months BETWEEN 1 AND 24),
  coverage_ends_on date NOT NULL,
  recorded_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_subscription_payments_school_idx
  ON platform_subscription_payments(school_id,paid_on DESC);

CREATE TABLE IF NOT EXISTS school_data_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  school_name text NOT NULL,
  requested_by text,
  requested_at timestamptz NOT NULL,
  deletion_reason text NOT NULL,
  completed_by text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS school_onboarding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL UNIQUE REFERENCES schools(id) ON DELETE CASCADE,
  administrator_name text NOT NULL,
  administrator_email text NOT NULL,
  invitation_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE school_onboarding ADD COLUMN IF NOT EXISTS invitation_token_hash text;
ALTER TABLE school_onboarding ADD COLUMN IF NOT EXISTS invitation_expires_at timestamptz;
ALTER TABLE school_onboarding ADD COLUMN IF NOT EXISTS invited_at timestamptz;
ALTER TABLE school_onboarding ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
ALTER TABLE school_onboarding ADD COLUMN IF NOT EXISTS auth_user_id text;
CREATE INDEX IF NOT EXISTS onboarding_token_idx ON school_onboarding(invitation_token_hash);

CREATE TABLE IF NOT EXISTS school_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  auth_user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'administrator', 'teacher', 'finance')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, auth_user_id)
);

CREATE TABLE IF NOT EXISTS staff_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('teacher', 'finance')),
  invitation_status text NOT NULL DEFAULT 'sent',
  invitation_token_hash text,
  invitation_expires_at timestamptz,
  invited_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  auth_user_id text,
  UNIQUE (school_id, email)
);
CREATE INDEX IF NOT EXISTS staff_invitation_token_idx ON staff_invitations(invitation_token_hash);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL,
  actor_email text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_school_created_idx ON audit_logs(school_id, created_at DESC);

CREATE TABLE IF NOT EXISTS classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);

CREATE TABLE IF NOT EXISTS subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);

CREATE TABLE IF NOT EXISTS programmes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  duration_months integer NOT NULL CHECK (duration_months BETWEEN 1 AND 120),
  qualification text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);

CREATE TABLE IF NOT EXISTS timetable_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time time NOT NULL,
  end_time time NOT NULL,
  teacher_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  UNIQUE (school_id, class_id, weekday, start_time)
);

CREATE TABLE IF NOT EXISTS students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id uuid REFERENCES classes(id) ON DELETE SET NULL,
  student_number text NOT NULL,
  full_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'graduated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, student_number)
);

ALTER TABLE students ADD COLUMN IF NOT EXISTS guardian_name text;
ALTER TABLE students ADD COLUMN IF NOT EXISTS guardian_phone text;
ALTER TABLE students ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE students ADD COLUMN IF NOT EXISTS gender text;
ALTER TABLE students ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE students ADD COLUMN IF NOT EXISTS previous_school text;
ALTER TABLE students ADD COLUMN IF NOT EXISTS admission_date date;

CREATE TABLE IF NOT EXISTS student_admission_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  date_of_birth date,
  gender text,
  address text,
  guardian_name text NOT NULL,
  guardian_phone text NOT NULL,
  guardian_email text,
  previous_school text,
  preferred_class text,
  notes text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admission_applications_school_status_idx
  ON student_admission_applications(school_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  attendance_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('present', 'late', 'absent', 'excused')),
  recorded_by text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, attendance_date)
);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS academic_year text;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS term text;
UPDATE attendance a SET academic_year=s.current_academic_year,term=s.current_term
FROM schools s WHERE a.school_id=s.id AND (a.academic_year IS NULL OR a.term IS NULL);

CREATE TABLE IF NOT EXISTS fee_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);

CREATE TABLE IF NOT EXISTS fee_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  fee_type_id uuid REFERENCES fee_types(id) ON DELETE SET NULL,
  description text NOT NULL,
  amount_bututs bigint NOT NULL CHECK (amount_bututs > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE fee_charges ADD COLUMN IF NOT EXISTS academic_year text;
ALTER TABLE fee_charges ADD COLUMN IF NOT EXISTS term text;
ALTER TABLE fee_charges ADD COLUMN IF NOT EXISTS due_date date;
UPDATE fee_charges f SET academic_year=s.current_academic_year,term=s.current_term
FROM schools s WHERE f.school_id=s.id AND (f.academic_year IS NULL OR f.term IS NULL);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  amount_bututs bigint NOT NULL CHECK (amount_bututs > 0),
  receipt_number text NOT NULL,
  operation_key text NOT NULL,
  paid_on date NOT NULL DEFAULT CURRENT_DATE,
  recorded_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, receipt_number),
  UNIQUE (school_id, operation_key)
);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS academic_year text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS term text;
UPDATE payments p SET academic_year=s.current_academic_year,term=s.current_term
FROM schools s WHERE p.school_id=s.id AND (p.academic_year IS NULL OR p.term IS NULL);

CREATE TABLE IF NOT EXISTS payment_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  adjustment_type text NOT NULL CHECK (adjustment_type IN ('refund','void')),
  amount_bututs bigint NOT NULL CHECK (amount_bututs > 0),
  reason text NOT NULL,
  recorded_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_adjustments_payment_idx
  ON payment_adjustments(school_id,payment_id,created_at);

CREATE TABLE IF NOT EXISTS fee_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  charge_id uuid NOT NULL REFERENCES fee_charges(id) ON DELETE RESTRICT,
  adjustment_type text NOT NULL CHECK (adjustment_type IN ('waiver','discount')),
  amount_bututs bigint NOT NULL CHECK (amount_bututs > 0),
  reason text NOT NULL,
  recorded_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fee_adjustments_charge_idx
  ON fee_adjustments(school_id,charge_id,created_at);

CREATE TABLE IF NOT EXISTS assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title text NOT NULL,
  term text NOT NULL,
  maximum_score numeric(7,2) NOT NULL DEFAULT 100 CHECK (maximum_score > 0),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assessment_marks (
  assessment_id uuid NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  score numeric(7,2) NOT NULL CHECK (score >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assessment_id, student_id)
);
ALTER TABLE assessment_marks ADD COLUMN IF NOT EXISTS remark text;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS subject_id uuid REFERENCES subjects(id) ON DELETE SET NULL;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS academic_year text;
UPDATE assessments a SET academic_year=s.current_academic_year
FROM schools s WHERE a.school_id=s.id AND a.academic_year IS NULL;

ALTER TABLE timetable_entries ADD COLUMN IF NOT EXISTS academic_year text;
ALTER TABLE timetable_entries ADD COLUMN IF NOT EXISTS term text;
UPDATE timetable_entries t SET academic_year=s.current_academic_year,term=s.current_term
FROM schools s WHERE t.school_id=s.id AND (t.academic_year IS NULL OR t.term IS NULL);
ALTER TABLE timetable_entries
  DROP CONSTRAINT IF EXISTS timetable_entries_school_id_class_id_weekday_start_time_key;
CREATE UNIQUE INDEX IF NOT EXISTS timetable_entries_period_slot_idx
  ON timetable_entries(school_id,class_id,academic_year,term,weekday,start_time);

CREATE INDEX IF NOT EXISTS students_school_class_idx ON students(school_id, class_id);
CREATE INDEX IF NOT EXISTS attendance_school_date_idx ON attendance(school_id, attendance_date);
CREATE INDEX IF NOT EXISTS charges_school_student_idx ON fee_charges(school_id, student_id);
CREATE INDEX IF NOT EXISTS payments_school_student_idx ON payments(school_id, student_id);
