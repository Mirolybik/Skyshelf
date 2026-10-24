/* RBAC, аутентификация, 2FA, смена и восстановление пароля. */
'use strict';

const { CryptoService } = require('./crypto-service');
const { UnauthorizedError, ForbiddenError, TooManyRequestsError, ConflictError, BadRequestError, NotFoundError } = require('../domain/errors');

class AuthService {
  constructor({ accounts, passwordResets, crypto, totp, audit, sessions }) {
    this.accounts = accounts;
    this.passwordResets = passwordResets;
    this.crypto = crypto;
    this.totp = totp;
    this.audit = audit;
    this.sessions = sessions;
    this.attempts = new Map();
  }

  static normalizeEmail(email) { return String(email ?? '').trim().toLowerCase(); }

  limit(key, max) {
    const now = Date.now();
    for (const [k, v] of this.attempts) if (v.until < now) this.attempts.delete(k);
    if (this.attempts.size > 10_000) throw new TooManyRequestsError('Повторите попытку позже.');
    const old = this.attempts.get(key) ?? { count: 0, until: now + 600_000 };
    if (old.count >= max) throw new TooManyRequestsError('Слишком много попыток. Попробуйте через 10 минут.');
    this.attempts.set(key, { count: old.count + 1, until: old.until });
  }

  static validatePassword(password) {
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
      throw new BadRequestError('Пароль должен содержать от 10 до 128 символов.');
    }
  }

  async register({ name, email, password }, ip) {
    this.limit(`register:${ip}`, 20);
    if (!name || !String(name).trim()) throw new BadRequestError('Проверьте поля: имя, корректный email и пароль от 10 символов.');
    const normalized = AuthService.normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 180) throw new BadRequestError('Проверьте поля: имя, корректный email и пароль от 10 символов.');
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw new BadRequestError('Проверьте поля: имя, корректный email и пароль от 10 символов.');
    if (await this.accounts.findByEmail(normalized)) throw new ConflictError('Этот email уже зарегистрирован.');
    const account = await this.accounts.insert({
      email: normalized,
      name: String(name).trim().slice(0, 80),
      passwordHash: await this.crypto.hashPassword(password),
      role: 'USER',
      plan: 'START',
      blocked: false,
      theme: 'dark',
      accent: 'blue',
      twoFactorEnabled: false,
      createdAt: new Date(),
    });
    await this.audit.record(account.id, null, 'ACCOUNT_REGISTERED', 'ACCOUNT', account.id, normalized);
    return account;
  }

  async authenticate(email, password, ip) {
    const normalized = AuthService.normalizeEmail(email);
    this.limit(`ip:${ip}`, 60);
    this.limit(`email:${normalized}`, 10);
    const account = await this.accounts.findByEmail(normalized);
    const provided = typeof password === 'string' ? password : '';
    const ok = account ? await this.crypto.verifyPassword(account.passwordHash, provided) : false;
    if (!account || !ok || account.blocked) {
      throw new UnauthorizedError('Неверный email или пароль, либо аккаунт заблокирован.');
    }
    this.attempts.delete(`email:${normalized}`);
    return account;
  }

  async verifyTwoFactor(account, code) {
    try {
      if (!account.twoFactorSecret) throw new UnauthorizedError('Введите корректный 6-значный код 2FA.');
      if (!this.totp.valid(this.crypto.decryptText(account.twoFactorSecret), code)) {
        throw new UnauthorizedError('Введите корректный 6-значный код 2FA.');
      }
    } catch (error) {
      if (error.status) throw error;
      throw new UnauthorizedError('Не удалось проверить двухфакторную защиту.');
    }
  }

  async current(session) {
    if (!session || !session.userId) throw new UnauthorizedError();
    const account = await this.accounts.findById(session.userId);
    if (!account) throw new UnauthorizedError('Аккаунт не найден');
    if (account.blocked) throw new ForbiddenError('Аккаунт заблокирован администратором.');
    return account;
  }

  async requireAdmin(session) {
    const account = await this.current(session);
    if (account.role !== 'ADMIN') throw new ForbiddenError('Действие доступно администратору.');
    return account;
  }

  async touchLogin(account) {
    await this.accounts.update(account.id, { lastLoginAt: new Date() });
    await this.audit.record(account.id, null, 'LOGIN_SUCCEEDED', 'ACCOUNT', account.id, 'Вход в защищённую сессию');
  }

  async changePassword(account, currentPassword, newPassword) {
    AuthService.validatePassword(newPassword);
    const ok = await this.crypto.verifyPassword(account.passwordHash, String(currentPassword ?? ''));
    if (!ok) throw new UnauthorizedError('Текущий пароль указан неверно.');
    const hash = await this.crypto.hashPassword(newPassword);
    await this.accounts.update(account.id, { passwordHash: hash });
    await this.audit.record(account.id, null, 'PASSWORD_CHANGED', 'ACCOUNT', account.id, 'Пароль обновлён пользователем');
  }

  /** Запрос на сброс пароля: генерирует одноразовый токен со сроком 30 минут. */
  async requestPasswordReset(email, ip) {
    this.limit(`reset:${ip}`, 15);
    const normalized = AuthService.normalizeEmail(email);
    if (!normalized) throw new BadRequestError('Укажите email аккаунта.');
    const account = await this.accounts.findByEmail(normalized);
    if (!account || account.blocked || !this.passwordResets) {
      // Не раскрываем существование email по времени или статусу
      return { ok: true, message: 'Если аккаунт существует, инструкция по сбросу создана.' };
    }
    await this.passwordResets.deleteByUser(account.id);
    const rawToken = this.crypto.newToken();
    const tokenHash = CryptoService.tokenHash(rawToken);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await this.passwordResets.insertToken({
      tokenHash, userId: account.id, createdAt: new Date(), expiresAt, usedAt: null,
    });
    await this.audit.record(account.id, null, 'PASSWORD_RESET_REQUESTED', 'ACCOUNT', account.id, normalized);
    return {
      ok: true,
      message: 'Токен восстановления выпущен (действует 30 минут).',
      resetToken: rawToken,
      expiresAt,
    };
  }

  /** Подтверждение сброса пароля по одноразовому токену. */
  async confirmPasswordReset(rawToken, newPassword, code = null) {
    if (!rawToken || !this.passwordResets) throw new NotFoundError('Токен восстановления недействителен или истёк.');
    AuthService.validatePassword(newPassword);
    const tokenHash = CryptoService.tokenHash(rawToken);
    const record = await this.passwordResets.findValid(tokenHash);
    if (!record) throw new NotFoundError('Токен восстановления недействителен или истёк.');
    const account = await this.accounts.findById(record.userId);
    if (!account || account.blocked) throw new NotFoundError('Токен восстановления недействителен или истёк.');
    if (account.twoFactorEnabled) {
      await this.verifyTwoFactor(account, code);
    }
    const passwordHash = await this.crypto.hashPassword(newPassword);
    await this.accounts.update(account.id, { passwordHash });
    await this.passwordResets.markUsed(tokenHash);
    for (const s of this.sessions.byUser(account.id)) this.sessions.destroy(s.id);
    await this.audit.record(account.id, null, 'PASSWORD_CHANGED', 'ACCOUNT', account.id, 'Восстановление пароля по токену');
    return { ok: true };
  }
}

module.exports = { AuthService };
