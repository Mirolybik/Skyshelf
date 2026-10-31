-- 0003: подписки (30 дней + 7 дней льготного периода) и распределение квоты проекта между участниками.

CREATE TABLE IF NOT EXISTS subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       varchar(16) NOT NULL CHECK (scope IN ('ACCOUNT', 'PROJECT')),
  account_id  uuid REFERENCES accounts(id) ON DELETE CASCADE,
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  plan        varchar(16) NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  grace_until timestamptz NOT NULL,
  renewed_at  timestamptz,
  purged_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_target_check CHECK (
    (scope = 'ACCOUNT' AND account_id IS NOT NULL AND project_id IS NULL) OR
    (scope = 'PROJECT' AND project_id IS NOT NULL AND account_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_account
  ON subscriptions (account_id) WHERE scope = 'ACCOUNT';
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_project
  ON subscriptions (project_id) WHERE scope = 'PROJECT';
CREATE INDEX IF NOT EXISTS idx_subscriptions_due
  ON subscriptions (grace_until) WHERE purged_at IS NULL;

-- Персональные лимиты участников внутри квоты проекта. NULL-строк нет:
-- отсутствие строки означает «лимит не выделен» (в проекте без распределения — общая квота).
CREATE TABLE IF NOT EXISTS quota_allocations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  bytes      bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_quota_allocations_project ON quota_allocations (project_id);
