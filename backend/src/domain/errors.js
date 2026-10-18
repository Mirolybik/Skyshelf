/* Доменные ошибки уровня сервиса (порт ResponseStatusException из Java-версии). */
'use strict';

class DomainError extends Error {
  constructor(status, message) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

class BadRequestError extends DomainError { constructor(m = 'Недопустимый запрос.') { super(400, m); } }
class UnauthorizedError extends DomainError { constructor(m = 'Войдите в аккаунт') { super(401, m); } }
class ForbiddenError extends DomainError { constructor(m = 'Доступ запрещён или сессия устарела. Обновите страницу.') { super(403, m); } }
class NotFoundError extends DomainError { constructor(m = 'Объект не найден или недоступен.') { super(404, m); } }
class ConflictError extends DomainError { constructor(m = 'Такая запись уже существует.') { super(409, m); } }
class PayloadTooLargeError extends DomainError { constructor(m = 'Максимум 20 МБ на файл.') { super(413, m); } }
class TooManyRequestsError extends DomainError { constructor(m = 'Слишком много попыток. Попробуйте через 10 минут.') { super(429, m); } }
class IntegrityError extends DomainError { constructor(m = 'Проверка целостности файла не пройдена.') { super(500, m); } }

module.exports = {
  DomainError, BadRequestError, UnauthorizedError, ForbiddenError,
  NotFoundError, ConflictError, PayloadTooLargeError, TooManyRequestsError, IntegrityError,
};
