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
let recipientPreviewTimer = null;
let recipientPreviewSeq = 0;
let lastRecipientPreview = null;
let cachedProfitStats = null;
let selectedProfitPeriod = 'today';
let cachedLowTonThreshold = 5;

// ===== Инициализация =====
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  const currentTgId = tg?.initDataUnsafe?.user?.id;
  const recipientInput = document.getElementById('recipientInput');

  if (tg?.initDataUnsafe?.user) {
    const user = tg.initDataUnsafe.user;
    const nameEl = document.getElementById('userName');
    if (nameEl) nameEl.textContent = user.first_name || 'Клиент';

    if (recipientInput && user.username) {
      recipientInput.value = user.username;
      fetchRecipientPreview(user.username);
    }
  }

  if (recipientInput) {
    recipientInput.addEventListener('input', () => {
      if (recipientInput.value.startsWith('@')) {
        recipientInput.value = recipientInput.value.replace(/^@+/, '');
      }
      scheduleRecipientPreview(recipientInput.value);
    });
  }

  // Проверяем статус администратора и активные заказы пользователя
  try {
    const userData = await API.getUser();
    if (userData.isAdmin || currentTgId === 5379376281) {
      const adminBtn = document.getElementById('adminTabBtn');
      if (adminBtn) adminBtn.style.display = 'flex';
    }
    renderActiveOrderBanner(userData.activeOrders || []);
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

// ===== Предпросмотр получателя (@username) =====

function scheduleRecipientPreview(rawVal) {
  if (recipientPreviewTimer) clearTimeout(recipientPreviewTimer);
  const clean = String(rawVal || '').trim().replace(/^@+/, '');
  if (!clean) {
    lastRecipientPreview = null;
    renderRecipientPreview(null);
    return;
  }
  if (clean.length < 4) {
    lastRecipientPreview = null;
    renderRecipientPreview({
      status: 'too_short',
      valid: false,
      username: '@' + clean,
      displayName: '@' + clean,
      reason: 'Введите минимум 4 символа @username'
    });
    return;
  }
  recipientPreviewTimer = setTimeout(() => {
    fetchRecipientPreview(clean);
  }, 450);
}

async function fetchRecipientPreview(rawVal) {
  const clean = String(rawVal || '').trim().replace(/^@+/, '');
  const seq = ++recipientPreviewSeq;
  if (!clean || clean.length < 4) {
    lastRecipientPreview = null;
    renderRecipientPreview(null);
    return null;
  }

  renderRecipientPreview({ loading: true, username: '@' + clean });

  try {
    const data = await API.getRecipientPreview(clean);
    if (seq !== recipientPreviewSeq) return null;

    // Если это сам текущий пользователь и в t.me скрыто фото, подставляем данные из WebApp initDataUnsafe
    const selfUser = tg?.initDataUnsafe?.user;
    if (data && data.valid && selfUser?.username && selfUser.username.toLowerCase() === clean.toLowerCase()) {
      if (!data.avatarUrl && selfUser.photo_url) data.avatarUrl = selfUser.photo_url;
      if ((!data.displayName || data.displayName === '@' + clean) && selfUser.first_name) {
        data.displayName = [selfUser.first_name, selfUser.last_name].filter(Boolean).join(' ');
      }
    }

    lastRecipientPreview = data;
    renderRecipientPreview(data);
    return data;
  } catch (e) {
    if (seq !== recipientPreviewSeq) return null;
    const fallback = { valid: true, status: 'lookup_unavailable', username: '@' + clean, displayName: '@' + clean };
    lastRecipientPreview = fallback;
    renderRecipientPreview(null);
    return fallback;
  }
}

function getInitials(name, username) {
  const src = String(name || username || '?').replace(/^@+/, '').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return src.slice(0, 2).toUpperCase() || '?';
}

function renderRecipientPreview(data) {
  const box = document.getElementById('recipientPreviewBox');
  if (!box) return;

  if (!data || data.status === 'lookup_unavailable') {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }

  box.style.display = 'flex';
  if (data.loading) {
    box.className = 'recipient-preview-card state-loading';
    box.innerHTML = `
      <div class="recipient-avatar-fallback">...</div>
      <div class="recipient-preview-info">
        <div class="recipient-preview-name">Поиск ${escapeHtmlSafe(data.username)}...</div>
        <div class="recipient-preview-sub">Проверяем аккаунт в Telegram</div>
      </div>
    `;
    return;
  }

  const initials = escapeHtmlSafe(getInitials(data.displayName, data.username));
  const avatarHtml = data.avatarUrl
    ? `<div class="recipient-avatar-wrap">
         <img src="${escapeHtmlSafe(data.avatarUrl)}" alt="" class="recipient-avatar-img" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
         <div class="recipient-avatar-fallback" style="display:none;">${initials}</div>
       </div>`
    : `<div class="recipient-avatar-fallback">${initials}</div>`;

  if (data.valid) {
    box.className = 'recipient-preview-card state-ok';
    box.innerHTML = `
      ${avatarHtml}
      <div class="recipient-preview-info">
        <div class="recipient-preview-name">${escapeHtmlSafe(data.displayName || data.username)}</div>
        <div class="recipient-preview-sub">${escapeHtmlSafe(data.username)}</div>
      </div>
      <span class="status-badge-clean confirmed">Найден</span>
    `;
  } else {
    box.className = 'recipient-preview-card state-warn';
    box.innerHTML = `
      ${avatarHtml}
      <div class="recipient-preview-info">
        <div class="recipient-preview-name">${escapeHtmlSafe(data.displayName || data.username)}</div>
        <div class="recipient-preview-sub warn">${escapeHtmlSafe(data.reason || 'Проверьте @username')}</div>
      </div>
      <span class="status-badge-clean rejected">Ошибка</span>
    `;
  }
}

function validateRecipientForCheckout(recipient) {
  if (!recipient) {
    Helpers.haptic('error');
    Helpers.showToast('Укажите @username получателя');
    const input = document.getElementById('recipientInput');
    if (input) input.focus();
    return false;
  }
  if (recipient.length < 4) {
    Helpers.haptic('error');
    Helpers.showToast('Username должен содержать от 4 символов');
    return false;
  }
  if (
    lastRecipientPreview &&
    lastRecipientPreview.username &&
    lastRecipientPreview.username.toLowerCase() === ('@' + recipient.toLowerCase()) &&
    lastRecipientPreview.valid === false
  ) {
    Helpers.haptic('error');
    Helpers.showToast(lastRecipientPreview.reason || 'Укажите корректный личный @username');
    const input = document.getElementById('recipientInput');
    if (input) input.focus();
    return false;
  }
  return true;
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
  if (!validateRecipientForCheckout(recipient)) return;

  if (starsAmount < catalog.minStars) {
    Helpers.showToast(`Минимальный заказ: ${catalog.minStars} звёзд`);
    return;
  }

  const price = starsAmount * catalog.starPriceUzs;
  startCheckoutFlow('stars', starsAmount, price, `${starsAmount} Telegram Stars`, recipient);
}

function openPremiumCheckout(months) {
  const recipient = getRecipient();
  if (!validateRecipientForCheckout(recipient)) return;

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

function escapeHtmlSafe(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderActiveOrderBanner(activeOrders) {
  const banner = document.getElementById('activeOrderBanner');
  if (!banner) return;

  const list = Array.isArray(activeOrders) ? activeOrders : [];
  if (list.length === 0) {
    banner.style.display = 'none';
    banner.innerHTML = '';
    return;
  }

  // Приоритет отдаём заказам, по которым оплата уже точно получена ('paid_processing')
  const top = list[0];
  const itemDesc = top.type === 'stars' ? `${top.amount} ★` : `Premium ${top.amount} мес.`;
  const extraCount = list.length > 1 ? ` <span style="opacity:0.7;">(+ ещё ${list.length - 1})</span>` : '';
  const isPaid = top.status === 'paid_processing';

  banner.className = `active-order-banner ${isPaid ? 'state-paid' : 'state-pending'}`;
  banner.style.display = 'block';

  if (isPaid) {
    banner.innerHTML = `
      <div class="active-banner-top">
        <div class="active-banner-title">
          <span class="banner-pulse-dot"></span>
          <span>Оплата получена · Заказ #${escapeHtmlSafe(top.id)}${extraCount}</span>
        </div>
        <span class="active-banner-link">Открыть ›</span>
      </div>
      <div class="active-banner-desc">
        Платёж принят! Администратор уже оформляет <strong>${escapeHtmlSafe(itemDesc)}</strong> для <strong>${escapeHtmlSafe(top.recipient_username)}</strong>. Скоро заказ будет отправлен — ожидайте!
      </div>
    `;
  } else {
    banner.innerHTML = `
      <div class="active-banner-top">
        <div class="active-banner-title">
          <span class="banner-pulse-dot"></span>
          <span>Заказ #${escapeHtmlSafe(top.id)} в работе${extraCount}</span>
        </div>
        <span class="active-banner-link">Открыть ›</span>
      </div>
      <div class="active-banner-desc">
        Проверяем поступление оплаты за <strong>${escapeHtmlSafe(itemDesc)}</strong> (${escapeHtmlSafe(top.recipient_username)}). Как только подтвердится, заказ будет отправлен — ожидайте!
      </div>
    `;
  }
}

async function refreshActiveBannerFromServer() {
  try {
    const userData = await API.getUser();
    renderActiveOrderBanner(userData.activeOrders || []);
  } catch (e) {}
}

let lastPolledStatus = '';

function startOrderStatusPolling(orderId) {
  stopOrderStatusPolling();
  lastPolledStatus = '';
  orderPollTimer = setInterval(async () => {
    try {
      const st = await API.getOrderStatus(orderId);
      if (!st || st.status === lastPolledStatus) return;

      if (st.status === 'confirmed') {
        lastPolledStatus = 'confirmed';
        stopOrderStatusPolling();
        showSuccessState({
          id: st.id,
          itemDescription: pendingOrder?.itemDesc || 'Ваш заказ',
          recipientUsername: pendingOrder?.recipient || '',
          priceUzs: st.priceUzs || pendingOrder?.priceUzs || 0,
          deliveryState: 'confirmed'
        });
        refreshActiveBannerFromServer();
      } else if (st.status === 'paid_processing') {
        lastPolledStatus = 'paid_processing';
        showSuccessState({
          id: st.id,
          itemDescription: pendingOrder?.itemDesc || 'Ваш заказ',
          recipientUsername: pendingOrder?.recipient || '',
          priceUzs: st.priceUzs || pendingOrder?.priceUzs || 0,
          deliveryState: 'paid_processing'
        });
        refreshActiveBannerFromServer();
      }
    } catch (e) {
      // Тихо игнорируем временный сетевой сбой поллинга
    }
  }, 3500);
}

function showSuccessState({ id, itemDescription, recipientUsername, priceUzs, deliveryState, autoConfirmed }) {
  const checkoutModal = document.getElementById('checkoutModal');
  if (checkoutModal) checkoutModal.classList.remove('show');

  document.getElementById('successOrderId').textContent = '#' + id;
  document.getElementById('successItem').textContent = itemDescription;
  document.getElementById('successRecipient').textContent = recipientUsername;
  document.getElementById('successPrice').textContent = Helpers.formatUzs(priceUzs);

  const titleEl = document.getElementById('successTitle');
  const descEl = document.getElementById('successDescription');
  const noticeEl = document.getElementById('successNotice');

  const state = deliveryState || (autoConfirmed ? 'confirmed' : 'pending');

  if (state === 'confirmed') {
    if (titleEl) titleEl.textContent = '✅ Оплата получена! Заказ выполнен';
    if (descEl) {
      descEl.innerHTML = `Заказ <span class="order-mono-id">#${escapeHtmlSafe(id)}</span> подтверждён автоматически — товар отправлен!`;
    }
    if (noticeEl) noticeEl.textContent = 'Чек и статус уже отправлены вам в чат бота.';
  } else if (state === 'paid_processing') {
    if (titleEl) titleEl.textContent = '✅ Оплата получена! Заказ выполняется';
    if (descEl) {
      descEl.innerHTML = `Платёж по заказу <span class="order-mono-id">#${escapeHtmlSafe(id)}</span> принят. Администратор уже оформляет отправку — ожидайте!`;
    }
    if (noticeEl) noticeEl.textContent = 'Если администратор сейчас занят, отправка может занять немного времени. Статус всегда виден сверху в магазине.';
  } else {
    if (titleEl) titleEl.textContent = '⏳ Заказ передан на проверку';
    if (descEl) {
      descEl.innerHTML = `Номер заказа <span class="order-mono-id">#${escapeHtmlSafe(id)}</span>. Оплата проверяется, администратор скоро выдаст заказ.`;
    }
    if (noticeEl) noticeEl.textContent = 'Как только поступление подтвердится, товар будет отправлен, а статус обновится сверху.';
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

    const status = res.alreadyConfirmed ? 'confirmed' : (res.order?.status || 'pending');
    showSuccessState({
      id: res.order.id,
      itemDescription: res.order.itemDescription,
      recipientUsername: res.order.recipientUsername,
      priceUzs: res.order.priceUzs,
      deliveryState: status
    });

    refreshActiveBannerFromServer();

    if (status !== 'confirmed' && pendingOrder.autoConfirm) {
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
    renderActiveOrderBanner(data.activeOrders || []);

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
      const safeRec = escapeHtmlSafe(o.recipient_username);
      const safeType = escapeHtmlSafe(o.type);
      return `
        <div class="order-entry">
          <div class="order-top">
            <span class="order-code">#${escapeHtmlSafe(o.id)}</span>
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
              <div class="order-field-val text-accent">${safeRec}</div>
            </div>
            <div>
              <span class="order-field-label">Дата</span>
              <div class="order-field-val">${Helpers.formatDate(o.created_at)}</div>
            </div>
          </div>
          <div class="order-footer-row">
            <button type="button"
                    class="repeat-order-btn"
                    data-type="${safeType}"
                    data-amount="${Number(o.amount)}"
                    data-recipient="${safeRec}"
                    onclick="repeatOrderFromBtn(this)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="17 1 21 5 17 9"></polyline>
                <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                <polyline points="7 23 3 19 7 15"></polyline>
                <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
              </svg>
              <span>Повторить заказ</span>
            </button>
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

async function repeatOrderFromBtn(btn) {
  if (!btn) return;
  const type = btn.dataset.type || 'stars';
  const amount = Number(btn.dataset.amount || 100);
  const recipient = String(btn.dataset.recipient || '').replace(/^@+/, '').trim();
  Helpers.haptic('medium');

  const input = document.getElementById('recipientInput');
  if (input && recipient) {
    input.value = recipient;
  }

  if (type === 'stars') {
    switchTab('stars');
    setStars(amount);
  } else {
    switchTab('premium');
  }

  if (recipient) {
    await fetchRecipientPreview(recipient);
  }

  if (type === 'stars') {
    openStarsCheckout();
  } else {
    openPremiumCheckout(amount);
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
    const { settings, stats, pendingOrders, profitStats, broadcastStats, walletBalance } = data;

    // Метрики
    const totalEl = document.getElementById('adminMetricTotal');
    const pendEl = document.getElementById('adminMetricPending');
    const revEl = document.getElementById('adminMetricRevenue');

    if (totalEl) totalEl.textContent = stats.total || 0;
    if (pendEl) pendEl.textContent = stats.pending || 0;
    if (revEl) revEl.textContent = Helpers.formatUzs(stats.revenue || 0);

    // Баланс TON и порог
    cachedLowTonThreshold = Number(settings.low_ton_threshold || 5);
    renderAdminTonBalance(walletBalance, cachedLowTonThreshold);

    // Статистика прибыли
    cachedProfitStats = profitStats || null;
    renderProfitStats();

    // База для рассылки
    renderBroadcastAudience(broadcastStats);

    // Поля настроек
    const sStar = document.getElementById('settingStarPrice');
    const sPrem3 = document.getElementById('settingPrem3');
    const sPrem6 = document.getElementById('settingPrem6');
    const sPrem12 = document.getElementById('settingPrem12');
    const sCard = document.getElementById('settingCardNumber');
    const sGroup = document.getElementById('settingOrdersGroup');
    const sCostStar = document.getElementById('settingCostStar');
    const sCostPrem3 = document.getElementById('settingCostPrem3');
    const sCostPrem6 = document.getElementById('settingCostPrem6');
    const sCostPrem12 = document.getElementById('settingCostPrem12');
    const sLowTon = document.getElementById('settingLowTonThreshold');

    if (sStar) sStar.value = settings.star_price_uzs || 220;
    if (sPrem3) sPrem3.value = settings.premium_3_uzs || 175000;
    if (sPrem6) sPrem6.value = settings.premium_6_uzs || 245000;
    if (sPrem12) sPrem12.value = settings.premium_12_uzs || 395000;
    if (sCard) sCard.value = settings.card_number || '5614681816265841';
    if (sGroup) sGroup.value = settings.orders_chat_id || '';
    if (sCostStar) sCostStar.value = settings.cost_star_uzs || 195;
    if (sCostPrem3) sCostPrem3.value = settings.cost_prem_3_uzs || 155000;
    if (sCostPrem6) sCostPrem6.value = settings.cost_prem_6_uzs || 207000;
    if (sCostPrem12) sCostPrem12.value = settings.cost_prem_12_uzs || 370000;
    if (sLowTon) sLowTon.value = settings.low_ton_threshold || 5;

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
          const safeRec = escapeHtmlSafe(o.recipient_username);
          const safeBuyer = escapeHtmlSafe(o.buyer_username);
          const safeComment = escapeHtmlSafe(o.sender_comment);
          const isPaidProc = o.status === 'paid_processing';

          const actionsHtml = isPaidProc
            ? `
              <button class="action-btn-confirm" onclick="promptAdminOrder('${o.id}', 'retry', '${safeRec}', '${itemDesc}')">
                🔄 Повторить Fragment
              </button>
              <button class="action-btn-confirm" style="background:var(--ok); color:#052e16;" onclick="promptAdminOrder('${o.id}', 'manual_done', '${safeRec}', '${itemDesc}')">
                ✅ Выдал вручную
              </button>
            `
            : `
              <button class="action-btn-confirm" onclick="promptAdminOrder('${o.id}', 'confirm', '${safeRec}', '${itemDesc}')">
                Подтвердить
              </button>
              <button class="action-btn-reject" onclick="promptAdminOrder('${o.id}', 'reject', '${safeRec}', '${itemDesc}')">
                Отклонить
              </button>
            `;

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
                  <div class="order-field-val text-accent">${safeRec}</div>
                </div>
                <div>
                  <span class="order-field-label">Покупатель</span>
                  <div class="order-field-val">${safeBuyer}</div>
                </div>
              </div>
              ${safeComment ? `<div class="order-field-label">Чек: <span style="color:#fff">${safeComment}</span></div>` : ''}
              <div class="admin-actions-row" id="actions-row-${o.id}">
                ${actionsHtml}
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
  const lowTonThreshold = document.getElementById('settingLowTonThreshold')?.value;
  const costStarUzs = document.getElementById('settingCostStar')?.value;
  const costPrem3Uzs = document.getElementById('settingCostPrem3')?.value;
  const costPrem6Uzs = document.getElementById('settingCostPrem6')?.value;
  const costPrem12Uzs = document.getElementById('settingCostPrem12')?.value;

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
      autoConfirmEnabled,
      lowTonThreshold,
      costStarUzs,
      costPrem3Uzs,
      costPrem6Uzs,
      costPrem12Uzs
    });

    Helpers.haptic('success');
    Helpers.showToast('Настройки успешно сохранены');

    // Обновляем локальный каталог и пересчитываем прибыль в админке
    await loadCatalog();
    loadAdminInfo();
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

  const isReject = action === 'reject';
  const msg = action === 'retry'
    ? `Повторить автовыдачу заказа #${orderId} (${itemDesc} на ${recipient}) через Fragment?`
    : action === 'manual_done'
      ? `Отметить заказ #${orderId} как уже выданный вручную? Клиенту уйдёт уведомление об успехе.`
      : action === 'confirm'
        ? `Вы уверены? Подтвердить заказ #${orderId} и отправить ${itemDesc} на ${recipient}?`
        : `Вы уверены, что хотите отклонить заказ #${orderId}?`;

  if (tg && typeof tg.showConfirm === 'function') {
    tg.showConfirm(msg, (confirmed) => {
      if (confirmed) {
        handleAdminOrder(orderId, action);
      }
    });
  } else {
    const row = document.getElementById(`actions-row-${orderId}`);
    if (row) {
      const btnText = action === 'retry'
        ? '🔄 Да, повторить Fragment'
        : action === 'manual_done'
          ? '✅ Да, выдано вручную'
          : action === 'confirm'
            ? '⚡ Да, точно выдать'
            : '❌ Да, точно отклонить';
      row.innerHTML = `
        <button class="${isReject ? 'action-btn-reject' : 'action-btn-confirm'}" style="font-weight:700;" onclick="handleAdminOrder('${orderId}', '${action}')">
          ${btnText}
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

    if ((action === 'confirm' || action === 'retry') && res.fragment) {
      if (res.fragment.success) {
        Helpers.showToast(`✅ Выдано через Fragment!`);
      } else {
        Helpers.showToast(`⏳ Оплата есть, но Fragment: ${res.fragment.error}`);
      }
    } else if (action === 'manual_done') {
      Helpers.showToast('✅ Заказ отмечен как выполненный');
    } else {
      Helpers.showToast(action === 'reject' ? 'Заказ отклонён' : 'Готово');
    }

    loadAdminInfo();
    refreshActiveBannerFromServer();
  } catch (err) {
    Helpers.haptic('error');
    Helpers.showToast(err.message || 'Ошибка выполнения действия');
  }
}

// ===== Баланс TON, статистика прибыли и рассылка (Admin) =====

function renderAdminTonBalance(wallet, threshold) {
  const valEl = document.getElementById('adminTonBalanceVal');
  const badgeEl = document.getElementById('adminTonStatusBadge');
  const hintEl = document.getElementById('adminTonAddressHint');
  const thr = Number(threshold || cachedLowTonThreshold || 5);

  if (hintEl) {
    const addr = wallet?.address ? ` · ${wallet.address.slice(0, 8)}...${wallet.address.slice(-6)}` : '';
    hintEl.textContent = `Порог уведомления: ${thr} TON${addr}`;
  }
  if (!valEl || !badgeEl) return;

  if (!wallet || !wallet.success) {
    valEl.textContent = '— TON';
    badgeEl.textContent = wallet?.error ? 'Ошибка сети' : 'Неизвестно';
    badgeEl.className = 'status-badge-clean pending';
    return;
  }

  valEl.textContent = wallet.balanceFormatted || `${Number(wallet.balance || 0).toFixed(3)} TON`;
  if (wallet.balance < 1) {
    badgeEl.textContent = 'Критично (< 1 TON)';
    badgeEl.className = 'status-badge-clean rejected';
  } else if (wallet.balance < thr) {
    badgeEl.textContent = `Низкий (< ${thr} TON)`;
    badgeEl.className = 'status-badge-clean pending';
  } else {
    badgeEl.textContent = 'В норме';
    badgeEl.className = 'status-badge-clean confirmed';
  }
}

async function refreshAdminTonBalance() {
  Helpers.haptic('light');
  try {
    const res = await API.getAdminTonBalance();
    renderAdminTonBalance(res, res.threshold);
    Helpers.showToast('Баланс TON обновлён');
  } catch (err) {
    Helpers.showToast(err.message || 'Не удалось обновить баланс TON');
  }
}

function switchProfitPeriod(period) {
  Helpers.haptic('light');
  selectedProfitPeriod = period;
  document.querySelectorAll('.period-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.period === period);
  });
  renderProfitStats();
}

function renderProfitStats() {
  const stats = cachedProfitStats?.[selectedProfitPeriod];
  if (!stats) return;

  const netEl = document.getElementById('profitNetVal');
  const revEl = document.getElementById('profitRevVal');
  const costEl = document.getElementById('profitCostVal');
  const salesEl = document.getElementById('profitSalesVal');
  const marginEl = document.getElementById('profitMarginBadge');
  const hintEl = document.getElementById('profitDetailHint');

  if (netEl) {
    const sign = stats.profitUzs > 0 ? '+' : '';
    netEl.textContent = `${sign}${Helpers.formatUzs(stats.profitUzs)}`;
    netEl.className = `profit-val ${stats.profitUzs >= 0 ? 'profit-ok' : 'profit-neg'}`;
  }
  if (revEl) revEl.textContent = Helpers.formatUzs(stats.revenueUzs);
  if (costEl) costEl.textContent = Helpers.formatUzs(stats.costUzs);
  if (salesEl) {
    salesEl.textContent = `${stats.orders} зак. (${stats.starsCount.toLocaleString('ru-RU')} ★ · Prem: ${stats.premiumCount})`;
  }
  if (marginEl) {
    marginEl.textContent = `Маржа ${stats.marginPct}%`;
    marginEl.className = `status-badge-clean ${stats.profitUzs >= 0 ? 'confirmed' : 'rejected'}`;
  }
  if (hintEl) {
    const tonNote = stats.tonSpent > 0 ? ` · Потрачено TON: ${stats.tonSpent}` : '';
    hintEl.textContent = `Оплачено: ${stats.confirmedOrders} выполн. / ${stats.processingOrders} в обработке${tonNote}`;
  }
}

function renderBroadcastAudience(bStats) {
  const badge = document.getElementById('broadcastAudienceBadge');
  if (!badge || !bStats) return;
  badge.textContent = `В базе: ${bStats.active} акт. / ${bStats.total}`;
}

async function sendBroadcastTest() {
  const textEl = document.getElementById('broadcastTextInput');
  const includeBtnEl = document.getElementById('broadcastIncludeBtn');
  const btn = document.getElementById('broadcastTestBtn');
  const text = (textEl?.value || '').trim();
  if (!text) {
    Helpers.haptic('error');
    Helpers.showToast('Введите текст сообщения');
    return;
  }

  Helpers.haptic('light');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span>Отправка...</span>'; }
  try {
    await API.sendBroadcastTest(text, Boolean(includeBtnEl?.checked));
    Helpers.haptic('success');
    Helpers.showToast('Тестовое сообщение отправлено вам в чат бота');
  } catch (err) {
    Helpers.haptic('error');
    Helpers.showToast(err.message || 'Ошибка отправки теста');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<span>Тест мне</span>'; }
  }
}

function restoreBroadcastButtons() {
  const row = document.getElementById('broadcastActionRow');
  if (!row) return;
  row.innerHTML = `
    <button type="button" class="cta-secondary-btn" style="flex:1; padding:11px; font-size:0.78rem;" id="broadcastTestBtn" onclick="sendBroadcastTest()">
      <span>Тест мне</span>
    </button>
    <button type="button" class="cta-primary-btn" style="flex:1.4; padding:11px; font-size:0.78rem;" id="broadcastSendBtn" onclick="promptAdminBroadcast()">
      <span>Отправить всем</span>
    </button>
  `;
}

function promptAdminBroadcast() {
  const textEl = document.getElementById('broadcastTextInput');
  const text = (textEl?.value || '').trim();
  if (!text) {
    Helpers.haptic('error');
    Helpers.showToast('Введите текст для рассылки');
    return;
  }

  Helpers.haptic('warning');
  const msg = 'Отправить это сообщение всем пользователям бота? Действие нельзя отменить.';
  if (tg && typeof tg.showConfirm === 'function') {
    tg.showConfirm(msg, (confirmed) => {
      if (confirmed) executeAdminBroadcast();
    });
  } else {
    const row = document.getElementById('broadcastActionRow');
    if (row) {
      row.innerHTML = `
        <button type="button" class="action-btn-confirm" style="font-weight:700;" onclick="executeAdminBroadcast()">
          📣 Да, разослать всем
        </button>
        <button type="button" class="action-btn-reject" style="background:#1e293b; color:#94a3b8;" onclick="restoreBroadcastButtons()">
          Отмена
        </button>
      `;
    }
  }
}

async function executeAdminBroadcast() {
  const textEl = document.getElementById('broadcastTextInput');
  const includeBtnEl = document.getElementById('broadcastIncludeBtn');
  const resBox = document.getElementById('broadcastResultBox');
  const row = document.getElementById('broadcastActionRow');
  const text = (textEl?.value || '').trim();
  if (!text) return restoreBroadcastButtons();

  if (row) {
    row.querySelectorAll('button').forEach(b => { b.disabled = true; });
  }
  if (resBox) {
    resBox.style.display = 'block';
    resBox.textContent = '⏳ Идёт рассылка по базе пользователей...';
  }

  try {
    const res = await API.sendBroadcast(text, Boolean(includeBtnEl?.checked));
    Helpers.haptic('success');
    Helpers.showToast(`Рассылка завершена: доставлено ${res.sent} из ${res.total}`);
    if (res.broadcastStats) renderBroadcastAudience(res.broadcastStats);
    if (resBox) {
      resBox.style.display = 'block';
      resBox.style.color = 'var(--ok)';
      resBox.textContent = `✅ Доставлено: ${res.sent} из ${res.total} (заблок.: ${res.blocked}, ошибок: ${res.failed})`;
    }
  } catch (err) {
    Helpers.haptic('error');
    Helpers.showToast(err.message || 'Ошибка рассылки');
    if (resBox) {
      resBox.style.display = 'block';
      resBox.style.color = 'var(--error)';
      resBox.textContent = `❌ ${err.message || 'Ошибка рассылки'}`;
    }
  } finally {
    restoreBroadcastButtons();
  }
}
