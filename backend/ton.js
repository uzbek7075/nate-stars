/**
 * Nate Stars — Direct TON Blockchain Transfer Engine (W5 / V5R1)
 * Автоматическая отправка TON покупателям напрямую через сеть TON.
 * Включает строгую очередь по seqno, проверку адреса и защиту от 429 rate-limit.
 */

const { mnemonicToPrivateKey } = require('@ton/crypto');
const { Address, beginCell, comment, external, internal, storeMessage, toNano } = require('@ton/core');
const { SendMode, WalletContractV5R1 } = require('@ton/ton');
const { dao } = require('./database');

const TONCENTER_BASE = 'https://toncenter.com/api/v2';
const GAS_RESERVE_TON = 0.05;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTonAmount(num) {
  const n = Number(num);
  if (!Number.isFinite(n)) return '0';
  return Number(n.toFixed(4)).toString();
}

async function toncenterRequest(method, { query = null, body = null } = {}) {
  const settings = dao.getAllSettings();
  const apiKey = (process.env.TONCENTER_API_KEY || settings.toncenter_api_key || '').trim();
  const headers = {
    'User-Agent': 'NateStars-TON/1.0',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(apiKey ? { 'X-API-Key': apiKey } : {})
  };

  let url = `${TONCENTER_BASE}/${method}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }

  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      await sleep(1250 * attempt);
    }
    try {
      const res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 429 || (data && data.code === 429)) {
        lastErr = new Error('Toncenter 429 rate limit');
        continue;
      }
      if (!res.ok || !data || data.ok === false) {
        const msg = data?.error || data?.result || `Toncenter HTTP ${res.status}`;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      }
      return data.result;
    } catch (err) {
      lastErr = err;
      if (!/429|fetch|network|timeout|ECONNRESET/i.test(err.message || '') && attempt >= 1) {
        throw err;
      }
    }
  }
  throw lastErr || new Error('Ошибка запроса к Toncenter API');
}

/**
 * Проверяет и нормализует TON-адрес получателя (форматы UQ..., EQ..., raw 0:...).
 */
function parseAndValidateAddress(rawAddress, { ownWalletAddress = '' } = {}) {
  const raw = String(rawAddress || '').trim();
  if (!raw) {
    return { valid: false, status: 'empty', reason: 'Укажите TON-адрес кошелька' };
  }

  let addr = null;
  let isBounceableInput = false;
  let isTestOnly = false;

  try {
    if (/^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$/.test(raw)) {
      const friendly = Address.parseFriendly(raw);
      addr = friendly.address;
      isBounceableInput = friendly.isBounceable;
      isTestOnly = friendly.isTestOnly;
    } else {
      addr = Address.parse(raw);
    }
  } catch (e) {
    return {
      valid: false,
      status: 'invalid_address',
      reason: 'Некорректный TON-адрес. Проверьте адрес из кошелька (UQ... или EQ...)'
    };
  }

  if (isTestOnly) {
    return {
      valid: false,
      status: 'testnet_address',
      reason: 'Указан адрес тестовой сети (testnet). Нужен обычный адрес TON Mainnet.'
    };
  }

  const nonBounceable = addr.toString({ bounceable: false, urlSafe: true });
  const bounceable = addr.toString({ bounceable: true, urlSafe: true });

  if (ownWalletAddress) {
    try {
      const ownNorm = Address.parse(ownWalletAddress).toString({ bounceable: false, urlSafe: true });
      if (ownNorm === nonBounceable) {
        return {
          valid: false,
          status: 'own_wallet',
          reason: 'Указан адрес самого магазина. Введите адрес вашего личного кошелька.'
        };
      }
    } catch (e) {}
  }

  return {
    valid: true,
    status: 'ok',
    address: nonBounceable,
    bounceableAddress: bounceable,
    rawInput: raw,
    isBounceableInput,
    workchain: addr.workChain,
    shortAddress: `${nonBounceable.slice(0, 6)}...${nonBounceable.slice(-6)}`
  };
}

class TonTransferServiceImpl {
  constructor() {
    this._queue = Promise.resolve();
  }

  enqueue(task) {
    const run = this._queue.then(task, task);
    this._queue = run.catch(() => {});
    return run;
  }

  getMnemonicWords() {
    const settings = dao.getAllSettings();
    const raw = (
      process.env.TON_MNEMONIC ||
      process.env.FRAGMENT_MNEMONICS ||
      settings.fragment_mnemonics ||
      ''
    ).trim();
    const words = raw.split(/\s+/).filter(Boolean);
    return words;
  }

  async deriveWallet() {
    const words = this.getMnemonicWords();
    if (words.length < 12) {
      throw new Error('Не настроена seed-фраза TON-кошелька');
    }
    const keyPair = await mnemonicToPrivateKey(words);
    const wallet = WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey });
    return { wallet, keyPair };
  }

  /**
   * Отправляет TON по заказу через последовательную очередь seqno.
   */
  sendOrderTon(order) {
    return this.enqueue(() => this._executeOrderTransfer(order));
  }

  async _executeOrderTransfer(order) {
    const amountTon = Number(order.amount);
    if (!Number.isFinite(amountTon) || amountTon <= 0) {
      return { success: false, error: 'Некорректное количество TON', manualRequired: true };
    }

    const { wallet, keyPair } = await this.deriveWallet();
    const ownAddress = wallet.address.toString({ bounceable: false, urlSafe: true });

    const parsed = parseAndValidateAddress(order.recipient_username, { ownWalletAddress: ownAddress });
    if (!parsed.valid) {
      return { success: false, error: parsed.reason, manualRequired: true };
    }

    const targetAddress = Address.parse(parsed.rawInput);
    const memo = String(order.ton_memo || '').trim();

    console.log(`💎 [TON Transfer] Подготовка отправки ${formatTonAmount(amountTon)} TON на ${parsed.address} (#${order.id})...`);

    try {
      // 1. Получаем актуальные баланс и seqno одним запросом
      const info = await toncenterRequest('getWalletInformation', { query: { address: ownAddress } });
      const balanceTon = Number(info.balance || 0) / 1e9;
      const currentSeqno = Number(info.seqno || 0);

      if (balanceTon < amountTon + GAS_RESERVE_TON) {
        const msg = `Недостаточно TON на кошельке (${balanceTon.toFixed(3)} TON, нужно ${formatTonAmount(amountTon + GAS_RESERVE_TON)} TON с учётом комиссии).`;
        console.warn(`⚠️ [TON Balance] ${msg}`);
        return { success: false, error: msg, manualRequired: true };
      }

      // 2. Если пользователь указал EQ..., проверяем, активирован ли контракт получателя
      let useBounce = false;
      if (parsed.isBounceableInput) {
        await sleep(1100);
        try {
          const destInfo = await toncenterRequest('getAddressInformation', { query: { address: parsed.bounceableAddress } });
          if (destInfo && destInfo.state === 'active') {
            useBounce = true;
          }
        } catch (e) {
          useBounce = false;
        }
      }

      // 3. Собираем и подписываем W5-перевод
      const amountNano = toNano(formatTonAmount(amountTon));
      const body = memo ? comment(memo) : undefined;

      const transferBody = wallet.createTransfer({
        seqno: currentSeqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [
          internal({
            to: targetAddress,
            value: amountNano,
            bounce: useBounce,
            body
          })
        ]
      });

      const extMsg = external({
        to: wallet.address,
        init: currentSeqno === 0 ? wallet.init : undefined,
        body: transferBody
      });
      const bocBase64 = beginCell().store(storeMessage(extMsg)).endCell().toBoc().toString('base64');

      // 4. Отправляем в блокчейн
      await sleep(1100);
      const sendRes = await toncenterRequest('sendBocReturnHash', { body: { boc: bocBase64 } });
      const msgHash = (sendRes && sendRes.hash) ? String(sendRes.hash) : '';

      // 5. Ждём подтверждения seqno в блокчейне (до ~16 сек)
      let confirmedSeqno = false;
      for (let i = 0; i < 6; i++) {
        await sleep(2500);
        try {
          const check = await toncenterRequest('getWalletInformation', { query: { address: ownAddress } });
          if (Number(check.seqno || 0) > currentSeqno) {
            confirmedSeqno = true;
            break;
          }
        } catch (pollErr) {
          console.warn('TON seqno poll warn:', pollErr.message);
        }
      }

      // Если seqno успел вырасти — достаём реальный хэш транзакции (если доступен)
      let finalTxHash = msgHash;
      if (confirmedSeqno) {
        await sleep(1100);
        try {
          const txs = await toncenterRequest('getTransactions', { query: { address: ownAddress, limit: '2' } });
          if (Array.isArray(txs) && txs[0]?.transaction_id?.hash) {
            finalTxHash = txs[0].transaction_id.hash;
          }
        } catch (txErr) {}
      }

      if (finalTxHash && !/^[a-fA-F0-9]{64}$/.test(finalTxHash)) {
        try {
          const hex = Buffer.from(finalTxHash, 'base64').toString('hex');
          if (hex.length === 64) finalTxHash = hex;
        } catch (e) {}
      }

      console.log(`✅ [TON Transfer] Заказ #${order.id}: ${formatTonAmount(amountTon)} TON отправлено на ${parsed.address} (confirmed=${confirmedSeqno})`);
      return {
        success: true,
        mode: 'direct_ton_w5',
        txHash: finalTxHash,
        confirmedSeqno,
        tonSpent: amountTon + 0.01,
        message: `Отправлено ${formatTonAmount(amountTon)} TON на ${parsed.shortAddress}`,
        deliveredAt: new Date().toISOString()
      };
    } catch (err) {
      console.error(`❌ [TON Transfer] Ошибка отправки #${order.id}:`, err.message);
      return {
        success: false,
        error: `Ошибка отправки TON: ${err.message}`,
        manualRequired: true
      };
    }
  }
}

const TonTransferService = new TonTransferServiceImpl();

module.exports = { TonTransferService, parseAndValidateAddress, formatTonAmount };
