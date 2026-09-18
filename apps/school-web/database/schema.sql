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

CREATE TABLE IF NOT EXISTS school_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  auth_user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'administrator', 'teacher', 'finance')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, auth_user_id)
);

CREATE TABLE IF NOT EXISTS classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
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

CREATE INDEX IF NOT EXISTS students_school_class_idx ON students(school_id, class_id);
CREATE INDEX IF NOT EXISTS attendance_school_date_idx ON attendance(school_id, attendance_date);
CREATE INDEX IF NOT EXISTS charges_school_student_idx ON fee_charges(school_id, student_id);
CREATE INDEX IF NOT EXISTS payments_school_student_idx ON payments(school_id, student_id);
