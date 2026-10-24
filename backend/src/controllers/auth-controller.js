/* Auth + профиль + восстановление пароля: регистрация, вход с TOTP, HttpOnly-сессии, CSRF, /me. */
'use strict';

const { Controller } = require('./controller');
const { BadRequestError } = require('../domain/errors');

const SESSION_COOKIE = 'SKYSHELF_SESSION';

class AuthController extends Controller {
  routes() {
    return [
      ['GET', '/api/health', this.health],
      ['GET', '/api/auth/csrf', this.csrf],
      ['POST', '/api/auth/register', this.signup],
      ['POST', '/api/auth/login', this.login],
      ['POST', '/api/auth/logout', this.logout],
      ['POST', '/api/auth/password-reset/request', this.requestReset],
      ['POST', '/api/auth/password-reset/confirm', this.confirmReset],
      ['GET', '/api/me', this.me],
      ['PATCH', '/api/me', this.patchMe],
    ];
  }

  static sessionCookie(value, maxAge = 0, secure = false) {
    const flags = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAge)}`];
    if (secure) flags.push('Secure');
    return flags.join('; ');
  }

  health() {
    return { status: 'ok', version: '1.0.0', encryption: 'AES-256-GCM' };
  }

  csrf(request, reply) {
    const session = request.session ?? this.services.sessions.create();
    request.session = session;
    reply.header('Set-Cookie', AuthController.sessionCookie(
      session.id,
      this.services.config.sessionTtlMs / 1000,
      this.services.config.forceHttps
    ));
    return { token: session.csrfToken, header: 'X-CSRF-Token' };
  }

  async signup(request, reply) {
    const account = await this.services.auth.register(request.body ?? {}, request.ip);
    reply.code(201);
    return account.view();
  }

  async login(request, reply) {
    const body = request.body ?? {};
    if (typeof body.email !== 'string' || typeof body.password !== 'string') throw new BadRequestError('Проверьте поля формы.');
    const { auth, sessions, config } = this.services;
    const account = await auth.authenticate(body.email, body.password, request.ip);
    if (account.twoFactorEnabled) await auth.verifyTwoFactor(account, body.code);
    const session = sessions.rotate(request.session?.id ?? request.cookies[SESSION_COOKIE]);
    session.userId = account.id;
    request.session = session;
    reply.header('Set-Cookie', AuthController.sessionCookie(session.id, config.sessionTtlMs / 1000, config.forceHttps));
    await auth.touchLogin(account);
    return account.view();
  }

  logout(request, reply) {
    if (request.session) this.services.sessions.destroy(request.session.id);
    reply.header('Set-Cookie', AuthController.sessionCookie('', 0, this.services.config.forceHttps));
    return { ok: true };
  }

  async requestReset(request) {
    const { email } = request.body ?? {};
    return this.services.auth.requestPasswordReset(email, request.ip);
  }

  async confirmReset(request) {
    const { token, newPassword, code } = request.body ?? {};
    return this.services.auth.confirmPasswordReset(token, newPassword, code);
  }

  async me(request) {
    const account = await this.services.auth.current(request.session);
    return account.view();
  }

  async patchMe(request) {
    const account = await this.services.auth.current(request.session);
    const body = request.body ?? {};
    const name = body.name !== undefined ? body.name : account.name;
    const theme = body.theme !== undefined ? body.theme : account.theme;
    const accent = body.accent !== undefined ? body.accent : account.accent;
    if (!name || !String(name).trim()) throw new BadRequestError('Имя обязательно.');
    if (!['dark', 'light'].includes(theme)) throw new BadRequestError('Выберите тему оформления.');
    if (!['blue', 'violet', 'mint'].includes(accent)) throw new BadRequestError('Выберите акцентный цвет.');
    await this.services.repos.accounts.update(account.id, {
      name: String(name).trim().slice(0, 80), theme, accent,
    });
    await this.services.audit.record(account.id, null, 'PROFILE_UPDATED', 'ACCOUNT', account.id, 'Профиль и оформление');
    const updated = await this.services.repos.accounts.findById(account.id);
    return updated.view();
  }
}

module.exports = { AuthController, SESSION_COOKIE };
