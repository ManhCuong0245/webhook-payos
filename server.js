import express from 'express';
import bodyParser from 'body-parser';

const app = express();
app.use(bodyParser.json());

// Kiểm tra server
app.get('/', (req, res) => {
  res.send('✅ Webhook server đang hoạt động');
});

// Webhook PayOS gửi dữ liệu vào đây
app.post('/api/payos/webhook', (req, res) => {
  console.log('📩 Nhận webhook từ PayOS:', req.body);
  res.status(200).send('OK'); // trả về 200 để PayOS không báo lỗi
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server chạy tại cổng ${PORT}`));
