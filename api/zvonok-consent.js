// api/zvonok-consent.js
// Vercel Node.js Serverless Function
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST' && req.method !== 'GET') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const {
      WEBHOOK_TOKEN,
      SALEBOT_API_KEY,
      SALEBOT_BOT_ID,
      DEFAULT_MESSAGE = 'Спасибо за согласие! Пришлю детали вебинара сюда 😊',
      FORCE_COUNTRY_CODE = '7', // под свои правила: '7' для РФ, '380' для UA и т.д.
    } = process.env;

    if (!WEBHOOK_TOKEN || !SALEBOT_API_KEY || !SALEBOT_BOT_ID) {
      return res.status(500).json({ error: 'env_missing' });
    }

    // 1) Валидация простым токеном из query (?token=...)
    if (req.query?.token !== WEBHOOK_TOKEN) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    // 2) Получаем сырое тело (Vercel даёт Node IncomingMessage)
    const raw = await readBody(req);

    // 3) Парсим тело: JSON или x-www-form-urlencoded
    const ct = (req.headers['content-type'] || '').toLowerCase();
    let body = {};
    if (ct.includes('application/json')) {
      body = safeJson(raw);
    } else if (ct.includes('application/x-www-form-urlencoded')) {
      body = Object.fromEntries(new URLSearchParams(raw));
    } else {
      // text/plain, multipart/form-data и прочее — оставим как есть
      // (на multipart всё равно сделаем fallback-поиск телефонов в raw)
      body = safeJson(raw);
      if (Object.keys(body).length === 0) body = { ...req.query };
    }

    // 4) Достаём номер из возможных полей
    let candidate =
      body.phone ||
      body.number ||
      body.client_phone ||
      body.abonent_number ||
      body.caller ||
      body.to ||
      body.ct_phone ||
      body.ct_phone8 ||
      body.ct_phone9 ||
      req.query.phone ||
      req.query.number ||
      req.query.client_phone ||
      req.query.abonent_number ||
      req.query.caller ||
      req.query.to ||
      req.query.ct_phone ||
      req.query.ct_phone8 ||
      req.query.ct_phone9 ||
      '';

    // 4.1) Если всё ещё пусто — попробуем вытащить из любого поля/сырого тела
    if (!candidate)
      candidate =
        extractPhoneFromAny(body) ||
        extractPhoneFromAny(req.query) ||
        extractPhoneFromText(raw);

    const phone = normalizePhone(candidate, FORCE_COUNTRY_CODE);
    if (!phone) {
      // опционально можно логировать для дебага
      console.warn('phone_not_found', {
        query: req.query,
        ct,
        raw: raw?.slice?.(0, 512),
      });
      return res.status(200).json({ ok: true, skipped: 'phone_not_found' });
    }

    // 5) Дергаем SaleBot whatsapp_callback
    const url = `https://chatter.salebot.pro/api/${SALEBOT_API_KEY}/whatsapp_callback`;
    const payload = {
      phone,
      bot_id: SALEBOT_BOT_ID,
      message: DEFAULT_MESSAGE,
      source: 'zvonok-consent',
      ts: new Date().toISOString(),
    };

    const sbResp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text = await sbResp.text();
    if (!sbResp.ok) {
      console.error('SaleBot error:', sbResp.status, text);
      return res.status(502).json({ error: 'salebot_failed', details: text });
    }

    return res.status(200).json({ ok: true, sent_to_salebot: phone });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal' });
  }
}

// ——— helpers ———
function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function normalizePhone(input, defaultCountry = '7') {
  if (!input) return '';
  const digits = String(input).replace(/[^\d]/g, '');

  // Очень простой нормалайзер (под РФ по умолчанию):
  if (digits.length === 11 && digits.startsWith('8'))
    return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith('7')) return `+${digits}`;
  if (digits.length === 10) return `+${defaultCountry}${digits}`;

  // Если уже есть код страны (12+ знаков): просто добавим +
  if (digits.length >= 11) return `+${digits}`;
  return '';
}

async function readBody(req) {
  if (req.method === 'GET') return '';
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function extractPhoneFromAny(obj) {
  for (const v of Object.values(obj || {})) {
    if (typeof v === 'string') {
      const m = v.match(/\+?\d{10,15}/);
      if (m) return m[0];
    }
  }
  return '';
}

function extractPhoneFromText(s) {
  const m = String(s || '').match(/\+?\d{10,15}/);
  return m ? m[0] : '';
}

