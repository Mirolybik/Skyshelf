/* Контроллер — базовый класс HTTP-слоя (аналог @RestController): объявляет route-таблицу,
   регистрирует её в Fastify и оборачивает обработчик единой обработкой ошибок. */
'use strict';

const { DomainError } = require('../domain/errors');

class Controller {
  constructor(services) { this.services = services; }

  /** [ [method, path, handler], ... ] — переопределяется потомками. */
  routes() { return []; }

  register(app) {
    for (const [method, path, handler] of this.routes()) {
      app.route({
        method, url: path,
        handler: async (request, reply) => {
          try {
            const result = await handler.call(this, request, reply);
            if (!reply.sent) reply.send(result ?? null);
          } catch (error) {
            this.handleError(request, reply, error);
          }
        },
      });
    }
  }

  handleError(request, reply, error) {
    if (error instanceof DomainError) {
      return reply.code(error.status).type('application/json').send({ message: error.message });
    }
    if (error && error.rawBody === undefined && error.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).type('application/json').send({ message: 'Максимальный размер файла — 20 МБ.' });
    }
    if (error && (error.code === 'FST_VALIDATION_ERROR' || error.statusCode === 400 && /body|JSON/i.test(String(error.message)))) {
      return reply.code(400).type('application/json').send({ message: 'Некорректный запрос.' });
    }
    if (error && error.code === '23505') {
      return reply.code(409).type('application/json').send({ message: 'Такая запись уже существует.' });
    }
    request.log.error({ err: error }, 'Request failed');
    return reply.code(500).type('application/json').send({ message: 'Не удалось выполнить действие. Проверьте журнал сервера.' });
  }

  static badRequest(message) { return new DomainError(400, message); }
}

module.exports = { Controller };
