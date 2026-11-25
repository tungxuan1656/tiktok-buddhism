# Telegram và PM2

Telegram không nhận đề bài, không mở agent và không đăng TikTok. Bot chỉ gửi về private chat trùng `TELEGRAM_USER_ID` và chỉ nhận lệnh từ chính user đó. Đặt `TELEGRAM_BOT_TOKEN` và `TELEGRAM_USER_ID` trong `.env` theo [mẫu](../.env.example), không commit hoặc nhắn khóa. Mở bot bằng account đã cấu hình.

- `/episodes`: xem mã, tên và trạng thái tập.
- `/get T34`: trả ảnh thành phẩm nguyên tệp, đúng thứ tự, sau đó gửi UTF-8 `T35-noi-dung.txt` dựng lúc gửi. Không lấy ảnh nháp hoặc gửi khi tập còn chỉnh. Tập cũ có thể đã đăng dù máy không còn đủ ảnh xác minh được.
- Tập mới chốt đủ ảnh: bot nhắn `T36: "Lắng Nghe" đã xong.`, không tự gửi ảnh. Lỗi API: ví dụ `T36: "Lắng Nghe" đang dừng ở ảnh 8 — IMG_HTTP_429.` Không báo hồi tố cho tập đã migrate.
- Nếu Telegram không xác nhận một tệp, bot dừng gửi bộ đó. Kiểm tra chat trước khi dùng lại `/get`; bot không tự lặp POST chưa rõ. Biên nhận và offset ở `.telegram/delivery.sqlite`, không có outbox sao ảnh hay kịch bản.

Chạy `npm run check` để kiểm cấu hình cục bộ (không gọi mạng). Chạy `npm run service:start` để khởi động một instance qua `ecosystem.config.cjs`. Kiểm với `pm2 status buddhism-telegram` và `pm2 logs buddhism-telegram --lines 20 --nostream`; không chạy thêm bot trực tiếp cùng token. Bot tắt không cản agent sản xuất.
