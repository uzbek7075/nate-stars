require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Telegraf } = require('telegraf');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { initDatabase, dao, calculateCostUzs } = require('./database');
const { authMiddleware } = require('./auth');
const { FragmentService } = require('./fragment');
const { TonTransferService, parseAndValidateAddress, formatTonAmount } = require('./ton');
const { refreshTonRate, getSavedTonRateSnapshot } = require('./tonRate');
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

function formatOrderItemDesc(type, amount) {
  if (type === 'stars') return `${amount} Telegram Stars`;
  if (type === 'ton') return `${formatTonAmount(amount)} TON`;
  return `Telegram Premium на ${amount} мес.`;
}

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
      normalizedAmount: starsCount,
      itemDescription: formatOrderItemDesc('stars', starsCount)
    };
  }
  if (type === 'ton') {
    const rawNum = parseFloat(String(amount).replace(',', '.'));
    const tonAmount = Math.round(rawNum * 100) / 100;
    const minTon = Number(settings.min_ton || 0.2);
    const maxTon = Number(settings.max_ton || 50);
    if (!Number.isFinite(tonAmount) || tonAmount < minTon) {
      throw new Error(`Минимум ${minTon} TON`);
    }
    if (tonAmount > maxTon) {
      throw new Error(`Максимум ${maxTon} TON за один заказ`);
    }
    const tonPrice = Number(settings.ton_price_uzs || 20000);
    return {
      basePriceUzs: Math.round(tonAmount * tonPrice),
      normalizedAmount: tonAmount,
      itemDescription: formatOrderItemDesc('ton', tonAmount)
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
      normalizedAmount: months,
      itemDescription: formatOrderItemDesc('premium', months)
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
  const itemDesc = formatOrderItemDesc(order.type, order.amount);
  const memoLine = order.ton_memo ? `• <b>Memo / Tag:</b> <code>${escapeHtml(order.ton_memo)}</code>\n` : '';
  const recLabel = order.type === 'ton' ? 'Кошелёк' : 'Получатель';

  const adminMessage =
    `<b>НОВЫЙ ЗАКАЗ #${escapeHtml(order.id)}</b>\n\n` +
    `• <b>Покупатель:</b> ${escapeHtml(order.buyer_username)} (ID: <code>${order.telegram_id}</code>)\n` +
    `• <b>${recLabel}:</b> <code>${escapeHtml(order.recipient_username)}</code>\n` +
    memoLine +
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

async function sendDeliveredClientMessage(order, txHash = '') {
  const itemDesc = formatOrderItemDesc(order.type, order.amount);
  const recLabel = order.type === 'ton' ? 'Кошелёк' : 'Получатель';
  const hashVal = txHash || order.tx_hash || '';
  const txLine = order.type === 'ton' && hashVal
    ? `\n🔗 <a href="https://tonviewer.com/transaction/${encodeURIComponent(hashVal)}">Посмотреть в Tonviewer</a>`
    : '';

  const clientMsg =
    `<b>Заказ #${escapeHtml(order.id)} выполнен</b>\n\n` +
    `Товар: <b>${escapeHtml(itemDesc)}</b>\n` +
    `${recLabel}: <code>${escapeHtml(order.recipient_username)}</code>\n` +
    (order.ton_memo ? `Memo: <code>${escapeHtml(order.ton_memo)}</code>\n` : '') +
    `Сумма: <b>${formatUzs(order.price_uzs)}</b>\n\n` +
    `Товар успешно доставлен. Спасибо за покупку в Nate Stars.${txLine}`;

  try {
    await bot.telegram.sendMessage(order.telegram_id, clientMsg, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  } catch (e) {
    console.warn('Не удалось уведомить клиента:', e.message);
  }
}

/**
 * Единая точка выполнения заказа (отправка через Fragment для Stars/Premium или блокчейн TON для TON).
 */
async function fulfillOrder(orderId, { confirmedBy = 'Admin', source = 'manual', cardXabarInfo = null, skipGroupNotice = false } = {}) {
  const order = dao.getOrder(orderId);
  if (!order) return { ok: false, reason: 'not_found' };
  if (order.status === 'confirmed') return { ok: false, reason: 'already_confirmed', order };

  // Сразу фиксируем статус 'paid_processing' (оплата получена), чтобы исключить гонку и потерю заказа
  dao.updateOrderStatus(orderId, 'paid_processing', source);

  const isTonOrder = order.type === 'ton';
  const deliveryRes = isTonOrder
    ? await TonTransferService.sendOrderTon(order)
    : await FragmentService.dispatchOrder(order);
  console.log(`⚡ [Order Fulfill #${orderId} via ${source}]`, deliveryRes);

  const itemDesc = formatOrderItemDesc(order.type, order.amount);
  const providerLabel = isTonOrder ? 'TON Transfer' : 'Fragment';
  const retryBtnText = isTonOrder ? '🔄 Повторить отправку TON' : '🔄 Повторить Fragment';

  if (deliveryRes.success) {
    const curSettings = dao.getAllSettings();
    const orderCostUzs = Number(order.cost_uzs || 0) > 0
      ? Number(order.cost_uzs)
      : calculateCostUzs(order.type, order.amount, curSettings);
    dao.updateOrderDeliveryCost(orderId, {
      costUzs: orderCostUzs,
      tonSpent: deliveryRes.tonSpent || 0,
      txHash: deliveryRes.txHash || ''
    });
    dao.updateOrderStatus(orderId, 'confirmed', source);
    await sendDeliveredClientMessage(dao.getOrder(orderId), deliveryRes.txHash || '');
  } else {
    const waitClientMsg =
      `✅ <b>Оплата по заказу #${escapeHtml(order.id)} получена!</b>\n\n` +
      `Товар: <b>${escapeHtml(itemDesc)}</b>\n` +
      `${isTonOrder ? 'Кошелёк' : 'Получатель'}: <code>${escapeHtml(order.recipient_username)}</code>\n` +
      `Сумма: <b>${formatUzs(order.price_uzs)}</b>\n\n` +
      `⏳ Администратор уже получил заказ и скоро отправит его вручную (если администратор сейчас на учёбе или занят, выдача может занять немного времени — не переживайте, статус заказа виден в шапке магазина).`;
    try {
      await bot.telegram.sendMessage(order.telegram_id, waitClientMsg, { parse_mode: 'HTML' });
    } catch (e) {
      console.warn('Не удалось уведомить клиента:', e.message);
    }
  }

  // После попытки автовыдачи проверяем остаток TON (при падении ниже порога уведомим админа)
  checkLowTonBalanceAndNotify({ triggerOrderId: orderId }).catch(() => {});

  if (!skipGroupNotice) {
    let deliveryNote = '';
    if (deliveryRes.success) {
      deliveryNote = `⚡ <b>${providerLabel}:</b> ${escapeHtml(deliveryRes.message)}`;
      if (deliveryRes.txHash) {
        deliveryNote += `\n🔗 <code>${escapeHtml(deliveryRes.txHash)}</code>`;
      }
    } else {
      deliveryNote = `⚠️ <b>${providerLabel}:</b> ${escapeHtml(deliveryRes.error)}\n<i>Заказ помечен «Оплачен · Ожидает выдачи». Пополните TON и нажмите «${retryBtnText}» или выдайте вручную.</i>`;
    }

    const header = source === 'cardxabar'
      ? `⚡ <b>АВТООПЛАТА CARDXABAR (#${escapeHtml(order.id)})</b>`
      : source === 'retry'
        ? `🔄 <b>ПОВТОРНАЯ ВЫДАЧА (#${escapeHtml(order.id)})</b> (${escapeHtml(confirmedBy)})`
        : `✅ <b>ЗАКАЗ #${escapeHtml(order.id)} ПОДТВЕРЖДЁН</b> (${escapeHtml(confirmedBy)})`;

    const cardLine = cardXabarInfo
      ? `💳 Зачислено: <code>+${formatUzs(cardXabarInfo.amount)}</code> (карта ***${escapeHtml(cardXabarInfo.cardLast4)})\n`
      : '';

    const groupMsg =
      `${header}\n\n` +
      cardLine +
      `• <b>Покупатель:</b> ${escapeHtml(order.buyer_username)}\n` +
      `• <b>${isTonOrder ? 'Кошелёк' : 'Получатель'}:</b> <code>${escapeHtml(order.recipient_username)}</code>\n` +
      (order.ton_memo ? `• <b>Memo:</b> <code>${escapeHtml(order.ton_memo)}</code>\n` : '') +
      `• <b>Товар:</b> ${escapeHtml(itemDesc)}\n` +
      `• <b>Сумма:</b> <code>${formatUzs(order.price_uzs)}</code>\n\n` +
      deliveryNote;

    const extraOpts = deliveryRes.success
      ? {}
      : {
          reply_markup: {
            inline_keyboard: [
              [
                { text: retryBtnText, callback_data: `retry_frag_${order.id}` },
                { text: '✅ Выдано вручную', callback_data: `manual_done_${order.id}` }
              ]
            ]
          }
        };

    await sendToAdminAndGroup(groupMsg, extraOpts);
  }

  return { ok: true, order: dao.getOrder(orderId), fragment: deliveryRes };
}

async function completeOrderManually(orderId) {
  const order = dao.getOrder(orderId);
  if (!order) return { ok: false, reason: 'not_found' };
  if (order.status === 'confirmed') return { ok: false, reason: 'already_confirmed', order };
  if (Number(order.cost_uzs || 0) <= 0) {
    const estCost = calculateCostUzs(order.type, order.amount, dao.getAllSettings());
    dao.updateOrderDeliveryCost(orderId, { costUzs: estCost, tonSpent: 0 });
  }
  dao.updateOrderStatus(orderId, 'confirmed', 'manual');
  await sendDeliveredClientMessage(order);
  return { ok: true, order: dao.getOrder(orderId) };
}

// ===== Предпросмотр получателя, мониторинг TON, статистика и рассылка =====

const recipientPreviewCache = new Map();
const RECIPIENT_CACHE_TTL_MS = 5 * 60 * 1000;
let lowTonCheckInFlight = false;
let broadcastInProgress = false;

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

/**
 * Получает имя, аватар и тип публичного @username через t.me с кэшированием.
 */
async function fetchTelegramRecipientPreview(rawUsername) {
  const clean = String(rawUsername || '').replace(/^@+/, '').trim();
  if (!/^[a-zA-Z0-9_]{4,32}$/.test(clean)) {
    return {
      valid: false,
      status: 'invalid_format',
      username: clean ? '@' + clean : '',
      reason: 'Username должен содержать от 4 символов (латиница, цифры, _)'
    };
  }

  const cacheKey = clean.toLowerCase();
  const cached = recipientPreviewCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < RECIPIENT_CACHE_TTL_MS) {
    return cached.data;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`https://t.me/${encodeURIComponent(clean)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NateStarsPreview/1.0)' },
      signal: controller.signal
    });
    const html = await res.text();

    const meta = (prop) => {
      const m = html.match(new RegExp(`<meta\\s+property=["']${prop}["']\\s+content=["']([^"']*)["']`, 'i'));
      return m ? decodeHtmlEntities(m[1]) : '';
    };
    const extraMatch = html.match(/class="tgme_page_extra"[^>]*>([\s\S]*?)<\/div>/i);
    const extra = extraMatch ? decodeHtmlEntities(extraMatch[1].replace(/<[^>]+>/g, '')) : '';
    const titleMatch = html.match(/class="tgme_page_title"[^>]*>([\s\S]*?)<\/div>/i);
    const pageTitle = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '')) : '';
    const actionMatch = html.match(/class="tgme_action_button_new[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const actionBtn = actionMatch ? decodeHtmlEntities(actionMatch[1].replace(/<[^>]+>/g, '')) : '';

    const ogTitle = meta('og:title');
    const ogImage = meta('og:image');
    const hasPhoto = /tgme_page_photo_image/i.test(html) && ogImage && !ogImage.includes('telegram.org/img/t_logo');
    const displayName = pageTitle || ogTitle || '@' + clean;

    let result;
    if (!extra) {
      result = {
        valid: false,
        status: 'not_found',
        username: '@' + clean,
        displayName: '@' + clean,
        avatarUrl: null,
        reason: 'Аккаунт с таким @username не найден'
      };
    } else if (/subscribers|members|подписчик|участник/i.test(extra)) {
      result = {
        valid: false,
        status: 'channel_or_group',
        username: '@' + clean,
        displayName,
        avatarUrl: hasPhoto ? ogImage : null,
        reason: 'Это канал или группа — укажите личный @username'
      };
    } else if (/^start bot$/i.test(actionBtn)) {
      result = {
        valid: false,
        status: 'is_bot',
        username: '@' + clean,
        displayName,
        avatarUrl: hasPhoto ? ogImage : null,
        reason: 'Это бот — звёзды и Premium дарятся личному аккаунту'
      };
    } else {
      result = {
        valid: true,
        status: 'ok',
        username: extra.startsWith('@') ? extra : '@' + clean,
        displayName,
        avatarUrl: hasPhoto ? ogImage : null
      };
    }

    if (recipientPreviewCache.size > 500) {
      recipientPreviewCache.clear();
    }
    recipientPreviewCache.set(cacheKey, { ts: Date.now(), data: result });
    return result;
  } catch (err) {
    return {
      valid: true,
      status: 'lookup_unavailable',
      username: '@' + clean,
      displayName: '@' + clean,
      avatarUrl: null
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Проверяет баланс TON-кошелька Fragment и уведомляет админа при падении ниже порога.
 */
async function checkLowTonBalanceAndNotify({ force = false, triggerOrderId = null } = {}) {
  if (lowTonCheckInFlight) return null;
  lowTonCheckInFlight = true;
  try {
    const balanceRes = await FragmentService.getWalletBalance();
    if (!balanceRes || !balanceRes.success) return balanceRes;

    const settings = dao.getAllSettings();
    const threshold = Math.max(0.5, Number(settings.low_ton_threshold || 5));
    const current = Number(balanceRes.balance || 0);
    const lastAlertAt = Number(settings.last_low_ton_alert_at || 0);
    const lastAlertBal = settings.last_low_ton_alert_balance !== '' ? Number(settings.last_low_ton_alert_balance) : null;
    const now = Date.now();

    if (current >= threshold) {
      if (lastAlertAt > 0) {
        dao.setSetting('last_low_ton_alert_at', '0');
        dao.setSetting('last_low_ton_alert_balance', '');
      }
      return { ...balanceRes, threshold, low: false };
    }

    const cooldownPassed = !lastAlertAt || (now - lastAlertAt) >= 4 * 60 * 60 * 1000;
    const droppedCritical = current < 1 && (lastAlertBal === null || lastAlertBal >= 1);

    if (force || cooldownPassed || droppedCritical) {
      dao.setSetting('last_low_ton_alert_at', String(now));
      dao.setSetting('last_low_ton_alert_balance', current.toFixed(3));

      const isCritical = current < 1;
      const title = isCritical
        ? '🚨 <b>КРИТИЧЕСКИ НИЗКИЙ БАЛАНС TON!</b>'
        : '⚠️ <b>Низкий баланс TON на кошельке</b>';
      const orderNote = triggerOrderId ? `\nПосле заказа: <code>#${escapeHtml(triggerOrderId)}</code>\n` : '\n';
      const criticalNote = isCritical
        ? '\n❗ <i>Меньше 1 TON — автовыдача Fragment временно не сможет отправлять заказы, клиенты будут видеть статус ожидания.</i>'
        : '\n<i>Рекомендуем пополнить кошелёк заранее, чтобы автовыдача не останавливалась.</i>';

      const msg =
        `${title}\n` +
        orderNote +
        `• Текущий остаток: <b>${current.toFixed(3)} TON</b>\n` +
        `• Порог уведомления: <b>${threshold} TON</b>\n` +
        `• Кошелёк: <code>${escapeHtml(balanceRes.address || '')}</code>` +
        criticalNote;

      for (const adminId of getAdminIds()) {
        try {
          await bot.telegram.sendMessage(adminId, msg, { parse_mode: 'HTML' });
        } catch (e) {
          console.warn('Не удалось отправить уведомление о балансе TON:', e.message);
        }
      }
    }

    return { ...balanceRes, threshold, low: true };
  } finally {
    lowTonCheckInFlight = false;
  }
}

function formatProfitReportText(profitStats, walletBalance, threshold) {
  const fmtPeriod = (label, b) => (
    `<b>${label}:</b>\n` +
    `• Заказов: <b>${b.orders}</b> (⭐ ${b.starsCount.toLocaleString('ru-RU')} · Prem: ${b.premiumCount} · TON: ${b.tonSoldAmount})\n` +
    `• Оборот: <b>${formatUzs(b.revenueUzs)}</b>\n` +
    `• Себест.: ${formatUzs(b.costUzs)} → <b>Прибыль: ${formatUzs(b.profitUzs)}</b> (${b.marginPct}%)`
  );

  const balStr = walletBalance?.success
    ? `<b>${walletBalance.balanceFormatted}</b> (порог: ${threshold} TON)`
    : 'не удалось получить';

  return (
    `📊 <b>Статистика прибыли Nate Stars</b>\n` +
    `💰 Баланс TON: ${balStr}\n\n` +
    `${fmtPeriod('Сегодня (Ташкент)', profitStats.today)}\n\n` +
    `${fmtPeriod('За 7 дней', profitStats.week)}\n\n` +
    `${fmtPeriod('За 30 дней', profitStats.month)}\n\n` +
    `${fmtPeriod('За всё время', profitStats.all)}`
  );
}

/**
 * Безопасная отправка одного сообщения рассылки с fallback при ошибке HTML-разметки.
 */
async function sendBroadcastPayload(chatId, { text, photoFileId = null, replyMarkup = undefined }) {
  if (photoFileId) {
    try {
      return await bot.telegram.sendPhoto(chatId, photoFileId, {
        caption: text || '',
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    } catch (e) {
      if (e?.response?.error_code === 400 && /parse/i.test(e.message || '')) {
        return await bot.telegram.sendPhoto(chatId, photoFileId, {
          caption: text || '',
          reply_markup: replyMarkup
        });
      }
      throw e;
    }
  }

  try {
    return await bot.telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: replyMarkup
    });
  } catch (e) {
    if (e?.response?.error_code === 400 && /parse/i.test(e.message || '')) {
      return await bot.telegram.sendMessage(chatId, text, {
        disable_web_page_preview: true,
        reply_markup: replyMarkup
      });
    }
    throw e;
  }
}

async function runAdminBroadcast({ text, photoFileId = null, includeOpenButton = true }) {
  if (broadcastInProgress) {
    throw new Error('Рассылка уже выполняется, дождитесь завершения');
  }
  broadcastInProgress = true;
  try {
    const users = dao.getActiveUsersForBroadcast();
    const urlToUse = WEBAPP_URL || `http://localhost:${PORT}`;
    const replyMarkup = includeOpenButton && urlToUse.startsWith('https://')
      ? { inline_keyboard: [[{ text: 'Открыть Nate Stars', web_app: { url: urlToUse } }]] }
      : undefined;

    let sent = 0;
    let blocked = 0;
    let failed = 0;

    for (const u of users) {
      try {
        await sendBroadcastPayload(u.telegram_id, { text, photoFileId, replyMarkup });
        sent += 1;
      } catch (err) {
        const code = err?.response?.error_code;
        if (code === 429) {
          const waitSec = Number(err.response?.parameters?.retry_after || 2);
          await new Promise(r => setTimeout(r, (waitSec + 1) * 1000));
          try {
            await sendBroadcastPayload(u.telegram_id, { text, photoFileId, replyMarkup });
            sent += 1;
            continue;
          } catch (retryErr) {
            if (retryErr?.response?.error_code === 403) {
              dao.markUserBlocked(u.telegram_id, true);
              blocked += 1;
            } else {
              failed += 1;
            }
            continue;
          }
        }
        if (code === 403) {
          dao.markUserBlocked(u.telegram_id, true);
          blocked += 1;
        } else {
          failed += 1;
        }
      }
      await new Promise(r => setTimeout(r, 45));
    }

    return {
      total: users.length,
      sent,
      blocked,
      failed,
      broadcastStats: dao.getBroadcastStats()
    };
  } finally {
    broadcastInProgress = false;
  }
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
    tonPriceUzs: Number(settings.ton_price_uzs || 20000),
    minTon: Number(settings.min_ton || 0.2),
    maxTon: Number(settings.max_ton || 50),
    autoConfirmEnabled: settings.auto_confirm_enabled === 'true'
  });
});

// Проверка и форматирование TON-адреса перед оплатой
app.get('/api/ton/validate-address', auth, (req, res) => {
  const address = String(req.query.address || '').trim();
  const ownWalletAddress = FragmentService.getConfig().walletAddress;
  res.json(parseAndValidateAddress(address, { ownWalletAddress }));
});

// Профиль пользователя, флаг isAdmin и активные заказы в работе
app.get('/api/user', auth, (req, res) => {
  const tgUser = req.telegramUser;
  dao.upsertUser({
    telegramId: tgUser.id,
    username: tgUser.username,
    firstName: tgUser.first_name,
    lastName: tgUser.last_name
  });
  const user = dao.getUser(tgUser.id);
  const activeOrders = dao.getUserActiveOrders(tgUser.id);
  res.json({
    user,
    isAdmin: isAdmin(tgUser.id),
    activeOrders
  });
});

// Предпросмотр получателя по @username (имя, аватарка, проверка на бота/канал)
app.get('/api/recipient-preview', auth, async (req, res) => {
  try {
    const username = String(req.query.username || '').trim();
    if (!username) {
      return res.status(400).json({ valid: false, status: 'empty', reason: 'Укажите @username' });
    }
    const preview = await fetchTelegramRecipientPreview(username);
    res.json(preview);
  } catch (err) {
    res.json({ valid: true, status: 'lookup_unavailable', username: '@' + String(req.query.username || '').replace(/^@+/, '') });
  }
});

// Админ-панель: сводка данных, статистика прибыли, баланс TON и ожидающие заказы
app.get('/api/admin/info', auth, requireAdmin, async (req, res) => {
  const settings = dao.getAllSettings();
  const stats = dao.getStats();
  const profitStats = dao.getProfitStats(settings);
  const broadcastStats = dao.getBroadcastStats();
  const pendingOrders = dao.getPendingOrders();
  const fragmentConfig = FragmentService.getConfig();
  const cardXabarStatus = CardXabarService.getStatus();
  const tonRateInfo = getSavedTonRateSnapshot();
  const walletBalance = await Promise.race([
    FragmentService.getWalletBalance(),
    new Promise(resolve => setTimeout(() => resolve({ success: false, balance: 0, error: 'Таймаут' }), 4000))
  ]);
  res.json({
    settings,
    stats,
    profitStats,
    broadcastStats,
    walletBalance,
    tonRateInfo,
    pendingOrders,
    fragmentConfig,
    cardXabarStatus
  });
});

// Админ-панель: принудительное обновление автокурса TON по бирже и ЦБ
app.post('/api/admin/ton-rate/refresh', auth, requireAdmin, async (req, res) => {
  try {
    const tonRateInfo = await refreshTonRate({ force: true });
    res.json({
      success: true,
      tonRateInfo,
      settings: dao.getAllSettings()
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Не удалось обновить курс TON' });
  }
});

// Админ-панель: проверка актуального баланса TON-кошелька
app.get('/api/admin/ton-balance', auth, requireAdmin, async (req, res) => {
  const settings = dao.getAllSettings();
  const threshold = Number(settings.low_ton_threshold || 5);
  const balance = await FragmentService.getWalletBalance();
  res.json({ ...balance, threshold });
});

// Админ-панель: тестовая рассылка самому себе (предпросмотр)
app.post('/api/admin/broadcast/test', auth, requireAdmin, async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    const includeOpenButton = req.body?.includeOpenButton !== false;
    if (!text) return res.status(400).json({ error: 'Введите текст сообщения для рассылки' });

    const urlToUse = WEBAPP_URL || `http://localhost:${PORT}`;
    const replyMarkup = includeOpenButton && urlToUse.startsWith('https://')
      ? { inline_keyboard: [[{ text: 'Открыть Nate Stars', web_app: { url: urlToUse } }]] }
      : undefined;

    await sendBroadcastPayload(req.telegramUser.id, { text, replyMarkup });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Ошибка отправки теста' });
  }
});

// Админ-панель: запуск рассылки по базе пользователей бота
app.post('/api/admin/broadcast/send', auth, requireAdmin, async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    const includeOpenButton = req.body?.includeOpenButton !== false;
    if (!text) return res.status(400).json({ error: 'Введите текст сообщения для рассылки' });

    const result = await runAdminBroadcast({ text, includeOpenButton });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Ошибка рассылки' });
  }
});

// Админ-панель: сохранение настроек из Mini App (включая Fragment, себестоимость, автокурс TON и автоподтверждение)
app.post('/api/admin/update-settings', auth, requireAdmin, async (req, res) => {
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
    autoConfirmEnabled,
    lowTonThreshold,
    costStarUzs,
    costPrem3Uzs,
    costPrem6Uzs,
    costPrem12Uzs,
    tonPriceUzs,
    costTonUzs,
    minTon,
    tonAutoRateEnabled,
    tonProviderSpreadPct,
    tonMarkupMode,
    tonMarkupUzs,
    tonMarkupPct,
    tonMinFloorUzs
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
  if (lowTonThreshold !== undefined && lowTonThreshold !== '') dao.setSetting('low_ton_threshold', String(lowTonThreshold));
  if (costStarUzs !== undefined && costStarUzs !== '') dao.setSetting('cost_star_uzs', String(costStarUzs));
  if (costPrem3Uzs !== undefined && costPrem3Uzs !== '') dao.setSetting('cost_prem_3_uzs', String(costPrem3Uzs));
  if (costPrem6Uzs !== undefined && costPrem6Uzs !== '') dao.setSetting('cost_prem_6_uzs', String(costPrem6Uzs));
  if (costPrem12Uzs !== undefined && costPrem12Uzs !== '') dao.setSetting('cost_prem_12_uzs', String(costPrem12Uzs));
  if (tonPriceUzs !== undefined && tonPriceUzs !== '') dao.setSetting('ton_price_uzs', String(tonPriceUzs));
  if (costTonUzs !== undefined && costTonUzs !== '') dao.setSetting('cost_ton_uzs', String(costTonUzs));
  if (minTon !== undefined && minTon !== '') dao.setSetting('min_ton', String(minTon));

  if (tonAutoRateEnabled !== undefined) dao.setSetting('ton_auto_rate_enabled', String(tonAutoRateEnabled));
  if (tonProviderSpreadPct !== undefined && tonProviderSpreadPct !== '') dao.setSetting('ton_provider_spread_pct', String(tonProviderSpreadPct));
  if (tonMarkupMode === 'fixed' || tonMarkupMode === 'percent') dao.setSetting('ton_markup_mode', tonMarkupMode);
  if (tonMarkupUzs !== undefined && tonMarkupUzs !== '') dao.setSetting('ton_markup_uzs', String(tonMarkupUzs));
  if (tonMarkupPct !== undefined && tonMarkupPct !== '') dao.setSetting('ton_markup_pct', String(tonMarkupPct));
  if (tonMinFloorUzs !== undefined && tonMinFloorUzs !== '') dao.setSetting('ton_min_floor_uzs', String(tonMinFloorUzs));

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

  let tonRateInfo = getSavedTonRateSnapshot();
  if (dao.getSetting('ton_auto_rate_enabled') !== 'false') {
    try {
      tonRateInfo = await refreshTonRate({ force: true });
    } catch (e) {
      console.warn('⚠️ Ошибка пересчёта автокурса TON:', e.message);
    }
  }

  res.json({
    success: true,
    settings: dao.getAllSettings(),
    tonRateInfo,
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

// Админ-панель: подтверждение / повтор Fragment / ручная выдача / отклонение заказа
app.post('/api/admin/order-action', auth, requireAdmin, async (req, res) => {
  const { orderId, action } = req.body;
  const order = dao.getOrder(orderId);

  if (!order) {
    return res.status(404).json({ error: 'Заказ не найден' });
  }

  const adminName = req.telegramUser?.username ? '@' + req.telegramUser.username : 'Admin';

  if (action === 'confirm' || action === 'retry') {
    const fulfilled = await fulfillOrder(orderId, {
      confirmedBy: adminName,
      source: action === 'retry' ? 'retry' : 'manual',
      skipGroupNotice: false
    });
    if (!fulfilled.ok && fulfilled.reason === 'already_confirmed') {
      return res.json({ success: true, status: 'confirmed', alreadyConfirmed: true });
    }
    return res.json({
      success: true,
      status: fulfilled.order?.status || 'paid_processing',
      fragment: fulfilled.fragment
    });
  } else if (action === 'manual_done') {
    const doneRes = await completeOrderManually(orderId);
    if (!doneRes.ok && doneRes.reason === 'already_confirmed') {
      return res.json({ success: true, status: 'confirmed', alreadyConfirmed: true });
    }
    return res.json({ success: true, status: 'confirmed' });
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
    const { recipientUsername, type, amount, tonMemo } = req.body;
    const tgUser = req.telegramUser;

    const settings = dao.getAllSettings();
    let calc;
    try {
      calc = calculateBasePrice(type, amount, settings);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    let fullRecipient = '';
    let cleanMemo = '';
    if (type === 'ton') {
      const addrCheck = parseAndValidateAddress(recipientUsername, {
        ownWalletAddress: FragmentService.getConfig().walletAddress
      });
      if (!addrCheck.valid) {
        return res.status(400).json({ error: addrCheck.reason });
      }
      fullRecipient = addrCheck.rawInput;
      cleanMemo = String(tonMemo || '').trim().slice(0, 120);
    } else {
      if (!recipientUsername) {
        return res.status(400).json({ error: 'Укажите @username получателя' });
      }
      const cleanUsername = recipientUsername.replace(/^@/, '').trim();
      if (!cleanUsername) {
        return res.status(400).json({ error: 'Некорректный username' });
      }
      fullRecipient = '@' + cleanUsername;
    }

    const { basePriceUzs, normalizedAmount, itemDescription } = calc;
    const autoConfirm = settings.auto_confirm_enabled === 'true';
    const cardNumber = settings.card_number || '5614681816265841';

    const existing = dao.findReusableAwaitingOrder({
      telegramId: tgUser.id,
      type,
      amount: normalizedAmount,
      recipientUsername: fullRecipient,
      basePriceUzs,
      tonMemo: cleanMemo
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
          tonMemo: existing.ton_memo || '',
          status: existing.status
        }
      });
    }

    const finalPriceUzs = autoConfirm ? dao.allocateUniquePrice(basePriceUzs) : basePriceUzs;
    const costUzs = calculateCostUzs(type, normalizedAmount, settings);
    const orderId = 'NS-' + Math.floor(100000 + Math.random() * 900000);

    dao.createOrder({
      id: orderId,
      telegramId: tgUser.id,
      buyerUsername: tgUser.username ? '@' + tgUser.username : tgUser.first_name,
      recipientUsername: fullRecipient,
      type,
      amount: normalizedAmount,
      priceUzs: finalPriceUzs,
      basePriceUzs,
      costUzs,
      cardNumber,
      status: 'awaiting_payment',
      senderComment: '',
      tonMemo: cleanMemo
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
        tonMemo: cleanMemo,
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
    const { recipientUsername, type, amount, senderComment, orderId: preparedId, tonMemo } = req.body;
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
        const itemDescription = formatOrderItemDesc(existing.type, existing.amount);
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

    const settings = dao.getAllSettings();
    let calc;
    try {
      calc = calculateBasePrice(type, amount, settings);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    let fullRecipient = '';
    let cleanMemo = '';
    if (type === 'ton') {
      const addrCheck = parseAndValidateAddress(recipientUsername, {
        ownWalletAddress: FragmentService.getConfig().walletAddress
      });
      if (!addrCheck.valid) {
        return res.status(400).json({ error: addrCheck.reason });
      }
      fullRecipient = addrCheck.rawInput;
      cleanMemo = String(tonMemo || '').trim().slice(0, 120);
    } else {
      if (!recipientUsername) {
        return res.status(400).json({ error: 'Укажите @username получателя' });
      }
      const cleanUsername = recipientUsername.replace(/^@/, '').trim();
      if (!cleanUsername) {
        return res.status(400).json({ error: 'Некорректный username' });
      }
      fullRecipient = '@' + cleanUsername;
    }

    const { basePriceUzs, normalizedAmount, itemDescription } = calc;
    const autoConfirm = settings.auto_confirm_enabled === 'true';
    const priceUzs = autoConfirm ? dao.allocateUniquePrice(basePriceUzs) : basePriceUzs;
    const costUzs = calculateCostUzs(type, normalizedAmount, settings);
    const orderId = 'NS-' + Math.floor(100000 + Math.random() * 900000);
    const cardNumber = settings.card_number || '5614681816265841';

    dao.createOrder({
      id: orderId,
      telegramId: tgUser.id,
      buyerUsername: tgUser.username ? '@' + tgUser.username : tgUser.first_name,
      recipientUsername: fullRecipient,
      type,
      amount: normalizedAmount,
      priceUzs,
      basePriceUzs,
      costUzs,
      cardNumber,
      status: 'pending',
      senderComment,
      tonMemo: cleanMemo
    });

    await notifyAdminsOfPendingOrder(dao.getOrder(orderId));

    res.json({
      success: true,
      order: {
        id: orderId,
        priceUzs,
        itemDescription,
        cardNumber,
        recipientUsername: fullRecipient,
        status: 'pending'
      }
    });

  } catch (err) {
    console.error('Ошибка создания заказа:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// История заказов пользователя и текущие заказы в работе
app.get('/api/orders', auth, (req, res) => {
  const orders = dao.getUserOrders(req.telegramUser.id);
  const activeOrders = dao.getUserActiveOrders(req.telegramUser.id);
  res.json({ orders, activeOrders });
});

// ===== БОТ: Команды и Кнопки =====

// Сохраняем в базу всех пользователей, взаимодействующих с ботом в ЛС (для рассылки и учёта)
bot.use(async (ctx, next) => {
  try {
    if (ctx.chat?.type === 'private' && ctx.from?.id && !ctx.from.is_bot) {
      dao.upsertUser({
        telegramId: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name
      });
    }
  } catch (e) {}
  return next();
});

// Команда /start
bot.start(async (ctx) => {
  const urlToUse = WEBAPP_URL || `http://localhost:${PORT}`;
  const userNick = ctx.from?.username
    ? '@' + ctx.from.username
    : (ctx.from?.first_name || 'друг');

  const welcomeText =
    `Привет, <b>${escapeHtml(userNick)}</b>! <tg-emoji emoji-id="5226775277094347795">👋</tg-emoji>\n\n` +
    `Здесь вы можете быстро приобрести <b>Telegram Stars</b> и <b>Premium</b> подписку на свой аккаунт за сумы.\n\n` +
    `• Доставка за пару секунд\n` +
    `• Оплата в сумах (Uzcard / Humo)\n` +
    `• Без входа в аккаунт и паролей — отправка подарком по @username\n` +
    `• Автоматическое подтверждение и выдача 24/7\n\n` +
    `Нажмите кнопку ниже, чтобы открыть магазин:`;

  await ctx.reply(welcomeText, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Открыть Nate Stars', web_app: { url: urlToUse } }]
      ]
    }
  });
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
  const tonPrice = settings.ton_price_uzs || '20000';
  const prem3 = settings.premium_3_uzs || '175000';
  const prem6 = settings.premium_6_uzs || '245000';
  const prem12 = settings.premium_12_uzs || '395000';
  const card = settings.card_number || '5614681816265841';
  const group = settings.orders_chat_id || 'Не привязана (напишите /setgroup в группе)';
  const autoTonEnabled = settings.ton_auto_rate_enabled !== 'false';
  const markupNote = !autoTonEnabled
    ? 'ручной тариф'
    : settings.ton_markup_mode === 'percent'
      ? `авто +${settings.ton_markup_pct || 15}%`
      : `авто +${formatUzs(settings.ton_markup_uzs || 2000)}`;

  const text = 
    `<b>Панель управления Nate Stars</b>\n\n` +
    `Текущие тарифы:\n` +
    `• 1 звезда: <b>${starPrice} сум</b>\n` +
    `• 1 TON: <b>${formatUzs(tonPrice)}</b> (${markupNote})\n` +
    `• Premium 3 мес: <b>${formatUzs(prem3)}</b>\n` +
    `• Premium 6 мес: <b>${formatUzs(prem6)}</b>\n` +
    `• Premium 12 мес: <b>${formatUzs(prem12)}</b>\n` +
    `• Карта для оплаты: <code>${card}</code>\n` +
    `• Группа заказов: <code>${group}</code>\n\n` +
    `<i>Вы также можете менять цены и наценку % прямо внутри Mini App во вкладке «Управление»!</i>`;

  ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📊 Прибыль', callback_data: 'admin_stats' },
          { text: '💰 Баланс TON', callback_data: 'admin_ton_balance' }
        ],
        [
          { text: '📣 Рассылка', callback_data: 'admin_broadcast' },
          { text: '📋 Ожидающие заказы', callback_data: 'view_pending_orders' }
        ],
        [
          { text: '🔄 Обновить курс TON', callback_data: 'refresh_ton_rate_bot' },
          { text: '📈 Наценка TON %', callback_data: 'edit_ton_markup_pct' }
        ],
        [
          { text: 'Цена за 1 звезду', callback_data: 'edit_star_price' },
          { text: 'Наценка фикс (сум)', callback_data: 'edit_ton_markup_uzs' }
        ],
        [
          { text: 'Premium 3м', callback_data: 'edit_prem_3' },
          { text: 'Premium 6м', callback_data: 'edit_prem_6' },
          { text: 'Premium 12м', callback_data: 'edit_prem_12' }
        ],
        [
          { text: 'Номер карты', callback_data: 'edit_card_number' },
          { text: 'Порог TON', callback_data: 'edit_low_ton' }
        ]
      ]
    }
  });
});

// Статистика прибыли в боте
bot.action('admin_stats', async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('Нет доступа');
  await ctx.answerCbQuery();
  const settings = dao.getAllSettings();
  const profitStats = dao.getProfitStats(settings);
  const threshold = Number(settings.low_ton_threshold || 5);
  const walletBalance = await FragmentService.getWalletBalance();
  await ctx.reply(formatProfitReportText(profitStats, walletBalance, threshold), { parse_mode: 'HTML' });
});

// Баланс TON кошелька в боте
bot.action('admin_ton_balance', async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('Нет доступа');
  await ctx.answerCbQuery();
  const settings = dao.getAllSettings();
  const threshold = Number(settings.low_ton_threshold || 5);
  const wallet = await FragmentService.getWalletBalance();
  const statusLine = !wallet.success
    ? `⚠️ Ошибка проверки: ${escapeHtml(wallet.error || 'сеть недоступна')}`
    : wallet.balance < threshold
      ? `⚠️ <b>Ниже порога (${threshold} TON)!</b> Пополните кошелёк.`
      : `✅ Баланс в норме (порог: ${threshold} TON)`;
  await ctx.reply(
    `💰 <b>Баланс кошелька Fragment</b>\n\n` +
    `• Остаток: <b>${wallet.success ? wallet.balanceFormatted : '—'}</b>\n` +
    `• Адрес: <code>${escapeHtml(wallet.address || '')}</code>\n` +
    `${statusLine}`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: 'Изменить порог TON', callback_data: 'edit_low_ton' }]]
      }
    }
  );
});

const pendingBotBroadcasts = new Map();

// Запуск рассылки из бота
bot.action('admin_broadcast', async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('Нет доступа');
  await ctx.answerCbQuery();
  const bStats = dao.getBroadcastStats();
  adminStates.set(userId, 'awaiting_broadcast_content');
  await ctx.reply(
    `📣 <b>Рассылка пользователям бота</b>\n\n` +
    `В базе: <b>${bStats.total}</b> чел. (доступно для отправки: <b>${bStats.active}</b>)\n\n` +
    `Отправьте следующим сообщением <b>текст</b> или <b>фото с подписью</b> для рассылки (поддерживается HTML-форматирование). Для отмены напишите <code>отмена</code>.`,
    { parse_mode: 'HTML' }
  );
});

bot.action('confirm_broadcast_bot', async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('Нет доступа');
  const payload = pendingBotBroadcasts.get(userId);
  if (!payload) return ctx.answerCbQuery('Черновик рассылки не найден или уже отправлен');
  pendingBotBroadcasts.delete(userId);

  await ctx.answerCbQuery('Рассылка запущена...');
  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    const statusMsg = await ctx.reply('⏳ Отправка сообщений пользователям...');
    const result = await runAdminBroadcast(payload);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `✅ <b>Рассылка завершена!</b>\n\n` +
      `• Всего в очереди: <b>${result.total}</b>\n` +
      `• Доставлено: <b>${result.sent}</b>\n` +
      `• Заблокировали бота: <b>${result.blocked}</b>\n` +
      `• Прочих ошибок: <b>${result.failed}</b>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  } catch (err) {
    await ctx.reply(`❌ Ошибка рассылки: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
});

bot.action('cancel_broadcast_bot', async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('Нет доступа');
  pendingBotBroadcasts.delete(userId);
  adminStates.delete(userId);
  await ctx.answerCbQuery('Рассылка отменена');
  await ctx.editMessageText('❌ Рассылка отменена.').catch(() => {});
});

bot.action('refresh_ton_rate_bot', async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('Нет доступа');
  await ctx.answerCbQuery('Обновляем курс TON...');
  try {
    const snap = await refreshTonRate({ force: true });
    await ctx.reply(
      `🔄 <b>Курс TON обновлён</b>\n\n` +
      `• Биржа TON/USD (${escapeHtml(snap.tonSource)}): <b>$${snap.tonUsd}</b>\n` +
      `• Курс ЦБ (${escapeHtml(snap.usdSource)}): <b>${snap.usdUzs} сум</b>\n` +
      `• Закуп (+${snap.providerSpreadPct}% Asterium): <b>${formatUzs(snap.purchaseCostUzs)}</b>\n` +
      `• Цена на витрине: <b>${formatUzs(snap.effectivePriceUzs)}</b>`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    await ctx.reply(`❌ Ошибка обновления курса: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
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
    case 'ton_price':
      adminStates.set(userId, 'set_ton_price');
      promptText = 'Введите новую цену за 1 TON в сумах (например: <code>14000</code>):';
      break;
    case 'ton_markup_pct':
      adminStates.set(userId, 'set_ton_markup_pct');
      promptText = 'Введите наценку на TON в <b>процентах %</b> поверх закупа (например: <code>15</code> или <code>18.5</code>):';
      break;
    case 'ton_markup_uzs':
      adminStates.set(userId, 'set_ton_markup_uzs');
      promptText = 'Введите фиксированную наценку на 1 TON в <b>сумах</b> (например: <code>2000</code>):';
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
    case 'low_ton':
      adminStates.set(userId, 'set_low_ton_threshold');
      promptText = 'Введите порог уведомления о низком балансе TON (например: <code>5</code> или <code>2.5</code>):';
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
    const desc = formatOrderItemDesc(order.type, order.amount);
    const msg = 
      `<b>Заказ #${escapeHtml(order.id)}</b>\n` +
      `Покупатель: ${escapeHtml(order.buyer_username)} (ID: <code>${order.telegram_id}</code>)\n` +
      `${order.type === 'ton' ? 'Кошелёк' : 'Получатель'}: <code>${escapeHtml(order.recipient_username)}</code>\n` +
      (order.ton_memo ? `Memo: <code>${escapeHtml(order.ton_memo)}</code>\n` : '') +
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

  const deliveryRes = fulfilled.fragment || { success: false, error: 'Не выполнен' };
  const isTon = order.type === 'ton';
  const providerLabel = isTon ? 'TON Transfer' : 'Fragment';
  const retryText = isTon ? '🔄 Повторить отправку TON' : '🔄 Повторить Fragment';
  let fragmentNote = '';
  let replyMarkup;
  let statusLine;

  if (deliveryRes.success) {
    statusLine = `✅ <b>ПОДТВЕРЖДЁН И ВЫДАН</b> (${escapeHtml(adminName)})`;
    fragmentNote = `\n⚡ <b>${providerLabel}:</b> ${escapeHtml(deliveryRes.message)}`;
    if (deliveryRes.txHash) fragmentNote += `\n🔗 <code>${escapeHtml(deliveryRes.txHash)}</code>`;
    replyMarkup = {
      inline_keyboard: [[{ text: '✅ Выполнен', callback_data: `done_${orderId}` }]]
    };
  } else {
    statusLine = `⏳ <b>ОПЛАТА ПОДТВЕРЖДЕНА, ОЖИДАЕТ ВЫДАЧИ</b> (${escapeHtml(adminName)})`;
    fragmentNote = `\n⚠️ <b>${providerLabel}:</b> ${escapeHtml(deliveryRes.error)}`;
    replyMarkup = {
      inline_keyboard: [[
        { text: retryText, callback_data: `retry_frag_${orderId}` },
        { text: '✅ Выдано вручную', callback_data: `manual_done_${orderId}` }
      ]]
    };
  }

  try {
    const originalText = ctx.callbackQuery.message.text || '';
    await ctx.editMessageText(
      originalText + `\n\n${statusLine}${fragmentNote}`,
      { parse_mode: 'HTML', reply_markup: replyMarkup }
    );
  } catch (e) {
    console.warn('Ошибка обновления сообщения заказа:', e.message);
  }
});

// 4.1 Повторная попытка отправки через Fragment (когда пополнили TON)
bot.action(/retry_frag_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('Нет доступа');

  const orderId = ctx.match[1];
  const order = dao.getOrder(orderId);
  if (!order) return ctx.answerCbQuery('Заказ не найден');
  if (order.status === 'confirmed') {
    await ctx.answerCbQuery('Заказ уже выполнен');
    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[{ text: '✅ Выполнен', callback_data: `done_${orderId}` }]]
      });
    } catch (e) {}
    return;
  }

  await ctx.answerCbQuery(order.type === 'ton' ? 'Пробуем отправить TON...' : 'Пробуем отправить через Fragment...');
  const adminName = ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name;
  const fulfilled = await fulfillOrder(orderId, {
    confirmedBy: adminName,
    source: 'retry',
    skipGroupNotice: true
  });

  const deliveryRes = fulfilled.fragment || { success: false, error: 'Ошибка отправки' };
  const doneHeader = order.type === 'ton' ? 'ВЫДАН В СЕТИ TON' : 'ВЫДАН ЧЕРЕЗ FRAGMENT';
  if (deliveryRes.success) {
    try {
      const originalText = ctx.callbackQuery.message.text || '';
      await ctx.editMessageText(
        originalText + `\n\n✅ <b>${doneHeader}</b> (${escapeHtml(adminName)})\n⚡ ${escapeHtml(deliveryRes.message)}` +
        (deliveryRes.txHash ? `\n🔗 <code>${escapeHtml(deliveryRes.txHash)}</code>` : ''),
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '✅ Выполнен', callback_data: `done_${orderId}` }]] }
        }
      );
    } catch (e) {}
  } else {
    try {
      await ctx.reply(`⚠️ Заказ <b>#${escapeHtml(orderId)}</b> пока не отправлен: ${escapeHtml(deliveryRes.error)}`, { parse_mode: 'HTML' });
    } catch (e) {}
  }
});

// 4.2 Отметка ручной выдачи (если админ выдал сам через fragment.com / Telegram)
bot.action(/manual_done_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return ctx.answerCbQuery('Нет доступа');

  const orderId = ctx.match[1];
  const adminName = ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name;
  const doneRes = await completeOrderManually(orderId);

  if (!doneRes.ok) {
    return ctx.answerCbQuery(doneRes.reason === 'already_confirmed' ? 'Уже выполнен' : 'Заказ не найден');
  }

  await ctx.answerCbQuery('Отмечено как выданное!');
  try {
    const originalText = ctx.callbackQuery.message.text || '';
    await ctx.editMessageText(
      originalText + `\n\n✅ <b>ВЫДАНО ВРУЧНУЮ</b> (${escapeHtml(adminName)})`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '✅ Выполнен', callback_data: `done_${orderId}` }]] }
      }
    );
  } catch (e) {}
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

// Обработка фото для рассылки админом
bot.on('photo', async (ctx, next) => {
  const userId = ctx.from.id;
  const state = adminStates.get(userId);
  if (state !== 'awaiting_broadcast_content' || !isAdmin(userId)) return next();

  adminStates.delete(userId);
  const photos = ctx.message.photo || [];
  const bestPhoto = photos[photos.length - 1];
  const caption = (ctx.message.caption || '').trim();
  const bStats = dao.getBroadcastStats();

  pendingBotBroadcasts.set(userId, {
    text: caption,
    photoFileId: bestPhoto?.file_id || null,
    includeOpenButton: true
  });

  await ctx.reply(
    `📣 <b>Предпросмотр рассылки с фото</b>\n` +
    `Получателей: <b>${bStats.active}</b> чел.\n\n` +
    `${caption ? escapeHtml(caption) : '<i>(без подписи)</i>'}`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: `✅ Отправить (${bStats.active} чел.)`, callback_data: 'confirm_broadcast_bot' }],
          [{ text: '❌ Отмена', callback_data: 'cancel_broadcast_bot' }]
        ]
      }
    }
  );
});

// Ввод текстовых данных админом
bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id;
  const state = adminStates.get(userId);

  if (!state || !isAdmin(userId)) return next();

  const text = ctx.message.text.trim();
  adminStates.delete(userId);

  if (state === 'awaiting_broadcast_content') {
    if (/^отмена$/i.test(text)) {
      pendingBotBroadcasts.delete(userId);
      return ctx.reply('❌ Рассылка отменена.');
    }
    const bStats = dao.getBroadcastStats();
    pendingBotBroadcasts.set(userId, {
      text,
      photoFileId: null,
      includeOpenButton: true
    });
    return ctx.reply(
      `📣 <b>Предпросмотр рассылки</b>\n` +
      `Получателей: <b>${bStats.active}</b> чел.\n\n` +
      `${escapeHtml(text)}`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: `✅ Отправить (${bStats.active} чел.)`, callback_data: 'confirm_broadcast_bot' }],
            [{ text: '❌ Отмена', callback_data: 'cancel_broadcast_bot' }]
          ]
        }
      }
    );
  }

  switch (state) {
    case 'set_star_price': {
      const num = parseInt(text.replace(/\s+/g, ''), 10);
      if (isNaN(num) || num <= 0) return ctx.reply('Введите положительное число.');
      dao.setSetting('star_price_uzs', String(num));
      return ctx.reply(`Цена за 1 звезду сохранена: <b>${num} сум</b>`, { parse_mode: 'HTML' });
    }
    case 'set_ton_price': {
      const num = parseInt(text.replace(/\s+/g, ''), 10);
      if (isNaN(num) || num <= 0) return ctx.reply('Введите положительное число.');
      dao.setSetting('ton_auto_rate_enabled', 'false');
      dao.setSetting('ton_price_uzs', String(num));
      return ctx.reply(`Цена за 1 TON (ручной режим): <b>${formatUzs(num)}</b>`, { parse_mode: 'HTML' });
    }
    case 'set_ton_markup_pct': {
      const val = parseFloat(text.replace(',', '.'));
      if (isNaN(val) || val < 0 || val > 500) return ctx.reply('Введите процент от 0 до 500 (например: 15).');
      dao.setSetting('ton_auto_rate_enabled', 'true');
      dao.setSetting('ton_markup_mode', 'percent');
      dao.setSetting('ton_markup_pct', String(val));
      const snap = await refreshTonRate({ force: true }).catch(() => null);
      const priceNote = snap ? ` (новая цена: <b>${formatUzs(snap.effectivePriceUzs)}</b>)` : '';
      return ctx.reply(`Включена авто-наценка <b>+${val}%</b> к закупу TON${priceNote}`, { parse_mode: 'HTML' });
    }
    case 'set_ton_markup_uzs': {
      const num = parseInt(text.replace(/\s+/g, ''), 10);
      if (isNaN(num) || num < 0) return ctx.reply('Введите число в сумах (например: 2000).');
      dao.setSetting('ton_auto_rate_enabled', 'true');
      dao.setSetting('ton_markup_mode', 'fixed');
      dao.setSetting('ton_markup_uzs', String(num));
      const snap = await refreshTonRate({ force: true }).catch(() => null);
      const priceNote = snap ? ` (новая цена: <b>${formatUzs(snap.effectivePriceUzs)}</b>)` : '';
      return ctx.reply(`Включена фикс. авто-наценка <b>+${formatUzs(num)}</b> на 1 TON${priceNote}`, { parse_mode: 'HTML' });
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
    case 'set_low_ton_threshold': {
      const val = parseFloat(text.replace(',', '.'));
      if (isNaN(val) || val < 0.5) return ctx.reply('Введите число не меньше 0.5 (например: 5).');
      dao.setSetting('low_ton_threshold', String(val));
      dao.setSetting('last_low_ton_alert_at', '0');
      return ctx.reply(`Порог уведомления о низком TON сохранён: <b>${val} TON</b>`, { parse_mode: 'HTML' });
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
let tonMonitorTimer = null;
let tonRateTimer = null;

async function start() {
  try {
    await initDatabase();
    console.log('💾 База данных готова');

    // Первичное обновление автокурса TON до открытия витрины (таймаут 4 сек)
    await Promise.race([
      refreshTonRate({ force: true }).then(s => {
        console.log(`💱 Автокурс TON: $${s.tonUsd} × ${s.usdUzs} (+${s.providerSpreadPct}% = ${s.purchaseCostUzs}) -> ${s.effectivePriceUzs} сум`);
      }),
      new Promise(resolve => setTimeout(resolve, 4000))
    ]).catch(err => console.warn('⚠️ Первичное обновление курса TON:', err.message));

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

    // Мониторинг остатка TON на кошельке Fragment (при старте и каждые 10 минут)
    setTimeout(() => {
      checkLowTonBalanceAndNotify().catch(() => {});
    }, 15000);
    tonMonitorTimer = setInterval(() => {
      checkLowTonBalanceAndNotify().catch(() => {});
    }, 10 * 60 * 1000);

    // Автообновление рыночного курса TON каждые 5 минут
    tonRateTimer = setInterval(() => {
      refreshTonRate().catch(err => console.warn('⚠️ Автокурс TON:', err.message));
    }, 5 * 60 * 1000);

    console.log(`\n🎉 Всё готово! Бот: https://t.me/${botInfo.username}\n`);

  } catch (err) {
    console.error('❌ Ошибка запуска:', err);
    process.exit(1);
  }
}

async function shutdown() {
  console.log('\nОстановка сервисов...');
  if (tonMonitorTimer) clearInterval(tonMonitorTimer);
  if (tonRateTimer) clearInterval(tonRateTimer);
  await CardXabarService.stopListenerOnly();
  if (tunnelProc) tunnelProc.kill();
  bot.stop();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

start();
