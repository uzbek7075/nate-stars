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
        throw new Error(data.error || `HTTP ${response.status}`);
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

    // Создать заказ на перевод
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
    }
  };
})();
