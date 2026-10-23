CREATE TABLE IF NOT EXISTS staff_users (
  id uuid PRIMARY KEY,
  login text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  blocked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_login_format CHECK (login ~ '^[a-z0-9._@-]{3,64}$')
);

CREATE TABLE IF NOT EXISTS staff_sessions (
  token_hash text PRIMARY KEY,
  staff_id uuid NOT NULL REFERENCES staff_users(id),
  csrf_hash text NOT NULL,
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_sessions_staff_id_idx ON staff_sessions (staff_id);
CREATE INDEX IF NOT EXISTS staff_sessions_expires_at_idx ON staff_sessions (expires_at);

CREATE TABLE IF NOT EXISTS staff_login_attempts (
  id bigserial PRIMARY KEY,
  login text NOT NULL,
  ip text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_login_attempts_key_idx ON staff_login_attempts (login, ip, failed_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES staff_users(id),
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_actor_id_id_idx ON audit_log (actor_id, id DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity_id_idx ON audit_log (entity, entity_id, id DESC);
