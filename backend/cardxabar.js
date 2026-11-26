/**
 * Nate Stars — CardXabar Cloud Automation Listener
 * Подключается к Telegram-аккаунту через GramJS (MTProto),
 * слушает входящие чеки о пополнении от @CardXabarBot
 * и автоматически подтверждает заказы по точной сумме («копейкам»).
 */

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { computeCheck } = require('telegram/Password');
const QRCode = require('qrcode');
const { dao } = require('./database');

const CARDXABAR_USERNAME = 'CardXabarBot';

/**
 * Парсит уведомление @CardXabarBot.
 * Пример реального чека:
 *   🟢 Perevod na kartu
 *   ➕ 1 000.00 UZS
 *   💳 ***5841
 *   📍 UB VISA TO UZCARD, UZ
 *   🕒 25.11.26 18:23
 *   💵 1 020.47 UZS
 */
function parseCardXabarMessage(rawText, targetCardLast4 = '') {
  if (!rawText || typeof rawText !== 'string') return null;

  const text = rawText.replace(/[\u00A0\u202F]/g, ' ').trim();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  // Жёстко отсекаем расходы / списания
  const lower = text.toLowerCase();
  if (
    text.includes('🔴') ||
    text.includes('➖') ||
    /(?:^|\n)\s*-\s*[\d\s.,]+\s*(?:uzs|сум)/i.test(text) ||
    /(?:spisanie|oplata|pokupka|chiqim|perevod s karty|списание|покупка|оплата|перевод с карты)/i.test(lower)
  ) {
    return null;
  }

  // Ищем строку пополнения, начинающуюся с ➕ или +
  let amount = null;
  for (const line of lines) {
    const m = line.match(/^(?:➕|\+)\s*([\d\s.,]+)\s*(?:UZS|сум|so['‘`]?m)/i);
    if (m) {
      let cleaned = m[1].replace(/\s+/g, '');
      if (/,\d{2}$/.test(cleaned) && !cleaned.includes('.')) {
        cleaned = cleaned.replace(',', '.');
      } else {
        cleaned = cleaned.replace(/,/g, '');
      }
      const parsed = parseFloat(cleaned);
      if (Number.isFinite(parsed) && parsed > 0) {
        amount = parsed;
        break;
      }
    }
  }

  if (amount === null) return null;

  // Извлекаем последние 4 цифры карты со строки 💳 ***5841
  let cardLast4 = '';
  for (const line of lines) {
    const cm = line.match(/💳[^0-9]*[*•xX]*\s*(\d{4})\b/);
    if (cm) {
      cardLast4 = cm[1];
      break;
    }
  }
  if (!cardLast4) {
    const fallbackCard = text.match(/\*{2,}\s*(\d{4})\b/);
    if (fallbackCard) cardLast4 = fallbackCard[1];
  }

  const rawTargets = Array.isArray(targetCardLast4) ? targetCardLast4 : [targetCardLast4];
  const expectedLast4List = rawTargets
    .map(v => String(v || '').replace(/\D/g, '').slice(-4))
    .filter(v => v.length === 4);

  if (expectedLast4List.length > 0) {
    if (cardLast4 && !expectedLast4List.includes(cardLast4)) {
      return null;
    }
    if (!cardLast4 && !expectedLast4List.some(l4 => text.includes(l4))) {
      return null;
    }
  }

  return {
    amount,
    cardLast4: cardLast4 || expectedLast4List[0] || '',
    rawText: text
  };
}

class CardXabarServiceImpl {
  constructor() {
    this.client = null;
    this.onPayment = null;
    this.cardXabarId = null;
    this.userLabel = '';
    this.listening = false;
    this.connected = false;
    this.pollTimer = null;
    this.listenerStartedMs = 0;
    this.lastError = '';

    // Состояние пошаговой авторизации в админке
    this.authState = {
      step: 'idle', // idle | waiting_code | waiting_qr | waiting_password | connected | error
      mode: null,   // phone | qr
      client: null,
      apiId: null,
      apiHash: null,
      phone: '',
      phoneCodeHash: '',
      qrDataUrl: '',
      passwordHint: '',
      passwordResolver: null,
      passwordRejecter: null,
      error: ''
    };
  }

  async init(onPaymentCallback) {
    this.onPayment = onPaymentCallback;

    const settings = dao.getAllSettings();
    const apiId = process.env.TG_API_ID || settings.tg_api_id;
    const apiHash = process.env.TG_API_HASH || settings.tg_api_hash;
    const sessionString = process.env.TG_SESSION || settings.tg_session_string;

    if (!apiId || !apiHash || !sessionString) {
      console.log('ℹ️ [CardXabar] Сессия Telegram не настроена — автоподтверждение ожидает подключения в админке.');
      return;
    }

    await this.connectAndListen(Number(apiId), apiHash, sessionString);
  }

  async connectAndListen(apiId, apiHash, sessionString, existingClient = null) {
    try {
      await this.stopListenerOnly();
      this.lastError = '';

      const client = existingClient || new TelegramClient(
        new StringSession(sessionString),
        Number(apiId),
        String(apiHash),
        { connectionRetries: 5 }
      );
      client.setLogLevel('warn');

      if (!client.connected) {
        await client.connect();
      }

      const authorized = await client.checkAuthorization();
      if (!authorized) {
        this.lastError = 'Сессия Telegram истекла, требуется повторная авторизация.';
        console.warn('⚠️ [CardXabar]', this.lastError);
        return false;
      }

      const me = await client.getMe();
      this.userLabel = me.username ? `@${me.username}` : `${me.firstName || ''} ${me.phone ? '(+' + me.phone + ')' : ''}`.trim();
      this.client = client;
      this.connected = true;
      this.listenerStartedMs = Date.now();

      // Резолвим @CardXabarBot
      try {
        const entity = await client.getEntity(CARDXABAR_USERNAME);
        this.cardXabarId = String(entity.id);
        console.log(`✅ [CardXabar] Бот @${CARDXABAR_USERNAME} найден (ID: ${this.cardXabarId})`);
      } catch (e) {
        console.warn(`⚠️ [CardXabar] Не удалось заранее найти @${CARDXABAR_USERNAME}:`, e.message);
      }

      // Реактивный слушатель входящих сообщений
      client.addEventHandler(async (event) => {
        try {
          const msg = event.message;
          if (!msg || msg.out || !msg.message) return;
          if (!this.isFromCardXabar(msg)) return;
          await this.handleCandidateMessage(msg);
        } catch (err) {
          console.error('❌ [CardXabar] Ошибка обработчика события:', err.message);
        }
      }, new NewMessage({ incoming: true }));

      // Страховочный опрос каждые 45 сек на случай сетевого пропуска
      this.pollTimer = setInterval(() => {
        this.pollRecentCardXabarMessages().catch(err => {
          console.warn('⚠️ [CardXabar Poll]:', err.message);
        });
      }, 45000);

      this.listening = true;
      this.authState.step = 'connected';
      console.log(`🎧 [CardXabar] Слушатель активен на аккаунте ${this.userLabel}`);
      return true;
    } catch (err) {
      this.lastError = err.message;
      this.connected = false;
      this.listening = false;
      console.error('❌ [CardXabar] Ошибка запуска слушателя:', err.message);
      return false;
    }
  }

  isFromCardXabar(msg) {
    const senderIdStr = msg.senderId ? String(msg.senderId) : '';
    const chatIdStr = msg.chatId ? String(msg.chatId) : '';
    if (this.cardXabarId && (senderIdStr === this.cardXabarId || chatIdStr === this.cardXabarId)) {
      return true;
    }
    const sender = msg.sender;
    if (sender && sender.username && sender.username.toLowerCase() === CARDXABAR_USERNAME.toLowerCase()) {
      this.cardXabarId = String(sender.id);
      return true;
    }
    return false;
  }

  async pollRecentCardXabarMessages() {
    if (!this.client || !this.listening) return;
    const autoEnabled = dao.getSetting('auto_confirm_enabled') === 'true';
    if (!autoEnabled) return;

    const target = this.cardXabarId ? Number(this.cardXabarId) : CARDXABAR_USERNAME;
    const messages = await this.client.getMessages(target, { limit: 5 });
    for (const msg of messages) {
      if (!msg || msg.out || !msg.message) continue;
      // Игнорируем сообщения старше 30 минут или пришедшие до старта слушателя
      const msgMs = (msg.date || 0) * 1000;
      if (msgMs < this.listenerStartedMs - 10 * 60 * 1000) continue;
      await this.handleCandidateMessage(msg);
    }
  }

  async handleCandidateMessage(msg) {
    const msgId = Number(msg.id);
    if (!msgId || dao.isCardXabarMsgProcessed(msgId)) return;

    const autoEnabled = dao.getSetting('auto_confirm_enabled') === 'true';
    if (!autoEnabled) return;

    const settings = dao.getAllSettings();
    const cardTargets = typeof dao.getPaynetCardPool === 'function'
      ? dao.getPaynetCardPool(settings)
      : [settings.card_number || ''];
    const parsed = parseCardXabarMessage(msg.message, cardTargets);
    if (!parsed) return;

    const msgDateMs = msg.date ? msg.date * 1000 : Date.now();
    console.log(`💳 [CardXabar] Входящее пополнение: +${parsed.amount} UZS (карта ***${parsed.cardLast4}, msg #${msgId})`);

    let matchedOrderId = '';
    if (typeof this.onPayment === 'function') {
      try {
        const res = await this.onPayment({
          amount: parsed.amount,
          cardLast4: parsed.cardLast4,
          msgId,
          msgDateMs,
          rawText: parsed.rawText
        });
        if (res && res.orderId) {
          matchedOrderId = res.orderId;
        }
      } catch (err) {
        console.error('❌ [CardXabar] Ошибка в callback оплаты:', err.message);
      }
    }

    dao.markCardXabarMsgProcessed(msgId, parsed.amount, parsed.cardLast4, matchedOrderId, parsed.rawText);
  }

  async stopListenerOnly() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.client) {
      try { await this.client.disconnect(); } catch (e) {}
      this.client = null;
    }
    this.connected = false;
    this.listening = false;
  }

  async cleanupAuthClient() {
    if (this.authState.passwordRejecter) {
      try { this.authState.passwordRejecter(new Error('AUTH_CANCELLED')); } catch (e) {}
    }
    if (this.authState.client && this.authState.client !== this.client) {
      try { await this.authState.client.disconnect(); } catch (e) {}
    }
    this.authState = {
      step: this.connected ? 'connected' : 'idle',
      mode: null,
      client: null,
      apiId: null,
      apiHash: null,
      phone: '',
      phoneCodeHash: '',
      qrDataUrl: '',
      passwordHint: '',
      passwordResolver: null,
      passwordRejecter: null,
      error: ''
    };
  }

  async finalizeAuthLogin(client, apiId, apiHash, phone) {
    const sessionString = client.session.save();
    dao.setSetting('tg_api_id', String(apiId).trim());
    dao.setSetting('tg_api_hash', String(apiHash).trim());
    dao.setSetting('tg_session_string', sessionString);
    if (phone) dao.setSetting('tg_phone', phone);
    dao.setSetting('auto_confirm_enabled', 'true');

    this.authState.client = null;
    this.authState.qrDataUrl = '';
    this.authState.passwordResolver = null;
    this.authState.passwordRejecter = null;

    await this.connectAndListen(Number(apiId), apiHash, sessionString, client);
    return {
      success: true,
      userLabel: this.userLabel,
      sessionString
    };
  }

  // ===== Авторизация по номеру телефона и коду =====
  async startPhoneAuth(apiId, apiHash, phone) {
    await this.cleanupAuthClient();

    const cleanApiId = Number(String(apiId).trim());
    const cleanApiHash = String(apiHash).trim();
    const cleanPhone = String(phone).trim();

    if (!cleanApiId || !cleanApiHash || !cleanPhone) {
      throw new Error('Заполните API ID, API Hash и номер телефона');
    }

    const client = new TelegramClient(new StringSession(''), cleanApiId, cleanApiHash, {
      connectionRetries: 5
    });
    client.setLogLevel('warn');
    await client.connect();

    const { phoneCodeHash, isCodeViaApp } = await client.sendCode(
      { apiId: cleanApiId, apiHash: cleanApiHash },
      cleanPhone
    );

    this.authState = {
      step: 'waiting_code',
      mode: 'phone',
      client,
      apiId: cleanApiId,
      apiHash: cleanApiHash,
      phone: cleanPhone,
      phoneCodeHash,
      qrDataUrl: '',
      passwordHint: '',
      passwordResolver: null,
      passwordRejecter: null,
      error: ''
    };

    return {
      success: true,
      step: 'waiting_code',
      isCodeViaApp,
      message: isCodeViaApp
        ? 'Код отправлен в чат «Telegram» (служебные уведомления). Введите его ниже.'
        : 'Код отправлен по SMS. Введите его ниже.'
    };
  }

  async submitPhoneCode(code) {
    const st = this.authState;
    if (!st.client || st.step !== 'waiting_code') {
      throw new Error('Сначала запросите код подтверждения');
    }

    const cleanCode = String(code || '').replace(/\s+/g, '').trim();
    if (!cleanCode) throw new Error('Введите код из Telegram');

    try {
      await st.client.invoke(new Api.auth.SignIn({
        phoneNumber: st.phone,
        phoneCodeHash: st.phoneCodeHash,
        phoneCode: cleanCode
      }));
      return await this.finalizeAuthLogin(st.client, st.apiId, st.apiHash, st.phone);
    } catch (err) {
      if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        const srp = await st.client.invoke(new Api.account.GetPassword());
        st.step = 'waiting_password';
        st.passwordHint = srp.hint || '';
        return {
          success: true,
          needsPassword: true,
          step: 'waiting_password',
          hint: st.passwordHint,
          message: 'Аккаунт защищён облачным паролем (2FA). Введите пароль ниже.'
        };
      }
      throw new Error(err.errorMessage || err.message);
    }
  }

  // ===== Авторизация по QR-коду =====
  async startQrAuth(apiId, apiHash) {
    await this.cleanupAuthClient();

    const cleanApiId = Number(String(apiId).trim());
    const cleanApiHash = String(apiHash).trim();
    if (!cleanApiId || !cleanApiHash) {
      throw new Error('Заполните API ID и API Hash (с сайта my.telegram.org)');
    }

    const client = new TelegramClient(new StringSession(''), cleanApiId, cleanApiHash, {
      connectionRetries: 5
    });
    client.setLogLevel('warn');
    await client.connect();

    this.authState = {
      step: 'waiting_qr',
      mode: 'qr',
      client,
      apiId: cleanApiId,
      apiHash: cleanApiHash,
      phone: '',
      phoneCodeHash: '',
      qrDataUrl: '',
      passwordHint: '',
      passwordResolver: null,
      passwordRejecter: null,
      error: ''
    };

    let firstQrResolve = null;
    const firstQrPromise = new Promise((resolve) => {
      firstQrResolve = resolve;
    });

    // Запускаем QR-процесс в фоне
    client.signInUserWithQrCode(
      { apiId: cleanApiId, apiHash: cleanApiHash },
      {
        qrCode: async ({ token }) => {
          const loginUrl = `tg://login?token=${token.toString('base64url')}`;
          const dataUrl = await QRCode.toDataURL(loginUrl, { width: 240, margin: 1 });
          this.authState.qrDataUrl = dataUrl;
          if (firstQrResolve) {
            firstQrResolve(dataUrl);
            firstQrResolve = null;
          }
        },
        password: async (hint) => {
          this.authState.step = 'waiting_password';
          this.authState.passwordHint = hint || '';
          return await new Promise((resolve, reject) => {
            this.authState.passwordResolver = resolve;
            this.authState.passwordRejecter = reject;
          });
        },
        onError: async (err) => {
          this.authState.error = err.errorMessage || err.message;
          if (String(this.authState.error).includes('AUTH_CANCELLED')) return true;
          return false;
        }
      }
    ).then(async () => {
      await this.finalizeAuthLogin(client, cleanApiId, cleanApiHash, '');
    }).catch((err) => {
      if (this.authState.step !== 'connected') {
        this.authState.step = 'error';
        this.authState.error = err.errorMessage || err.message;
      }
      if (firstQrResolve) {
        firstQrResolve('');
        firstQrResolve = null;
      }
    });

    await Promise.race([
      firstQrPromise,
      new Promise(r => setTimeout(r, 6000))
    ]);

    if (!this.authState.qrDataUrl) {
      throw new Error(this.authState.error || 'Не удалось сгенерировать QR-код');
    }

    return {
      success: true,
      step: 'waiting_qr',
      qrDataUrl: this.authState.qrDataUrl
    };
  }

  async submitPassword(password) {
    const st = this.authState;
    if (!st.client || st.step !== 'waiting_password') {
      throw new Error('Облачный пароль сейчас не требуется');
    }

    const pwd = String(password || '');
    if (!pwd) throw new Error('Введите облачный пароль');

    if (st.mode === 'qr' && st.passwordResolver) {
      st.passwordResolver(pwd);
      st.passwordResolver = null;
      // Даём время QR-потоку завершиться
      await new Promise(r => setTimeout(r, 2000));
      if (st.step === 'connected') {
        return {
          success: true,
          userLabel: this.userLabel,
          sessionString: dao.getSetting('tg_session_string')
        };
      }
      if (st.error) throw new Error(st.error);
      return { success: true, step: st.step };
    }

    // Phone auth flow 2FA
    try {
      const srp = await st.client.invoke(new Api.account.GetPassword());
      const check = await computeCheck(srp, pwd);
      await st.client.invoke(new Api.auth.CheckPassword({ password: check }));
      return await this.finalizeAuthLogin(st.client, st.apiId, st.apiHash, st.phone);
    } catch (err) {
      throw new Error(err.errorMessage || err.message);
    }
  }

  async disconnect() {
    await this.cleanupAuthClient();
    await this.stopListenerOnly();
    dao.setSetting('tg_session_string', '');
    dao.setSetting('auto_confirm_enabled', 'false');
    this.userLabel = '';
    this.cardXabarId = null;
    this.lastError = '';
  }

  getStatus() {
    const settings = dao.getAllSettings();
    const sessionString = process.env.TG_SESSION || settings.tg_session_string || '';
    const recentLogs = dao.getRecentCardXabarLogs(5);
    return {
      connected: this.connected,
      listening: this.listening,
      autoConfirmEnabled: settings.auto_confirm_enabled === 'true',
      hasSession: Boolean(sessionString),
      sessionStringPreview: sessionString ? sessionString.slice(0, 12) + '...' + sessionString.slice(-8) : '',
      userLabel: this.userLabel,
      cardXabarResolved: Boolean(this.cardXabarId),
      apiId: process.env.TG_API_ID || settings.tg_api_id || '',
      hasApiHash: Boolean(process.env.TG_API_HASH || settings.tg_api_hash),
      phone: settings.tg_phone || settings.fragment_phone || '',
      authStep: this.authState.step,
      authMode: this.authState.mode,
      qrDataUrl: this.authState.step === 'waiting_qr' ? this.authState.qrDataUrl : '',
      passwordHint: this.authState.passwordHint || '',
      lastError: this.lastError || this.authState.error || '',
      recentLogs
    };
  }
}

const CardXabarService = new CardXabarServiceImpl();

module.exports = { CardXabarService, parseCardXabarMessage };
