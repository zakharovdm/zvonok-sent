// api/zvonok-consent.js
// Vercel Node.js Serverless Function

export default async function handler(req, res) {
  try {
    if (!['POST', 'GET'].includes(req.method)) {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const {
      WEBHOOK_TOKEN,
      SALEBOT_API_KEY,
      SALEBOT_WA_BOT_ID,      // ID WA-канала (обязателен для whatsapp_message)
      SALEBOT_BOT_ID,         // опциональный fallback через whatsapp_callback
      DEFAULT_MESSAGE = 'Спасибо за согласие! Пришлю детали вебинара сюда 😊',
      SALEBOT_MESSAGE_ID,     // дефолтный ID шаблона для WABA
      SALEBOT_FORCE_TEMPLATE, // '1' → слать шаблон в приоритете
      FORCE_COUNTRY_CODE = '7',
    } = process.env;

    if (!WEBHOOK_TOKEN || !SALEBOT_API_KEY) {
      return res.status(500).json({ error: 'env_missing_base' });
    }
    if (!SALEBOT_WA_BOT_ID && !SALEBOT_BOT_ID) {
      return res.status(500).json({ error: 'env_missing_channel', hint: 'нужен SALEBOT_WA_BOT_ID или (как запас) SALEBOT_BOT_ID' });
    }

    // 1) авторизация вебхука
    if ((req.query?.token || '') !== WEBHOOK_TOKEN) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    // 2) прочесть тело и распарсить
    const raw = await readBody(req);
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

    // 3) телефон (ct_* + запасные ключи) и нормализация
    let candidate =
      body.phone || body.number || body.client_phone || body.abonent_number ||
      body.caller || body.to || body.ct_phone || body.ct_phone8 || body.ct_phone9 ||
      req.query.phone || req.query.number || req.query.client_phone ||
      req.query.abonent_number || req.query.caller || req.query.to ||
      req.query.ct_phone || req.query.ct_phone8 || req.query.ct_phone9 || '';

    if (!candidate) {
      candidate =
        extractPhoneFromAny(body) ||
        extractPhoneFromAny(req.query) ||
        extractPhoneFromText(raw);
    }
    const phone = normalizePhone(candidate, FORCE_COUNTRY_CODE);

    // 3.1) фильтр «нажата 1» — если вебхук повешен широко
    const button = (body.ct_button_num ?? req.query.ct_button_num)?.toString();
    if (button && button !== '1') {
      return res.status(200).json({ ok: true, skipped: 'button_not_1' });
    }

    if (!phone) {
      console.warn('phone_not_found', { query: req.query, ct, raw: String(raw).slice(0, 400) });
      return res.status(200).json({ ok: true, skipped: 'phone_not_found' });
    }

    // 4) режим отправки: text / template / both, с оверрайдами из query
    const waId = Number(req.query.wa_id || SALEBOT_WA_BOT_ID || 0);
    const mode = (req.query.mode || '').toString();            // 'text' | 'template' | ''
    const msg = (req.query.msg || '').toString() || DEFAULT_MESSAGE;
    const templateId = Number(req.query.template_id || SALEBOT_MESSAGE_ID || 0);

    // приоритет шаблона: если явно mode=template ИЛИ SALEBOT_FORCE_TEMPLATE='1' (и не переопределили mode=text)
    const preferTemplate = mode === 'template' || (SALEBOT_FORCE_TEMPLATE === '1' && mode !== 'text');

    if (!waId && !SALEBOT_BOT_ID) {
      return res.status(500).json({ error: 'wa_bot_id_missing', hint: 'передай ?wa_id=... или задай SALEBOT_WA_BOT_ID, либо включи fallback SALEBOT_BOT_ID' });
    }

    const attempts = [];

    // 5) отправка (сначала шаблон при необходимости)
    if (waId && preferTemplate && templateId > 0) {
      const rTpl = await sendWA({ apiKey: SALEBOT_API_KEY, phone, whatsapp_bot_id: waId, message_id: templateId });
      attempts.push({ via: 'whatsapp_message(template)', status: rTpl.status, body: rTpl.body });
      if (rTpl.ok) {
        return res.status(200).json({
          ok: true, sent_to_salebot: phone, wa_bot_id: waId,
          salebot_via: 'whatsapp_message(template)', salebot_response: rTpl.body
        });
      }
      console.error('whatsapp_message(template) failed', rTpl.status, rTpl.body);
    }

    if (waId) {
      const rTxt = await sendWA({ apiKey: SALEBOT_API_KEY, phone, whatsapp_bot_id: waId, text: msg });
      attempts.push({ via: 'whatsapp_message(text)', status: rTxt.status, body: rTxt.body });
      if (rTxt.ok) {
        return res.status(200).json({
          ok: true, sent_to_salebot: phone, wa_bot_id: waId,
          salebot_via: 'whatsapp_message(text)', text_sent: msg, salebot_response: rTxt.body
        });
      }
      console.error('whatsapp_message(text) failed', rTxt.status, rTxt.body);
    }

    // fallback: запуск схемы (на случай, если WA-канал/окно мешают, а логика отправки внутри бота)
    if (SALEBOT_BOT_ID) {
      const rCb = await sendCallback({
        apiKey: SALEBOT_API_KEY,
        phone, bot_id: Number(SALEBOT_BOT_ID),
        message: msg, resume_bot: true
      });
      attempts.push({ via: 'whatsapp_callback', status: rCb.status, body: rCb.body });
      if (rCb.ok) {
        return res.status(200).json({
          ok: true, sent_to_salebot: phone,
          salebot_via: 'whatsapp_callback', salebot_response: rCb.body
        });
      }
      console.error('whatsapp_callback failed', rCb.status, rCb.body);
    }

    return res.status(502).json({ error: 'salebot_failed', attempts, hint: 'проверь 24h окно WABA, правильность wa_id и template_id' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'internal', details: String(e?.message || e) });
  }
}

/* ---------- helpers ---------- */
function safeJson(s){ try { return JSON.parse(s) } catch { return {} } }
function safeParseJson(s){ try { return JSON.parse(s) } catch { return null } }

function normalizePhone(input, defaultCountry='7') {
  const src = String(input ?? '').trim();
  const digits = src.replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.length === 11 && digits.startsWith('8')) return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith('7')) return `+${digits}`;
  if (digits.length === 10) return `+${defaultCountry}${digits}`;
  if (digits.length >= 11) return `+${digits}`;
  return '';
}

async function readBody(req){
  if (req.method === 'GET') return '';
  return await new Promise((resolve, reject) => {
    let data=''; req.on('data', c => data+=c); req.on('end', () => resolve(data)); req.on('error', reject);
  });
}

function extractPhoneFromAny(obj){
  for (const v of Object.values(obj || {})) {
    if (typeof v === 'string') {
      const m = v.match(/\+?\d{10,15}/);
      if (m) return m[0];
    }
  }
  return '';
}
function extractPhoneFromText(s){
  const m = String(s || '').match(/\+?\d{10,15}/);
  return m ? m[0] : '';
}

/* ---------- SaleBot API ---------- */
async function sendWA({ apiKey, phone, whatsapp_bot_id, text, message_id }) {
  const url = `https://chatter.salebot.pro/api/${apiKey}/whatsapp_message`;
  const payload = { phone, whatsapp_bot_id };
  if (message_id) payload.message_id = Number(message_id);
  else payload.text = text;

  const resp = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  const t = await resp.text();
  return { ok: resp.ok, status: resp.status, body: safeParseJson(t) ?? t, payloadSent: payload };
}

async function sendCallback({ apiKey, phone, bot_id, message, resume_bot }) {
  const url = `https://chatter.salebot.pro/api/${apiKey}/whatsapp_callback`;
  const payload = {
    phone, bot_id, message, resume_bot: !!resume_bot,
    source: 'zvonok-consent', ts: new Date().toISOString()
  };
  const resp = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  const t = await resp.text();
  return { ok: resp.ok, status: resp.status, body: safeParseJson(t) ?? t, payloadSent: payload };
}
