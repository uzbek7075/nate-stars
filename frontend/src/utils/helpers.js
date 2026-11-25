/**
 * Nate Stars — Helpers (UZS Edition - Clean Vector Icons)
 */

const Helpers = (() => {

  // Форматирование сум: 100000 -> "100 000 сум"
  function formatUzs(amount) {
    if (isNaN(amount)) return '0 сум';
    return Number(amount).toLocaleString('ru-RU') + ' сум';
  }

  // Корректный парсинг даты с учетом UTC таймзоны
  function parseDate(dateStr) {
    if (!dateStr) return null;
    let s = String(dateStr).trim();
    // SQLite datetime('now') возвращает "YYYY-MM-DD HH:MM:SS" (UTC без суффикса Z)
    if (s.includes(' ') && !s.includes('T')) {
      s = s.replace(' ', 'T');
    }
    if (!s.endsWith('Z') && !s.includes('+') && !s.includes('-', 10)) {
      s += 'Z';
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? new Date(dateStr) : d;
  }

  // Форматирование даты
  function formatDate(dateStr) {
    if (!dateStr) return '';
    const date = parseDate(dateStr);
    if (!date || isNaN(date.getTime())) return '';

    const now = new Date();
    const diff = Math.max(0, now - date);

    if (diff < 60000) return 'Только что';
    if (diff < 3600000) {
      const mins = Math.max(1, Math.floor(diff / 60000));
      return `${mins} мин. назад`;
    }
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return `${hours} ч. назад`;
    }

    return date.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // Форматирование номера карты с пробелами: "5614 6818 1626 5841"
  function formatCardNumber(num) {
    if (!num) return '';
    const clean = String(num).replace(/\s+/g, '');
    return clean.replace(/(\d{4})/g, '$1 ').trim();
  }

  // Статус заказа — строгие чистые бейджи без смайлов
  function statusBadge(status) {
    switch (status) {
      case 'confirmed':
        return '<span class="status-badge-clean confirmed">Выполнен</span>';
      case 'rejected':
        return '<span class="status-badge-clean rejected">Отклонён</span>';
      case 'awaiting_payment':
        return '<span class="status-badge-clean pending">Ожидает оплаты</span>';
      default:
        return '<span class="status-badge-clean pending">В обработке</span>';
    }
  }

  function copyText(text, successMsg = 'Скопировано') {
    const val = String(text || '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(val).catch(() => {});
    } else {
      const el = document.createElement('textarea');
      el.value = val;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    haptic('success');
    showToast(successMsg);
  }

  // Показать toast-уведомление
  function showToast(message, duration = 2500) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration);
  }

  // Вибрация (Haptic)
  function haptic(type = 'light') {
    if (window.Telegram?.WebApp?.HapticFeedback) {
      switch (type) {
        case 'light':
          window.Telegram.WebApp.HapticFeedback.impactOccurred('light');
          break;
        case 'medium':
          window.Telegram.WebApp.HapticFeedback.impactOccurred('medium');
          break;
        case 'success':
          window.Telegram.WebApp.HapticFeedback.notificationOccurred('success');
          break;
        case 'error':
          window.Telegram.WebApp.HapticFeedback.notificationOccurred('error');
          break;
      }
    }
  }

  return { formatUzs, formatDate, formatCardNumber, statusBadge, showToast, haptic, copyText };
})();
