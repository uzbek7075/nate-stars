/**
 * Nate Stars — App Controller (Clean Vector UI Edition)
 */

const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
  try {
    tg.setHeaderColor('#090C15');
    tg.setBackgroundColor('#090C15');
  } catch (e) {}
}

// ===== Состояние =====
let currentTab = 'stars';
let catalog = {
  starPriceUzs: 220,
  minStars: 50,
  cardNumber: '5614681816265841',
  cardHolder: 'Uzcard / Humo (любой банк Узбекистана)',
  premium3Uzs: 175000,
  premium6Uzs: 245000,
  premium12Uzs: 395000,
  autoConfirmEnabled: false
};

let starsAmount = 100;
let pendingOrder = null;
let orderPollTimer = null;
let cxQrPollTimer = null;
let cachedCxStatus = null;

// ===== Инициализация =====
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  const currentTgId = tg?.initDataUnsafe?.user?.id;

  if (tg?.initDataUnsafe?.user) {
    const user = tg.initDataUnsafe.user;
    const nameEl = document.getElementById('userName');
    if (nameEl) nameEl.textContent = user.first_name || 'Клиент';

    const recipientInput = document.getElementById('recipientInput');
    if (recipientInput) {
      if (user.username) {
        recipientInput.value = user.username;
      }
      recipientInput.addEventListener('input', () => {
        if (recipientInput.value.startsWith('@')) {
          recipientInput.value = recipientInput.value.replace(/^@+/, '');
        }
      });
    }
  }

  // Проверяем статус администратора
  try {
    const userData = await API.getUser();
    if (userData.isAdmin || currentTgId === 5379376281) {
      const adminBtn = document.getElementById('adminTabBtn');
      if (adminBtn) adminBtn.style.display = 'flex';
    }
  } catch (e) {
    if (currentTgId === 5379376281) {
      const adminBtn = document.getElementById('adminTabBtn');
      if (adminBtn) adminBtn.style.display = 'flex';
    }
  }

  await loadCatalog();
  updateStarsCalc();

  const autoConfirmSel = document.getElementById('settingAutoConfirmEnabled');
  if (autoConfirmSel) {
    autoConfirmSel.addEventListener('change', async () => {
      try {
        const val = autoConfirmSel.value === 'true';
        await API.updateAdminSettings({ autoConfirmEnabled: val });
        Helpers.haptic('success');
        Helpers.showToast(val ? 'Автооплата CardXabar включена' : 'Включено ручное подтверждение');
        await loadCatalog();
      } catch (e) {
        Helpers.showToast('Ошибка переключения: ' + e.message);
      }
    });
  }
}

async function loadCatalog() {
  try {
    const data = await API.getCatalog();
    catalog = { ...catalog, ...data };
    applyCatalogToUI();
  } catch (err) {
    console.warn('Использованы базовые тарифы:', err.message);
    applyCatalogToUI();
  }
}

function applyCatalogToUI() {
  const rateBadge = document.getElementById('rateBadge');
  if (rateBadge) {
    rateBadge.textContent = `1 ★ = ${catalog.starPriceUzs} сум`;
  }

  const p3 = document.getElementById('prem3Price');
  const p6 = document.getElementById('prem6Price');
  const p12 = document.getElementById('prem12Price');

  if (p3) p3.textContent = Helpers.formatUzs(catalog.premium3Uzs);
  if (p6) p6.textContent = Helpers.formatUzs(catalog.premium6Uzs);
  if (p12) p12.textContent = Helpers.formatUzs(catalog.premium12Uzs);

  const pm3 = document.getElementById('prem3PerMonth');
  const pm6 = document.getElementById('prem6PerMonth');
  const pm12 = document.getElementById('prem12PerMonth');

  if (pm3) pm3.textContent = `~${Helpers.formatUzs(Math.round(catalog.premium3Uzs / 3))} / мес`;
  if (pm6) pm6.textContent = `~${Helpers.formatUzs(Math.round(catalog.premium6Uzs / 6))} / мес`;
  if (pm12) pm12.textContent = `~${Helpers.formatUzs(Math.round(catalog.premium12Uzs / 12))} / мес`;

  updateStarsCalc();
}

// ===== Калькулятор звёзд =====

function setStars(amount) {
  Helpers.haptic('light');
  starsAmount = Math.max(catalog.minStars, amount);
  const input = document.getElementById('starsAmountInput');
  if (input) input.value = starsAmount;

  document.querySelectorAll('.preset-pill').forEach(btn => {
    const btnVal = parseInt(btn.textContent.replace(/\s+/g, ''), 10);
    btn.classList.toggle('active', btnVal === amount);
  });

  updateStarsCalc();
}

function adjustStars(diff) {
  Helpers.haptic('light');
  starsAmount = Math.max(catalog.minStars, starsAmount + diff);
  const input = document.getElementById('starsAmountInput');
  if (input) input.value = starsAmount;

  document.querySelectorAll('.preset-pill').forEach(btn => {
    const btnVal = parseInt(btn.textContent.replace(/\s+/g, ''), 10);
    btn.classList.toggle('active', btnVal === starsAmount);
  });

  updateStarsCalc();
}

function onStarsInputChange() {
  const input = document.getElementById('starsAmountInput');
  if (!input) return;

  let val = parseInt(input.value, 10);
  if (isNaN(val) || val < 1) val = catalog.minStars;
  starsAmount = val;

  document.querySelectorAll('.preset-pill').forEach(btn => {
    const btnVal = parseInt(btn.textContent.replace(/\s+/g, ''), 10);
    btn.classList.toggle('active', btnVal === starsAmount);
  });

  updateStarsCalc();
}

function updateStarsCalc() {
  const price = starsAmount * catalog.starPriceUzs;
  const priceEl = document.getElementById('starsPriceText');
  if (priceEl) {
    priceEl.textContent = Helpers.formatUzs(price);
  }
}

function getRecipient() {
  const input = document.getElementById('recipientInput');
  let val = input ? input.value.trim() : '';
  val = val.replace(/^@+/, '');
  return val;
}

// ===== Чекаут =====

async function startCheckoutFlow(type, amount, fallbackPrice, itemDesc, recipient) {
  pendingOrder = {
    id: null,
    type,
    amount,
    priceUzs: fallbackPrice,
    itemDesc,
    recipient: '@' + recipient,
    autoConfirm: Boolean(catalog.autoConfirmEnabled)
  };

  try {
    const prep = await API.prepareOrder({
      recipientUsername: '@' + recipient,
      type,
      amount
    });
    if (prep && prep.order) {
      pendingOrder.id = prep.order.id;
      pendingOrder.priceUzs = prep.order.priceUzs;
      pendingOrder.autoConfirm = Boolean(prep.autoConfirm);
    }
  } catch (err) {
    console.warn('Fallback локальной суммы (prepareOrder):', err.message);
  }

  showCheckoutModal();
}

function openStarsCheckout() {
  const recipient = getRecipient();
  if (!recipient) {
    Helpers.haptic('error');
    Helpers.showToast('Укажите @username получателя');
    const input = document.getElementById('recipientInput');
    if (input) input.focus();
    return;
  }

  if (starsAmount < catalog.minStars) {
    Helpers.showToast(`Минимальный заказ: ${catalog.minStars} звёзд`);
    return;
  }

  const price = starsAmount * catalog.starPriceUzs;
  startCheckoutFlow('stars', starsAmount, price, `${starsAmount} Telegram Stars`, recipient);
}

function openPremiumCheckout(months) {
  const recipient = getRecipient();
  if (!recipient) {
    Helpers.haptic('error');
    Helpers.showToast('Укажите @username получателя');
    const input = document.getElementById('recipientInput');
    if (input) input.focus();
    return;
  }

  let price = catalog.premium3Uzs;
  if (months === 6) price = catalog.premium6Uzs;
  if (months === 12) price = catalog.premium12Uzs;

  startCheckoutFlow('premium', months, price, `Telegram Premium на ${months} мес.`, recipient);
}

function showCheckoutModal() {
  Helpers.haptic('medium');

  document.getElementById('modalItemDesc').textContent = pendingOrder.itemDesc;
  document.getElementById('modalRecipient').textContent = pendingOrder.recipient;
  document.getElementById('modalPrice').textContent = Helpers.formatUzs(pendingOrder.priceUzs);
  document.getElementById('modalCardNumber').textContent = Helpers.formatCardNumber(catalog.cardNumber);
  document.getElementById('modalCardHolder').textContent = catalog.cardHolder;
  document.getElementById('senderCommentInput').value = '';

  const autoBanner = document.getElementById('autoPayNotice');
  const autoSumEl = document.getElementById('autoPayExactSum');
  if (autoBanner) {
    if (pendingOrder.autoConfirm) {
      autoBanner.style.display = 'block';
      if (autoSumEl) autoSumEl.textContent = Helpers.formatUzs(pendingOrder.priceUzs);
    } else {
      autoBanner.style.display = 'none';
    }
  }

  const modal = document.getElementById('checkoutModal');
  if (modal) modal.classList.add('show');

  if (pendingOrder.id && pendingOrder.autoConfirm) {
    startOrderStatusPolling(pendingOrder.id);
  }
}

function stopOrderStatusPolling() {
  if (orderPollTimer) {
    clearInterval(orderPollTimer);
    orderPollTimer = null;
  }
}

function startOrderStatusPolling(orderId) {
  stopOrderStatusPolling();
  orderPollTimer = setInterval(async () => {
    try {
      const st = await API.getOrderStatus(orderId);
      if (st && st.status === 'confirmed') {
        stopOrderStatusPolling();
        showSuccessState({
          id: st.id,
          itemDescription: pendingOrder?.itemDesc || 'Ваш заказ',
          recipientUsername: pendingOrder?.recipient || '',
          priceUzs: st.priceUzs || pendingOrder?.priceUzs || 0,
          autoConfirmed: true
        });
      }
    } catch (e) {
      // Тихо игнорируем временный сетевой сбой поллинга
    }
  }, 3500);
}

function showSuccessState({ id, itemDescription, recipientUsername, priceUzs, autoConfirmed }) {
  const checkoutModal = document.getElementById('checkoutModal');
  if (checkoutModal) checkoutModal.classList.remove('show');

  document.getElementById('successOrderId').textContent = '#' + id;
  document.getElementById('successItem').textContent = itemDescription;
  document.getElementById('successRecipient').textContent = recipientUsername;
  document.getElementById('successPrice').textContent = Helpers.formatUzs(priceUzs);

  const titleEl = document.getElementById('successTitle');
  const descEl = document.getElementById('successDescription');
  const noticeEl = document.getElementById('successNotice');

  if (autoConfirmed) {
    if (titleEl) titleEl.textContent = '✅ Оплата получена! Заказ выполнен';
    if (descEl) {
      descEl.innerHTML = `Заказ <span class="order-mono-id">#${id}</span> подтверждён автоматически — товар отправлен!`;
    }
    if (noticeEl) noticeEl.textContent = 'Чек и статус уже отправлены вам в чат бота.';
  } else {
    if (titleEl) titleEl.textContent = 'Заказ передан на проверку';
    if (descEl) {
      descEl.innerHTML = `Номер заказа <span class="order-mono-id">#${id}</span>. Оплата проверяется автоматически.`;
    }
    if (noticeEl) noticeEl.textContent = 'Как только поступление отобразится в CardXabar, заказ выполнится сам.';
  }

  const successModal = document.getElementById('successModal');
  if (successModal) successModal.classList.add('show');
  Helpers.haptic('success');
}

function closeCheckout() {
  stopOrderStatusPolling();
  const modal = document.getElementById('checkoutModal');
  if (modal) modal.classList.remove('show');
  pendingOrder = null;
}

function copyCardNumber() {
  const cleanCard = catalog.cardNumber.replace(/\s+/g, '');
  Helpers.copyText(cleanCard, 'Номер карты скопирован');
}

function copyOrderPrice() {
  if (!pendingOrder) return;
  Helpers.copyText(String(pendingOrder.priceUzs), `Сумма ${Helpers.formatUzs(pendingOrder.priceUzs)} скопирована`);
}

async function submitPayment() {
  if (!pendingOrder) return;

  const btn = document.getElementById('confirmPayBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>Проверка...</span>';
  }

  const senderComment = document.getElementById('senderCommentInput')?.value?.trim() || '';

  try {
    let res;
    if (pendingOrder.id) {
      res = await API.markOrderPaid(pendingOrder.id, senderComment);
      res.order = {
        ...res.order,
        itemDescription: pendingOrder.itemDesc,
        priceUzs: res.order.price_uzs || pendingOrder.priceUzs,
        recipientUsername: res.order.recipient_username || pendingOrder.recipient
      };
    } else {
      res = await API.createOrder({
        recipientUsername: pendingOrder.recipient,
        type: pendingOrder.type,
        amount: pendingOrder.amount,
        senderComment
      });
    }

    const isConfirmed = Boolean(res.alreadyConfirmed || res.order?.status === 'confirmed');
    showSuccessState({
      id: res.order.id,
      itemDescription: res.order.itemDescription,
      recipientUsername: res.order.recipientUsername,
      priceUzs: res.order.priceUzs,
      autoConfirmed: isConfirmed
    });

    if (!isConfirmed && pendingOrder.autoConfirm) {
      startOrderStatusPolling(res.order.id);
    } else {
      stopOrderStatusPolling();
    }

  } catch (err) {
    Helpers.haptic('error');
    Helpers.showToast(err.message || 'Ошибка оформления заказа');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<span>Я оплатил</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>`;
    }
  }
}

function closeSuccessModal() {
  stopOrderStatusPolling();
  pendingOrder = null;
  const modal = document.getElementById('successModal');
  if (modal) modal.classList.remove('show');
  switchTab('orders');
}

// ===== Вкладки =====

function switchTab(tab) {
  if (tab === currentTab) return;
  Helpers.haptic('light');
  currentTab = tab;

  document.querySelectorAll('.segment-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tab}`);
  });

  if (tab !== 'admin') {
    stopCxQrPolling();
  }

  if (tab === 'orders') {
    loadOrders();
  } else if (tab === 'admin') {
    loadAdminInfo();
  }
}

async function loadOrders() {
  const container = document.getElementById('ordersContainer');
  if (!container) return;

  container.innerHTML = '<div class="loader-wrap"><div class="clean-spinner"></div></div>';

  try {
    const data = await API.getOrders();
    const orders = data.orders || [];

    if (orders.length === 0) {
      container.innerHTML = `
        <div class="empty-state-box">
          <div class="empty-state-title">Заказов пока нет</div>
          <div class="empty-state-sub">Оформленные покупки появятся здесь</div>
        </div>
      `;
      return;
    }

    container.innerHTML = orders.map(o => {
      const itemDesc = o.type === 'stars' ? `${o.amount} Stars` : `Premium ${o.amount} мес.`;
      return `
        <div class="order-entry">
          <div class="order-top">
            <span class="order-code">#${o.id}</span>
            ${Helpers.statusBadge(o.status)}
          </div>
          <div class="order-data-grid">
            <div>
              <span class="order-field-label">Товар</span>
              <div class="order-field-val">${itemDesc}</div>
            </div>
            <div>
              <span class="order-field-label">Сумма</span>
              <div class="order-field-val">${Helpers.formatUzs(o.price_uzs)}</div>
            </div>
            <div>
              <span class="order-field-label">Получатель</span>
              <div class="order-field-val text-accent">${o.recipient_username}</div>
            </div>
            <div>
              <span class="order-field-label">Дата</span>
              <div class="order-field-val">${Helpers.formatDate(o.created_at)}</div>
            </div>
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    container.innerHTML = `
      <div class="empty-state-box">
        <div class="empty-state-title">Ошибка загрузки</div>
        <div class="empty-state-sub">Не удалось получить список заказов</div>
      </div>
    `;
  }
}


// ===== Панель управления (Admin) =====

async function loadAdminInfo() {
  const pendingContainer = document.getElementById('adminPendingOrdersList');
  if (pendingContainer) {
    pendingContainer.innerHTML = '<div class="loader-wrap"><div class="clean-spinner"></div></div>';
  }

  try {
    const data = await API.getAdminInfo();
    const { settings, stats, pendingOrders } = data;

    // Метрики
    const totalEl = document.getElementById('adminMetricTotal');
    const pendEl = document.getElementById('adminMetricPending');
    const revEl = document.getElementById('adminMetricRevenue');

    if (totalEl) totalEl.textContent = stats.total || 0;
    if (pendEl) pendEl.textContent = stats.pending || 0;
    if (revEl) revEl.textContent = Helpers.formatUzs(stats.revenue || 0);

    // Поля настроек
    const sStar = document.getElementById('settingStarPrice');
    const sPrem3 = document.getElementById('settingPrem3');
    const sPrem6 = document.getElementById('settingPrem6');
    const sPrem12 = document.getElementById('settingPrem12');
    const sCard = document.getElementById('settingCardNumber');
    const sGroup = document.getElementById('settingOrdersGroup');

    if (sStar) sStar.value = settings.star_price_uzs || 220;
    if (sPrem3) sPrem3.value = settings.premium_3_uzs || 175000;
    if (sPrem6) sPrem6.value = settings.premium_6_uzs || 245000;
    if (sPrem12) sPrem12.value = settings.premium_12_uzs || 395000;
    if (sCard) sCard.value = settings.card_number || '5614681816265841';
    if (sGroup) sGroup.value = settings.orders_chat_id || '';

    // Настройки Fragment
    const fragConfig = data.fragmentConfig || {};
    const fEnabled = document.getElementById('settingFragmentEnabled');
    const fPhone = document.getElementById('settingFragmentPhone');
    const fMnemonics = document.getElementById('settingFragmentMnemonics');
    const fApiKey = document.getElementById('settingFragmentApiKey');
    const fBadge = document.getElementById('fragmentStatusBadge');

    if (fEnabled) fEnabled.value = fragConfig.enabled ? 'true' : 'false';
    if (fPhone && fragConfig.phone) fPhone.value = fragConfig.phone;
    if (fMnemonics && fragConfig.mnemonics) fMnemonics.value = fragConfig.mnemonics;
    if (fApiKey && fragConfig.apiKey) fApiKey.value = fragConfig.apiKey;

    if (fBadge) {
      if (fragConfig.hasToken || fragConfig.hasSeed) {
        fBadge.textContent = '✅ Авторизован';
        fBadge.className = 'status-badge-clean confirmed';
      } else {
        fBadge.textContent = '⚠️ Не авторизован';
        fBadge.className = 'status-badge-clean pending';
      }
    }

    // Статус CardXabar
    renderCardXabarStatus(data.cardXabarStatus || {});

    // Ожидающие заказы
    if (pendingContainer) {
      if (!pendingOrders || pendingOrders.length === 0) {
        pendingContainer.innerHTML = `
          <div class="empty-state-box">
            <div class="empty-state-title">Нет ожидающих заказов</div>
            <div class="empty-state-sub">Все новые заказы будут появляться здесь и в группе</div>
          </div>
        `;
      } else {
        pendingContainer.innerHTML = pendingOrders.map(o => {
          const itemDesc = o.type === 'stars' ? `${o.amount} Stars` : `Premium ${o.amount} мес.`;
          return `
            <div class="admin-order-card" id="admin-order-${o.id}">
              <div class="order-top">
                <span class="order-code">#${o.id}</span>
                ${Helpers.statusBadge(o.status)}
              </div>
              <div class="order-data-grid">
                <div>
                  <span class="order-field-label">Товар</span>
                  <div class="order-field-val">${itemDesc}</div>
                </div>
                <div>
                  <span class="order-field-label">Сумма</span>
                  <div class="order-field-val">${Helpers.formatUzs(o.price_uzs)}</div>
                </div>
                <div>
                  <span class="order-field-label">Получатель</span>
                  <div class="order-field-val text-accent">${o.recipient_username}</div>
                </div>
                <div>
                  <span class="order-field-label">Покупатель</span>
                  <div class="order-field-val">${o.buyer_username}</div>
                </div>
              </div>
              ${o.sender_comment ? `<div class="order-field-label">Чек: <span style="color:#fff">${o.sender_comment}</span></div>` : ''}
              <div class="admin-actions-row" id="actions-row-${o.id}">
                <button class="action-btn-confirm" onclick="promptAdminOrder('${o.id}', 'confirm', '${o.recipient_username}', '${itemDesc}')">
                  Подтвердить
                </button>
                <button class="action-btn-reject" onclick="promptAdminOrder('${o.id}', 'reject', '${o.recipient_username}', '${itemDesc}')">
                  Отклонить
                </button>
              </div>
            </div>
          `;
        }).join('');
      }
    }

  } catch (err) {
    Helpers.showToast('Ошибка загрузки данных админки');
    if (pendingContainer) {
      pendingContainer.innerHTML = `
        <div class="empty-state-box">
          <div class="empty-state-title">Доступ ограничен</div>
          <div class="empty-state-sub">Панель доступна только для аккаунта ID 5379376281</div>
        </div>
      `;
    }
  }
}

// ===== Управление CardXabar (@CardXabarBot) =====

function stopCxQrPolling() {
  if (cxQrPollTimer) {
    clearInterval(cxQrPollTimer);
    cxQrPollTimer = null;
  }
}

function startCxQrPolling() {
  stopCxQrPolling();
  cxQrPollTimer = setInterval(async () => {
    try {
      const cx = await API.getCardXabarStatus();
      renderCardXabarStatus(cx);
      if (cx.connected || cx.authStep === 'connected' || cx.authStep === 'waiting_password' || cx.authStep === 'error') {
        stopCxQrPolling();
        if (cx.connected) {
          Helpers.haptic('success');
          Helpers.showToast('✅ @CardXabarBot успешно подключён!');
          await loadCatalog();
        }
      }
    } catch (e) {}
  }, 2500);
}

function renderCardXabarStatus(cx) {
  if (!cx) return;
  cachedCxStatus = cx;

  const badge = document.getElementById('cxStatusBadge');
  const autoSelect = document.getElementById('settingAutoConfirmEnabled');
  const connectedBox = document.getElementById('cxConnectedBox');
  const setupBox = document.getElementById('cxSetupBox');
  const accLabel = document.getElementById('cxAccountLabel');
  const botResolved = document.getElementById('cxBotResolvedBadge');
  const apiIdInput = document.getElementById('cxApiId');
  const phoneInput = document.getElementById('cxPhone');
  const codeBox = document.getElementById('cxCodeBox');
  const qrBox = document.getElementById('cxQrBox');
  const qrImg = document.getElementById('cxQrImg');
  const passBox = document.getElementById('cxPasswordBox');
  const passHint = document.getElementById('cxPasswordHint');
  const errBox = document.getElementById('cxErrorBox');
  const logsBox = document.getElementById('cxRecentLogs');

  if (autoSelect) autoSelect.value = cx.autoConfirmEnabled ? 'true' : 'false';
  if (apiIdInput && cx.apiId && !apiIdInput.value) apiIdInput.value = cx.apiId;
  if (phoneInput && cx.phone && !phoneInput.value) phoneInput.value = cx.phone;

  if (badge) {
    if (cx.connected) {
      badge.textContent = '✅ Слушает 24/7';
      badge.className = 'status-badge-clean confirmed';
    } else if (cx.authStep === 'waiting_code' || cx.authStep === 'waiting_qr' || cx.authStep === 'waiting_password') {
      badge.textContent = '⏳ Вход...';
      badge.className = 'status-badge-clean pending';
    } else {
      badge.textContent = 'Не подключён';
      badge.className = 'status-badge-clean pending';
    }
  }

  if (connectedBox) connectedBox.style.display = cx.connected ? 'block' : 'none';
  if (setupBox) setupBox.style.display = cx.connected ? 'none' : 'block';

  if (accLabel) accLabel.textContent = cx.userLabel || 'Telegram активен';
  if (botResolved) {
    botResolved.textContent = cx.cardXabarResolved ? '@CardXabarBot найден' : 'Ожидаем @CardXabarBot';
    botResolved.className = cx.cardXabarResolved ? 'status-badge-clean confirmed' : 'status-badge-clean pending';
  }

  if (codeBox) codeBox.style.display = cx.authStep === 'waiting_code' ? 'block' : 'none';
  if (qrBox) {
    qrBox.style.display = cx.authStep === 'waiting_qr' && cx.qrDataUrl ? 'block' : 'none';
    if (qrImg && cx.qrDataUrl) qrImg.src = cx.qrDataUrl;
  }
  if (passBox) {
    passBox.style.display = cx.authStep === 'waiting_password' ? 'block' : 'none';
    if (passHint) passHint.textContent = cx.passwordHint ? `(подсказка: ${cx.passwordHint})` : '';
  }

  if (errBox) {
    if (cx.lastError) {
      errBox.style.display = 'block';
      errBox.textContent = '⚠️ ' + cx.lastError;
    } else {
      errBox.style.display = 'none';
    }
  }

  if (logsBox) {
    const logs = cx.recentLogs || [];
    if (logs.length === 0) {
      logsBox.innerHTML = '';
    } else {
      logsBox.innerHTML = `<div class="order-field-label" style="margin-bottom:2px;">Последние чеки CardXabar</div>` +
        logs.map(l => `
          <div class="cx-log-row">
            <span>+${Helpers.formatUzs(l.amount)} (***${l.card_last4 || '----'})</span>
            <span style="color:${l.order_id ? 'var(--ok)' : 'var(--text-soft)'}; font-family:var(--font-mono);">
              ${l.order_id ? '#' + l.order_id : 'Без заказа'}
            </span>
          </div>
        `).join('');
    }
  }
}

async function startCardXabarPhoneAuth() {
  const apiId = document.getElementById('cxApiId')?.value?.trim();
  const apiHash = document.getElementById('cxApiHash')?.value?.trim();
  const phone = document.getElementById('cxPhone')?.value?.trim();
  const btn = document.getElementById('cxSendCodeBtn');

  if (!apiId || !apiHash || !phone) {
    Helpers.haptic('error');
    return Helpers.showToast('Укажите API ID, API Hash и номер телефона');
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Отправка...</span>';
  }

  try {
    const res = await API.cardXabarAuthPhone({ apiId, apiHash, phone });
    Helpers.haptic('success');
    Helpers.showToast(res.message || 'Код отправлен!');
    const st = await API.getCardXabarStatus();
    renderCardXabarStatus(st);
  } catch (err) {
    Helpers.haptic('error');
    Helpers.showToast(err.message || 'Ошибка отправки кода');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>📱 Войти по коду</span>';
    }
  }
}

async function submitCardXabarCode() {
  const code = document.getElementById('cxCodeInput')?.value?.trim();
  if (!code) {
    Helpers.haptic('error');
    return Helpers.showToast('Введите код');
  }
  try {
    const res = await API.cardXabarAuthCode(code);
    if (res.needsPassword) {
      Helpers.showToast(res.message || 'Введите облачный пароль 2FA');
    } else {
      Helpers.haptic('success');
      Helpers.showToast('✅ @CardXabarBot подключён!');
      await loadCatalog();
    }
    const st = await API.getCardXabarStatus();
    renderCardXabarStatus(st);
  } catch (err) {
    Helpers.haptic('error');
    Helpers.showToast(err.message || 'Неверный код');
  }
}

async function startCardXabarQrAuth() {
  const apiId = document.getElementById('cxApiId')?.value?.trim();
  const apiHash = document.getElementById('cxApiHash')?.value?.trim();
  const btn = document.getElementById('cxQrBtn');

  if (!apiId || !apiHash) {
    Helpers.haptic('error');
    return Helpers.showToast('Сначала укажите API ID и API Hash');
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Создание QR...</span>';
  }

  try {
    await API.cardXabarAuthQr({ apiId, apiHash });
    const st = await API.getCardXabarStatus();
    renderCardXabarStatus(st);
    startCxQrPolling();
    Helpers.showToast('Отсканируйте QR в Telegram → Устройства');
  } catch (err) {
    Helpers.haptic('error');
    Helpers.showToast(err.message || 'Ошибка создания QR');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>📷 По QR-коду</span>';
    }
  }
}

async function submitCardXabarPassword() {
  const pwd = document.getElementById('cxPasswordInput')?.value;
  if (!pwd) return Helpers.showToast('Введите пароль 2FA');

  try {
    await API.cardXabarAuthPassword(pwd);
    Helpers.haptic('success');
    Helpers.showToast('✅ @CardXabarBot подключён!');
    stopCxQrPolling();
    const st = await API.getCardXabarStatus();
    renderCardXabarStatus(st);
    await loadCatalog();
  } catch (err) {
    Helpers.haptic('error');
    Helpers.showToast(err.message || 'Ошибка пароля 2FA');
  }
}

async function copyCardXabarSession() {
  try {
    const data = await API.exportCardXabarSession();
    const envBlock = `TG_API_ID=${data.apiId}\nTG_API_HASH=${data.apiHash}\nTG_SESSION=${data.sessionString}`;
    Helpers.copyText(envBlock, 'Переменные для Render скопированы!');
  } catch (err) {
    Helpers.showToast('Ошибка экспорта: ' + err.message);
  }
}

async function disconnectCardXabar() {
  try {
    await API.cardXabarDisconnect();
    Helpers.showToast('Слушатель отключён');
    const st = await API.getCardXabarStatus();
    renderCardXabarStatus(st);
    await loadCatalog();
  } catch (err) {
    Helpers.showToast(err.message || 'Ошибка отключения');
  }
}

// Генерация нового чистого кошелька TON на 24 слова
async function generateWalletInApp() {
  const btn = document.getElementById('genWalletBtn');
  const textarea = document.getElementById('settingFragmentMnemonics');

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Генерация 24 слов...</span>';
  }

  try {
    const res = await API.generateTonWallet();
    if (res.mnemonics) {
      if (textarea) textarea.value = res.mnemonics;

      // Копируем в буфер для удобства
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(res.mnemonics).catch(() => {});
      }

      Helpers.haptic('success');
      Helpers.showToast('✅ Создан валидный кошелёк (24 слова скопированы в буфер!)');
    }
  } catch (err) {
    Helpers.haptic('error');
    Helpers.showToast('Ошибка создания кошелька: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>⚡ Сгенерировать чистый кошелёк (24 слова)</span>';
    }
  }
}

// Запуск авторизации Fragment через API
async function startFragmentAuth() {
  const btn = document.getElementById('startAuthFragmentBtn');
  const phone = document.getElementById('settingFragmentPhone')?.value?.trim();
  const mnemonics = document.getElementById('settingFragmentMnemonics')?.value?.trim();
  const apiKey = document.getElementById('settingFragmentApiKey')?.value?.trim();

  if (!phone) {
    Helpers.haptic('error');
    return Helpers.showToast('Введите номер телефона (+998...)');
  }
  if (!mnemonics) {
    Helpers.haptic('error');
    return Helpers.showToast('Введите seed-фразу (24 слова)');
  }

  const words = mnemonics.split(/\s+/).filter(Boolean);
  if (words.length !== 24) {
    Helpers.haptic('error');
    return Helpers.showToast(`Требуется ровно 24 слова (сейчас: ${words.length}). Tonkeeper: Настройки -> Резервная копия`);
  }

  if (!apiKey) {
    Helpers.haptic('error');
    return Helpers.showToast('Укажите API Ключ! Получите его на fragment-api.com');
  }

  // Если вставлен прямой JWT-токен (начинается на eyJ), активируем его без запроса к Telegram
  if (apiKey.startsWith('eyJ')) {
    try {
      Helpers.showToast('Активация JWT токена Fragment...');
      await API.saveSettings({
        fragmentEnabled: true,
        fragmentPhone: phone,
        fragmentMnemonics: mnemonics,
        fragmentApiKey: apiKey
      });
      Helpers.haptic('success');
      Helpers.showToast('✅ Fragment успешно авторизован!');
      await loadAdminData();
      return;
    } catch (e) {
      Helpers.showToast('Ошибка: ' + e.message);
      return;
    }
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Ожидание нажатия в Telegram...</span>';
  }

  Helpers.showToast('Запрос отправлен. Нажмите «Авторизоваться» в Telegram!');

  try {
    const res = await API.authenticateFragment({
      phone,
      mnemonics,
      apiKey
    });

    Helpers.haptic('success');
    Helpers.showToast('✅ Fragment успешно авторизован!');
    
    // Перезагружаем статус
    loadAdminInfo();
  } catch (err) {
    Helpers.haptic('error');
    Helpers.showToast(err.message || 'Ошибка авторизации Fragment');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>🔑 Авторизовать Fragment</span>';
    }
  }
}

async function saveAdminSettings() {
  const btn = document.getElementById('saveSettingsBtn');
  const fBtn = document.getElementById('saveFragmentBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>Сохранение...</span>';
  }
  if (fBtn) {
    fBtn.disabled = true;
    fBtn.innerHTML = '<span>Сохранение...</span>';
  }

  const starPriceUzs = document.getElementById('settingStarPrice')?.value;
  const premium3Uzs = document.getElementById('settingPrem3')?.value;
  const premium6Uzs = document.getElementById('settingPrem6')?.value;
  const premium12Uzs = document.getElementById('settingPrem12')?.value;
  const cardNumber = document.getElementById('settingCardNumber')?.value;
  const ordersChatId = document.getElementById('settingOrdersGroup')?.value;

  const fragmentEnabled = document.getElementById('settingFragmentEnabled')?.value === 'true';
  const fragmentPhone = document.getElementById('settingFragmentPhone')?.value;
  const fragmentMnemonics = document.getElementById('settingFragmentMnemonics')?.value;
  const fragmentApiKey = document.getElementById('settingFragmentApiKey')?.value;
  const autoConfirmEnabled = document.getElementById('settingAutoConfirmEnabled')?.value === 'true';

  try {
    const res = await API.updateAdminSettings({
      starPriceUzs,
      premium3Uzs,
      premium6Uzs,
      premium12Uzs,
      cardNumber,
      ordersChatId,
      fragmentEnabled,
      fragmentPhone,
      fragmentMnemonics,
      fragmentApiKey,
      autoConfirmEnabled
    });

    Helpers.haptic('success');
    Helpers.showToast('Настройки успешно сохранены');

    // Обновляем локальный каталог
    await loadCatalog();
  } catch (err) {
    Helpers.haptic('error');
    Helpers.showToast(err.message || 'Ошибка сохранения');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>Сохранить тарифы</span>';
    }
    if (fBtn) {
      fBtn.disabled = false;
      fBtn.innerHTML = '<span>Сохранить настройки Fragment</span>';
    }
  }
}

// Защита от мисклика в Mini App
function promptAdminOrder(orderId, action, recipient, itemDesc) {
  Helpers.haptic('warning');

  const isConfirm = action === 'confirm';
  const msg = isConfirm
    ? `Вы уверены? Подтвердить заказ #${orderId} и отправить ${itemDesc} на ${recipient}?`
    : `Вы уверены, что хотите отклонить заказ #${orderId}?`;

  if (tg && typeof tg.showConfirm === 'function') {
    tg.showConfirm(msg, (confirmed) => {
      if (confirmed) {
        handleAdminOrder(orderId, action);
      }
    });
  } else {
    // Встроенные кнопки двойного подтверждения (для браузера / fallback)
    const row = document.getElementById(`actions-row-${orderId}`);
    if (row) {
      row.innerHTML = `
        <button class="${isConfirm ? 'action-btn-confirm' : 'action-btn-reject'}" style="font-weight:700;" onclick="handleAdminOrder('${orderId}', '${action}')">
          ${isConfirm ? '⚡ Да, точно выдать' : '❌ Да, точно отклонить'}
        </button>
        <button class="action-btn-reject" style="background:#1e293b; color:#94a3b8;" onclick="loadAdminInfo()">
          Отмена
        </button>
      `;
    }
  }
}

async function handleAdminOrder(orderId, action) {
  Helpers.haptic('medium');

  try {
    const res = await API.adminOrderAction(orderId, action);
    Helpers.haptic('success');
    
    if (action === 'confirm' && res.fragment) {
      if (res.fragment.success) {
        Helpers.showToast(`Выдано через Fragment (${res.fragment.mode})`);
      } else {
        Helpers.showToast(`Подтверждено (Fragment: ${res.fragment.error})`);
      }
    } else {
      Helpers.showToast(action === 'confirm' ? 'Заказ подтверждён' : 'Заказ отклонён');
    }
    
    // Перезагружаем список
    loadAdminInfo();
  } catch (err) {
    Helpers.haptic('error');
    Helpers.showToast(err.message || 'Ошибка выполнения действия');
  }
}
