-- 0002: токены восстановления пароля (хранятся только SHA-256 хеши токенов)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash  varchar(64) PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens (user_id);
