-- 0001: базовая схема SkyShelf (порт JPA-сущностей back 2 в PostgreSQL).

CREATE TABLE IF NOT EXISTS accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              varchar(180) NOT NULL UNIQUE,
  password_hash      text NOT NULL,
  name               varchar(80) NOT NULL,
  role               varchar(16) NOT NULL DEFAULT 'USER',
  plan               varchar(16) NOT NULL DEFAULT 'START',
  blocked            boolean NOT NULL DEFAULT false,
  theme              varchar(16) NOT NULL DEFAULT 'dark',
  accent             varchar(16) NOT NULL DEFAULT 'blue',
  two_factor_secret  text,
  two_factor_enabled boolean NOT NULL DEFAULT false,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES accounts(id),
  name          varchar(120) NOT NULL,
  description   varchar(700) NOT NULL DEFAULT '',
  course        varchar(120) NOT NULL DEFAULT '',
  teacher       varchar(120) NOT NULL DEFAULT '',
  deadline      timestamptz,
  accent        varchar(16) NOT NULL DEFAULT 'blue',
  cover         varchar(16) NOT NULL DEFAULT 'orb',
  status        varchar(16) NOT NULL DEFAULT 'IN_PROGRESS',
  final_file_id uuid,
  plan          varchar(16) NOT NULL DEFAULT 'START',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS folders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES accounts(id),
  project_id uuid REFERENCES projects(id),
  name       varchar(120) NOT NULL,
  color      varchar(16) NOT NULL DEFAULT 'blue'
);

CREATE TABLE IF NOT EXISTS stored_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES accounts(id),
  project_id    uuid REFERENCES projects(id),
  folder_id     uuid REFERENCES folders(id),
  name          varchar(180) NOT NULL,
  object_key    uuid NOT NULL,
  size          bigint NOT NULL,
  mime_type     varchar(100) NOT NULL DEFAULT 'application/octet-stream',
  checksum      varchar(64),
  version_count integer NOT NULL DEFAULT 1,
  created_by_id uuid,
  favorite      boolean NOT NULL DEFAULT false,
  trashed       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stored_files_owner ON stored_files (owner_id);
CREATE INDEX IF NOT EXISTS idx_stored_files_project ON stored_files (project_id);

ALTER TABLE projects ADD CONSTRAINT fk_projects_final_file
  FOREIGN KEY (final_file_id) REFERENCES stored_files(id);

CREATE TABLE IF NOT EXISTS file_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id        uuid NOT NULL REFERENCES stored_files(id),
  object_key     uuid NOT NULL,
  version_number integer NOT NULL,
  size           bigint NOT NULL,
  mime_type      varchar(100) NOT NULL DEFAULT 'application/octet-stream',
  checksum       varchar(64),
  created_by_id  uuid,
  note           varchar(240) NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions (file_id);

CREATE TABLE IF NOT EXISTS memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  user_id    uuid NOT NULL REFERENCES accounts(id),
  role       varchar(16) NOT NULL DEFAULT 'READER',
  UNIQUE (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS share_links (
  token           varchar(64) PRIMARY KEY,
  file_id         uuid NOT NULL REFERENCES stored_files(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  max_downloads   integer NOT NULL DEFAULT 0,
  download_count  integer NOT NULL DEFAULT 0,
  password_hash   text
);

CREATE TABLE IF NOT EXISTS project_tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  title       varchar(180) NOT NULL,
  completed   boolean NOT NULL DEFAULT false,
  assignee_id uuid REFERENCES accounts(id),
  due_at      timestamptz,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks (project_id);

CREATE TABLE IF NOT EXISTS submission_links (
  token      varchar(64) PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  views      integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_submission_links_project ON submission_links (project_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid,
  project_id  uuid,
  action      varchar(60) NOT NULL,
  target_type varchar(40) NOT NULL,
  target_id   uuid,
  details     varchar(500) NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_events (project_id);
