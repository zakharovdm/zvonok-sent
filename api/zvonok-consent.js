// api/zvonok-consent.js
// Гибрид: 1) отправляем WA (text или template), 2) запускаем бота whatsapp_callback

export default async function handler(req, res) {
  try {
    if (!['GET','POST'].includes(req.method)) return res.status(405).json({ error:'method_not_allowed' });

    const {
      WEBHOOK_TOKEN,
      SALEBOT_API_KEY,        // ключ проекта Salebot
      SALEBOT_WA_BOT_ID,      // ID WA-канала (для whatsapp_message)
      SALEBOT_BOT_ID,         // ID бота (для whatsapp_callback)
      DEFAULT_MESSAGE = 'Спасибо за согласие! Пришлю детали вебинара сюда 😊',
      SALEBOT_MESSAGE_ID,     // ID шаблона (если нужно WABA-вне-24ч)
      FORCE_COUNTRY_CODE = '7'
    } = process.env;

    if (!WEBHOOK_TOKEN || !SALEBOT_API_KEY || !SALEBOT_BOT_ID) {
      return res.status(500).json({ error:'env_missing', have:{
        WEBHOOK_TOKEN:!!WEBHOOK_TOKEN, SALEBOT_API_KEY:!!SALEBOT_API_KEY, SALEBOT_BOT_ID:!!SALEBOT_BOT_ID
      }});
    }

    // auth
    if ((req.query?.token || '') !== WEBHOOK_TOKEN) return res.status(401).json({ error:'invalid_token' });

    // parse
    const raw = await readBody(req);
    const ct = (req.headers['content-type'] || '').toLowerCase();
    let body = {};
    if (ct.includes('application/json')) body = safeJson(raw);
    else if (ct.includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(raw || ''));
    else { body = safeJson(raw); if (Object.keys(body).length === 0) body = { ...req.query }; }

    // phone
    let candidate =
      body.phone || body.number || body.client_phone || body.abonent_number ||
      body.caller || body.to || body.ct_phone || body.ct_phone8 || body.ct_phone9 ||
      req.query.phone || req.query.number || req.query.client_phone ||
      req.query.abonent_number || req.query.caller || req.query.to ||
      req.query.ct_phone || req.query.ct_phone8 || req.query.ct_phone9 || '';
    if (!candidate) candidate = extractPhoneFromAny(body) || extractPhoneFromAny(req.query) || extractPhoneFromText(raw);
    const phone = normalizePhone(candidate, FORCE_COUNTRY_CODE);

    // фильтр согласия
    const button = (body.ct_button_num ?? req.query.ct_button_num)?.toString();
    if (button && button !== '1') return res.status(200).json({ ok:true, skipped:'button_not_1' });

    if (!phone) {
      console.warn('phone_not_found',{ query:req.query, ct, raw:String(raw||'').slice(0,300) });
      return res.status(200).json({ ok:true, skipped:'phone_not_found' });
    }

    // overrides для теста
    const waId = Number(req.query.wa_id || SALEBOT_WA_BOT_ID || 0);
    const mode = (req.query.mode || '').toString(); // 'text' | 'template' | ''
    const textMsg = (req.query.msg || '').toString() || DEFAULT_MESSAGE;
    const templateId = Number(req.query.template_id || SALEBOT_MESSAGE_ID || 0);

    const base = `https://chatter.salebot.pro/api/${SALEBOT_API_KEY}`;
    const attempts = [];

    // 1) СНАЧАЛА отправим клиенту сообщение (если есть waId)
    if (waId) {
      // если явно просим шаблон, или задан SALEBOT_MESSAGE_ID — шлём шаблон
      if ((mode === 'template' || (mode !== 'text' && templateId > 0))) {
        const tpl = await sendWA(base, { phone, whatsapp_bot_id: waId, message_id: templateId });
        attempts.push({ via:'whatsapp_message(template)', status:tpl.status, body:tpl.body, payload:tpl.payload });
      } else {
        const txt = await sendWA(base, { phone, whatsapp_bot_id: waId, text: textMsg });
        attempts.push({ via:'whatsapp_message(text)', status:txt.status, body:txt.body, payload:txt.payload });
      }
    }

    // 2) Затем обязательно запускаем бота, чтобы он ловил "Да"
    const cbPayload = cleanUndefined({
      phone,
      bot_id: Number(SALEBOT_BOT_ID),
      message: (req.query.cbmsg || body.cbmsg || 'added_to_list_callback').toString(), // триггер
      start_signal: (req.query.start_signal || body.start_signal || 'zvonok_consent').toString(),
      resume_bot: true,
      source: 'zvonok-consent',
      ts: new Date().toISOString(),
      // полезные поля из Zvonok в карточку клиента
      ct_call_id: body.ct_call_id || req.query.ct_call_id,
      ct_status: body.ct_status || req.query.ct_status,
      ct_dial_status: body.ct_dial_status || req.query.ct_dial_status,
    });
    const cb = await fetch(`${base}/whatsapp_callback`, {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(cbPayload)
    });
    const cbText = await cb.text();
    attempts.push({ via:'whatsapp_callback', status:cb.status, body:safeParseJson(cbText) ?? cbText, payload: cbPayload });

    // ответ
    const ok = attempts.every(a => a.status >= 200 && a.status < 300);
    return res.status(ok ? 200 : 502).json({
      ok, sent_to_salebot: phone, wa_bot_id: waId || null,
      attempts
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error:'internal', details:String(e?.message || e) });
  }
}

/* helpers */
function safeJson(s){ try { return JSON.parse(s) } catch { return {} } }
function safeParseJson(s){ try { return JSON.parse(s) } catch { return null } }
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

/* SaleBot API */
async function sendWA(base, payload) {
  // для совместимости кладём и text, и message, если это не шаблон
  const p = { phone: payload.phone, whatsapp_bot_id: payload.whatsapp_bot_id };
  if (payload.message_id) p.message_id = Number(payload.message_id);
  else { p.text = payload.text; p.message = payload.text; }

  const r = await fetch(`${base}/whatsapp_message`, {
    method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(p)
  });
  const t = await r.text();
  return { ok:r.ok, status:r.status, body: safeParseJson(t) ?? t, payload: p };
}
