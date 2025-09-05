// api/zvonok-consent.js
export default async function handler(req, res) {
  try {
    if (!['POST', 'GET'].includes(req.method)) {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const {
      WEBHOOK_TOKEN,
      SALEBOT_API_KEY,
      SALEBOT_WA_BOT_ID,      // ID WA-канала по умолчанию
      SALEBOT_BOT_ID,         // опциональный fallback через callback
      DEFAULT_MESSAGE = 'Спасибо за согласие! Пришлю детали вебинара сюда 😊',
      SALEBOT_MESSAGE_ID,     // дефолтный шаблон (если нужен)
      SALEBOT_FORCE_TEMPLATE, // '1' → по умолчанию слать шаблон
      FORCE_COUNTRY_CODE = '7',
    } = process.env;

    if (!WEBHOOK_TOKEN || !SALEBOT_API_KEY) {
      return res.status(500).json({ error: 'env_missing_base' });
    }

    // 1) токен
    if (req.query?.token !== WEBHOOK_TOKEN) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    // 2) тело
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

    // 3) достаём телефон
    let candidate =
      body.phone || body.number || body.client_phone || body.abonent_number ||
      body.caller || body.to || body.ct_phone || body.ct_phone8 || body.ct_phone9 ||
      req.query.phone || req.query.number || req.query.client_phone ||
      req.query.abonent_number || req.query.caller || req.query.to ||
      req.query.ct_phone || req.query.ct_phone8 || req.query.ct_phone9 || '';

    if (!candidate) {
      candidate = extractPhoneFromAny(body) || extractPhoneFromAny(req.query) || extractPhoneFromText(raw);
    }
    const phone = normalizePhone(candidate, FORCE_COUNTRY_CODE);

    // фильтр согласия по кнопке (если нужно)
    const button = (body.ct_button_num ?? req.query.ct_button_num)?.toString();
    if (button && button !== '1') {
      return res.status(200).json({ ok: true, skipped: 'button_not_1' });
    }

    if (!phone) {
      console.warn('phone_not_found', { query: req.query, ct, raw: raw?.slice?.(0, 400) });
      return res.status(200).json({ ok: true, skipped: 'phone_not_found' });
    }

    // 4) Оверрайды для диагностики:
    //    wa_id — подменить канал; msg — подменить текст; template_id — явный шаблон; mode=text|template
    const waId = Number(req.query.wa_id || SALEBOT_WA_BOT_ID || 0);
    const textOverride = (req.query.msg ?? '').toString();
    const templateOverride = Number(req.query.template_id || 0);
    const mode = (req.query.mode || '').toString();

    const wantTemplate = mode === 'template' || (SALEBOT_FORCE_TEMPLATE === '1' && mode !== 'text');
    const templateId = templateOverride || (SALEBOT_MESSAGE_ID ? Number(SALEBOT_MESSAGE_ID) : 0);
    const finalText = textOverride || DEFAULT_MESSAGE;

    if (!waId) {
      return res.status(500).json({ error: 'wa_bot_id_missing', hint: 'передай ?wa_id=... или задай SALEBOT_WA_BOT_ID' });
    }

    // 5) Пытаемся отправить
    const attempts = [];

    if (wantTemplate && templateId > 0) {
      const rTpl = await sendWA({ phone, whatsapp_bot_id: waId, message_id: templateId });
      attempts.push({ via: 'whatsapp_message(template)', status: rTpl.status, body: rTpl.body });
      if (rTpl.ok) {
        return res.status(200).json({
          ok: true,
          sent_to_salebot: phone,
          salebot_via: 'whatsapp_message(template)',
          wa_bot_id: waId,
          template_id: templateId,
          salebot_response: rTpl.body,
        });
      }
      console.error('whatsapp_message(template) failed', rTpl.status, rTpl.body);
    }

    const rTxt = await sendWA({ phone, whatsapp_bot_id: waId, text: finalText });
    attempts.push({ via: 'whatsapp_message(text)', status: rTxt.status, body: rTxt.body });
    if (rTxt.ok) {
      return res.status(200).json({
        ok: true,
        sent_to_salebot: phone,
        salebot_via: 'whatsapp_message(text)',
        wa_bot_id: waId,
        text_sent: finalText,
        salebot_response: rTxt.body,
      });
    }
    console.error('whatsapp_message(text) failed', rTxt.status, rTxt.body);

    if (SALEBOT_BOT_ID) {
      const rCb = await sendCallback({ phone, bot_id: Number(SALEBOT_BOT_ID), message: finalText, resume_bot: true });
      attempts.push({ via: 'whatsapp_callback', status: rCb.status, body: rCb.body });
      if (rCb.ok) {
        return res.status(200).json({
          ok: true,
          sent_to_salebot: phone,
          salebot_via: 'whatsapp_callback',
          wa_bot_id: waId,
          text_sent: finalText,
          salebot_response: rCb.body,
        });
      }
      console.error('whatsapp_callback failed', rCb.status, rCb.body);
    }

    return res.status(502).json({ error: 'salebot_failed', wa_bot_id: waId, attempts });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'internal' });
  }
}

/* helpers */
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function safeParseJson(s) { try { return JSON.parse(s); } catch { return null; } }

function normalizePhone(input, defaultCountry = '7') {
  if (!input) return '';
  const d = String(input).replace(/[^\d]/g, '');
  if (d.length === 11 && d.startsWith('8')) return `+7${d.slice(1)}`;
  if (d.length === 11 && d.startsWith('7')) return `+${d}`;
  if (d.length === 10) return `+${defaultCountry}${d}`;
  if (d.length >= 11) return `+${d}`;
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

/* SaleBot API */
async function sendWA({ phone, whatsapp_bot_id, text, message_id }) {
  const { SALEBOT_API_KEY } = process.env;
  const url = `https://chatter.salebot.pro/api/${SALEBOT_API_KEY}/whatsapp_message`;
  const payload = { phone, whatsapp_bot_id };
  if (message_id) payload.message_id = Number(message_id);
  else payload.text = text;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const respText = await resp.text();
  return { ok: resp.ok, status: resp.status, body: safeParseJson(respText) ?? respText };
}

async function sendCallback({ phone, bot_id, message, resume_bot }) {
  const { SALEBOT_API_KEY } = process.env;
  const url = `https://chatter.salebot.pro/api/${SALEBOT_API_KEY}/whatsapp_callback`;
  const payload = { phone, bot_id, message, resume_bot: !!resume_bot, source: 'zvonok-consent', ts: new Date().toISOString() };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const respText = await resp.text();
  return { ok: resp.ok, status: resp.status, body: safeParseJson(respText) ?? respText };
}
