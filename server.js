import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import axios from 'axios';
import CryptoJS from 'crypto-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';

/* ============== Helpers ============== */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'database/sessions.json');

const logger = {
  info: (...a) => console.log('[INFO]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERROR]', ...a),
};

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); }
  catch { return []; }
}
function saveDB(rows) {
  fs.writeFileSync(DB_PATH, JSON.stringify(rows, null, 2));
}

/** PayOS signature theo thứ tự key alphabet:
 * amount, cancelUrl, description, orderCode, returnUrl
 * format: amount=...&cancelUrl=...&description=...&orderCode=...&returnUrl=...
 */
function buildPayOSSignature({ amount, cancelUrl, description, orderCode, returnUrl }, checksumKey) {
  const dataString =
    `amount=${amount}` +
    `&cancelUrl=${cancelUrl}` +
    `&description=${description}` +   // KHÔNG encodeURIComponent
    `&orderCode=${orderCode}` +
    `&returnUrl=${returnUrl}`;
  const hmac = CryptoJS.HmacSHA256(dataString, checksumKey);
  return CryptoJS.enc.Hex.stringify(hmac);
}

/* ============== External services ============== */
const PAYOS_BASE = 'https://api-merchant.payos.vn'; // production

async function payosCreatePaymentLink({ orderCode, amount, description, returnUrl, cancelUrl, buyerEmail, buyerName }) {
  const headers = {
    'Content-Type': 'application/json',
    'x-client-id': process.env.PAYOS_CLIENT_ID,
    'x-api-key': process.env.PAYOS_API_KEY,
  };
  const signature = buildPayOSSignature(
    { amount, cancelUrl, description, orderCode, returnUrl },
    process.env.PAYOS_CHECKSUM_KEY
  );
  const payload = { orderCode, amount, description, buyerEmail, buyerName, cancelUrl, returnUrl, signature };

  logger.info('[PayOS][Create] order=', orderCode, 'amount=', amount);
  const { data } = await axios.post(`${PAYOS_BASE}/v2/payment-requests`, payload, { headers, timeout: 15000 });
  return data; // { code, desc, data: { checkoutUrl, qrCode, ... } }
}

async function emailjsSendReceipt({ to_email, station, kwh, amount, order_code, paid_at }) {
  const url = 'https://api.emailjs.com/api/v1.0/email/send';
  const payload = {
    service_id: process.env.EMAILJS_SERVICE_ID,
    template_id: process.env.EMAILJS_TEMPLATE_ID,
    user_id: process.env.EMAILJS_PUBLIC_KEY,
    template_params: { to_email, station, kwh, amount, order_code, paid_at }
  };
  try {
    const { data } = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
    logger.info('[EmailJS] Sent OK to', to_email, '| order=', order_code);
    return data;
  } catch (err) {
    logger.warn('[EmailJS] Send FAIL:', err?.response?.data || err.message);
    return null; // không throw để webhook vẫn trả 200
  }
}

async function blynkUpdate(pin, value) {
  const token = process.env.BLYNK_TOKEN;
  const url = `https://blynk.cloud/external/api/update?token=${token}&${pin}=${encodeURIComponent(value)}`;
  try {
    const { data } = await axios.get(url, { timeout: 8000 });
    logger.info('[Blynk] Update', pin, '=', value, '->', data);
    return data;
  } catch (err) {
    logger.warn('[Blynk] Update FAIL', pin, err?.response?.data || err.message);
    return null;
  }
}

/* ============== App init ============== */
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

/* Health check */
app.get('/', (req, res) => res.json({ ok: true, name: 'EV Charging Server', time: new Date().toISOString() }));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

/* ============== API: create payment ============== */
/**
 * POST /api/payment/create
 * body: { station, uid, kWh, email }
 */
app.post('/api/payment/create', async (req, res) => {
  try {
    const { station, uid, kWh, email } = req.body || {};
    if (![1, 2].includes(Number(station))) return res.status(400).json({ error: 'Invalid station' });
    if (typeof kWh !== 'number' || kWh <= 0) return res.status(400).json({ error: 'Invalid kWh' });

    const unitPrice = parseInt(process.env.UNIT_PRICE || '5000', 10);
    const amount = Math.round(kWh * unitPrice);
    const orderCode = Number(`${Date.now().toString().slice(-9)}`); // integer ngắn gọn
    const description = `EVSAC-S${station}-${uid?.slice(-4) || 'XXXX'}`;
    const returnUrl = process.env.RETURN_URL || `${process.env.PUBLIC_BASE_URL}/success`;
    const cancelUrl = process.env.CANCEL_URL || `${process.env.PUBLIC_BASE_URL}/cancel`;

    const resp = await payosCreatePaymentLink({
      orderCode, amount, description, returnUrl, cancelUrl,
      buyerEmail: email, buyerName: uid || 'EV User'
    });
    if (resp?.code !== '00') {
      return res.status(500).json({ error: 'PayOS create failed', detail: resp });
    }

    const { data } = resp; // checkoutUrl, qrCode, status, orderCode
    const rows = loadDB();
    rows.push({
      id: nanoid(8),
      orderCode: data.orderCode || orderCode,
      station, uid, kWh, amount, email,
      status: data.status || 'PENDING',
      createdAt: new Date().toISOString(),
      paidAt: null
    });
    saveDB(rows);

    logger.info('[CREATE]', `S${station}`, 'UID:', uid, 'kWh:', kWh, '=>', amount, 'order=', orderCode);
    return res.json({ checkoutUrl: data.checkoutUrl, qrCode: data.qrCode, amount });
  } catch (err) {
    logger.error('CREATE error', err?.response?.data || err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* ============== API: PayOS webhook ============== */
/**
 * POST /api/payos/webhook
 * body: { code, desc, success, data:{ orderCode, amount, transactionDateTime }, signature }
 * Trả 200 OK ngay cả khi email lỗi → tránh retry dồn dập.
 */
app.post('/api/payos/webhook', async (req, res) => {
  const body = req.body || {};
  try {
    // TODO (nâng cao): verify signature webhook theo PayOS docs nếu cần.
    const isPaid = (body?.code === '00' || body?.success === true) && body?.data?.orderCode;
    if (!isPaid) {
      logger.warn('[WEBHOOK] Ignored payload:', body?.code, body?.desc);
      return res.status(200).json({ ok: true });
    }

    const { orderCode, amount, transactionDateTime } = body.data;
    const rows = loadDB();
    const idx = rows.findIndex(r => String(r.orderCode) === String(orderCode));
    if (idx === -1) {
      logger.warn('[WEBHOOK] order not found:', orderCode);
      return res.status(200).json({ ok: true });
    }
    if (rows[idx].status === 'PAID') {
      logger.info('[WEBHOOK] Duplicate paid ignored:', orderCode);
      return res.status(200).json({ ok: true });
    }

    rows[idx].status = 'PAID';
    rows[idx].paidAt = new Date().toISOString();
    saveDB(rows);
    logger.info('[WEBHOOK] Paid OK | order=', orderCode, '| amount=', amount);

    // EmailJS (không throw)
    await emailjsSendReceipt({
      to_email: rows[idx].email || '',
      station: rows[idx].station,
      kwh: rows[idx].kWh,
      amount: rows[idx].amount,
      order_code: rows[idx].orderCode,
      paid_at: transactionDateTime || rows[idx].paidAt
    });

    // Blynk
    await blynkUpdate('V11', 'PAID');
    await blynkUpdate('V12', rows[idx].amount);

    return res.status(200).json({ ok: true });
  } catch (err) {
    logger.error('[WEBHOOK] error:', err?.response?.data || err.message);
    return res.status(200).json({ ok: true });
  }
});

/* ============== Start server ============== */
const port = process.env.PORT || 10000;
app.listen(port, () => logger.info(`Server started : http://localhost:${port}`));
