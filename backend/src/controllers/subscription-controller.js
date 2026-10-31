/* Контроллер подписки аккаунта: статус, срок, льготный период и тестовое продление. */
'use strict';

const { Controller } = require('./controller');

class SubscriptionController extends Controller {
  routes() {
    return [
      ['GET', '/api/subscription', this.accountSubscription],
      ['POST', '/api/subscription/renew', this.renewAccountSubscription],
    ];
  }

  async accountSubscription(request) {
    const user = await this.services.auth.current(request.session);
    return this.services.subscriptions.accountInfo(user.id);
  }

  async renewAccountSubscription(request) {
    const user = await this.services.auth.current(request.session);
    const plan = request.body?.plan ?? user.plan;
    return this.services.db.transaction(() =>
      this.services.subscriptions.renewAccount(user.id, plan, user.id)
    );
  }
}

module.exports = { SubscriptionController };
