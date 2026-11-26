const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'nate_stars.db');

let db = null;

async function initDatabase() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Таблица пользователей
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      balance_uzs INTEGER DEFAULT 0,
      is_blocked INTEGER DEFAULT 0,
      last_seen_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Безопасная миграция колонок таблицы users
  try {
    const uStmt = db.prepare("PRAGMA table_info(users)");
    const userCols = [];
    while (uStmt.step()) userCols.push(uStmt.getAsObject().name);
    uStmt.free();
    if (!userCols.includes('is_blocked')) {
      db.run("ALTER TABLE users ADD COLUMN is_blocked INTEGER DEFAULT 0");
    }
    if (!userCols.includes('last_seen_at')) {
      db.run("ALTER TABLE users ADD COLUMN last_seen_at TEXT DEFAULT ''");
    }
    if (!userCols.includes('balance_uzs')) {
      db.run("ALTER TABLE users ADD COLUMN balance_uzs INTEGER DEFAULT 0");
    }
  } catch (e) {
    console.warn('Миграция users:', e.message);
  }

  // Таблица настроек и цен
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Проверяем схему таблицы заказов
  let needRecreateOrders = false;
  try {
    const stmt = db.prepare("PRAGMA table_info(orders)");
    const cols = [];
    while (stmt.step()) cols.push(stmt.getAsObject().name);
    stmt.free();
    if (cols.length > 0 && !cols.includes('buyer_username')) {
      needRecreateOrders = true;
    }
  } catch (e) {
    needRecreateOrders = true;
  }

  if (needRecreateOrders) {
    db.run("DROP TABLE IF EXISTS orders");
  }

  // Таблица заказов
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      telegram_id INTEGER NOT NULL,
      buyer_username TEXT,
      recipient_username TEXT NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      price_uzs INTEGER NOT NULL,
      base_price_uzs INTEGER DEFAULT 0,
      card_pay_uzs INTEGER DEFAULT 0,
      balance_used_uzs INTEGER DEFAULT 0,
      balance_refunded INTEGER DEFAULT 0,
      card_number TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      sender_comment TEXT,
      payment_source TEXT DEFAULT 'manual',
      cost_uzs INTEGER DEFAULT 0,
      ton_spent REAL DEFAULT 0,
      ton_memo TEXT DEFAULT '',
      tx_hash TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Безопасная миграция новых колонок в существующей таблице orders
  try {
    const stmt = db.prepare("PRAGMA table_info(orders)");
    const orderCols = [];
    while (stmt.step()) orderCols.push(stmt.getAsObject().name);
    stmt.free();
    if (!orderCols.includes('base_price_uzs')) {
      db.run("ALTER TABLE orders ADD COLUMN base_price_uzs INTEGER DEFAULT 0");
    }
    if (!orderCols.includes('card_pay_uzs')) {
      db.run("ALTER TABLE orders ADD COLUMN card_pay_uzs INTEGER DEFAULT 0");
    }
    if (!orderCols.includes('balance_used_uzs')) {
      db.run("ALTER TABLE orders ADD COLUMN balance_used_uzs INTEGER DEFAULT 0");
    }
    if (!orderCols.includes('balance_refunded')) {
      db.run("ALTER TABLE orders ADD COLUMN balance_refunded INTEGER DEFAULT 0");
    }
    if (!orderCols.includes('payment_source')) {
      db.run("ALTER TABLE orders ADD COLUMN payment_source TEXT DEFAULT 'manual'");
    }
    if (!orderCols.includes('cost_uzs')) {
      db.run("ALTER TABLE orders ADD COLUMN cost_uzs INTEGER DEFAULT 0");
    }
    if (!orderCols.includes('ton_spent')) {
      db.run("ALTER TABLE orders ADD COLUMN ton_spent REAL DEFAULT 0");
    }
    if (!orderCols.includes('ton_memo')) {
      db.run("ALTER TABLE orders ADD COLUMN ton_memo TEXT DEFAULT ''");
    }
    if (!orderCols.includes('tx_hash')) {
      db.run("ALTER TABLE orders ADD COLUMN tx_hash TEXT DEFAULT ''");
    }
  } catch (e) {
    console.warn('Миграция orders:', e.message);
  }

  // Таблица пополнений баланса наличными через Paynet
  db.run(`
    CREATE TABLE IF NOT EXISTS paynet_topups (
      id TEXT PRIMARY KEY,
      telegram_id INTEGER NOT NULL,
      buyer_username TEXT,
      cash_amount_uzs INTEGER NOT NULL,
      fee_pct REAL NOT NULL,
      expected_card_uzs INTEGER NOT NULL,
      credited_uzs INTEGER DEFAULT 0,
      card_number TEXT NOT NULL,
      card_last4 TEXT DEFAULT '',
      paynet_target TEXT DEFAULT '',
      status TEXT DEFAULT 'awaiting_payment',
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Журнал операций с балансом пользователя
  db.run(`
    CREATE TABLE IF NOT EXISTS balance_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      delta_uzs INTEGER NOT NULL,
      balance_after_uzs INTEGER NOT NULL,
      reason TEXT NOT NULL,
      ref_id TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Таблица обработанных уведомлений CardXabar (защита от двойного срабатывания)
  db.run(`
    CREATE TABLE IF NOT EXISTS processed_cardxabar_msgs (
      msg_id INTEGER PRIMARY KEY,
      amount REAL NOT NULL,
      card_last4 TEXT,
      order_id TEXT,
      raw_text TEXT,
      processed_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Значения по умолчанию для настроек (ID владельца: 5379376281, Группа: -1003724696975)
  const defaultSettings = {
    'star_price_uzs': '210',
    'min_stars': '50',
    'card_number': '5614681816265841',
    'card_holder': 'Карта для перевода (Uzcard / Humo)',
    'premium_3_uzs': '163000',
    'premium_6_uzs': '220000',
    'premium_12_uzs': '390000',
    'admin_ids': '5379376281',
    'orders_chat_id': '-1003724696975',
    'fragment_enabled': 'true',
    'fragment_provider': 'simulation',
    'fragment_api_key': '',
    'fragment_api_url': 'https://starsapi.uz',
    'ton_wallet_mnemonic': '',
    'auto_confirm_enabled': 'false',
    'tg_api_id': '',
    'tg_api_hash': '',
    'tg_session_string': '',
    'tg_phone': '',
    'low_ton_threshold': '5',
    'last_low_ton_alert_at': '0',
    'last_low_ton_alert_balance': '',
    'cost_star_uzs': '195',
    'cost_prem_3_uzs': '155000',
    'cost_prem_6_uzs': '207000',
    'cost_prem_12_uzs': '370000',
    'ton_price_uzs': '14000',
    'cost_ton_uzs': '12000',
    'min_ton': '0.2',
    'max_ton': '50',
    'ton_auto_rate_enabled': 'true',
    'ton_provider_spread_pct': '3',
    'ton_markup_mode': 'fixed',
    'ton_markup_uzs': '2000',
    'ton_markup_pct': '15',
    'ton_min_floor_uzs': '0',
    'last_ton_usd': '',
    'last_cbu_usd_uzs': '',
    'ton_rate_snapshot': '{}',
    'paynet_enabled': 'true',
    'paynet_fee_pct': '3',
    'paynet_ttl_minutes': '10',
    'paynet_min_cash_uzs': '5000',
    'paynet_target': '',
    'paynet_cards': ''
  };

  for (const [key, val] of Object.entries(defaultSettings)) {
    const res = db.exec(`SELECT value FROM settings WHERE key = '${key}'`);
    if (res.length === 0 || res[0].values.length === 0) {
      db.run(`INSERT INTO settings (key, value) VALUES (?, ?)`, [key, val]);
    }
  }

  // Подхватываем переменные окружения Render для автоподтверждения CardXabar
  if (process.env.TG_API_ID) {
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('tg_api_id', ?)", [String(process.env.TG_API_ID).trim()]);
  }
  if (process.env.TG_API_HASH) {
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('tg_api_hash', ?)", [String(process.env.TG_API_HASH).trim()]);
  }
  if (process.env.TG_SESSION) {
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('tg_session_string', ?)", [String(process.env.TG_SESSION).trim()]);
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_confirm_enabled', 'true')");
  }

  // Всегда гарантируем актуальные ID владельца и группы
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_ids', '5379376281')");
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('orders_chat_id', '-1003724696975')");

  // Авторизация Fragment / TON-кошелька (переменная окружения TON_MNEMONIC имеет приоритет)
  const envMnemonic = (process.env.TON_MNEMONIC || process.env.FRAGMENT_MNEMONICS || '').trim();
  const activeMnemonic = envMnemonic || 'harbor age artwork marble cram manage dolphin evolve walnut firm dose dynamic lift castle eye boil guilt minute feel diesel search top void door';
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('fragment_enabled', 'true')");
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('fragment_phone', '+998930690203')");
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('fragment_mnemonics', ?)", [activeMnemonic]);
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('fragment_wallet_address', 'UQCG_TZEtQ8_wPOqZgQEQ8mH0yUv8xJbVibY_eHTIhOt5LCk')");
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('fragment_api_key', 'e153ec41-bb0b-4e74-998d-bc5c7a36634c')");
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('fragment_jwt_saved_at', ?)", [new Date().toISOString()]);

  saveDb();
  console.log('✅ База данных и настройки успешно инициализированы');
  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function runSql(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function parseCreatedMs(dateStr) {
  if (!dateStr) return NaN;
  const s = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  return Date.parse(s);
}

function calculateCostUzs(type, amount, settings) {
  const numAmount = Number(amount || 0);
  if (type === 'stars') {
    return Math.round(numAmount * Number(settings?.cost_star_uzs || 195));
  }
  if (type === 'ton') {
    return Math.round(numAmount * Number(settings?.cost_ton_uzs || 18500));
  }
  if (numAmount === 3) return Number(settings?.cost_prem_3_uzs || 155000);
  if (numAmount === 6) return Number(settings?.cost_prem_6_uzs || 207000);
  if (numAmount === 12) return Number(settings?.cost_prem_12_uzs || 370000);
  return 0;
}

const dao = {
  getSetting(key) {
    const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? row.value : null;
  },

  getAllSettings() {
    const rows = queryAll('SELECT key, value FROM settings');
    const result = {};
    rows.forEach(r => { result[r.key] = r.value; });
    return result;
  },

  setSetting(key, value) {
    runSql(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, [key, String(value)]);
  },

  upsertUser({ telegramId, username, firstName, lastName }) {
    const nowIso = new Date().toISOString();
    runSql(`
      INSERT INTO users (telegram_id, username, first_name, last_name, is_blocked, last_seen_at)
      VALUES (?, ?, ?, ?, 0, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        is_blocked = 0,
        last_seen_at = excluded.last_seen_at
    `, [telegramId, username || '', firstName || '', lastName || '', nowIso]);
  },

  markUserBlocked(telegramId, blocked = true) {
    runSql('UPDATE users SET is_blocked = ? WHERE telegram_id = ?', [blocked ? 1 : 0, Number(telegramId)]);
  },

  getBroadcastStats() {
    const totalRow = queryOne('SELECT COUNT(*) as count FROM users') || { count: 0 };
    const activeRow = queryOne('SELECT COUNT(*) as count FROM users WHERE COALESCE(is_blocked, 0) = 0') || { count: 0 };
    const total = Number(totalRow.count || 0);
    const active = Number(activeRow.count || 0);
    return {
      total,
      active,
      blocked: Math.max(0, total - active)
    };
  },

  getActiveUsersForBroadcast() {
    return queryAll('SELECT telegram_id, username, first_name FROM users WHERE COALESCE(is_blocked, 0) = 0 ORDER BY id DESC');
  },

  getUser(telegramId) {
    return queryOne('SELECT * FROM users WHERE telegram_id = ?', [Number(telegramId)]);
  },

  getUserByUsernameOrId(identifier) {
    const raw = String(identifier || '').trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      return this.getUser(Number(raw));
    }
    const clean = raw.replace(/^@+/, '').toLowerCase();
    return queryOne('SELECT * FROM users WHERE LOWER(username) = ?', [clean]);
  },

  getUsersWithBalance(limit = 30) {
    return queryAll('SELECT telegram_id, username, first_name, balance_uzs, last_seen_at FROM users WHERE COALESCE(balance_uzs, 0) > 0 ORDER BY balance_uzs DESC LIMIT ?', [limit]);
  },

  getPaynetCardPool(settings = null) {
    const cfg = settings || this.getAllSettings();
    const list = [];
    const primary = String(cfg.card_number || '').replace(/\s+/g, '').trim();
    if (primary) list.push(primary);
    const extraRaw = String(cfg.paynet_cards || '');
    for (const part of extraRaw.split(/[\n,;]+/)) {
      const cleaned = part.replace(/\s+/g, '').trim();
      if (cleaned && cleaned.replace(/\D/g, '').length >= 4 && !list.includes(cleaned)) {
        list.push(cleaned);
      }
    }
    return list;
  },

  adjustUserBalance(telegramId, deltaUzs, reason = 'manual', refId = '') {
    const tgId = Number(telegramId);
    const delta = Math.round(Number(deltaUzs || 0));
    let user = this.getUser(tgId);
    if (!user) {
      this.upsertUser({ telegramId: tgId, username: '', firstName: 'Клиент', lastName: '' });
      user = this.getUser(tgId);
    }
    const cur = Number(user?.balance_uzs || 0);
    const next = Math.max(0, cur + delta);
    const appliedDelta = next - cur;
    const nowIso = new Date().toISOString();

    runSql('UPDATE users SET balance_uzs = ? WHERE telegram_id = ?', [next, tgId]);
    runSql(`
      INSERT INTO balance_logs (telegram_id, delta_uzs, balance_after_uzs, reason, ref_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [tgId, appliedDelta, next, String(reason || 'manual'), String(refId || ''), nowIso]);

    return { prevBalance: cur, delta: appliedDelta, newBalance: next };
  },

  debitUserBalanceIfEnough(telegramId, amountUzs, reason = 'order_payment', refId = '') {
    const tgId = Number(telegramId);
    const need = Math.round(Number(amountUzs || 0));
    if (need <= 0) return { ok: true, newBalance: Number(this.getUser(tgId)?.balance_uzs || 0) };

    const user = this.getUser(tgId);
    const cur = Number(user?.balance_uzs || 0);
    if (cur < need) {
      return { ok: false, balance: cur };
    }
    const next = cur - need;
    const nowIso = new Date().toISOString();
    runSql('UPDATE users SET balance_uzs = ? WHERE telegram_id = ?', [next, tgId]);
    runSql(`
      INSERT INTO balance_logs (telegram_id, delta_uzs, balance_after_uzs, reason, ref_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [tgId, -need, next, String(reason || 'order_payment'), String(refId || ''), nowIso]);
    return { ok: true, prevBalance: cur, newBalance: next };
  },

  refundOrderBalanceOnce(orderId) {
    const order = this.getOrder(orderId);
    if (!order) return { refunded: false };
    const used = Number(order.balance_used_uzs || 0);
    if (used <= 0 || Number(order.balance_refunded || 0) === 1) {
      return { refunded: false };
    }
    runSql('UPDATE orders SET balance_refunded = 1, updated_at = ? WHERE id = ?', [new Date().toISOString(), orderId]);
    const adj = this.adjustUserBalance(order.telegram_id, used, 'order_refund', orderId);
    return { refunded: true, amount: used, newBalance: adj.newBalance };
  },

  createOrder({ id, telegramId, buyerUsername, recipientUsername, type, amount, priceUzs, basePriceUzs, cardPayUzs = 0, balanceUsedUzs = 0, costUzs, cardNumber, status, senderComment, paymentSource, tonMemo = '', txHash = '' }) {
    const nowIso = new Date().toISOString();
    const effectiveCardPay = Number(cardPayUzs) >= 0 && balanceUsedUzs > 0 ? Number(cardPayUzs) : (Number(cardPayUzs) > 0 ? Number(cardPayUzs) : priceUzs);
    runSql(`
      INSERT INTO orders (id, telegram_id, buyer_username, recipient_username, type, amount, price_uzs, base_price_uzs, card_pay_uzs, balance_used_uzs, balance_refunded, cost_uzs, card_number, status, sender_comment, payment_source, ton_memo, tx_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      telegramId,
      buyerUsername,
      recipientUsername,
      type,
      amount,
      priceUzs,
      basePriceUzs || priceUzs,
      effectiveCardPay,
      Number(balanceUsedUzs || 0),
      Number(costUzs || 0),
      cardNumber,
      status || 'pending',
      senderComment || '',
      paymentSource || 'manual',
      String(tonMemo || ''),
      String(txHash || ''),
      nowIso,
      nowIso
    ]);
  },

  getOrder(id) {
    return queryOne('SELECT * FROM orders WHERE id = ?', [id]);
  },

  updateOrderStatus(id, status, paymentSource = null) {
    const nowIso = new Date().toISOString();
    if (paymentSource) {
      runSql(`
        UPDATE orders SET status = ?, payment_source = ?, updated_at = ? WHERE id = ?
      `, [status, paymentSource, nowIso, id]);
    } else {
      runSql(`
        UPDATE orders SET status = ?, updated_at = ? WHERE id = ?
      `, [status, nowIso, id]);
    }
  },

  updateOrderDeliveryCost(id, { costUzs, tonSpent = 0, txHash = '' } = {}) {
    const nowIso = new Date().toISOString();
    runSql(`
      UPDATE orders
      SET cost_uzs = CASE WHEN ? > 0 THEN ? ELSE cost_uzs END,
          ton_spent = CASE WHEN ? > 0 THEN ? ELSE ton_spent END,
          tx_hash = CASE WHEN ? != '' THEN ? ELSE tx_hash END,
          updated_at = ?
      WHERE id = ?
    `, [Number(costUzs || 0), Number(costUzs || 0), Number(tonSpent || 0), Number(tonSpent || 0), String(txHash || ''), String(txHash || ''), nowIso, id]);
  },

  markOrderPaidByUser(id, senderComment) {
    const nowIso = new Date().toISOString();
    runSql(`
      UPDATE orders
      SET status = CASE WHEN status = 'awaiting_payment' THEN 'pending' ELSE status END,
          sender_comment = CASE WHEN ? != '' THEN ? ELSE sender_comment END,
          updated_at = ?
      WHERE id = ?
    `, [senderComment || '', senderComment || '', nowIso, id]);
  },

  /**
   * Повторно использует свежий неоплаченный заказ того же клиента (за последние 15 минут),
   * чтобы при закрытии/повторном открытии окна оплаты не тратились лишние «копейки».
   */
  findReusableAwaitingOrder({ telegramId, type, amount, recipientUsername, basePriceUzs, balanceUsedUzs = 0, tonMemo = '' }) {
    const cutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const candidates = queryAll(`
      SELECT * FROM orders
      WHERE telegram_id = ? AND type = ? AND amount = ? AND recipient_username = ?
        AND status = 'awaiting_payment'
      ORDER BY created_at DESC LIMIT 5
    `, [telegramId, type, amount, recipientUsername]);

    return candidates.find(o =>
      o.created_at >= cutoffIso &&
      Number(o.base_price_uzs || o.price_uzs) === Number(basePriceUzs) &&
      Number(o.balance_used_uzs || 0) === Number(balanceUsedUzs || 0) &&
      String(o.ton_memo || '') === String(tonMemo || '')
    ) || null;
  },

  expireStalePaynetTopups() {
    const nowIso = new Date().toISOString();
    const stale = queryOne("SELECT COUNT(*) as c FROM paynet_topups WHERE status = 'awaiting_payment' AND expires_at <= ?", [nowIso]);
    if (stale && Number(stale.c) > 0) {
      runSql("UPDATE paynet_topups SET status = 'expired', updated_at = ? WHERE status = 'awaiting_payment' AND expires_at <= ?", [nowIso, nowIso]);
    }
  },

  /**
   * Подбирает уникальную сумму оплаты (базовая цена + 1..50 сум) среди всех активных заказов и Paynet-пополнений.
   */
  allocateUniquePrice(basePriceUzs) {
    this.expireStalePaynetTopups();
    const cutoffMs = Date.now() - 90 * 60 * 1000;
    const activeOrders = queryAll(`
      SELECT price_uzs, card_pay_uzs, created_at FROM orders
      WHERE status IN ('awaiting_payment', 'pending')
    `);
    const activeTopups = queryAll(`
      SELECT expected_card_uzs, created_at FROM paynet_topups
      WHERE status IN ('awaiting_payment', 'pending')
    `);

    const usedPrices = new Set();
    for (const o of activeOrders) {
      const ts = parseCreatedMs(o.created_at);
      if (!isNaN(ts) && ts >= cutoffMs) {
        const pay = Number(o.card_pay_uzs || 0) > 0 ? Number(o.card_pay_uzs) : Number(o.price_uzs);
        usedPrices.add(pay);
      }
    }
    for (const t of activeTopups) {
      usedPrices.add(Number(t.expected_card_uzs));
    }

    const candidatesPrimary = [];
    for (let d = 1; d <= 50; d++) {
      const candidate = basePriceUzs + d;
      if (!usedPrices.has(candidate)) candidatesPrimary.push(candidate);
    }
    if (candidatesPrimary.length > 0) {
      return candidatesPrimary[Math.floor(Math.random() * candidatesPrimary.length)];
    }

    for (let d = 51; d <= 250; d++) {
      const candidate = basePriceUzs + d;
      if (!usedPrices.has(candidate)) return candidate;
    }
    return basePriceUzs + 1;
  },

  /**
   * Ищет активный заказ по точной сумме зачисления из CardXabar (созданный до поступления платежа).
   */
  findOrderForCardXabarPayment(receivedAmount, msgDateMs, cardLast4 = '') {
    const cutoffMs = Date.now() - 120 * 60 * 1000;
    const candidates = queryAll(`
      SELECT * FROM orders
      WHERE status IN ('awaiting_payment', 'pending')
      ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC
    `);

    const target = Number(receivedAmount);
    const cleanIncomingLast4 = String(cardLast4 || '').replace(/\D/g, '').slice(-4);
    for (const o of candidates) {
      const createdMs = parseCreatedMs(o.created_at);
      if (isNaN(createdMs) || createdMs < cutoffMs) continue;
      if (msgDateMs && createdMs > msgDateMs + 120 * 1000) continue;

      const orderLast4 = String(o.card_number || '').replace(/\D/g, '').slice(-4);
      if (cleanIncomingLast4 && orderLast4 && cleanIncomingLast4 !== orderLast4) continue;

      const expectedCardPay = Number(o.card_pay_uzs || 0) > 0 ? Number(o.card_pay_uzs) : Number(o.price_uzs);
      if (Number(o.balance_used_uzs || 0) > 0 && Number(o.card_pay_uzs || 0) === 0) continue;

      if (Math.abs(expectedCardPay - target) < 0.01) {
        return o;
      }
    }
    return null;
  },

  createPaynetTopup({ id, telegramId, buyerUsername, cashAmountUzs, feePct, expectedCardUzs, cardNumber, cardLast4, paynetTarget, expiresAt }) {
    const nowIso = new Date().toISOString();
    runSql(`
      INSERT INTO paynet_topups (id, telegram_id, buyer_username, cash_amount_uzs, fee_pct, expected_card_uzs, credited_uzs, card_number, card_last4, paynet_target, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'awaiting_payment', ?, ?, ?)
    `, [
      id,
      Number(telegramId),
      buyerUsername || '',
      Math.round(cashAmountUzs),
      Number(feePct),
      Math.round(expectedCardUzs),
      cardNumber,
      cardLast4 || '',
      paynetTarget || cardNumber,
      expiresAt,
      nowIso,
      nowIso
    ]);
  },

  getPaynetTopup(id) {
    this.expireStalePaynetTopups();
    return queryOne('SELECT * FROM paynet_topups WHERE id = ?', [id]);
  },

  getUserActiveTopups(telegramId) {
    this.expireStalePaynetTopups();
    return queryAll(`
      SELECT * FROM paynet_topups
      WHERE telegram_id = ? AND status IN ('awaiting_payment', 'pending')
      ORDER BY created_at DESC LIMIT 5
    `, [Number(telegramId)]);
  },

  getUserTopups(telegramId, limit = 15) {
    this.expireStalePaynetTopups();
    return queryAll(`
      SELECT * FROM paynet_topups
      WHERE telegram_id = ?
      ORDER BY created_at DESC LIMIT ?
    `, [Number(telegramId), limit]);
  },

  getAdminTopups(limit = 25) {
    this.expireStalePaynetTopups();
    return queryAll(`
      SELECT * FROM paynet_topups
      ORDER BY CASE WHEN status = 'pending' THEN 0 WHEN status = 'awaiting_payment' THEN 1 ELSE 2 END, created_at DESC
      LIMIT ?
    `, [limit]);
  },

  updatePaynetTopupStatus(id, status, extra = {}) {
    const nowIso = new Date().toISOString();
    if (extra.creditedUzs !== undefined) {
      runSql('UPDATE paynet_topups SET status = ?, credited_uzs = ?, updated_at = ? WHERE id = ?', [status, Math.round(extra.creditedUzs), nowIso, id]);
    } else {
      runSql('UPDATE paynet_topups SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso, id]);
    }
  },

  findReusableAwaitingPaynetTopup(telegramId, cashAmountUzs) {
    this.expireStalePaynetTopups();
    const minValidUntilIso = new Date(Date.now() + 60 * 1000).toISOString();
    return queryOne(`
      SELECT * FROM paynet_topups
      WHERE telegram_id = ? AND cash_amount_uzs = ? AND status = 'awaiting_payment' AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1
    `, [Number(telegramId), Math.round(cashAmountUzs), minValidUntilIso]);
  },

  allocatePaynetTopupSlot({ cashAmount, feePct, settings, minCash = 5000 }) {
    this.expireStalePaynetTopups();
    const pool = this.getPaynetCardPool(settings);
    const calcExpected = (c) => Math.round(c * (1 - Number(feePct) / 100));
    const expectedCardUzs = calcExpected(cashAmount);

    const pendingCutoffMs = Date.now() - 25 * 60 * 1000;
    const orderCutoffMs = Date.now() - 90 * 60 * 1000;

    const activeTopups = queryAll(`
      SELECT card_last4, expected_card_uzs, status, expires_at, created_at FROM paynet_topups
      WHERE status IN ('awaiting_payment', 'pending')
    `);
    const activeOrders = queryAll(`
      SELECT card_number, price_uzs, card_pay_uzs, created_at FROM orders
      WHERE status IN ('awaiting_payment', 'pending')
    `);

    const isBusyForCard = (cardLast4, expectedAmt) => {
      for (const t of activeTopups) {
        if (t.status === 'pending' && parseCreatedMs(t.created_at) < pendingCutoffMs) continue;
        if (Number(t.expected_card_uzs) === expectedAmt && (!t.card_last4 || !cardLast4 || t.card_last4 === cardLast4)) {
          return t;
        }
      }
      for (const o of activeOrders) {
        if (parseCreatedMs(o.created_at) < orderCutoffMs) continue;
        const pay = Number(o.card_pay_uzs || 0) > 0 ? Number(o.card_pay_uzs) : Number(o.price_uzs);
        const oL4 = String(o.card_number || '').replace(/\D/g, '').slice(-4);
        if (pay === expectedAmt && (!oL4 || !cardLast4 || oL4 === cardLast4)) {
          return { expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
        }
      }
      return null;
    };

    for (const card of pool) {
      const l4 = card.replace(/\D/g, '').slice(-4);
      if (!isBusyForCard(l4, expectedCardUzs)) {
        const displayTarget = (pool.length === 1 && String(settings.paynet_target || '').trim())
          ? String(settings.paynet_target).trim()
          : card;
        return {
          ok: true,
          cardNumber: card,
          cardLast4: l4,
          displayTarget,
          expectedCardUzs
        };
      }
    }

    let minExpiresMs = Date.now() + 10 * 60 * 1000;
    for (const card of pool) {
      const l4 = card.replace(/\D/g, '').slice(-4);
      const conflict = isBusyForCard(l4, expectedCardUzs);
      if (conflict && conflict.expires_at) {
        const ms = parseCreatedMs(conflict.expires_at);
        if (!isNaN(ms) && ms < minExpiresMs) minExpiresMs = ms;
      }
    }

    const retryAfterSec = Math.max(30, Math.ceil((minExpiresMs - Date.now()) / 1000));
    const suggestedAmounts = [];
    for (const delta of [1000, -1000, 2000, -2000, 3000, 5000]) {
      if (suggestedAmounts.length >= 2) break;
      const candCash = cashAmount + delta;
      if (candCash < minCash) continue;
      const candExpected = calcExpected(candCash);
      const hasFreeCard = pool.some(c => !isBusyForCard(c.replace(/\D/g, '').slice(-4), candExpected));
      if (hasFreeCard) {
        suggestedAmounts.push({ cashAmount: candCash, expectedCardUzs: candExpected });
      }
    }

    return {
      ok: false,
      code: 'SUM_BUSY',
      expectedCardUzs,
      retryAfterSec,
      suggestedAmounts
    };
  },

  findTopupForCardXabarPayment(receivedAmount, msgDateMs, cardLast4 = '') {
    this.expireStalePaynetTopups();
    const target = Number(receivedAmount);
    const cleanIncomingLast4 = String(cardLast4 || '').replace(/\D/g, '').slice(-4);
    const recentCutoffMs = Date.now() - 45 * 60 * 1000;
    const graceCutoffMs = Date.now() - 3 * 60 * 1000;

    const candidates = queryAll(`
      SELECT * FROM paynet_topups
      WHERE status IN ('pending', 'awaiting_payment', 'expired')
      ORDER BY CASE WHEN status = 'pending' THEN 0 WHEN status = 'awaiting_payment' THEN 1 ELSE 2 END, created_at ASC
    `);

    for (const t of candidates) {
      const createdMs = parseCreatedMs(t.created_at);
      if (isNaN(createdMs) || createdMs < recentCutoffMs) continue;
      if (msgDateMs && createdMs > msgDateMs + 120 * 1000) continue;

      if (t.status === 'expired') {
        const expMs = parseCreatedMs(t.expires_at);
        if (isNaN(expMs) || expMs < graceCutoffMs) continue;
      }

      if (cleanIncomingLast4 && t.card_last4 && cleanIncomingLast4 !== t.card_last4) continue;
      if (Math.abs(Number(t.expected_card_uzs) - target) < 0.01) {
        return t;
      }
    }
    return null;
  },

  confirmPaynetTopup(id, creditedUzs) {
    const topup = this.getPaynetTopup(id);
    if (!topup) return { ok: false, reason: 'not_found' };
    if (topup.status === 'confirmed') return { ok: false, reason: 'already_confirmed', topup };

    const amount = Math.round(Number(creditedUzs || topup.expected_card_uzs));
    this.updatePaynetTopupStatus(id, 'confirmed', { creditedUzs: amount });
    const adj = this.adjustUserBalance(topup.telegram_id, amount, 'paynet_topup', id);
    return {
      ok: true,
      topup: this.getPaynetTopup(id),
      creditedUzs: amount,
      newBalanceUzs: adj.newBalance
    };
  },

  isCardXabarMsgProcessed(msgId) {
    const row = queryOne('SELECT msg_id FROM processed_cardxabar_msgs WHERE msg_id = ?', [Number(msgId)]);
    return Boolean(row);
  },

  markCardXabarMsgProcessed(msgId, amount, cardLast4, orderId, rawText) {
    const nowIso = new Date().toISOString();
    runSql(`
      INSERT OR REPLACE INTO processed_cardxabar_msgs (msg_id, amount, card_last4, order_id, raw_text, processed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [Number(msgId), Number(amount), cardLast4 || '', orderId || '', rawText || '', nowIso]);
  },

  getRecentCardXabarLogs(limit = 10) {
    return queryAll('SELECT * FROM processed_cardxabar_msgs ORDER BY processed_at DESC LIMIT ?', [limit]);
  },

  getUserOrders(telegramId, limit = 20) {
    const rows = queryAll('SELECT * FROM orders WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 40', [telegramId]);
    const cutoffMs = Date.now() - 30 * 60 * 1000;
    return rows.filter(o => {
      if (o.status !== 'awaiting_payment') return true;
      return parseCreatedMs(o.created_at) >= cutoffMs;
    }).slice(0, limit);
  },

  getUserActiveOrders(telegramId) {
    return queryAll(`
      SELECT * FROM orders
      WHERE telegram_id = ? AND status IN ('pending', 'paid_processing')
      ORDER BY CASE WHEN status = 'paid_processing' THEN 0 ELSE 1 END, created_at DESC
    `, [telegramId]);
  },

  getAllOrders(limit = 50) {
    return queryAll('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?', [limit]);
  },

  getPendingOrders() {
    return queryAll(`
      SELECT * FROM orders
      WHERE status IN ('pending', 'paid_processing')
      ORDER BY CASE WHEN status = 'paid_processing' THEN 0 ELSE 1 END, created_at DESC
    `);
  },

  getStats() {
    const totalOrders = queryOne("SELECT COUNT(*) as count FROM orders WHERE status != 'awaiting_payment'") || { count: 0 };
    const pendingOrders = queryOne("SELECT COUNT(*) as count FROM orders WHERE status IN ('pending', 'paid_processing')") || { count: 0 };
    const confirmedOrders = queryOne("SELECT COUNT(*) as count, COALESCE(SUM(price_uzs), 0) as total FROM orders WHERE status IN ('confirmed', 'paid_processing')") || { count: 0, total: 0 };
    return {
      total: totalOrders.count,
      pending: pendingOrders.count,
      confirmed: confirmedOrders.count,
      revenue: confirmedOrders.total
    };
  },

  getProfitStats(settings = null) {
    const cfg = settings || this.getAllSettings();
    const paidOrders = queryAll(`
      SELECT type, amount, price_uzs, cost_uzs, ton_spent, status, created_at
      FROM orders
      WHERE status IN ('confirmed', 'paid_processing')
    `);

    const TZ_OFFSET_MS = 5 * 60 * 60 * 1000; // Asia/Tashkent UTC+5
    const nowShifted = Date.now() + TZ_OFFSET_MS;
    const d = new Date(nowShifted);
    const todayStartMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - TZ_OFFSET_MS;
    const weekStartMs = todayStartMs - 6 * 86400000;
    const monthStartMs = todayStartMs - 29 * 86400000;

    const makeBucket = () => ({
      orders: 0,
      confirmedOrders: 0,
      processingOrders: 0,
      starsCount: 0,
      premiumCount: 0,
      tonCount: 0,
      tonSoldAmount: 0,
      revenueUzs: 0,
      costUzs: 0,
      profitUzs: 0,
      marginPct: 0,
      tonSpent: 0
    });

    const buckets = {
      today: makeBucket(),
      week: makeBucket(),
      month: makeBucket(),
      all: makeBucket()
    };

    const addToBucket = (b, order, estCost) => {
      b.orders += 1;
      if (order.status === 'confirmed') b.confirmedOrders += 1;
      else b.processingOrders += 1;
      if (order.type === 'stars') b.starsCount += Number(order.amount || 0);
      else if (order.type === 'ton') {
        b.tonCount += 1;
        b.tonSoldAmount = Math.round((b.tonSoldAmount + Number(order.amount || 0)) * 10000) / 10000;
      } else b.premiumCount += 1;
      b.revenueUzs += Number(order.price_uzs || 0);
      b.costUzs += estCost;
      b.tonSpent += Number(order.ton_spent || 0);
    };

    for (const o of paidOrders) {
      const savedCost = Number(o.cost_uzs || 0);
      const estCost = savedCost > 0 ? savedCost : calculateCostUzs(o.type, o.amount, cfg);
      const ts = parseCreatedMs(o.created_at);

      addToBucket(buckets.all, o, estCost);
      if (!isNaN(ts)) {
        if (ts >= monthStartMs) addToBucket(buckets.month, o, estCost);
        if (ts >= weekStartMs) addToBucket(buckets.week, o, estCost);
        if (ts >= todayStartMs) addToBucket(buckets.today, o, estCost);
      }
    }

    for (const b of Object.values(buckets)) {
      b.profitUzs = b.revenueUzs - b.costUzs;
      b.marginPct = b.revenueUzs > 0 ? Math.round((b.profitUzs / b.revenueUzs) * 1000) / 10 : 0;
      b.tonSpent = Math.round(b.tonSpent * 10000) / 10000;
    }

    return buckets;
  }
};

module.exports = { initDatabase, dao, calculateCostUzs };
