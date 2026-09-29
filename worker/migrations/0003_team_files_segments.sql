-- Team accounts with roles, uploaded files, and per-device / per-source /
-- A/B-variant counters for the dashboard.

CREATE TABLE users (
  id           TEXT PRIMARY KEY,               -- u_…
  email        TEXT NOT NULL UNIQUE,           -- lower-case
  name         TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL,                  -- owner | admin | editor | viewer
  pass_hash    TEXT NOT NULL,                  -- pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,    -- consecutive wrong passwords
  locked_until TEXT                            -- set for 15 minutes after 5 wrong passwords
);

-- Login sessions. Only the SHA-256 of the bearer token is stored.
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions (user_id);

-- Single-use links: team invitations and password resets. Only the token hash is stored.
CREATE TABLE invites (
  id         TEXT PRIMARY KEY,                 -- i_… (listed in the team panel; the token itself is not)
  token_hash TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL DEFAULT 'invite',   -- invite | reset
  email      TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT '',
  user_id    TEXT,                             -- reset: the account whose password is set
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Who did what: publishing, deleting, experiments, team changes.
CREATE TABLE audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL,
  actor    TEXT NOT NULL DEFAULT '',  -- name at the time, kept after the member is removed
  actor_id TEXT,
  action   TEXT NOT NULL,
  target   TEXT NOT NULL DEFAULT '',
  detail   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_audit_ts ON audit_log (ts);

-- Files in R2. kind = 'answer' (uploaded by a respondent, private) or
-- 'media' (form images uploaded in the builder, public).
-- Answer files that never get attached to a submission are deleted after a day.
CREATE TABLE uploads (
  key         TEXT PRIMARY KEY,  -- R2 object key
  form_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  question_id TEXT NOT NULL DEFAULT '',
  session_id  TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  response_id TEXT
);
CREATE INDEX idx_uploads_form ON uploads (form_id, session_id);
CREATE INDEX idx_uploads_pending ON uploads (created_at) WHERE response_id IS NULL AND kind = 'answer';

-- Views / starts / completions per day by device, traffic source and A/B variant.
CREATE TABLE segments (
  form_id     TEXT NOT NULL,
  day         TEXT NOT NULL,
  dim         TEXT NOT NULL,  -- device | source | variant
  value       TEXT NOT NULL,  -- e.g. mobile, facebook, x_ab12cd:B
  views       INTEGER NOT NULL DEFAULT 0,
  starts      INTEGER NOT NULL DEFAULT 0,
  completions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (form_id, day, dim, value)
);

-- A session is counted under the device / source / variant of its first event.
ALTER TABLE sessions ADD COLUMN device TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN variant TEXT NOT NULL DEFAULT '';
