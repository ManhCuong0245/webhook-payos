import express from "express";
const app = express();
app.use(express.json());

// Token bảo mật trùng với PayOS
const WEBHOOK_TOKEN = "hethongsacxe";

// Khi PayOS gửi dữ liệu thanh toán
app.post("/api/payos/webhook", (req, res) => {
  if (req.headers["x-payos-token"] !== WEBHOOK_TOKEN) {
    return res.status(403).send("Invalid token");
  }

  console.log("💳 Giao dịch nhận:", req.body);
  res.sendStatus(200);
});

// Kiểm tra server hoạt động
app.get("/", (req, res) => res.send("Webhook đang hoạt động 🚀"));

// Render sẽ tự set PORT
app.listen(process.env.PORT || 3000, () =>
  console.log("✅ Server webhook đang chạy...")
);
