/**
 * Nate Stars — TON Auto-Rate Engine (Asterium-aligned)
 * Получает рыночный курс TON/USD (TonAPI -> резерв CoinGecko) и USD/UZS (ЦБ Уз cbu.uz),
 * подгоняет закуп с учётом спреда провайдера (по умолчанию +3% под Asterium)
 * и рассчитывает итоговую цену продажи (фикс +UZS или +%).
 */

const { dao } = require('./database');

const CBU_CACHE_MS = 60 * 60 * 1000;
let cbuCache = { rate: 0, fetchedAt: 0 };

async function fetchJsonWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'NateStars-RateEngine/1.0' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTonUsdRate() {
  try {
    const data = await fetchJsonWithTimeout('https://tonapi.io/v2/rates?tokens=ton&currencies=usd', 5000);
    const price = Number(data?.rates?.TON?.prices?.USD);
    if (Number.isFinite(price) && price > 0) {
      return { price, source: 'tonapi' };
    }
  } catch (e) {}

  try {
    const cg = await fetchJsonWithTimeout('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd', 5000);
    const price = Number(cg?.['the-open-network']?.usd);
    if (Number.isFinite(price) && price > 0) {
      return { price, source: 'coingecko' };
    }
  } catch (e) {}

  const cached = Number(dao.getSetting('last_ton_usd') || 0);
  if (cached > 0) {
    return { price: cached, source: 'cache' };
  }
  throw new Error('Не удалось получить курс TON/USD');
}

async function fetchUsdUzsRate({ force = false } = {}) {
  const now = Date.now();
  if (!force && cbuCache.rate > 0 && (now - cbuCache.fetchedAt) < CBU_CACHE_MS) {
    return { rate: cbuCache.rate, source: 'cbu_cache' };
  }

  try {
    const data = await fetchJsonWithTimeout('https://cbu.uz/ru/arkhiv-kursov-valyut/json/USD/', 5000);
    const rate = Number(Array.isArray(data) ? data[0]?.Rate : data?.Rate);
    if (Number.isFinite(rate) && rate > 1000) {
      cbuCache = { rate, fetchedAt: now };
      dao.setSetting('last_cbu_usd_uzs', String(rate));
      return { rate, source: 'cbu.uz' };
    }
  } catch (e) {}

  const fallbackRate = cbuCache.rate || Number(dao.getSetting('last_cbu_usd_uzs') || 0);
  if (fallbackRate > 1000) {
    return { rate: fallbackRate, source: 'db_cache' };
  }
  throw new Error('Не удалось получить курс USD/UZS');
}

/**
 * Чистый расчёт цены закупа и продажи TON по заданным курсам и настройкам.
 */
function calculateTonPricing({ tonUsd, usdUzs, settings }) {
  const spreadPct = Number(settings.ton_provider_spread_pct ?? 3);
  const markupMode = settings.ton_markup_mode === 'percent' ? 'percent' : 'fixed';
  const markupUzs = Number(settings.ton_markup_uzs ?? 2000);
  const markupPct = Number(settings.ton_markup_pct ?? 15);
  const minFloorUzs = Number(settings.ton_min_floor_uzs || 0);

  const rawMarketUzs = tonUsd * usdUzs;
  const purchaseCostUzs = Math.round(rawMarketUzs * (1 + spreadPct / 100));

  const rawSellUzs = markupMode === 'percent'
    ? purchaseCostUzs * (1 + markupPct / 100)
    : purchaseCostUzs + markupUzs;

  // Красивое округление вверх до ближайших 100 сум (например, 10000 + 2000 = 12000; 13953 -> 14000)
  let sellPriceUzs = Math.ceil(rawSellUzs / 100) * 100;
  if (minFloorUzs > 0 && sellPriceUzs < minFloorUzs) {
    sellPriceUzs = minFloorUzs;
  }

  return {
    tonUsd: Math.round(tonUsd * 10000) / 10000,
    usdUzs: Math.round(usdUzs * 100) / 100,
    rawMarketUzs: Math.round(rawMarketUzs),
    providerSpreadPct: spreadPct,
    purchaseCostUzs,
    markupMode,
    markupUzs,
    markupPct,
    minFloorUzs,
    sellPriceUzs
  };
}

/**
 * Запрашивает актуальные курсы и обновляет ton_price_uzs / cost_ton_uzs, если автокурс включён.
 */
async function refreshTonRate({ force = false } = {}) {
  const settings = dao.getAllSettings();
  const autoEnabled = settings.ton_auto_rate_enabled !== 'false';

  const [tonRes, usdRes] = await Promise.all([
    fetchTonUsdRate(),
    fetchUsdUzsRate({ force })
  ]);

  if (tonRes.source !== 'cache') {
    dao.setSetting('last_ton_usd', String(tonRes.price));
  }

  const calc = calculateTonPricing({
    tonUsd: tonRes.price,
    usdUzs: usdRes.rate,
    settings
  });

  const currentCost = Number(settings.cost_ton_uzs || 0);
  const currentPrice = Number(settings.ton_price_uzs || 0);
  let priceUpdated = false;

  if (autoEnabled) {
    if (force || Math.abs(calc.purchaseCostUzs - currentCost) >= 10) {
      dao.setSetting('cost_ton_uzs', String(calc.purchaseCostUzs));
    }
    if (force || Math.abs(calc.sellPriceUzs - currentPrice) >= 100 || currentPrice <= 0) {
      dao.setSetting('ton_price_uzs', String(calc.sellPriceUzs));
      priceUpdated = true;
    }
  }

  const snapshot = {
    ...calc,
    autoEnabled,
    priceUpdated,
    effectivePriceUzs: autoEnabled && priceUpdated ? calc.sellPriceUzs : Number(dao.getSetting('ton_price_uzs') || calc.sellPriceUzs),
    tonSource: tonRes.source,
    usdSource: usdRes.source,
    updatedAt: new Date().toISOString()
  };

  dao.setSetting('ton_rate_snapshot', JSON.stringify(snapshot));
  return snapshot;
}

function getSavedTonRateSnapshot() {
  try {
    const raw = dao.getSetting('ton_rate_snapshot');
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

module.exports = {
  refreshTonRate,
  calculateTonPricing,
  getSavedTonRateSnapshot
};
