/* Auth + профиль (порт AuthController.java): регистрация, вход с TOTP, HttpOnly-сессии, CSRF, /me. */
'use strict';

const { Controller } = require('./controller');
const { UnauthorizedError, BadRequestError } = require('../domain/errors');

const SESSION_COOKIE = 'SKYSHELF_SESSION';

class AuthController extends Controller {
  routes() {
    return [
      ['GET', '/api/health', this.health],
      ['GET', '/api/auth/csrf', this.csrf],
      ['POST', '/api/auth/register', this.signup],
      ['POST', '/api/auth/login', this.login],
      ['POST', '/api/auth/logout', this.logout],
      ['GET', '/api/me', this.me],
      ['PATCH', '/api/me', this.patchMe],
    ];
  }

  static sessionCookie(value, maxAge = 0) {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  }

  health() {
    return { status: 'ok', version: '1.0.0', encryption: 'AES-256-GCM' };
  }

  csrf(request, reply) {
    const session = request.session ?? this.services.sessions.create();
    reply.header('Set-Cookie', AuthController.sessionCookie(session.id, this.services.config.sessionTtlMs / 1000));
    return { token: session.csrfToken, header: 'X-CSRF-Token' };
  }

  // не «register»: это имя занято Controller.register(app), который вешает роуты на Fastify
  async signup(request, reply) {
    const account = await this.services.auth.register(request.body ?? {}, request.ip);
    reply.code(201);
    return account.view();
  }

  async login(request, reply) {
    const body = request.body ?? {};
    if (typeof body.email !== 'string' || typeof body.password !== 'string') throw new BadRequestError('Проверьте поля формы.');
    const { auth, sessions } = this.services;
    const account = await auth.authenticate(body.email, body.password, request.ip);
    if (account.twoFactorEnabled) await auth.verifyTwoFactor(account, body.code);
    // защита от фиксации сессии: старый session ID уничтожается, создаётся новый
    const session = sessions.rotate(request.session?.id ?? request.cookies[SESSION_COOKIE_ID]);
    session.userId = account.id;
    reply.header('Set-Cookie', AuthController.sessionCookie(session.id, this.services.config.sessionTtlMs / 1000));
    await auth.touchLogin(account);
    return account.view();
  }

  logout(request, reply) {
    if (request.session) this.services.sessions.destroy(request.session.id);
    reply.header('Set-Cookie', AuthController.sessionCookie('', 0));
    return { ok: true };
  }

  async me(request) {
    const account = await this.services.auth.current(request.session);
    return account.view();
  }

  async patchMe(request) {
    const account = await this.services.auth.current(request.session);
    const { name, theme, accent } = request.body ?? {};
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

// внутренний хелпер: id куки из запроса подставляется middleware-ем
const SESSION_COOKIE_ID = '__session_id__';

module.exports = { AuthController, SESSION_COOKIE };
