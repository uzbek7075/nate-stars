/**
 * Nate Stars — Direct Fragment Automation Engine
 * Работает через официальный API шлюз Fragment (api.fragment-api.com)
 */

const { dao } = require('./database');
const { mnemonicNew, mnemonicValidate, mnemonicWordList } = require('@ton/crypto');

const FRAGMENT_BASE_URL = 'https://api.fragment-api.com/v1';

const FragmentService = {
  /**
   * Сгенерировать чистую валидную TON seed-фразу на 24 слова
   */
  async generateNewWallet() {
    const words = await mnemonicNew(24);
    return {
      success: true,
      mnemonics: words.join(' '),
      count: words.length
    };
  },

  /**
   * Получить текущие настройки интеграции с Fragment
   */
  getConfig() {
    const settings = dao.getAllSettings();
    const token = settings.fragment_jwt_token || '';
    return {
      enabled: settings.fragment_enabled === 'true',
      phone: settings.fragment_phone || '',
      mnemonics: settings.fragment_mnemonics || '',
      apiKey: settings.fragment_api_key || '',
      hasToken: Boolean(token),
      tokenPreview: token ? token.substring(0, 10) + '...' : '',
      savedAt: settings.fragment_jwt_saved_at || null
    };
  },

  /**
   * Запуск авторизации Fragment через номер телефона и 24 слова
   * @param {Object} params
   * @param {string} params.phone - номер телефона Telegram
   * @param {string} params.mnemonics - ровно 24 слова кошелька TON (V4R2)
   * @param {string} params.apiKey - API ключ с дашборда fragment-api.com
   */
  async authenticate({ phone, mnemonics, apiKey = '' }) {
    if (!phone) {
      return { success: false, error: 'Укажите номер телефона Telegram (+998...)' };
    }
    if (!mnemonics) {
      return { success: false, error: 'Укажите seed-фразу кошелька (24 слова)' };
    }

    const cleanPhone = String(phone).trim().replace(/[^\d+]/g, '');
    const mnemonicsList = String(mnemonics).trim().split(/\s+/).filter(Boolean);
    const cleanApiKey = String(apiKey || '').trim();

    if (!cleanApiKey) {
      return { 
        success: false, 
        error: 'Требуется API Ключ! Получите его бесплатно в личном кабинете на https://fragment-api.com/dashboard' 
      };
    }

    if (mnemonicsList.length !== 24) {
      return { 
        success: false, 
        error: `Fragment API принимает только ровно 24 слова стандарта V4R2 (вы ввели: ${mnemonicsList.length}). Нажмите «Сгенерировать кошелёк» ниже.` 
      };
    }

    // Проверяем слова по словарю TON
    const dict = new Set(mnemonicWordList);
    const badWords = mnemonicsList.filter(w => !dict.has(w.toLowerCase()));
    if (badWords.length > 0) {
      return {
        success: false,
        error: `Слова не найдены в словаре TON: ${badWords.join(', ')}. Проверьте опечатки.`
      };
    }

    // Проверяем контрольную сумму TON
    const isChecksumValid = await mnemonicValidate(mnemonicsList);
    if (!isChecksumValid) {
      return {
        success: false,
        error: `Фраза не проходит проверку TON (контрольная сумма не сошлась). Проверьте правильность слов и отсутствие дубликатов (например, два раза 'record').`
      };
    }

    console.log(`🔑 [Fragment Auth] Запрос авторизации для телефона ${cleanPhone}...`);

    const payload = {
      api_key: cleanApiKey,
      phone_number: cleanPhone,
      mnemonics: mnemonicsList,
      version: 'V4R2'
    };

    try {
      const controller = new AbortController();
      // Даём 70 секунд, чтобы пользователь успел нажать «Авторизоваться» в Telegram
      const timeoutId = setTimeout(() => controller.abort(), 70000);

      const response = await fetch(`${FRAGMENT_BASE_URL}/auth/authenticate/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const data = await response.json().catch(() => ({}));

      if (response.ok && data.token) {
        // Сохраняем полученный JWT токен и настройки в базу
        dao.setSetting('fragment_jwt_token', data.token);
        dao.setSetting('fragment_jwt_saved_at', new Date().toISOString());
        dao.setSetting('fragment_phone', cleanPhone);
        dao.setSetting('fragment_mnemonics', mnemonicsList.join(' '));
        dao.setSetting('fragment_api_key', cleanApiKey);
        dao.setSetting('fragment_enabled', 'true');

        console.log('✅ [Fragment Auth] Успешная авторизация! JWT токен сохранён в базу.');
        return {
          success: true,
          message: 'Авторизация Fragment успешно завершена!',
          token: data.token
        };
      } else {
        let errMsg = '';
        if (data.api_key) {
          errMsg += `API ключ: ${Array.isArray(data.api_key) ? data.api_key.join(', ') : data.api_key}. `;
        }
        if (data.mnemonics) {
          errMsg += `Seed-фраза: ${Array.isArray(data.mnemonics) ? data.mnemonics.join(', ') : data.mnemonics}. `;
        }
        if (data.phone_number) {
          errMsg += `Телефон: ${Array.isArray(data.phone_number) ? data.phone_number.join(', ') : data.phone_number}. `;
        }
        if (data.non_field_errors) {
          errMsg += `${Array.isArray(data.non_field_errors) ? data.non_field_errors.join(', ') : data.non_field_errors}. `;
        }
        if (!errMsg) {
          errMsg = data.error || data.detail || (typeof data === 'string' ? data : JSON.stringify(data));
        }

        console.error('❌ [Fragment Auth] Ошибка авторизации:', errMsg);
        return {
          success: false,
          error: errMsg.trim() || `Ошибка сервера Fragment (${response.status})`
        };
      }

    } catch (err) {
      console.error('❌ [Fragment Auth] Исключение:', err.message);
      if (err.name === 'AbortError') {
        return {
          success: false,
          error: 'Время ожидания истекло (70 сек). Нажмите подтверждение в Telegram быстрее.'
        };
      }
      return {
        success: false,
        error: `Сетевая ошибка: ${err.message}`
      };
    }
  },

  /**
   * Автоматическая отправка заказа на Fragment
   * @param {Object} order - объект заказа из БД
   */
  async dispatchOrder(order) {
    const config = this.getConfig();
    const settings = dao.getAllSettings();
    const token = settings.fragment_jwt_token;

    const cleanUsername = String(order.recipient_username || '').replace(/^@/, '').trim();
    if (!cleanUsername) {
      return { success: false, error: 'Не указан username получателя', manualRequired: true };
    }

    if (!config.enabled) {
      return {
        success: true,
        mode: 'manual',
        message: 'Автовыдача Fragment выключена (ручная выдача)',
        manualRequired: true
      };
    }

    if (!token) {
      return {
        success: false,
        error: 'Fragment не авторизован (нажмите «Авторизовать Fragment» в админке)',
        manualRequired: true
      };
    }

    console.log(`⚡ [Fragment Order] Отправка заказа #${order.id} на @${cleanUsername} (${order.type}: ${order.amount})...`);

    try {
      let endpoint = '';
      let bodyData = {};

      if (order.type === 'stars') {
        endpoint = '/order/stars/';
        bodyData = {
          username: cleanUsername,
          quantity: Number(order.amount),
          show_sender: "false"
        };
      } else {
        endpoint = '/order/premium/';
        bodyData = {
          username: cleanUsername,
          months: Number(order.amount),
          show_sender: "false"
        };
      }

      const response = await fetch(`${FRAGMENT_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
          'Authorization': `JWT ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(bodyData)
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok && (data.success || data.status === 200 || !data.error)) {
        console.log(`✅ [Fragment Order] Заказ #${order.id} успешно доставлен на @${cleanUsername}!`);
        return {
          success: true,
          mode: 'fragment_api',
          txHash: data.tx_hash || data.transaction_id || `frag_${Date.now()}`,
          message: `Успешно отправлено: ${order.type === 'stars' ? order.amount + ' Stars' : order.amount + ' мес. Premium'} на @${cleanUsername}`,
          deliveredAt: new Date().toISOString()
        };
      } else {
        const errorText = data.error || data.detail || data.message || JSON.stringify(data);
        console.error(`❌ [Fragment Order] Ошибка отправки заказа #${order.id}:`, errorText);

        // Если токен протух (401), пробуем авто-переавторизацию
        if (response.status === 401 && config.phone && config.mnemonics) {
          console.log('🔄 [Fragment] JWT токен истёк, пробуем обновить...');
          const reauth = await this.authenticate({
            phone: config.phone,
            mnemonics: config.mnemonics,
            apiKey: config.apiKey
          });
          if (reauth.success) {
            // Повторяем отправку с новым токеном
            return await this.dispatchOrder(order);
          }
        }

        return {
          success: false,
          error: errorText,
          manualRequired: true
        };
      }

    } catch (err) {
      console.error(`❌ [Fragment Order] Сетевая ошибка:`, err.message);
      return {
        success: false,
        error: `Сетевая ошибка Fragment: ${err.message}`,
        manualRequired: true
      };
    }
  }
};

module.exports = { FragmentService };
