// api/zvonok-consent.js
// Variant A: только запуск бота через whatsapp_callback (шаблон уходит из первого блока в конструкторе)

export default async function handler(req, res) {
  try {
    if (!['GET', 'POST'].includes(req.method)) {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const {
      WEBHOOK_TOKEN,
      SALEBOT_API_KEY,
      SALEBOT_BOT_ID,                 // ID бота в конструкторе (обязательно)
      FORCE_COUNTRY_CODE = '7',       // нормализация номера
      DEFAULT_CALLBACK_MESSAGE = 'added_to_list_callback' // текст-триггер для стартового условия
    } = process.env;

    if (!WEBHOOK_TOKEN || !SALEBOT_API_KEY || !SALEBOT_BOT_ID) {
      return res.status(500).json({ error: 'env_missing', have: {
        WEBHOOK_TOKEN: !!WEBHOOK_TOKEN,
        SALEBOT_API_KEY: !!SALEBOT_API_KEY,
        SALEBOT_BOT_ID: !!SALEBOT_BOT_ID,
      }});
    }

    // 1) auth
    if ((req.query?.token || '') !== WEBHOOK_TOKEN) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    // 2) parse body
    const raw = await readBody(req);
    const ct = (req.headers['content-type'] || '').toLowerCase();
    let body = {};
    if (ct.includes('application/json')) {
      body = safeJson(raw);
    } else if (ct.includes('application/x-www-form-urlencoded')) {
      body = Object.fromEntries(new URLSearchParams(raw || ''));
    } else {
      body = safeJson(raw);
      if (Object.keys(body).length === 0) body = { ...req.query };
    }

    // 3) phone + normalize
    let candidate =
      body.phone || body.number || body.client_phone || body.abonent_number ||
      body.caller || body.to || body.ct_phone || body.ct_phone8 || body.ct_phone9 ||
      req.query.phone || req.query.number || req.query.client_phone ||
      req.query.abonent_number || req.query.caller || req.query.to ||
      req.query.ct_phone || req.query.ct_phone8 || req.query.ct_phone9 || '';

    if (!candidate) candidate = extractPhoneFromAny(body) || extractPhoneFromAny(req.query) || extractPhoneFromText(raw);
    const phone = normalizePhone(candidate, FORCE_COUNTRY_CODE);

    // 3.1) фильтр согласия (если нужно)
    const button = (body.ct_button_num ?? req.query.ct_button_num)?.toString();
    if (button && button !== '1') {
      return res.status(200).json({ ok: true, skipped: 'button_not_1' });
    }

    if (!phone) {
      console.warn('phone_not_found', { query: req.query, ct, raw: String(raw || '').slice(0, 300) });
      return res.status(200).json({ ok: true, skipped: 'phone_not_found' });
    }

    // 4) ОБЯЗАТЕЛЬНОЕ сообщение для whatsapp_callback
    const cbMessage =
      (req.query.msg || req.query.message || body.msg || body.message || DEFAULT_CALLBACK_MESSAGE).toString();

    // 5) стартуем бота (первый блок — шаблон; стартовое условие в боте: added_to_list_callback)
    const base = `https://chatter.salebot.pro/api/${SALEBOT_API_KEY}`;
    const payload = cleanUndefined({
      phone,
      bot_id: Number(SALEBOT_BOT_ID),
      message: cbMessage,              // ← ОБЯЗАТЕЛЬНО
      resume_bot: true,
      source: 'zvonok-consent',
      ts: new Date().toISOString(),
      // полезные поля из Zvonok попадут в карточку клиента
      ct_call_id: body.ct_call_id || req.query.ct_call_id,
      ct_status: body.ct_status || req.query.ct_status,
      ct_dial_status: body.ct_dial_status || req.query.ct_dial_status,
    });

    const r = await fetch(`${base}/whatsapp_callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    if (!r.ok) {
      console.error('whatsapp_callback failed', r.status, text);
      return res.status(502).json({ error: 'salebot_callback_failed', status: r.status, body: text, sent: payload });
    }

    return res.status(200).json({
      ok: true,
      sent_to_salebot: phone,
      salebot_via: 'whatsapp_callback',
      message_used: cbMessage,
      salebot_response: safeJson(text) || text
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'internal', details: String(e?.message || e) });
  }
}

/* helpers */
function safeJson(s){ try { return JSON.parse(s) } catch { return {} } }
function normalizePhone(input, defaultCountry='7'){
  const d = String(input ?? '').trim().replace(/[^\d]/g,'');
  if (!d) return '';
  if (d.length === 11 && d.startsWith('8')) return `+7${d.slice(1)}`;
  if (d.length === 11 && d.startsWith('7')) return `+${d}`;
  if (d.length === 10) return `+${defaultCountry}${d}`;
  if (d.length >= 11) return `+${d}`;
  return '';
}
async function readBody(req){
  if (req.method === 'GET') return '';
  return await new Promise((resolve, reject) => {
    let data=''; req.on('data', c => data+=c); req.on('end', () => resolve(data)); req.on('error', reject);
  });
}
function extractPhoneFromAny(o){ for (const v of Object.values(o||{})) if (typeof v==='string'){ const m=v.match(/\+?\d{10,15}/); if (m) return m[0]; } return ''; }
function extractPhoneFromText(s){ const m=String(s||'').match(/\+?\d{10,15}/); return m?m[0]:''; }
function cleanUndefined(obj){ const o={}; for (const [k,v] of Object.entries(obj)) if (v!==undefined) o[k]=v; return o; }
