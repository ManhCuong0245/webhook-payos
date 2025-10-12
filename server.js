// server.js — Hệ thống sạc xe điện + PayOS webhook (phiên bản dùng Blynk)
import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// ====== CẤU HÌNH ======
const CLIENT_ID = 'cec2681b-4257-4aa4-8e3b-974af9cf6ea5';
const API_KEY = 'df48b405-e3aa-498f-b2a3-28042d756731';
const CHECKSUM_KEY = '24a0011e0db99a0b892a1443b3827d73f583fa3fbf90765a8d384f9d1d6a5e23';

// Blynk Cloud
const BLYNK_TOKEN = 'Wsql9VzqLlV259XRmmsVf6aw2B0kkxn0';
const BLYNK_URL = `https://blynk.cloud/external/api/update?token=${BLYNK_TOKEN}`;

// ====== TRANG CHỦ ======
app.get('/', (req, res) => {
  res.send('✅ Hệ thống sạc xe điện webhook PayOS đang hoạt động.');
});

// ====== API TẠO MÃ QR THANH TOÁN ======
app.post('/api/payment/create', async (req, res) => {
  try {
    const { kWh, user } = req.body;
    const amount = Math.round(kWh * 5000); // ví dụ: 5.000đ/kWh

    const payload = {
      orderCode: Date.now(),
      amount,
      description: `Thanh toán phí sạc cho ${user} (${kWh} kWh)`,
      returnUrl: 'https://hethongsacxe.onrender.com/thankyou',
      cancelUrl: 'https://hethongsacxe.onrender.com/cancel',
    };

    const response = await fetch('https://api-merchant.payos.vn/v2/payment-requests', {
      method: 'POST',
      headers: {
        'x-client-id': CLIENT_ID,
        'x-api-key': API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    console.log('✅ QR created:', data);

    if (!data.data?.checkoutUrl) {
      return res.status(400).json({ error: 'Không tạo được QR thanh toán' });
    }

    // Trả về cho ESP32 hoặc ứng dụng
    res.json({
      message: 'Tạo QR thành công',
      amount,
      qr: data.data.checkoutUrl,
    });
  } catch (err) {
    console.error('❌ Lỗi tạo QR:', err);
    res.status(500).json({ error: 'Create QR failed' });
  }
});

// ====== API WEBHOOK PAYOS ======
app.post('/api/payos/webhook', async (req, res) => {
  const data = req.body.data;
  console.log('📩 Nhận webhook từ PayOS:', data);

  // Kiểm tra giao dịch thành công
  if (data?.code === '00' && data?.desc === 'Thành công') {
    console.log('💰 Thanh toán thành công cho đơn:', data.orderCode);

    // Gửi thông báo về Blynk
    try {
      await fetch(`${BLYNK_URL}&V1=Thanh toán thành công!`);
      console.log('✅ Đã gửi thông báo tới Blynk');
    } catch (err) {
      console.error('❌ Lỗi gửi Blynk:', err);
    }
  }

  res.status(200).send('OK');
});

// ====== KHỞI CHẠY SERVER ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server đang chạy trên cổng ${PORT}`));
