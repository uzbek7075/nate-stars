const crypto = require('crypto');

/**
 * Верификация initData от Telegram WebApp
 * Проверяет подлинность данных, полученных из Mini App
 */
function validateInitData(initData, botToken) {
  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  // Собираем строку для проверки
  params.delete('hash');
  const entries = [...params.entries()];
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  // HMAC-SHA-256 с ключом, полученным из токена бота
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (hmac !== hash) return null;

  // Парсим user из initData
  const userStr = params.get('user');
  if (!userStr) return null;

  try {
    return JSON.parse(userStr);
  } catch {
    return null;
  }
}

/**
 * Express middleware для проверки Telegram авторизации
 */
function authMiddleware(botToken) {
  return (req, res, next) => {
    const initData = req.headers['x-telegram-init-data'] || req.query.initData;
    
    if (initData) {
      const user = validateInitData(initData, botToken);
      if (user) {
        req.telegramUser = user;
        return next();
      }
    }

    // Если запрос из обычного браузера (для превью / тестов)
    const isLocalOrPreview = req.hostname === 'localhost' || req.hostname === '127.0.0.1' || !initData;
    if (isLocalOrPreview) {
      req.telegramUser = {
        id: 777000,
        username: 'nate_guest',
        first_name: 'Гость Nate Stars',
        last_name: ''
      };
      return next();
    }

    return res.status(401).json({ error: 'Invalid or missing Telegram init data' });
  };
}

module.exports = { validateInitData, authMiddleware };
