// api/sb-selftest.js
export default async function handler(req, res) {
  try {
    if (!['GET', 'POST'].includes(req.method)) {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const {
      WEBHOOK_TOKEN,
      SALEBOT_API_KEY,
      SALEBOT_WA_BOT_ID,   // дефолтный WA-канал
      SALEBOT_MESSAGE_ID,  // дефолтный ID шаблона (если нужен template)
      DEFAULT_MESSAGE = 'VIA_SELFTEST',
    } = process.env;

    if (!WEBHOOK_TOKEN || !SALEBOT_API_KEY) {
      return res.status(500).json({
        error: 'env_missing',
        have: { WEBHOOK_TOKEN: !!WEBHOOK_TOKEN, SALEBOT_API_KEY: !!SALEBOT_API_KEY }
      });
    }

    // auth
    if ((req.query?.token || '') !== WEBHOOK_TOKEN) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    // query overrides
    const phone = pickPhone(req) || '';
    const waId = Number(req.query.wa_id || SALEBOT_WA_BOT_ID || 0);
    const mode = (req.query.mode || 'text').toString(); // text | template | both
    const text = (req.query.text || req.query.msg || DEFAULT_MESSAGE).toString();
    const templateId = Number(req.query.template_id || SALEBOT_MESSAGE_ID || 0);
    const dry = req.query.dry === '1'; // если 1 — только проверки, без отправок

    const base = `https://chatter.salebot.pro/api/${SALEBOT_API_KEY}`;
    const result = {
      inputs: { phone, wa_id: waId, mode, text, template_id: templateId, dry },
      checks: {},
      sends: []
    };

    // 1) connected_channels
    const ch = await fetch(`${base}/connected_channels`);
    result.checks.connected_channels = await packResp(ch);

    // 2) check_whatsapp (если есть телефон)
    if (phone) {
      const cw = await fetch(`${base}/check_whatsapp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone })
      });
      result.checks.check_whatsapp = await packResp(cw);
    } else {
      result.checks.check_whatsapp = { skipped: 'no_phone' };
    }

    if (dry) {
      return res.status(200).json({ ok: true, ...result, note: 'dry_run' });
    }

    // 3) отправки (если указаны и номер, и канал)
    if (!phone) result.sends.push({ skipped: 'no_phone' });
    if (!waId)  result.sends.push({ skipped: 'no_wa_id' });

    if (phone && waId) {
      // template сначала (если нужно)
      if ((mode === 'template' || mode === 'both') && templateId > 0) {
        const rt = await sendWA(base, { phone, whatsapp_bot_id: waId, message_id: templateId });
        result.sends.push({ via: 'whatsapp_message(template)', ...rt });
      }

      // текст
      if (mode === 'text' || mode === 'both') {
        const rx = await sendWA(base, { phone, whatsapp_bot_id: waId, text });
        result.sends.push({ via: 'whatsapp_message(text)', ...rx });
      }
    }

    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'internal', details: String(e?.message || e) });
  }
}

/* helpers */
function pickPhone(req) {
  const q = req.query || {};
  const keys = ['phone','ct_phone','ct_phone8','ct_phone9'];
  for (const k of keys) if (q[k]) return String(q[k]);
  return '';
}

async function packResp(resp) {
  const text = await resp.text();
  return {
    ok: resp.ok,
    status: resp.status,
    body: safeParseJson(text) ?? text
  };
}

function safeParseJson(s) { try { return JSON.parse(s); } catch { return null; } }

async function sendWA(base, payload) {
  const r = await fetch(`${base}/whatsapp_message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: safeParseJson(text) ?? text, payloadSent: payload };
}
