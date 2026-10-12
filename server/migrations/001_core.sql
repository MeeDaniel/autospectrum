-- All schedule-changing writes lock this singleton before reading catalog or bookings.
CREATE TABLE IF NOT EXISTS schedule_state (
  id integer PRIMARY KEY CHECK (id = 1)
);
INSERT INTO schedule_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS categories (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);

CREATE TABLE IF NOT EXISTS services (
  id text PRIMARY KEY,
  category_id text NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX IF NOT EXISTS services_category_idx ON services(category_id);

CREATE TABLE IF NOT EXISTS bookings (
  id text PRIMARY KEY,
  service_id text NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  date date NOT NULL,
  status text NOT NULL CHECK (status IN ('new', 'confirmed', 'completed', 'cancelled')),
  start_minute integer GENERATED ALWAYS AS ((data->>'startMinute')::integer) STORED,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX IF NOT EXISTS bookings_date_start_idx ON bookings(date, start_minute, id);
CREATE INDEX IF NOT EXISTS bookings_service_idx ON bookings(service_id);
CREATE INDEX IF NOT EXISTS bookings_status_date_idx ON bookings(status, date);

CREATE TABLE IF NOT EXISTS settings (
  id integer PRIMARY KEY CHECK (id = 1),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key text PRIMARY KEY,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (id, data) VALUES (1,
  '{"workStart":540,"workEnd":1080,"breaks":[{"start":720,"end":750}],"revision":1,"weekdays":{"0":{"closed":true,"workStart":540,"workEnd":1080,"breaks":[]},"1":{"closed":false,"workStart":540,"workEnd":1080,"breaks":[{"start":720,"end":750}]},"2":{"closed":false,"workStart":540,"workEnd":1080,"breaks":[{"start":720,"end":750}]},"3":{"closed":false,"workStart":540,"workEnd":1080,"breaks":[{"start":720,"end":750}]},"4":{"closed":false,"workStart":540,"workEnd":1080,"breaks":[{"start":720,"end":750}]},"5":{"closed":false,"workStart":540,"workEnd":1080,"breaks":[{"start":720,"end":750}]},"6":{"closed":false,"workStart":540,"workEnd":1080,"breaks":[{"start":720,"end":750}]}},"exceptions":{}}'::jsonb)
ON CONFLICT (id) DO NOTHING;
