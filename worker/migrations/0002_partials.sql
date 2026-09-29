-- Unfinished responses, kept only for forms that opt in (form.recovery.partials)
-- and only once a valid email or phone number was entered. A row is deleted as
-- soon as the same session submits, and after 30 days by the cron job.
CREATE TABLE partials (
  form_id        TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,              -- ISO 8601 UTC
  answers        TEXT NOT NULL,              -- JSON {questionId: value}
  hidden         TEXT NOT NULL DEFAULT '{}', -- JSON {utm_source: ...}
  contact        TEXT NOT NULL,              -- JSON {email, phone, name}
  last_question  TEXT NOT NULL DEFAULT '',
  answered_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (form_id, session_id)
);
CREATE INDEX idx_partials_form_time ON partials (form_id, updated_at);
