// api/zvonok-consent.js
// Vercel Serverless Function — Zvonok -> Salebot (WhatsApp)

export default async function handler(req, res) {
  try {
    if (!['GET', 'POST'].includes(req.method)) {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const {
      WEBHOOK_TOKEN,
      SALEBOT_API_KEY,
      SALEBOT_WA_BOT_ID,      // ID WA-канала (обязателен для whatsapp_message)
      SALEBOT_BOT_ID,         // опциональный fallback через whatsapp_callback
      DEFAULT_MESSAGE = 'Спасибо за согласие! Пришлю детали вебинара сюда 😊',
      SALEBOT_MESSAGE_ID,     // дефолтный ID шаблона (если есть — попробуем сначала его)
      FORCE_COUNTRY_CODE = '7'
    } = process.env;

    if (!WEBHOOK_TOKEN || !SALEBOT_API_KEY) {
      return res.status(500).json({ error: 'env_missing_base' });
    }
    if (!SALEBOT_WA_BOT_ID && !SALEBOT_BOT_ID) {
      return res.status(500).json({
        error: 'env_missing_channel',
        hint: 'Нужен SALEBOT_WA_BOT_ID (WA-канал) или хотя бы SALEBOT_BOT_ID (fallback)'
      });
    }

    // 1) auth токеном
    if ((req.query?.token || '') !== WEBHOOK_TOKEN) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    // 2) прочитать и распарсить тело
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

    // 3) достаём телефон из ct_* и др. + нормализация
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

    // 3.1) опционально: пропускаем, если не нажата 1
    const button = (body.ct_button_num ?? req.query.ct_button_num)?.toString();
    if (button && button !== '1') {
      return res.status(200).json({ ok: true, skipped: 'button_not_1' });
    }

    if (!phone) {
      console.warn('phone_not_found', { query: req.query, ct, raw: String(raw).slice(0, 400) });
      return res.status(200).json({ ok: true, skipped: 'phone_not_found' });
    }

    // 4) оверрайды для теста: ?wa_id, ?mode=text|template, ?template_id, ?msg
    const waId = Number(req.query.wa_id || SALEBOT_WA_BOT_ID || 0);
    const mode = (req.query.mode || '').toString(); // '', 'text', 'template'
    const msg  = (req.query.msg || '').toString() || DEFAULT_MESSAGE;
    const templateId = Number(req.query.template_id || SALEBOT_MESSAGE_ID || 0);

    const attempts = [];
    const base = `https://chatter.salebot.pro/api/${SALEBOT_API_KEY}`;

    // 5) если есть шаблон — пробуем его первым (WABA вне 24ч)
    if (waId && (mode === 'template' || (mode !== 'text' && templateId > 0))) {
      const rTpl = await sendWA(base, { phone, whatsapp_bot_id: waId, message_id: templateId });
      attempts.push({ via: 'whatsapp_message(template)', status: rTpl.status, body: rTpl.body, payload: rTpl.payload });
      if (rTpl.ok) {
        const hist = await pullHistory(base, phone);
        return res.status(200).json({
          ok: true, sent_to_salebot: phone, wa_bot_id: waId,
          salebot_via: 'whatsapp_message(template)', salebot_response: rTpl.body,
          history: hist
        });
      }
      console.error('whatsapp_message(template) failed', rTpl.status, rTpl.body);
    }

    // 6) затем пробуем обычный текст (или если шаблон не задан)
    if (waId) {
      const rTxt = await sendWA(base, { phone, whatsapp_bot_id: waId, text: msg });
      attempts.push({ via: 'whatsapp_message(text)', status: rTxt.status, body: rTxt.body, payload: rTxt.payload });
      if (rTxt.ok) {
        const hist = await pullHistory(base, phone);
        return res.status(200).json({
          ok: true, sent_to_salebot: phone, wa_bot_id: waId,
          salebot_via: 'whatsapp_message(text)', text_sent: msg, salebot_response: rTxt.body,
          history: hist
        });
      }
      console.error('whatsapp_message(text) failed', rTxt.status, rTxt.body);
    }

    // 7) fallback — стартуем бота (если настроена логика отправки внутри схемы)
    if (SALEBOT_BOT_ID) {
      const rCb = await sendCallback(base, {
        phone, bot_id: Number(SALEBOT_BOT_ID), message: msg, resume_bot: true
      });
      attempts.push({ via: 'whatsapp_callback', status: rCb.status, body: rCb.body, payload: rCb.payload });
      if (rCb.ok) {
        const hist = await pullHistory(base, phone);
        return res.status(200).json({
          ok: true, sent_to_salebot: phone,
          salebot_via: 'whatsapp_callback', salebot_response: rCb.body,
          history: hist
        });
      }
      console.error('whatsapp_callback failed', rCb.status, rCb.body);
    }

    // если ничего не сработало
    const hist = await pullHistory(base, phone);
    return res.status(502).json({
      error: 'salebot_failed',
      attempts, history: hist,
      hint: 'Если WABA и окно 24h закрыто — задай SALEBOT_MESSAGE_ID или передай ?mode=template&template_id=...'
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'internal', details: String(e?.message || e) });
  }
}

/* ===== helpers ===== */

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

/* ===== SaleBot calls ===== */

async function sendWA(base, payload) {
  // для текста передадим и text, и message (некоторые редакции API принимают message)
  const p = { phone: payload.phone, whatsapp_bot_id: payload.whatsapp_bot_id };
  if (payload.message_id) p.message_id = Number(payload.message_id);
  else { p.text = payload.text; p.message = payload.text; }

  const r = await fetch(`${base}/whatsapp_message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(p),
  });
  const t = await r.text();
  return { ok: r.ok, status: r.status, body: safeParseJson(t) ?? t, payload: p };
}

async function sendCallback(base, payload) {
  const r = await fetch(`${base}/whatsapp_callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      phone: payload.phone,
      bot_id: payload.bot_id,
      message: payload.message,
      resume_bot: !!payload.resume_bot,
      source: 'zvonok-consent',
      ts: new Date().toISOString()
    })
  });
  const t = await r.text();
  return { ok: r.ok, status: r.status, body: safeParseJson(t) ?? t, payload };
}

// «консоль-лог» от SaleBot: client_id и последние события в чате
async function pullHistory(base, phone){
  try {
    const cid = await fetch(`${base}/whatsapp_client_id?phone=${encodeURIComponent(phone)}`);
    const cPack = await packResp(cid);
    const clientId = cPack?.body?.client_id || cPack?.body?.id || cPack?.body?.clientId;
    if (!clientId) return { whatsapp_client_id: cPack, get_history: { skipped: 'no_client_id' } };
    const h = await fetch(`${base}/get_history?client_id=${encodeURIComponent(clientId)}`);
    return { whatsapp_client_id: cPack, get_history: await packResp(h) };
  } catch (e) {
    return { error: String(e) };
  }
}
async function packResp(r){ const t=await r.text(); return { ok:r.ok, status:r.status, body:safeParseJson(t) ?? t } }
