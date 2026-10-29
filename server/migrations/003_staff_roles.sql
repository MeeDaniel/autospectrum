ALTER TABLE staff_users
  ADD COLUMN role text NOT NULL DEFAULT 'staff',
  ADD CONSTRAINT staff_role_valid CHECK (role IN ('staff', 'operator'));
