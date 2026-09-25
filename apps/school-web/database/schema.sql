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

CREATE INDEX IF NOT EXISTS students_school_class_idx ON students(school_id, class_id);
CREATE INDEX IF NOT EXISTS attendance_school_date_idx ON attendance(school_id, attendance_date);
CREATE INDEX IF NOT EXISTS charges_school_student_idx ON fee_charges(school_id, student_id);
CREATE INDEX IF NOT EXISTS payments_school_student_idx ON payments(school_id, student_id);
