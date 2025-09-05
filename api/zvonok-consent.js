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
      // для прямой отправки сообщения в WhatsApp нужен ID WA-канала:
      SALEBOT_WA_BOT_ID, // ← обязателен, если хотим whatsapp_message
      // для fallback через запуск схемы (whatsapp_callback) — ID бота проекта:
      SALEBOT_BOT_ID,    // ← опционален, как запасной путь
      DEFAULT_MESSAGE = 'Спасибо за согласие! Пришлю детали вебинара сюда 😊',
      FORCE_COUNTRY_CODE = '7',
    } = process.env;

    // Базовые проверки переменных
    if (!WEBHOOK_TOKEN || !SALEBOT_API_KEY) {
      return res.status(500).json({ error: 'env_missing_base' });
    }
    const canWhatsappMessage = Boolean(SALEBOT_WA_BOT_ID);
    const canCallback = Boolean(SALEBOT_BOT_ID);

    // 1) Валидация простым токеном (?token=...)
    if (req.query?.token !== WEBHOOK_TOKEN) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    // 2) Получаем сырое тело
    const raw = await readBody(req);

    // 3) Парсим тело: JSON или x-www-form-urlencoded; в остальных случаях — fallback
    const ct = (req.headers['content-type'] || '').toLowerCase();
    let body = {};
    if (ct.includes('application/json')) {
      body = safeJson(raw);
    } else if (ct.includes('application/x-www-form-urlencoded')) {
      body = Object.fromEntries(new URLSearchParams(raw));
    } else {
      body = safeJson(raw);
      if (Object.keys(body).length === 0) body = { ...req.query };
    }

    // 4) Достаём номер (поддержка ct_* и fallback-поиск)
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

    if (!candidate) {
      candidate =
        extractPhoneFromAny(body) ||
        extractPhoneFromAny(req.query) ||
        extractPhoneFromText(raw);
    }

    const phone = normalizePhone(candidate, FORCE_COUNTRY_CODE);

    // (опц.) фильтр согласия по кнопке: если прилетает не "1", пропускаем
    const button = (body.ct_button_num ?? req.query.ct_button_num)?.toString();
    if (button && button !== '1') {
      return res.status(200).json({ ok: true, skipped: 'button_not_1' });
    }

    if (!phone) {
      console.warn('phone_not_found', {
        query: req.query,
        ct,
        raw: raw?.slice?.(0, 512),
      });
      // Возвращаем 200, чтобы Zvonok не ретраил, и логируем
      return res.status(200).json({ ok: true, skipped: 'phone_not_found' });
    }

    // 5) Отправляем в SaleBot: сначала пробуем прямую отправку WA-сообщения,
    //    если нет SALEBOT_WA_BOT_ID или ошибка — fallback на whatsapp_callback (если задан SALEBOT_BOT_ID)
    let lastResp = null;

    if (canWhatsappMessage) {
      const r = await sendToSalebotWhatsApp(phone, DEFAULT_MESSAGE);
      lastResp = { via: 'whatsapp_message', ...r };
      if (r.ok) {
        return res.status(200).json({
          ok: true,
          sent_to_salebot: phone,
          salebot_via: 'whatsapp_message',
          salebot_response: r.body,
        });
      }
      console.error('whatsapp_message failed', r.status, r.body);
      // продолжаем к fallback, если можно
    }

    if (canCallback) {
      const r2 = await sendToSalebotCallback(phone, DEFAULT_MESSAGE);
      lastResp = { via: 'whatsapp_callback', ...r2 };
      if (r2.ok) {
        return res.status(200).json({
          ok: true,
          sent_to_salebot: phone,
          salebot_via: 'whatsapp_callback',
          salebot_response: r2.body,
        });
      }
      console.error('whatsapp_callback failed', r2.status, r2.body);
    }

    // Если сюда дошли — ни один путь не сработал
    return res.status(502).json({
      error: 'salebot_failed',
      details: lastResp || { via: 'none', reason: 'no_available_method' },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal' });
  }
}

/* ——— helpers ——— */

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function safeParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizePhone(input, defaultCountry = '7') {
  if (!input) return '';
  const digits = String(input).replace(/[^\d]/g, '');

  // РФ по умолчанию (подправь под свой регион):
  if (digits.length === 11 && digits.startsWith('8')) return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith('7')) return `+${digits}`;
  if (digits.length === 10) return `+${defaultCountry}${digits}`;
  if (digits.length >= 11) return `+${digits}`; // уже с кодом страны
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

/* ——— SaleBot calls ——— */

async function sendToSalebotWhatsApp(phone, text) {
  const { SALEBOT_API_KEY, SALEBOT_WA_BOT_ID } = process.env;
  const url = `https://chatter.salebot.pro/api/${SALEBOT_API_KEY}/whatsapp_message`;

  const payload = {
    phone,                                // "+7..."
    text: text || 'Спасибо! Записываю вас на вебинар ✨',
    whatsapp_bot_id: Number(SALEBOT_WA_BOT_ID), // ID WA-канала в Salebot
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const respText = await resp.text();
  return {
    ok: resp.ok,
    status: resp.status,
    body: safeParseJson(respText) ?? respText,
  };
}

async function sendToSalebotCallback(phone, text) {
  const { SALEBOT_API_KEY, SALEBOT_BOT_ID } = process.env;
  const url = `https://chatter.salebot.pro/api/${SALEBOT_API_KEY}/whatsapp_callback`;

  const payload = {
    phone,                                // по умолчанию SaleBot ждёт "phone"
    bot_id: Number(SALEBOT_BOT_ID),       // ID бота в конструкторе
    message: text,
    resume_bot: true,                     // снимет с паузы, если была
    source: 'zvonok-consent',
    ts: new Date().toISOString(),
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const respText = await resp.text();
  return {
    ok: resp.ok,
    status: resp.status,
    body: safeParseJson(respText) ?? respText,
  };
}
