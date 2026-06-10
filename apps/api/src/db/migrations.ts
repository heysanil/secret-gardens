/**
 * Migration SQL embedded as TS constants (no .sql files read at runtime —
 * keeps a compiled container simple). Applied in array order by name.
 *
 * NOTE: columns referencing better-auth's `user` table (created_by, user_id)
 * are deliberately plain TEXT with indexes, NOT foreign keys — better-auth
 * creates `user` in Phase 4, after these migrations run, and foreign_keys=ON
 * would make a forward REFERENCES fail. FKs among OUR tables keep
 * ON DELETE CASCADE.
 */

const MIGRATION_001_INIT = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_projects_created_by ON projects(created_by);

CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, slug)
);
CREATE INDEX idx_environments_project_id ON environments(project_id);

CREATE TABLE project_memberships (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'write', 'read')),
  UNIQUE(project_id, user_id)
);
CREATE INDEX idx_project_memberships_user_id ON project_memberships(user_id);

CREATE TABLE project_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  wrapped_dek TEXT NOT NULL,
  wrap_nonce TEXT NOT NULL,
  wrap_tag TEXT NOT NULL,
  kek_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  UNIQUE(project_id, version)
);

CREATE TABLE service_tokens (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'read_write')),
  environment_ids TEXT,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_service_tokens_project_id ON service_tokens(project_id);
CREATE INDEX idx_service_tokens_created_by ON service_tokens(created_by);

CREATE TABLE user_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_user_tokens_user_id ON user_tokens(user_id);

CREATE TABLE instance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Membership creation timestamp for the members listing. DEFAULT 0 only
 * satisfies the constraint for any pre-existing rows; the API always writes
 * an explicit value.
 */
const MIGRATION_002_MEMBERSHIP_CREATED_AT = `
ALTER TABLE project_memberships ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
`;

export interface Migration {
  name: string;
  sql: string;
}

/** Ordered list — append-only; never edit an applied migration. */
export const MIGRATIONS: readonly Migration[] = [
  { name: "001_init", sql: MIGRATION_001_INIT },
  {
    name: "002_membership_created_at",
    sql: MIGRATION_002_MEMBERSHIP_CREATED_AT,
  },
];
