/* Конфигурация приложения (порт env-параметров Java-версии: application.properties). */
'use strict';

class AppConfig {
  constructor(env = process.env) {
    this.port = Number(env.PORT || 8080);
    this.host = env.SERVER_ADDRESS || '127.0.0.1';
    this.publicOrigin = env.PUBLIC_ORIGIN || null;
    this.forceHttps = env.FORCE_HTTPS === 'true';
    this.httpsKeyFile = env.HTTPS_KEY_FILE || null;
    this.httpsCertFile = env.HTTPS_CERT_FILE || null;

    // PostgreSQL
    this.dbUrl = env.DATABASE_URL || env.DB_URL ||
      `postgres://${env.DB_USER || 'skyshelf'}:${env.DB_PASSWORD || 'skyshelf'}@${env.DB_HOST || 'localhost'}:${env.DB_PORT || 5432}/${env.DB_NAME || 'skyshelf'}`;

    // Хранилище объектов: local | minio
    this.storageDriver = env.APP_STORAGE || 'local';
    this.storageDir = env.APP_STORAGE_DIR || './data/objects';
    this.minio = {
      endpoint: env.MINIO_ENDPOINT || 'http://localhost:9000',
      user: env.MINIO_USER || env.MINIO_ACCESS_KEY || 'skyshelf',
      password: env.MINIO_PASSWORD || env.MINIO_SECRET_KEY || 'skyshelf-secret',
      secretKey: env.MINIO_SECRET_KEY || env.MINIO_PASSWORD || 'skyshelf-secret',
      bucket: env.MINIO_BUCKET || 'skyshelf',
      accessKey: env.MINIO_ACCESS_KEY || env.MINIO_USER || 'skyshelf',
    };

    // Криптография
    this.masterKey = env.SKYSHELF_MASTER_KEY || 'U2t5U2hlbGYtRGVtby1NYXN0ZXItS2V5LTIwMjYhISE=';

    // Бизнес-параметры
    this.demo = env.APP_DEMO === 'true';
    this.passwordRecoveryEnabled = env.APP_PASSWORD_RECOVERY !== 'false';
    this.quotaBytes = BigInt(env.APP_QUOTA_BYTES || '16106127360'); // START: 15 ГБ
    this.maxUploadBytes = 20 * 1024 * 1024;
    this.sessionTtlMs = 30 * 60 * 1000;
    this.cookiePrefix = '__Host-';

    // Подписки: срок 30 дней + 7 дней льготного периода перед удалением данных.
    this.subscriptionDays = Math.max(1, Number(env.APP_SUBSCRIPTION_DAYS || 30));
    this.subscriptionGraceDays = Math.max(0, Number(env.APP_SUBSCRIPTION_GRACE_DAYS || 7));
    this.subscriptionSweepIntervalMs = Math.max(1000, Number(env.APP_SUBSCRIPTION_SWEEP_MS || 10 * 60 * 1000));
  }

  isProduction() { return this.forceHttps || process.env.NODE_ENV === 'production'; }
}

module.exports = { AppConfig };
