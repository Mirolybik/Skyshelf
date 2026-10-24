/* Контроллер безопасности и журнала действий: 2FA (TOTP), пароль, крипто-обзор и /api/activity. */
'use strict';

const { Controller } = require('./controller');
const { BadRequestError, UnauthorizedError } = require('../domain/errors');

class SecurityController extends Controller {
  routes() {
    return [
      ['GET', '/api/security/overview', this.overview],
      ['POST', '/api/security/2fa/setup', this.setup2fa],
      ['POST', '/api/security/2fa/enable', this.enable2fa],
      ['POST', '/api/security/2fa/disable', this.disable2fa],
      ['POST', '/api/security/password', this.changePassword],
      ['GET', '/api/activity', this.activity],
    ];
  }

  async overview(request) {
    const user = await this.services.auth.current(request.session);
    return {
      twoFactorEnabled: Boolean(user.twoFactorEnabled),
      passwordAlgorithm: 'Argon2id',
      fileEncryption: 'AES-256-GCM',
      integrity: 'SHA-256 + GCM Tag',
      sessionProtection: 'HttpOnly + SameSite=Lax + CSRF',
      passwordRecovery: this.services.config.passwordRecoveryEnabled ? 'Token-based (SHA-256)' : 'Disabled',
    };
  }

  async setup2fa(request) {
    const user = await this.services.auth.current(request.session);
    const secret = this.services.totp.newSecret();
    const encrypted = this.services.crypto.encryptText(secret);
    await this.services.repos.accounts.update(user.id, {
      twoFactorSecret: encrypted,
      twoFactorEnabled: false,
    });
    await this.services.audit.record(user.id, null, 'TWO_FACTOR_SETUP_STARTED', 'ACCOUNT', user.id, 'Сгенерирован секрет TOTP');
    return {
      secret,
      uri: this.services.totp.uri(user.email, secret),
    };
  }

  async enable2fa(request) {
    const user = await this.services.auth.current(request.session);
    const { code } = request.body ?? {};
    if (!user.twoFactorSecret) throw new BadRequestError('Сначала запустите настройку 2FA.');
    const secret = this.services.crypto.decryptText(user.twoFactorSecret);
    if (!this.services.totp.valid(secret, code)) {
      throw new BadRequestError('Неверный 6-значный код подтверждения.');
    }
    await this.services.repos.accounts.update(user.id, { twoFactorEnabled: true });
    await this.services.audit.record(user.id, null, 'TWO_FACTOR_ENABLED', 'ACCOUNT', user.id, 'Двухфакторная аутентификация включена');
    return { ok: true, twoFactorEnabled: true };
  }

  async disable2fa(request) {
    const user = await this.services.auth.current(request.session);
    const { password, code } = request.body ?? {};
    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new BadRequestError('Двухфакторная защита не включена.');
    }
    const passOk = await this.services.crypto.verifyPassword(user.passwordHash, String(password ?? ''));
    if (!passOk) throw new UnauthorizedError('Неверный текущий пароль.');
    const secret = this.services.crypto.decryptText(user.twoFactorSecret);
    if (!this.services.totp.valid(secret, code)) {
      throw new BadRequestError('Неверный 6-значный код TOTP.');
    }
    await this.services.repos.accounts.update(user.id, {
      twoFactorEnabled: false,
      twoFactorSecret: null,
    });
    await this.services.audit.record(user.id, null, 'TWO_FACTOR_DISABLED', 'ACCOUNT', user.id, 'Двухфакторная аутентификация отключена');
    return { ok: true, twoFactorEnabled: false };
  }

  async changePassword(request) {
    const user = await this.services.auth.current(request.session);
    const { currentPassword, newPassword } = request.body ?? {};
    await this.services.auth.changePassword(user, currentPassword, newPassword);
    return { ok: true };
  }

  async activity(request) {
    const user = await this.services.auth.current(request.session);
    return this.services.audit.visible(user.id, request.query?.limit);
  }
}

module.exports = { SecurityController };
