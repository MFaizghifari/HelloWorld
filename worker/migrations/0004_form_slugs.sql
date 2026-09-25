-- Custom form links: https://<host>/<slug>. NULL = no custom link (several NULLs are allowed).
ALTER TABLE forms ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_forms_slug ON forms (slug);
