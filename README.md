# ⭐ Nate Stars

Telegram Mini App для продажи **Telegram Stars** и **Telegram Premium** подписок.

---

## 🏗 Архитектура

```
Пользователь открывает Mini App
        ↓
  Выбирает товар (Stars / Premium)
        ↓
  Frontend → POST /api/create-invoice → Backend
        ↓
  Backend создаёт Invoice через Telegram Bot API (XTR)
        ↓
  Frontend получает invoiceLink и вызывает WebApp.openInvoice()
        ↓
  Telegram показывает нативное окно оплаты
        ↓
  Пользователь подтверждает оплату Stars
        ↓
  Bot получает pre_checkout_query → подтверждает
        ↓
  Bot получает successful_payment → доставляет товар
        ↓
  Для Stars: начисляет на баланс
  Для Premium: вызывает giftPremiumSubscription()
```

## 📦 Структура проекта

```
nate-stars/
├── backend/
│   ├── server.js        # Express + Telegraf сервер
│   ├── database.js      # SQLite база данных + DAO
│   ├── auth.js          # Верификация Telegram initData
│   ├── package.json
│   ├── .env             # Конфигурация (BOT_TOKEN)
│   └── .env.example
│
└── frontend/
    ├── index.html       # Главная страница Mini App
    └── src/
        ├── app.js       # Основная логика
        ├── styles/
        │   └── main.css # Стили (Deep Blue Theme)
        └── utils/
            ├── api.js   # HTTP-клиент для бэкенда
            └── helpers.js
```

## 🚀 Запуск

### 1. Создайте бота
- Перейдите к [@BotFather](https://t.me/BotFather)
- Создайте бота: `/newbot`
- Включите платежи через Stars: `/mybots` → Payments → Telegram Stars
- Скопируйте токен

### 2. Настройте .env
```bash
cd backend
# Отредактируйте .env, вставьте свой BOT_TOKEN
```

### 3. Установите зависимости
```bash
cd backend
npm install
```

### 4. Запустите сервер
```bash
npm start
```

### 5. Настройте Mini App
- В @BotFather: `/mybots` → Bot Settings → Menu Button
- Или используйте `/setmenubutton`
- Укажите URL вашего развёрнутого фронтенда

## 🌐 Деплой

Для работы Mini App нужен HTTPS. Варианты:
- **ngrok** (для тестирования): `ngrok http 3001`
- **VPS + Nginx + Let's Encrypt** (для продакшена)
- **Railway / Render / Vercel** (для быстрого деплоя)

## 💰 Как работает монетизация

1. Пользователь платит **Telegram Stars (XTR)** через нативный интерфейс
2. Stars копятся на балансе бота
3. Через **21 день** Stars можно вывести на **Fragment** → конвертировать в **TON** → продать за фиат

## 🔒 Безопасность

- Все запросы к API проверяются через `initData` (HMAC-SHA-256)
- Платежи идут через официальный Telegram Bot API
- Идемпотентность: дублирующиеся `successful_payment` не обрабатываются повторно
- `provider_token` пустой — только для Stars, минуя сторонние платежные системы

## 📄 Лицензия

MIT
