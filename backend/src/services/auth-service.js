/* RBAC и аутентификация (порт SecurityConfig + AuthController): проверка пароля Argon2id,
   TOTP-шаг, смена session ID при входе, троттлинг попыток входа, актуальность блокировки. */
'use strict';

const { UnauthorizedError, ForbiddenError, TooManyRequestsError, ConflictError, BadRequestError } = require('../domain/errors');

class AuthService {
  constructor({ accounts, crypto, totp, audit, sessions }) {
    this.accounts = accounts;
    this.crypto = crypto;
    this.totp = totp;
    this.audit = audit;
    this.sessions = sessions;
    this.attempts = new Map(); // key → { count, until }
  }

  static normalizeEmail(email) { return String(email ?? '').trim().toLowerCase(); }

  /** Скользящее окно на IP и email (порт limit() из AuthController). */
  limit(key, max) {
    const now = Date.now();
    for (const [k, v] of this.attempts) if (v.until < now) this.attempts.delete(k);
    if (this.attempts.size > 10_000) throw new TooManyRequestsError('Повторите попытку позже.');
    const old = this.attempts.get(key) ?? { count: 0, until: now + 600_000 };
    if (old.count >= max) throw new TooManyRequestsError('Слишком много попыток. Попробуйте через 10 минут.');
    this.attempts.set(key, { count: old.count + 1, until: old.until });
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
    });
    await this.audit.record(account.id, null, 'ACCOUNT_REGISTERED', 'ACCOUNT', account.id, normalized);
    return account;
  }

  /** Проверка пары email/пароль без создания сессии (используется контроллером логина). */
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
    if (account.twoFactorEnabled) {
      // второй шаг — код TOTP проверяет контроллер login (чтобы не светить различие состояний здесь)
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

  /** Аккаунт из запроса: сессия + актуальный бан (порт current(Authentication)). */
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
}

module.exports = { AuthService };
