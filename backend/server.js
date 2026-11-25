require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Telegraf } = require('telegraf');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { initDatabase, dao } = require('./database');
const { authMiddleware } = require('./auth');
const { FragmentService } = require('./fragment');
const { CardXabarService } = require('./cardxabar');

// ===== Конфигурация =====
const BOT_TOKEN = process.env.BOT_TOKEN;
let WEBAPP_URL = process.env.RENDER_EXTERNAL_URL || process.env.WEBAPP_URL || '';
const PORT = process.env.PORT || 3001;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не задан!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const auth = authMiddleware(BOT_TOKEN);
const adminStates = new Map();

// Экранирование HTML для безопасной отправки в Telegram
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getAdminIds() {
  const str = dao.getSetting('admin_ids') || '5379376281';
  return str.split(',').map(s => s.trim()).filter(Boolean).map(Number);
}

function isAdmin(telegramId) {
  const admins = getAdminIds();
  return admins.includes(Number(telegramId)) || Number(telegramId) === 5379376281;
}

function addAdmin(telegramId) {
  const admins = getAdminIds();
  if (!admins.includes(Number(telegramId))) {
    admins.push(Number(telegramId));
    dao.setSetting('admin_ids', admins.join(','));
  }
}

function formatUzs(num) {
  return Number(num).toLocaleString('ru-RU') + ' сум';
}

// Middleware для защиты админ-роутов API
function requireAdmin(req, res, next) {
  if (!req.telegramUser || !isAdmin(req.telegramUser.id)) {
    return res.status(403).json({ error: 'Доступ разрешён только администратору' });
  }
  next();
}

// ===== Вспомогательные функции заказов и автовыдачи =====

function calculateBasePrice(type, amount, settings) {
  if (type === 'stars') {
    const starsCount = Number(amount);
    const minStars = Number(settings.min_stars || 50);
    if (isNaN(starsCount) || starsCount < minStars) {
      throw new Error(`Минимум ${minStars} звёзд`);
    }
    const starPrice = Number(settings.star_price_uzs || 220);
    return {
      basePriceUzs: starsCount * starPrice,
      itemDescription: `${starsCount} Telegram Stars`
    };
  }
  if (type === 'premium') {
    const months = Number(amount);
    let price = 0;
    if (months === 3) price = Number(settings.premium_3_uzs || 175000);
    else if (months === 6) price = Number(settings.premium_6_uzs || 245000);
    else if (months === 12) price = Number(settings.premium_12_uzs || 395000);
    else throw new Error('Некорректный срок Premium');
    return {
      basePriceUzs: price,
      itemDescription: `Telegram Premium на ${months} мес.`
    };
  }
  throw new Error('Неизвестный тип товара');
}

async function sendToAdminAndGroup(htmlMessage, extraOptions = {}) {
  const ordersChatId = dao.getSetting('orders_chat_id');
  if (ordersChatId) {
    try {
      await bot.telegram.sendMessage(ordersChatId, htmlMessage, {
        parse_mode: 'HTML',
        ...extraOptions
      });
    } catch (err) {
      console.warn('Ошибка отправки в группу заказов:', err.message);
    }
  }

  const admins = getAdminIds();
  for (const adminId of admins) {
    if (String(adminId) === String(ordersChatId)) continue;
    try {
      await bot.telegram.sendMessage(adminId, htmlMessage, {
        parse_mode: 'HTML',
        ...extraOptions
      });
    } catch (err) {
      console.warn(`Не удалось отправить админу ${adminId}:`, err.message);
    }
  }
}

async function notifyAdminsOfPendingOrder(order) {
  const itemDesc = order.type === 'stars'
    ? `${order.amount} Telegram Stars`
    : `Telegram Premium на ${order.amount} мес.`;

  const adminMessage =
    `<b>НОВЫЙ ЗАКАЗ #${escapeHtml(order.id)}</b>\n\n` +
    `• <b>Покупатель:</b> ${escapeHtml(order.buyer_username)} (ID: <code>${order.telegram_id}</code>)\n` +
    `• <b>Получатель:</b> ${escapeHtml(order.recipient_username)}\n` +
    `• <b>Товар:</b> ${escapeHtml(itemDesc)}\n` +
    `• <b>Сумма:</b> <code>${formatUzs(order.price_uzs)}</code>\n` +
    `• <b>Карта оплаты:</b> <code>${escapeHtml(order.card_number)}</code>\n` +
    (order.sender_comment ? `• <b>Чек / отправитель:</b> ${escapeHtml(order.sender_comment)}\n` : '') +
    `\n<i>Статус: ожидает проверки платежа</i>`;

  await sendToAdminAndGroup(adminMessage, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Подтвердить', callback_data: `pre_confirm_${order.id}` },
          { text: '❌ Отклонить', callback_data: `pre_reject_${order.id}` }
        ]
      ]
    }
  });
}

/**
 * Единая точка выполнения заказа (подтверждение + отправка через Fragment + уведомления).
 * Используется вручную из админки/группы и автоматически при срабатывании CardXabar.
 */
async function fulfillOrder(orderId, { confirmedBy = 'Admin', source = 'manual', cardXabarInfo = null, skipGroupNotice = false } = {}) {
  const order = dao.getOrder(orderId);
  if (!order) return { ok: false, reason: 'not_found' };
  if (order.status === 'confirmed') return { ok: false, reason: 'already_confirmed', order };

  dao.updateOrderStatus(orderId, 'confirmed', source);

  const fragmentRes = await FragmentService.dispatchOrder(order);
  console.log(`⚡ [Order Fulfill #${orderId} via ${source}]`, fragmentRes);

  const itemDesc = order.type === 'stars'
    ? `${order.amount} Telegram Stars`
    : `Telegram Premium на ${order.amount} мес.`;

  const clientMsg = fragmentRes.success
    ? `<b>Заказ #${escapeHtml(order.id)} выполнен</b>\n\n` +
      `Товар: <b>${escapeHtml(itemDesc)}</b>\n` +
      `Получатель: <b>${escapeHtml(order.recipient_username)}</b>\n` +
      `Сумма: <b>${formatUzs(order.price_uzs)}</b>\n\n` +
      `Товар успешно доставлен на указанный аккаунт. Спасибо за покупку в Nate Stars.`
    : `<b>Оплата по заказу #${escapeHtml(order.id)} подтверждена</b>\n\n` +
      `Товар: <b>${escapeHtml(itemDesc)}</b>\n` +
      `Получатель: <b>${escapeHtml(order.recipient_username)}</b>\n` +
      `Сумма: <b>${formatUzs(order.price_uzs)}</b>\n\n` +
      `Заказ передан на выдачу и скоро поступит на указанный аккаунт.`;

  try {
    await bot.telegram.sendMessage(order.telegram_id, clientMsg, { parse_mode: 'HTML' });
  } catch (e) {
    console.warn('Не удалось уведомить клиента:', e.message);
  }

  if (!skipGroupNotice) {
    let fragmentNote = '';
    if (fragmentRes.success) {
      fragmentNote = `⚡ <b>Fragment:</b> ${escapeHtml(fragmentRes.message)}`;
      if (fragmentRes.txHash) fragmentNote += `\n🔗 <code>${escapeHtml(fragmentRes.txHash)}</code>`;
    } else {
      fragmentNote = `⚠️ <b>Fragment:</b> ${escapeHtml(fragmentRes.error)}`;
    }

    const header = source === 'cardxabar'
      ? `⚡ <b>АВТООПЛАТА CARDXABAR (#${escapeHtml(order.id)})</b>`
      : `✅ <b>ЗАКАЗ #${escapeHtml(order.id)} ПОДТВЕРЖДЁН</b> (${escapeHtml(confirmedBy)})`;

    const cardLine = cardXabarInfo
      ? `💳 Зачислено: <code>+${formatUzs(cardXabarInfo.amount)}</code> (карта ***${escapeHtml(cardXabarInfo.cardLast4)})\n`
      : '';

    const groupMsg =
      `${header}\n\n` +
      cardLine +
      `• <b>Покупатель:</b> ${escapeHtml(order.buyer_username)}\n` +
      `• <b>Получатель:</b> ${escapeHtml(order.recipient_username)}\n` +
      `• <b>Товар:</b> ${escapeHtml(itemDesc)}\n` +
      `• <b>Сумма:</b> <code>${formatUzs(order.price_uzs)}</code>\n\n` +
      fragmentNote;

    await sendToAdminAndGroup(groupMsg);
  }

  return { ok: true, order, fragment: fragmentRes };
}

async function handleCardXabarPayment({ amount, cardLast4, msgId, msgDateMs }) {
  const order = dao.findOrderForCardXabarPayment(amount, msgDateMs);
  if (!order) {
    console.log(`ℹ️ [CardXabar] Пополнение +${amount} UZS (***${cardLast4}) — подходящих активных заказов нет.`);
    return { matched: false };
  }

  console.log(`🎯 [CardXabar] Совпадение! +${amount} UZS -> Заказ #${order.id} (${order.recipient_username})`);
  const res = await fulfillOrder(order.id, {
    confirmedBy: 'CardXabar Auto',
    source: 'cardxabar',
    cardXabarInfo: { amount, cardLast4, msgId }
  });
  return { matched: true, orderId: order.id, res };
}

async function notifyAdminSessionBackup(sessionString, apiId, apiHash) {
  if (!sessionString) return;
  const admins = getAdminIds();
  const msg =
    `🔐 <b>CardXabar подключён к Nate Stars!</b>\n\n` +
    `Автоподтверждение платежей по карте запущено и уже работает.\n\n` +
    `<b>Важно для Render:</b> Чтобы сессия не сбрасывалась при обновлениях сервера, сохраните эти 3 переменные в <i>Render → Environment</i>:\n` +
    `• <code>TG_API_ID</code> = <code>${escapeHtml(apiId)}</code>\n` +
    `• <code>TG_API_HASH</code> = <code>${escapeHtml(apiHash)}</code>\n` +
    `• <code>TG_SESSION</code> = <code>${escapeHtml(sessionString)}</code>`;
  for (const adminId of admins) {
    try {
      await bot.telegram.sendMessage(adminId, msg, { parse_mode: 'HTML' });
    } catch (e) {}
  }
}

// ===== API Маршруты =====

// Каталог и текущие настройки цен
app.get('/api/catalog', (req, res) => {
  const settings = dao.getAllSettings();
  res.json({
    starPriceUzs: Number(settings.star_price_uzs || 220),
    minStars: Number(settings.min_stars || 50),
    cardNumber: settings.card_number || '5614681816265841',
    cardHolder: settings.card_holder || 'Uzcard / Humo',
    premium3Uzs: Number(settings.premium_3_uzs || 175000),
    premium6Uzs: Number(settings.premium_6_uzs || 245000),
    premium12Uzs: Number(settings.premium_12_uzs || 395000),
    autoConfirmEnabled: settings.auto_confirm_enabled === 'true'
  });
});

// Профиль пользователя и флаг isAdmin
app.get('/api/user', auth, (req, res) => {
  const tgUser = req.telegramUser;
  dao.upsertUser({
    telegramId: tgUser.id,
    username: tgUser.username,
    firstName: tgUser.first_name,
    lastName: tgUser.last_name
  });
  const user = dao.getUser(tgUser.id);
  res.json({
    user,
    isAdmin: isAdmin(tgUser.id)
  });
});

// Админ-панель: сводка данных, настройки и ожидающие заказы
app.get('/api/admin/info', auth, requireAdmin, (req, res) => {
  const settings = dao.getAllSettings();
  const stats = dao.getStats();
  const pendingOrders = dao.getPendingOrders();
  const fragmentConfig = FragmentService.getConfig();
  const cardXabarStatus = CardXabarService.getStatus();
  res.json({
    settings,
    stats,
    pendingOrders,
    fragmentConfig,
    cardXabarStatus
  });
});

// Админ-панель: сохранение настроек из Mini App (включая Fragment и автоподтверждение)
app.post('/api/admin/update-settings', auth, requireAdmin, (req, res) => {
  const {
    starPriceUzs,
    minStars,
    cardNumber,
    cardHolder,
    premium3Uzs,
    premium6Uzs,
    premium12Uzs,
    ordersChatId,
    fragmentEnabled,
    fragmentPhone,
    fragmentMnemonics,
    fragmentApiKey,
    autoConfirmEnabled
  } = req.body;

  if (starPriceUzs) dao.setSetting('star_price_uzs', String(starPriceUzs));
  if (minStars) dao.setSetting('min_stars', String(minStars));
  if (cardNumber) dao.setSetting('card_number', String(cardNumber).replace(/\s+/g, ''));
  if (cardHolder) dao.setSetting('card_holder', String(cardHolder));
  if (premium3Uzs) dao.setSetting('premium_3_uzs', String(premium3Uzs));
  if (premium6Uzs) dao.setSetting('premium_6_uzs', String(premium6Uzs));
  if (premium12Uzs) dao.setSetting('premium_12_uzs', String(premium12Uzs));
  if (ordersChatId !== undefined) dao.setSetting('orders_chat_id', String(ordersChatId));
  if (autoConfirmEnabled !== undefined) dao.setSetting('auto_confirm_enabled', String(autoConfirmEnabled));

  // Настройки Fragment
  if (fragmentEnabled !== undefined) dao.setSetting('fragment_enabled', String(fragmentEnabled));
  if (fragmentPhone !== undefined) dao.setSetting('fragment_phone', String(fragmentPhone));
  if (fragmentMnemonics !== undefined) dao.setSetting('fragment_mnemonics', String(fragmentMnemonics));
  if (fragmentApiKey !== undefined) {
    const cleanKey = String(fragmentApiKey).trim();
    dao.setSetting('fragment_api_key', cleanKey);
    if (cleanKey.startsWith('eyJ')) {
      dao.setSetting('fragment_jwt_token', cleanKey);
      dao.setSetting('fragment_jwt_saved_at', new Date().toISOString());
      dao.setSetting('fragment_enabled', 'true');
      console.log('✅ [Admin API] JWT-токен Fragment сохранён и активирован напрямую!');
    }
  }

  res.json({
    success: true,
    settings: dao.getAllSettings(),
    fragmentConfig: FragmentService.getConfig(),
    cardXabarStatus: CardXabarService.getStatus()
  });
});

// ===== API авторизации слушателя CardXabar (Admin) =====
app.get('/api/admin/cardxabar/status', auth, requireAdmin, (req, res) => {
  res.json(CardXabarService.getStatus());
});

app.get('/api/admin/cardxabar/export', auth, requireAdmin, (req, res) => {
  const settings = dao.getAllSettings();
  const apiId = process.env.TG_API_ID || settings.tg_api_id || '';
  const apiHash = process.env.TG_API_HASH || settings.tg_api_hash || '';
  const sessionString = process.env.TG_SESSION || settings.tg_session_string || '';
  res.json({ apiId, apiHash, sessionString });
});

app.post('/api/admin/cardxabar/auth-phone', auth, requireAdmin, async (req, res) => {
  try {
    const { apiId, apiHash, phone } = req.body;
    const result = await CardXabarService.startPhoneAuth(apiId, apiHash, phone);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/cardxabar/auth-code', auth, requireAdmin, async (req, res) => {
  try {
    const { code } = req.body;
    const result = await CardXabarService.submitPhoneCode(code);
    if (result.sessionString) {
      notifyAdminSessionBackup(result.sessionString, dao.getSetting('tg_api_id'), dao.getSetting('tg_api_hash'));
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/cardxabar/auth-qr', auth, requireAdmin, async (req, res) => {
  try {
    const { apiId, apiHash } = req.body;
    const result = await CardXabarService.startQrAuth(apiId, apiHash);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/cardxabar/auth-password', auth, requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    const result = await CardXabarService.submitPassword(password);
    if (result.sessionString) {
      notifyAdminSessionBackup(result.sessionString, dao.getSetting('tg_api_id'), dao.getSetting('tg_api_hash'));
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/cardxabar/disconnect', auth, requireAdmin, async (req, res) => {
  try {
    await CardXabarService.disconnect();
    res.json({ success: true, status: CardXabarService.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Админ-панель: генерация нового чистого TON-кошелька (24 слова)
app.post('/api/admin/generate-wallet', auth, requireAdmin, async (req, res) => {
  try {
    const wallet = await FragmentService.generateNewWallet();
    res.json(wallet);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Админ-панель: запуск авторизации Fragment
app.post('/api/admin/fragment-auth', auth, requireAdmin, async (req, res) => {
  try {
    const { phone, mnemonics, apiKey } = req.body;
    const result = await FragmentService.authenticate({ phone, mnemonics, apiKey });
    if (result.success) {
      res.json({ success: true, message: result.message, config: FragmentService.getConfig() });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Админ-панель: подтверждение / отклонение заказа из Mini App
app.post('/api/admin/order-action', auth, requireAdmin, async (req, res) => {
  const { orderId, action } = req.body;
  const order = dao.getOrder(orderId);

  if (!order) {
    return res.status(404).json({ error: 'Заказ не найден' });
  }

  if (action === 'confirm') {
    const fulfilled = await fulfillOrder(orderId, {
      confirmedBy: req.telegramUser?.username ? '@' + req.telegramUser.username : 'Admin',
      source: 'manual',
      skipGroupNotice: false
    });
    if (!fulfilled.ok && fulfilled.reason === 'already_confirmed') {
      return res.json({ success: true, status: 'confirmed', alreadyConfirmed: true });
    }
    return res.json({
      success: true,
      status: 'confirmed',
      fragment: fulfilled.fragment
    });
  } else if (action === 'reject') {
    dao.updateOrderStatus(orderId, 'rejected');

    const clientMsg =
      `<b>Заказ #${escapeHtml(order.id)} отклонён</b>\n\n` +
      `Оплата не была обнаружена или произошла ошибка.\n` +
      `Если вы совершили перевод, свяжитесь с поддержкой.`;

    try {
      await bot.telegram.sendMessage(order.telegram_id, clientMsg, { parse_mode: 'HTML' });
    } catch (e) {
      console.warn('Не удалось уведомить клиента:', e.message);
    }

    return res.json({ success: true, status: 'rejected' });
  }

  res.status(400).json({ error: 'Неизвестное действие' });
});

// Шаг 1 оформления заказа: резервирование точной суммы («копеек») до перевода
app.post('/api/orders/prepare', auth, (req, res) => {
  try {
    const { recipientUsername, type, amount } = req.body;
    const tgUser = req.telegramUser;

    if (!recipientUsername) {
      return res.status(400).json({ error: 'Укажите @username получателя' });
    }

    const cleanUsername = recipientUsername.replace(/^@/, '').trim();
    if (!cleanUsername) {
      return res.status(400).json({ error: 'Некорректный username' });
    }

    const settings = dao.getAllSettings();
    let calc;
    try {
      calc = calculateBasePrice(type, amount, settings);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const { basePriceUzs, itemDescription } = calc;
    const autoConfirm = settings.auto_confirm_enabled === 'true';
    const cardNumber = settings.card_number || '5614681816265841';
    const fullRecipient = '@' + cleanUsername;

    const existing = dao.findReusableAwaitingOrder({
      telegramId: tgUser.id,
      type,
      amount: Number(amount),
      recipientUsername: fullRecipient,
      basePriceUzs
    });

    if (existing) {
      return res.json({
        success: true,
        autoConfirm,
        order: {
          id: existing.id,
          priceUzs: existing.price_uzs,
          basePriceUzs: existing.base_price_uzs || existing.price_uzs,
          deltaUzs: existing.price_uzs - (existing.base_price_uzs || existing.price_uzs),
          itemDescription,
          cardNumber: existing.card_number,
          recipientUsername: existing.recipient_username,
          status: existing.status
        }
      });
    }

    const finalPriceUzs = autoConfirm ? dao.allocateUniquePrice(basePriceUzs) : basePriceUzs;
    const orderId = 'NS-' + Math.floor(100000 + Math.random() * 900000);

    dao.createOrder({
      id: orderId,
      telegramId: tgUser.id,
      buyerUsername: tgUser.username ? '@' + tgUser.username : tgUser.first_name,
      recipientUsername: fullRecipient,
      type,
      amount: Number(amount),
      priceUzs: finalPriceUzs,
      basePriceUzs,
      cardNumber,
      status: 'awaiting_payment',
      senderComment: ''
    });

    res.json({
      success: true,
      autoConfirm,
      order: {
        id: orderId,
        priceUzs: finalPriceUzs,
        basePriceUzs,
        deltaUzs: finalPriceUzs - basePriceUzs,
        itemDescription,
        cardNumber,
        recipientUsername: fullRecipient,
        status: 'awaiting_payment'
      }
    });
  } catch (err) {
    console.error('Ошибка подготовки заказа:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Шаг 2: клиент нажал «Я оплатил» — перевод в pending и уведомление админа (если ещё не автоподтверждён)
app.post('/api/orders/:id/paid', auth, async (req, res) => {
  try {
    const orderId = req.params.id;
    const { senderComment } = req.body || {};
    const order = dao.getOrder(orderId);

    if (!order) {
      return res.status(404).json({ error: 'Заказ не найден' });
    }
    if (Number(order.telegram_id) !== Number(req.telegramUser.id) && !isAdmin(req.telegramUser.id)) {
      return res.status(403).json({ error: 'Доступ запрещён' });
    }

    if (order.status === 'confirmed') {
      return res.json({ success: true, alreadyConfirmed: true, order });
    }

    const wasAwaiting = order.status === 'awaiting_payment';
    dao.markOrderPaidByUser(orderId, String(senderComment || '').trim());
    const updatedOrder = dao.getOrder(orderId);

    if (wasAwaiting) {
      await notifyAdminsOfPendingOrder(updatedOrder);
    }

    res.json({ success: true, order: updatedOrder });
  } catch (err) {
    console.error('Ошибка отметки оплаты:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Проверка статуса заказа в реальном времени (для модалки автооплаты)
app.get('/api/orders/:id/status', auth, (req, res) => {
  const order = dao.getOrder(req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Заказ не найден' });
  }
  if (Number(order.telegram_id) !== Number(req.telegramUser.id) && !isAdmin(req.telegramUser.id)) {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  res.json({
    id: order.id,
    status: order.status,
    priceUzs: order.price_uzs,
    paymentSource: order.payment_source || 'manual'
  });
});

// Совместимый эндпоинт прямого создания заказа (если вызван без prepare)
app.post('/api/create-order', auth, async (req, res) => {
  try {
    const { recipientUsername, type, amount, senderComment, orderId: preparedId } = req.body;
    const tgUser = req.telegramUser;

    if (preparedId) {
      const existing = dao.getOrder(preparedId);
      if (existing && Number(existing.telegram_id) === Number(tgUser.id)) {
        if (existing.status === 'confirmed') {
          return res.json({ success: true, alreadyConfirmed: true, order: existing });
        }
        const wasAwaiting = existing.status === 'awaiting_payment';
        dao.markOrderPaidByUser(preparedId, String(senderComment || '').trim());
        const updated = dao.getOrder(preparedId);
        if (wasAwaiting) await notifyAdminsOfPendingOrder(updated);
        const itemDescription = existing.type === 'stars'
          ? `${existing.amount} Telegram Stars`
          : `Telegram Premium на ${existing.amount} мес.`;
        return res.json({
          success: true,
          order: {
            id: updated.id,
            priceUzs: updated.price_uzs,
            itemDescription,
            cardNumber: updated.card_number,
            recipientUsername: updated.recipient_username,
            status: updated.status
          }
        });
      }
    }

    if (!recipientUsername) {
      return res.status(400).json({ error: 'Укажите @username получателя' });
    }

    const cleanUsername = recipientUsername.replace(/^@/, '').trim();
    if (!cleanUsername) {
      return res.status(400).json({ error: 'Некорректный username' });
    }

    const settings = dao.getAllSettings();
    let calc;
    try {
      calc = calculateBasePrice(type, amount, settings);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const { basePriceUzs, itemDescription } = calc;
    const autoConfirm = settings.auto_confirm_enabled === 'true';
    const priceUzs = autoConfirm ? dao.allocateUniquePrice(basePriceUzs) : basePriceUzs;
    const orderId = 'NS-' + Math.floor(100000 + Math.random() * 900000);
    const cardNumber = settings.card_number || '5614681816265841';

    dao.createOrder({
      id: orderId,
      telegramId: tgUser.id,
      buyerUsername: tgUser.username ? '@' + tgUser.username : tgUser.first_name,
      recipientUsername: '@' + cleanUsername,
      type,
      amount: Number(amount),
      priceUzs,
      basePriceUzs,
      cardNumber,
      status: 'pending',
      senderComment
    });

    await notifyAdminsOfPendingOrder(dao.getOrder(orderId));

    res.json({
      success: true,
      order: {
        id: orderId,
        priceUzs,
        itemDescription,
        cardNumber,
        recipientUsername: '@' + cleanUsername,
        status: 'pending'
      }
    });

  } catch (err) {
    console.error('Ошибка создания заказа:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// История заказов пользователя
app.get('/api/orders', auth, (req, res) => {
  const orders = dao.getUserOrders(req.telegramUser.id);
  res.json({ orders });
});

// ===== БОТ: Команды и Кнопки =====

// Команда /start
bot.start((ctx) => {
  const urlToUse = WEBAPP_URL || `http://localhost:${PORT}`;
  
  ctx.reply(
    '<b>Nate Stars</b>\n\n' +
    'Сервис покупки Telegram Stars и Premium подписок в Узбекистане.\n\n' +
    '• Оплата в сумах (UZS) через Uzcard и Humo\n' +
    '• Быстрая доставка подарком по @username\n' +
    '• Без передачи паролей и конфиденциальных данных\n\n' +
    'Нажмите кнопку ниже для открытия каталога:',
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Открыть Nate Stars', web_app: { url: urlToUse } }]
        ]
      }
    }
  );
});

// Команда /setgroup — Привязка группы для получения заказов
bot.command('setgroup', async (ctx) => {
  const userId = ctx.from.id;
  const chatType = ctx.chat.type;

  if (!isAdmin(userId)) {
    return ctx.reply('Команда доступна только администратору.');
  }

  if (chatType !== 'group' && chatType !== 'supergroup') {
    return ctx.reply('Эту команду нужно отправить внутри группы, в которую добавлен бот.');
  }

  const groupId = ctx.chat.id;
  dao.setSetting('orders_chat_id', String(groupId));

  ctx.reply(
    `<b>Группа успешно привязана к Nate Stars!</b>\n\n` +
    `ID группы: <code>${groupId}</code>\n` +
    `Все новые заказы будут автоматически прилетать в этот чат с кнопками подтверждения.`,
    { parse_mode: 'HTML' }
  );
});

// Команда /admin — Управление ценами в боте
bot.command('admin', async (ctx) => {
  const userId = ctx.from.id;

  if (!isAdmin(userId)) {
    return ctx.reply('Доступ ограничен.');
  }

  addAdmin(userId);

  const settings = dao.getAllSettings();
  const starPrice = settings.star_price_uzs || '220';
  const prem3 = settings.premium_3_uzs || '175000';
  const prem6 = settings.premium_6_uzs || '245000';
  const prem12 = settings.premium_12_uzs || '395000';
  const card = settings.card_number || '5614681816265841';
  const group = settings.orders_chat_id || 'Не привязана (напишите /setgroup в группе)';

  const text = 
    `<b>Панель управления Nate Stars</b>\n\n` +
    `Текущие тарифы:\n` +
    `• 1 звезда: <b>${starPrice} сум</b>\n` +
    `• Premium 3 мес: <b>${formatUzs(prem3)}</b>\n` +
    `• Premium 6 мес: <b>${formatUzs(prem6)}</b>\n` +
    `• Premium 12 мес: <b>${formatUzs(prem12)}</b>\n` +
    `• Карта для оплаты: <code>${card}</code>\n` +
    `• Группа заказов: <code>${group}</code>\n\n` +
    `<i>Вы также можете менять цены прямо внутри Mini App во вкладке «Управление»!</i>`;

  ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Цена за 1 звезду', callback_data: 'edit_star_price' }],
        [
          { text: 'Premium 3м', callback_data: 'edit_prem_3' },
          { text: 'Premium 6м', callback_data: 'edit_prem_6' },
          { text: 'Premium 12м', callback_data: 'edit_prem_12' }
        ],
        [{ text: 'Номер карты', callback_data: 'edit_card_number' }],
        [{ text: 'Ожидающие заказы', callback_data: 'view_pending_orders' }]
      ]
    }
  });
});

// Обработка кнопок админки
bot.action(/edit_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('Нет доступа');

  const action = ctx.match[1];
  let promptText = '';

  switch (action) {
    case 'star_price':
      adminStates.set(userId, 'set_star_price');
      promptText = 'Введите новую цену за 1 звезду в сумах (например: <code>230</code>):';
      break;
    case 'prem_3':
      adminStates.set(userId, 'set_prem_3');
      promptText = 'Введите цену на Premium 3 месяца в сумах (например: <code>180000</code>):';
      break;
    case 'prem_6':
      adminStates.set(userId, 'set_prem_6');
      promptText = 'Введите цену на Premium 6 месяцев в сумах (например: <code>250000</code>):';
      break;
    case 'prem_12':
      adminStates.set(userId, 'set_prem_12');
      promptText = 'Введите цену на Premium 12 месяцев в сумах (например: <code>410000</code>):';
      break;
    case 'card_number':
      adminStates.set(userId, 'set_card_number');
      promptText = 'Введите новый номер карты (16 цифр):';
      break;
    default:
      return ctx.answerCbQuery();
  }

  await ctx.answerCbQuery();
  ctx.reply(promptText, { parse_mode: 'HTML' });
});

// Просмотр ожидающих заказов (безопасный HTML)
bot.action('view_pending_orders', async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('Нет доступа');

  const pending = dao.getPendingOrders();
  await ctx.answerCbQuery();

  if (pending.length === 0) {
    return ctx.reply('Нет ожидающих заказов. Все заказы обработаны.');
  }

  for (const order of pending.slice(0, 5)) {
    const desc = order.type === 'stars' ? `${order.amount} Stars` : `Premium ${order.amount} мес.`;
    const msg = 
      `<b>Заказ #${escapeHtml(order.id)}</b>\n` +
      `Покупатель: ${escapeHtml(order.buyer_username)} (ID: <code>${order.telegram_id}</code>)\n` +
      `Получатель: ${escapeHtml(order.recipient_username)}\n` +
      `Товар: ${escapeHtml(desc)}\n` +
      `Сумма: <code>${formatUzs(order.price_uzs)}</code>\n` +
      `Дата: ${escapeHtml(order.created_at)}`;

    await ctx.reply(msg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Подтвердить', callback_data: `pre_confirm_${order.id}` },
            { text: '❌ Отклонить', callback_data: `pre_reject_${order.id}` }
          ]
        ]
      }
    });
  }
});

// 1. Предварительное подтверждение — ЗАЩИТА ОТ МИСКЛИКА
bot.action(/pre_confirm_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('Нет доступа');

  const orderId = ctx.match[1];
  const order = dao.getOrder(orderId);
  if (!order) return ctx.answerCbQuery('Заказ не найден');
  if (order.status === 'confirmed') return ctx.answerCbQuery('Заказ уже выполнен');

  await ctx.answerCbQuery('⚠️ Защита от мисклика: подтвердите выдачу товара');

  try {
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        [
          { text: `⚡ ТОЧНО ВЫДАТЬ (#${orderId})`, callback_data: `real_confirm_${orderId}` }
        ],
        [
          { text: '↩️ Отмена', callback_data: `cancel_action_${orderId}` }
        ]
      ]
    });
  } catch (e) {
    console.warn('Ошибка изменения кнопок подтверждения:', e.message);
  }
});

// 2. Предварительное отклонение — ЗАЩИТА ОТ МИСКЛИКА
bot.action(/pre_reject_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('Нет доступа');

  const orderId = ctx.match[1];
  const order = dao.getOrder(orderId);
  if (!order) return ctx.answerCbQuery('Заказ не найден');

  await ctx.answerCbQuery('⚠️ Защита от мисклика: подтвердите отклонение');

  try {
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        [
          { text: `❌ ТОЧНО ОТКЛОНИТЬ (#${orderId})`, callback_data: `real_reject_${orderId}` }
        ],
        [
          { text: '↩️ Отмена', callback_data: `cancel_action_${orderId}` }
        ]
      ]
    });
  } catch (e) {
    console.warn('Ошибка изменения кнопок отклонения:', e.message);
  }
});

// 3. Отмена действия (возврат стандартных кнопок)
bot.action(/cancel_action_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('Нет доступа');

  const orderId = ctx.match[1];
  await ctx.answerCbQuery('Действие отменено');

  try {
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        [
          { text: '✅ Подтвердить', callback_data: `pre_confirm_${orderId}` },
          { text: '❌ Отклонить', callback_data: `pre_reject_${orderId}` }
        ]
      ]
    });
  } catch (e) {
    console.warn('Ошибка возврата кнопок:', e.message);
  }
});

// 4. Окончательное подтверждение и вызов Fragment
bot.action(/real_confirm_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('Нет доступа');

  const orderId = ctx.match[1];
  const order = dao.getOrder(orderId);
  if (!order) return ctx.answerCbQuery('Заказ не найден');
  if (order.status === 'confirmed') {
    await ctx.answerCbQuery('Заказ уже подтверждён');
    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[{ text: '✅ Выполнен', callback_data: `done_${orderId}` }]]
      });
    } catch (e) {}
    return;
  }

  await ctx.answerCbQuery('Заказ подтверждён! Отправка...');
  const adminName = ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name;

  const fulfilled = await fulfillOrder(orderId, {
    confirmedBy: adminName,
    source: 'manual',
    skipGroupNotice: true
  });

  const fragmentRes = fulfilled.fragment || { success: false, error: 'Не выполнен' };
  let fragmentNote = '';
  if (fragmentRes.success) {
    fragmentNote = `\n⚡ <b>Fragment:</b> ${escapeHtml(fragmentRes.message)}`;
    if (fragmentRes.txHash) fragmentNote += `\n🔗 <code>${escapeHtml(fragmentRes.txHash)}</code>`;
  } else {
    fragmentNote = `\n⚠️ <b>Fragment:</b> ${escapeHtml(fragmentRes.error)} (требуется ручная выдача)`;
  }

  try {
    const originalText = ctx.callbackQuery.message.text || '';
    await ctx.editMessageText(
      originalText + `\n\n✅ <b>ПОДТВЕРЖДЁН И ВЫДАН</b> (${escapeHtml(adminName)})${fragmentNote}`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Выполнен', callback_data: `done_${orderId}` }]
          ]
        }
      }
    );
  } catch (e) {
    console.warn('Ошибка обновления сообщения заказа:', e.message);
  }
});

// 5. Окончательное отклонение
bot.action(/real_reject_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('Нет доступа');

  const orderId = ctx.match[1];
  const order = dao.getOrder(orderId);
  if (!order) return ctx.answerCbQuery('Заказ не найден');

  dao.updateOrderStatus(orderId, 'rejected');
  await ctx.answerCbQuery('Заказ отклонён');

  const adminName = ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name;

  try {
    const originalText = ctx.callbackQuery.message.text || '';
    await ctx.editMessageText(
      originalText + `\n\n❌ <b>ОТКЛОНЁН</b> (${escapeHtml(adminName)})`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Отклонён', callback_data: `done_${orderId}` }]
          ]
        }
      }
    );
  } catch (e) {
    console.warn('Ошибка обновления сообщения отклонения:', e.message);
  }

  const clientMsg = 
    `<b>Заказ #${escapeHtml(order.id)} отклонён</b>\n\n` +
    `Перевод не был обнаружен или произошла ошибка.\n` +
    `Если вы уже совершили оплату, свяжитесь с поддержкой.`;

  try {
    await bot.telegram.sendMessage(order.telegram_id, clientMsg, { parse_mode: 'HTML' });
  } catch (e) {
    console.warn('Не удалось уведомить клиента:', e.message);
  }
});

// Заглушка для нажатия на выполненный заказ
bot.action(/done_(.+)/, async (ctx) => {
  await ctx.answerCbQuery('Этот заказ уже закрыт.');
});

// Обратная совместимость для старых кнопок
bot.action(/confirm_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  ctx.match[1] = orderId;
  return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: `pre_confirm_${orderId}` } });
});

bot.action(/reject_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  ctx.match[1] = orderId;
  return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: `pre_reject_${orderId}` } });
});

// Ввод текстовых данных админом
bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id;
  const state = adminStates.get(userId);

  if (!state || !isAdmin(userId)) return next();

  const text = ctx.message.text.trim();
  adminStates.delete(userId);

  switch (state) {
    case 'set_star_price': {
      const num = parseInt(text.replace(/\s+/g, ''), 10);
      if (isNaN(num) || num <= 0) return ctx.reply('Введите положительное число.');
      dao.setSetting('star_price_uzs', String(num));
      return ctx.reply(`Цена за 1 звезду сохранена: <b>${num} сум</b>`, { parse_mode: 'HTML' });
    }
    case 'set_prem_3': {
      const num = parseInt(text.replace(/\s+/g, ''), 10);
      if (isNaN(num) || num <= 0) return ctx.reply('Введите число.');
      dao.setSetting('premium_3_uzs', String(num));
      return ctx.reply(`Цена на Premium 3 мес: <b>${formatUzs(num)}</b>`, { parse_mode: 'HTML' });
    }
    case 'set_prem_6': {
      const num = parseInt(text.replace(/\s+/g, ''), 10);
      if (isNaN(num) || num <= 0) return ctx.reply('Введите число.');
      dao.setSetting('premium_6_uzs', String(num));
      return ctx.reply(`Цена на Premium 6 мес: <b>${formatUzs(num)}</b>`, { parse_mode: 'HTML' });
    }
    case 'set_prem_12': {
      const num = parseInt(text.replace(/\s+/g, ''), 10);
      if (isNaN(num) || num <= 0) return ctx.reply('Введите число.');
      dao.setSetting('premium_12_uzs', String(num));
      return ctx.reply(`Цена на Premium 12 мес: <b>${formatUzs(num)}</b>`, { parse_mode: 'HTML' });
    }
    case 'set_card_number': {
      const clean = text.replace(/[^0-9]/g, '');
      if (clean.length < 12) return ctx.reply('Номер карты должен содержать от 16 цифр.');
      dao.setSetting('card_number', clean);
      return ctx.reply(`Новый номер карты сохранён: <code>${clean}</code>`, { parse_mode: 'HTML' });
    }
  }

  next();
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ===== Helper: Запуск туннеля (Cloudflare без экранов подтверждения) =====
function startCloudflareTunnel() {
  return new Promise((resolve) => {
    const cfBin = path.join(__dirname, 'cloudflared.exe');
    if (!fs.existsSync(cfBin)) {
      return resolve(null);
    }

    console.log('🌐 Запуск Cloudflare HTTPS-туннеля (без промежуточных окон)...');
    const cf = spawn(cfBin, ['tunnel', '--url', `http://127.0.0.1:${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let resolved = false;

    function handleData(chunk) {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        console.log('✨ Чистый Cloudflare-туннель активен:', match[0]);
        resolve({ url: match[0], process: cf });
      }
    }

    cf.stdout.on('data', handleData);
    cf.stderr.on('data', handleData);

    cf.on('error', (err) => {
      console.warn('⚠️ Ошибка запуска Cloudflare:', err.message);
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });

    setTimeout(() => {
      if (!resolved) {
        console.warn('⚠️ Таймаут ожидания Cloudflare');
        resolved = true;
        resolve(null);
      }
    }, 25000);
  });
}

function startPinggyTunnel() {
  return new Promise((resolve) => {
    console.log('🌐 Запуск резервного Pinggy HTTPS-туннеля...');
    const py = spawn('python', ['-u', path.join(__dirname, 'tunnel.py'), String(PORT)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let resolved = false;

    py.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const match = text.match(/TUNNEL_READY=(https:\/\/[^\s]+)/);
      if (match && !resolved) {
        resolved = true;
        resolve({ url: match[1], process: py });
      }
    });

    py.stderr.on('data', (chunk) => {
      console.warn('Tunnel log:', chunk.toString().trim());
    });

    py.on('error', (err) => {
      console.warn('⚠️ Ошибка запуска туннеля:', err.message);
      if (!resolved) {
        resolved = true;
        resolve({ url: null, process: null });
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ url: null, process: py });
      }
    }, 15000);
  });
}

async function startTunnelProcess() {
  const cf = await startCloudflareTunnel();
  if (cf && cf.url) return cf;
  return await startPinggyTunnel();
}

// ===== Запуск =====
let tunnelProc = null;

async function start() {
  try {
    await initDatabase();
    console.log('💾 База данных готова');

    await new Promise((resolve) => app.listen(PORT, resolve));
    console.log(`🚀 Сервер запущен на порту ${PORT}`);

    if (WEBAPP_URL && WEBAPP_URL.startsWith('https://')) {
      console.log(`🌐 Использован постоянный домен: ${WEBAPP_URL}`);
    } else {
      const tunnel = await startTunnelProcess();
      if (tunnel && tunnel.url) {
        WEBAPP_URL = tunnel.url;
        tunnelProc = tunnel.process;
        console.log(`✨ HTTPS-туннель активен: ${WEBAPP_URL}`);
      } else {
        WEBAPP_URL = `http://localhost:${PORT}`;
      }
    }

    const botInfo = await bot.telegram.getMe();
    bot.botInfo = botInfo;
    console.log(`🤖 Бот авторизован: @${botInfo.username}`);

    if (WEBAPP_URL && WEBAPP_URL.startsWith('https://')) {
      try {
        await bot.telegram.setChatMenuButton({
          menu_button: {
            type: 'web_app',
            text: '⭐ Nate Stars',
            web_app: { url: WEBAPP_URL }
          }
        });
        console.log('🔘 Кнопка меню в Telegram настроена на:', WEBAPP_URL);
      } catch (menuErr) {
        console.warn('⚠️ Ошибка настройки Menu Button:', menuErr.message);
      }
    }

    bot.launch();
    console.log('✅ Бот слушает сообщения!');

    // Запускаем облачный слушатель @CardXabarBot (если авторизован)
    CardXabarService.init(handleCardXabarPayment).catch(err => {
      console.warn('⚠️ Ошибка запуска CardXabar:', err.message);
    });

    console.log(`\n🎉 Всё готово! Бот: https://t.me/${botInfo.username}\n`);

  } catch (err) {
    console.error('❌ Ошибка запуска:', err);
    process.exit(1);
  }
}

async function shutdown() {
  console.log('\nОстановка сервисов...');
  await CardXabarService.stopListenerOnly();
  if (tunnelProc) tunnelProc.kill();
  bot.stop();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

start();
