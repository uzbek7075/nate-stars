/**
 * Nate Stars — API Client (UZS Edition)
 */

const API = (() => {
  const BASE_URL = '';

  function getInitData() {
    if (window.Telegram && window.Telegram.WebApp) {
      return window.Telegram.WebApp.initData || '';
    }
    return '';
  }

  async function request(url, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': getInitData(),
      ...options.headers
    };

    try {
      const response = await fetch(`${BASE_URL}${url}`, {
        ...options,
        headers
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const err = new Error(data.error || `HTTP ${response.status}`);
        err.status = response.status;
        err.data = data;
        throw err;
      }

      return data;
    } catch (err) {
      console.error(`API Error [${url}]:`, err);
      throw err;
    }
  }

  return {
    // Получить тарифы и настройки (номер карты, цены)
    getCatalog() {
      return request('/api/catalog');
    },

    // Получить профиль
    getUser() {
      return request('/api/user');
    },

    // Предпросмотр получателя по @username
    getRecipientPreview(username) {
      return request(`/api/recipient-preview?username=${encodeURIComponent(username)}`);
    },

    // Проверка TON-адреса
    validateTonAddress(address) {
      return request(`/api/ton/validate-address?address=${encodeURIComponent(address)}`);
    },

    // Подготовить заказ (зарезервировать точную сумму с «копейками»)
    prepareOrder(orderData) {
      return request('/api/orders/prepare', {
        method: 'POST',
        body: JSON.stringify(orderData)
      });
    },

    // Отметить оплату («Я оплатил»)
    markOrderPaid(orderId, senderComment) {
      return request(`/api/orders/${encodeURIComponent(orderId)}/paid`, {
        method: 'POST',
        body: JSON.stringify({ senderComment })
      });
    },

    // Проверить статус оплаты заказа (live polling)
    getOrderStatus(orderId) {
      return request(`/api/orders/${encodeURIComponent(orderId)}/status`);
    },

    // Создать заказ на перевод (fallback)
    createOrder(orderData) {
      return request('/api/create-order', {
        method: 'POST',
        body: JSON.stringify(orderData)
      });
    },

    // Получить историю заказов
    getOrders() {
      return request('/api/orders');
    },

    // Админ-панель: данные и статистика
    getAdminInfo() {
      return request('/api/admin/info');
    },

    // Админ-панель: сохранить новые цены и настройки
    updateAdminSettings(settings) {
      return request('/api/admin/update-settings', {
        method: 'POST',
        body: JSON.stringify(settings)
      });
    },

    // Админ-панель: подтвердить или отклонить заказ
    adminOrderAction(orderId, action) {
      return request('/api/admin/order-action', {
        method: 'POST',
        body: JSON.stringify({ orderId, action })
      });
    },

    // Админ-панель: авторизация Fragment
    authenticateFragment(data) {
      return request('/api/admin/fragment-auth', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },

    // Админ-панель: сгенерировать чистый кошелёк TON (24 слова)
    generateTonWallet() {
      return request('/api/admin/generate-wallet', {
        method: 'POST'
      });
    },

    // Админ-панель: CardXabar (автоподтверждение платежей)
    getCardXabarStatus() {
      return request('/api/admin/cardxabar/status');
    },

    exportCardXabarSession() {
      return request('/api/admin/cardxabar/export');
    },

    cardXabarAuthPhone(data) {
      return request('/api/admin/cardxabar/auth-phone', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },

    cardXabarAuthCode(code) {
      return request('/api/admin/cardxabar/auth-code', {
        method: 'POST',
        body: JSON.stringify({ code })
      });
    },

    cardXabarAuthQr(data) {
      return request('/api/admin/cardxabar/auth-qr', {
        method: 'POST',
        body: JSON.stringify(data)
      });
    },

    cardXabarAuthPassword(password) {
      return request('/api/admin/cardxabar/auth-password', {
        method: 'POST',
        body: JSON.stringify({ password })
      });
    },

    cardXabarDisconnect() {
      return request('/api/admin/cardxabar/disconnect', {
        method: 'POST'
      });
    },

    getAdminTonBalance() {
      return request('/api/admin/ton-balance');
    },

    refreshAdminTonRate() {
      return request('/api/admin/ton-rate/refresh', {
        method: 'POST'
      });
    },

    sendBroadcastTest(text, includeOpenButton = true) {
      return request('/api/admin/broadcast/test', {
        method: 'POST',
        body: JSON.stringify({ text, includeOpenButton })
      });
    },

    sendBroadcast(text, includeOpenButton = true) {
      return request('/api/admin/broadcast/send', {
        method: 'POST',
        body: JSON.stringify({ text, includeOpenButton })
      });
    },

    payOrderWithBalance(orderData) {
      return request('/api/orders/pay-with-balance', {
        method: 'POST',
        body: JSON.stringify(orderData)
      });
    },

    createPaynetTopup(cashAmount) {
      return request('/api/topups/paynet/create', {
        method: 'POST',
        body: JSON.stringify({ cashAmount })
      });
    },

    getTopupStatus(topupId) {
      return request(`/api/topups/${encodeURIComponent(topupId)}/status`);
    },

    cancelPaynetTopup(topupId) {
      return request(`/api/topups/${encodeURIComponent(topupId)}/cancel`, {
        method: 'POST'
      });
    },

    markPaynetTopupPaid(topupId) {
      return request(`/api/topups/${encodeURIComponent(topupId)}/paid`, {
        method: 'POST'
      });
    },

    adminTopupAction(topupId, action, customAmount = null) {
      return request('/api/admin/topup-action', {
        method: 'POST',
        body: JSON.stringify({ topupId, action, customAmount })
      });
    },

    adminAdjustUserBalance(identifier, deltaUzs, note = '') {
      return request('/api/admin/user-balance', {
        method: 'POST',
        body: JSON.stringify({ identifier, deltaUzs, note })
      });
    }
  };
})();
