-- Belajarlagi Form on Cloudflare D1.
-- Raw submissions live in `responses`; the dashboard reads the small
-- pre-aggregated tables (daily, funnel, answer_counts) so its cost does not
-- grow with the number of submissions.

CREATE TABLE forms (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT '',
  json         TEXT NOT NULL,
  sheet_id     TEXT,                       -- Google Sheet mirror (NULL = no sync)
  sheet_cols   TEXT NOT NULL DEFAULT '[]', -- column keys already written to the sheet header, in order
  sheet_status TEXT NOT NULL DEFAULT '',   -- last sync result, shown in the dashboard
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE responses (
  id           TEXT PRIMARY KEY,
  form_id      TEXT NOT NULL,
  submitted_at TEXT NOT NULL,              -- ISO 8601 UTC
  session_id   TEXT,
  answers      TEXT NOT NULL,              -- JSON {questionId: value}
  hidden       TEXT NOT NULL DEFAULT '{}', -- JSON {utm_source: ...}
  meta         TEXT NOT NULL DEFAULT '{}', -- JSON {durationSec, pageUrl, ...}
  synced       INTEGER NOT NULL DEFAULT 0  -- 1 once copied to Google Sheets
);
CREATE INDEX idx_responses_form_time ON responses (form_id, submitted_at);
CREATE INDEX idx_responses_unsynced ON responses (synced, submitted_at) WHERE synced = 0;
-- Client retries reuse the same session id: one submission per session.
CREATE UNIQUE INDEX idx_responses_session ON responses (form_id, session_id) WHERE session_id IS NOT NULL;

-- One row per visitor session; lets repeated/late events update counters exactly once.
CREATE TABLE sessions (
  id          TEXT NOT NULL,
  form_id     TEXT NOT NULL,
  day         TEXT NOT NULL,               -- YYYY-MM-DD (UTC) of the first event
  started     INTEGER NOT NULL DEFAULT 0,
  completed   INTEGER NOT NULL DEFAULT 0,
  path        TEXT NOT NULL DEFAULT '[]',  -- JSON array of question ids reached
  PRIMARY KEY (form_id, id)
);

CREATE TABLE daily (
  form_id     TEXT NOT NULL,
  day         TEXT NOT NULL,
  views       INTEGER NOT NULL DEFAULT 0,
  starts      INTEGER NOT NULL DEFAULT 0,
  completions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (form_id, day)
);

CREATE TABLE funnel (
  form_id     TEXT NOT NULL,
  day         TEXT NOT NULL,
  question_id TEXT NOT NULL,
  reached     INTEGER NOT NULL DEFAULT 0,
  dropped     INTEGER NOT NULL DEFAULT 0,  -- sessions whose last reached question is this one and never completed
  PRIMARY KEY (form_id, day, question_id)
);

-- Distribution counters for choice / scale / number questions, plus
-- '__source' (utm_source) and '__duration' (seconds, bucketed by 5).
CREATE TABLE answer_counts (
  form_id     TEXT NOT NULL,
  day         TEXT NOT NULL,
  question_id TEXT NOT NULL,
  value       TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (form_id, day, question_id, value)
);
