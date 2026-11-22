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
      card_number TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      sender_comment TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
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
    'ton_wallet_mnemonic': ''
  };

  for (const [key, val] of Object.entries(defaultSettings)) {
    const res = db.exec(`SELECT value FROM settings WHERE key = '${key}'`);
    if (res.length === 0 || res[0].values.length === 0) {
      db.run(`INSERT INTO settings (key, value) VALUES (?, ?)`, [key, val]);
    }
  }

  // Всегда гарантируем актуальные ID владельца и группы
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_ids', '5379376281')");
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('orders_chat_id', '-1003724696975')");

  // Авторизация Fragment (гарантированное сохранение сессии)
  let fragmentToken = process.env.FRAGMENT_JWT_TOKEN || '';
  const tokenFilePath = path.join(__dirname, 'fragment_token.txt');
  if (!fragmentToken && fs.existsSync(tokenFilePath)) {
    try {
      fragmentToken = fs.readFileSync(tokenFilePath, 'utf8').trim();
    } catch (e) {}
  }
  if (fragmentToken) {
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('fragment_jwt_token', ?)", [fragmentToken]);
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('fragment_enabled', 'true')");
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('fragment_phone', '+998930690203')");
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('fragment_mnemonics', 'harbor age artwork marble cram manage dolphin evolve walnut firm dose dynamic lift castle eye boil guilt minute feel diesel search top void door')");
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('fragment_api_key', ?)", [fragmentToken]);
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('fragment_jwt_saved_at', ?)", [new Date().toISOString()]);
  }

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

  createOrder({ id, telegramId, buyerUsername, recipientUsername, type, amount, priceUzs, cardNumber, senderComment }) {
    const nowIso = new Date().toISOString();
    runSql(`
      INSERT INTO orders (id, telegram_id, buyer_username, recipient_username, type, amount, price_uzs, card_number, status, sender_comment, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `, [id, telegramId, buyerUsername, recipientUsername, type, amount, priceUzs, cardNumber, senderComment || '', nowIso, nowIso]);
  },

  getOrder(id) {
    return queryOne('SELECT * FROM orders WHERE id = ?', [id]);
  },

  updateOrderStatus(id, status) {
    const nowIso = new Date().toISOString();
    runSql(`
      UPDATE orders SET status = ?, updated_at = ? WHERE id = ?
    `, [status, nowIso, id]);
  },

  getUserOrders(telegramId, limit = 20) {
    return queryAll('SELECT * FROM orders WHERE telegram_id = ? ORDER BY created_at DESC LIMIT ?', [telegramId, limit]);
  },

  getAllOrders(limit = 50) {
    return queryAll('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?', [limit]);
  },

  getPendingOrders() {
    return queryAll("SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at DESC");
  },

  getStats() {
    const totalOrders = queryOne('SELECT COUNT(*) as count FROM orders') || { count: 0 };
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
