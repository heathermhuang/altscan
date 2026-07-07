CREATE TABLE tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  email      TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner','admin','viewer')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (tenant_id, email)
);
CREATE INDEX members_email_idx ON members(email);

CREATE TABLE explorers (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  key                  TEXT NOT NULL,
  brand                TEXT NOT NULL,
  public_url           TEXT NOT NULL,
  origin_url           TEXT NOT NULL,
  render_web_id        TEXT,
  render_indexer_id    TEXT,
  render_db_id         TEXT,
  cf_zone_id           TEXT,
  ga4_property_id      TEXT,
  admin_secret_binding TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','provisioning','suspended')),
  created_at           INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_email TEXT NOT NULL,
  tenant_id   TEXT,
  explorer_id TEXT,
  action      TEXT NOT NULL,
  payload     TEXT,
  at          INTEGER NOT NULL DEFAULT (unixepoch())
);
