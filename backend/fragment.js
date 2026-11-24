/**
 * Nate Stars — Direct Fragment Automation Engine
 * Автоматизированный шлюз покупки Telegram Stars и Telegram Premium
 * Использует прямой REST API шлюз Fragment (api.fragment-api.space)
 * Без истекающих веб-токенов, без необходимости постоянных подтверждений
 */

const fs = require('fs');
const path = require('path');
const { dao } = require('./database');
const { mnemonicNew } = require('@ton/crypto');

const FRAGMENT_API_URL = 'https://api.fragment-api.space/api/v1';
const DEFAULT_WALLET_ADDRESS = 'UQCG_TZEtQ8_wPOqZgQEQ8mH0yUv8xJbVibY_eHTIhOt5G1e';

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
    const mnemonics = settings.fragment_mnemonics || '';
    return {
      enabled: settings.fragment_enabled === 'true',
      phone: settings.fragment_phone || '+998930690203',
      mnemonics: mnemonics,
      walletAddress: DEFAULT_WALLET_ADDRESS,
      hasSeed: Boolean(mnemonics && mnemonics.trim().split(/\s+/).length >= 12),
      provider: 'direct_ton'
    };
  },

  /**
   * Проверить актуальный баланс TON кошелька
   */
  async getWalletBalance() {
    try {
      const res = await fetch(`https://toncenter.com/api/v2/getAddressInformation?address=${DEFAULT_WALLET_ADDRESS}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const data = await res.json();
      if (data && data.ok && data.result) {
        const rawBalance = Number(data.result.balance || 0);
        const tonBalance = rawBalance / 1e9;
        return {
          success: true,
          balance: tonBalance,
          balanceFormatted: tonBalance.toFixed(3) + ' TON',
          address: DEFAULT_WALLET_ADDRESS
        };
      }
      return { success: false, balance: 0, error: 'Ошибка получения баланса' };
    } catch (e) {
      return { success: false, balance: 0, error: e.message };
    }
  },

  /**
   * Автоматическая отправка заказа на Fragment
   * @param {Object} order - объект заказа из БД
   */
  async dispatchOrder(order) {
    const config = this.getConfig();

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

    if (!config.mnemonics) {
      return {
        success: false,
        error: 'Не настроена seed-фраза TON-кошелька для Fragment',
        manualRequired: true
      };
    }

    const seedBase64 = Buffer.from(config.mnemonics.trim()).toString('base64');
    const targetUsername = '@' + cleanUsername;

    console.log(`⚡ [Fragment Order] Отправка заказа #${order.id} на ${targetUsername} (${order.type}: ${order.amount})...`);

    try {
      let endpoint = '';
      let bodyData = {};

      if (order.type === 'stars') {
        endpoint = '/stars/buy';
        bodyData = {
          username: targetUsername,
          amount: Number(order.amount),
          seed: seedBase64,
          payment_method: 'ton'
        };
      } else {
        endpoint = '/premium/buy';
        bodyData = {
          username: targetUsername,
          duration: Number(order.amount),
          seed: seedBase64,
          payment_method: 'ton'
        };
      }

      const response = await fetch(`${FRAGMENT_API_URL}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        body: JSON.stringify(bodyData)
      });

      const data = await response.json().catch(() => ({}));

      // 1. Успешная покупка
      if (response.ok && data.success) {
        let orderData = data.data || {};
        let txHash = orderData.tx_hash || orderData.request_id || `frag_${Date.now()}`;

        // Если заказ в очереди/обработке, пробуем подождать пару секунд до завершения
        if (orderData.status === 'queued' || orderData.status === 'processing') {
          if (orderData.request_id) {
            console.log(`⏳ [Fragment Queue] Заказ в очереди #${orderData.request_id}, ожидаем выполнения...`);
            for (let i = 0; i < 4; i++) {
              await new Promise(r => setTimeout(r, 2000));
              try {
                const qRes = await fetch(`${FRAGMENT_API_URL}/queue/${orderData.request_id}`, {
                  headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                const qData = await qRes.json();
                if (qData && qData.success && qData.data) {
                  if (qData.data.status === 'completed') {
                    orderData = qData.data;
                    txHash = orderData.tx_hash || txHash;
                    break;
                  }
                  if (qData.data.status === 'failed') {
                    throw new Error(qData.data.error || 'Ошибка в очереди Fragment');
                  }
                }
              } catch (qErr) {
                console.warn('Queue check error:', qErr.message);
              }
            }
          }
        }

        console.log(`✅ [Fragment Order] Заказ #${order.id} успешно доставлен на ${targetUsername}!`);
        return {
          success: true,
          mode: 'fragment_api',
          txHash: txHash,
          message: `Успешно отправлено: ${order.type === 'stars' ? order.amount + ' Stars' : order.amount + ' мес. Premium'} на ${targetUsername}`,
          deliveredAt: new Date().toISOString()
        };
      }

      // 2. Ошибка недостаточного баланса
      if (response.status === 402 || (data.error && data.error.error_code === 'INSUFFICIENT_WALLET_BALANCE')) {
        const errorMsg = data.error?.message || 'На кошельке недостаточно TON для автовыдачи (нужно минимум 1 TON).';
        console.warn(`⚠️ [Fragment Balance] ${errorMsg}`);
        return {
          success: false,
          error: `${errorMsg} Заказ сохранён, требуется ручная выдача или пополнение кошелька.`,
          manualRequired: true
        };
      }

      // 3. Прочие ошибки
      let errMsg = '';
      if (data.error) {
        errMsg = data.error.message || data.error.error_code || JSON.stringify(data.error);
        if (data.error.details && Array.isArray(data.error.details)) {
          errMsg += ' (' + data.error.details.map(d => `${d.field}: ${d.message}`).join(', ') + ')';
        }
      } else {
        errMsg = `Ошибка сервера Fragment (${response.status})`;
      }

      console.error(`❌ [Fragment Order] Ошибка отправки заказа #${order.id}:`, errMsg);
      return {
        success: false,
        error: errMsg,
        manualRequired: true
      };

    } catch (err) {
      console.error(`❌ [Fragment Order] Исключение:`, err.message);
      return {
        success: false,
        error: `Сетевая ошибка Fragment: ${err.message}`,
        manualRequired: true
      };
    }
  }
};

module.exports = { FragmentService };
