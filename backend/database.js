const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'nate_stars.db');

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
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

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
      card_number TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      sender_comment TEXT,
      payment_source TEXT DEFAULT 'manual',
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
    if (!orderCols.includes('payment_source')) {
      db.run("ALTER TABLE orders ADD COLUMN payment_source TEXT DEFAULT 'manual'");
    }
  } catch (e) {
    console.warn('Миграция orders:', e.message);
  }

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
    'star_price_uzs': '220',
    'min_stars': '50',
    'card_number': '5614681816265841',
    'card_holder': 'Карта для перевода (Uzcard / Humo)',
    'premium_3_uzs': '175000',
    'premium_6_uzs': '245000',
    'premium_12_uzs': '395000',
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
    'tg_phone': ''
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

  // Авторизация Fragment (гарантированное сохранение настроек)
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('fragment_enabled', 'true')");
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('fragment_phone', '+998930690203')");
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('fragment_mnemonics', 'harbor age artwork marble cram manage dolphin evolve walnut firm dose dynamic lift castle eye boil guilt minute feel diesel search top void door')");
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
    runSql(`
      INSERT INTO users (telegram_id, username, first_name, last_name)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name
    `, [telegramId, username || '', firstName || '', lastName || '']);
  },

  getUser(telegramId) {
    return queryOne('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
  },

  createOrder({ id, telegramId, buyerUsername, recipientUsername, type, amount, priceUzs, basePriceUzs, cardNumber, status, senderComment, paymentSource }) {
    const nowIso = new Date().toISOString();
    runSql(`
      INSERT INTO orders (id, telegram_id, buyer_username, recipient_username, type, amount, price_uzs, base_price_uzs, card_number, status, sender_comment, payment_source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      telegramId,
      buyerUsername,
      recipientUsername,
      type,
      amount,
      priceUzs,
      basePriceUzs || priceUzs,
      cardNumber,
      status || 'pending',
      senderComment || '',
      paymentSource || 'manual',
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
  findReusableAwaitingOrder({ telegramId, type, amount, recipientUsername, basePriceUzs }) {
    const cutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const candidates = queryAll(`
      SELECT * FROM orders
      WHERE telegram_id = ? AND type = ? AND amount = ? AND recipient_username = ?
        AND status = 'awaiting_payment'
      ORDER BY created_at DESC LIMIT 5
    `, [telegramId, type, amount, recipientUsername]);

    return candidates.find(o =>
      o.created_at >= cutoffIso &&
      Number(o.base_price_uzs || o.price_uzs) === Number(basePriceUzs)
    ) || null;
  },

  /**
   * Подбирает уникальную сумму оплаты (базовая цена + 1..99 сум) среди всех активных заказов,
   * чтобы однозначно определить покупателя по сообщению CardXabar.
   */
  allocateUniquePrice(basePriceUzs) {
    const cutoffIso = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const activeOrders = queryAll(`
      SELECT price_uzs, created_at FROM orders
      WHERE status IN ('awaiting_payment', 'pending')
    `);

    const usedPrices = new Set();
    for (const o of activeOrders) {
      const ts = Date.parse(o.created_at.includes('T') ? o.created_at : o.created_at.replace(' ', 'T') + 'Z');
      if (!isNaN(ts) && ts >= Date.parse(cutoffIso)) {
        usedPrices.add(Number(o.price_uzs));
      }
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
  findOrderForCardXabarPayment(receivedAmount, msgDateMs) {
    const cutoffMs = Date.now() - 120 * 60 * 1000;
    const candidates = queryAll(`
      SELECT * FROM orders
      WHERE status IN ('awaiting_payment', 'pending')
      ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC
    `);

    const target = Number(receivedAmount);
    for (const o of candidates) {
      const createdStr = o.created_at.includes('T') ? o.created_at : o.created_at.replace(' ', 'T') + 'Z';
      const createdMs = Date.parse(createdStr);
      if (isNaN(createdMs) || createdMs < cutoffMs) continue;
      // Платёж должен поступить не раньше создания заказа (допуск 2 минуты на рассинхрон часов)
      if (msgDateMs && createdMs > msgDateMs + 120 * 1000) continue;

      if (Math.abs(Number(o.price_uzs) - target) < 0.01) {
        return o;
      }
    }
    return null;
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
      const createdStr = o.created_at.includes('T') ? o.created_at : o.created_at.replace(' ', 'T') + 'Z';
      return Date.parse(createdStr) >= cutoffMs;
    }).slice(0, limit);
  },

  getAllOrders(limit = 50) {
    return queryAll('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?', [limit]);
  },

  getPendingOrders() {
    return queryAll("SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at DESC");
  },

  getStats() {
    const totalOrders = queryOne("SELECT COUNT(*) as count FROM orders WHERE status != 'awaiting_payment'") || { count: 0 };
    const pendingOrders = queryOne("SELECT COUNT(*) as count FROM orders WHERE status = 'pending'") || { count: 0 };
    const confirmedOrders = queryOne("SELECT COUNT(*) as count, COALESCE(SUM(price_uzs), 0) as total FROM orders WHERE status = 'confirmed'") || { count: 0, total: 0 };
    return {
      total: totalOrders.count,
      pending: pendingOrders.count,
      confirmed: confirmedOrders.count,
      revenue: confirmedOrders.total
    };
  }
};

module.exports = { initDatabase, dao };
