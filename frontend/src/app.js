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
  premium12Uzs: 395000
};

let starsAmount = 100;
let pendingOrder = null;

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

  pendingOrder = {
    type: 'stars',
    amount: starsAmount,
    priceUzs: price,
    itemDesc: `${starsAmount} Telegram Stars`,
    recipient: '@' + recipient
  };

  showCheckoutModal();
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

  pendingOrder = {
    type: 'premium',
    amount: months,
    priceUzs: price,
    itemDesc: `Telegram Premium на ${months} мес.`,
    recipient: '@' + recipient
  };

  showCheckoutModal();
}

function showCheckoutModal() {
  Helpers.haptic('medium');

  document.getElementById('modalItemDesc').textContent = pendingOrder.itemDesc;
  document.getElementById('modalRecipient').textContent = pendingOrder.recipient;
  document.getElementById('modalPrice').textContent = Helpers.formatUzs(pendingOrder.priceUzs);
  document.getElementById('modalCardNumber').textContent = Helpers.formatCardNumber(catalog.cardNumber);
  document.getElementById('modalCardHolder').textContent = catalog.cardHolder;
  document.getElementById('senderCommentInput').value = '';

  const modal = document.getElementById('checkoutModal');
  if (modal) modal.classList.add('show');
}

function closeCheckout() {
  const modal = document.getElementById('checkoutModal');
  if (modal) modal.classList.remove('show');
  pendingOrder = null;
}

function copyCardNumber() {
  const cleanCard = catalog.cardNumber.replace(/\s+/g, '');

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(cleanCard);
  } else {
    const el = document.createElement('textarea');
    el.value = cleanCard;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  }

  Helpers.haptic('success');
  Helpers.showToast('Номер карты скопирован');
}

async function submitPayment() {
  if (!pendingOrder) return;

  const btn = document.getElementById('confirmPayBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>Отправка...</span>';
  }

  const senderComment = document.getElementById('senderCommentInput')?.value?.trim() || '';

  try {
    const res = await API.createOrder({
      recipientUsername: pendingOrder.recipient,
      type: pendingOrder.type,
      amount: pendingOrder.amount,
      senderComment
    });

    closeCheckout();

    document.getElementById('successOrderId').textContent = '#' + res.order.id;
    document.getElementById('successItem').textContent = res.order.itemDescription;
    document.getElementById('successRecipient').textContent = res.order.recipientUsername;
    document.getElementById('successPrice').textContent = Helpers.formatUzs(res.order.priceUzs);

    const successModal = document.getElementById('successModal');
    if (successModal) successModal.classList.add('show');

    Helpers.haptic('success');

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
      if (fragConfig.hasToken) {
        fBadge.textContent = '✅ Авторизован';
        fBadge.className = 'status-badge-clean confirmed';
      } else {
        fBadge.textContent = '⚠️ Не авторизован';
        fBadge.className = 'status-badge-clean pending';
      }
    }

    // Ожидающие заказы
    if (pendingContainer) {
      if (!pendingOrders || pendingOrders.length === 0) {
        pendingContainer.innerHTML = `
          <div class="empty-state-box">
            <div class="empty-state-title">Нет ожидающих заказов</div>
            <div class="empty-state-sub">Все новые заказы будут появляться здесь и в группе</div>
          </div>
        `;
        return;
      }

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
      fragmentApiKey
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
