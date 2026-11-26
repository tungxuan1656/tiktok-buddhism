# Telegram và PM2

Telegram không nhận đề bài, không mở agent và không đăng TikTok. Bot chỉ gửi về private chat trùng `TELEGRAM_USER_ID` và chỉ nhận lệnh từ chính user đó. Đặt `TELEGRAM_BOT_TOKEN` và `TELEGRAM_USER_ID` trong `.env` theo [mẫu](../.env.example), không commit hoặc nhắn khóa. Mở bot bằng account đã cấu hình.

- `/episodes`: xem mã, tên và trạng thái tập.
- `/get T34`: trả ảnh thành phẩm nguyên tệp, đúng thứ tự, sau đó gửi UTF-8 `T34-noi-dung.txt` dựng lúc gửi. Không lấy ảnh nháp hoặc gửi khi tập còn chỉnh. Tập cũ có thể đã đăng dù máy không còn đủ ảnh xác minh được.
- Tập mới chốt đủ ảnh: bot nhắn `T36: "Lắng Nghe" đã xong.`, không tự gửi ảnh. Lỗi API: ví dụ `T36: "Lắng Nghe" đang dừng ở ảnh 8 — IMG_HTTP_429.` Không báo hồi tố cho tập đã migrate.
- Bot gửi từng tệp có giãn cách. Với phản hồi 429 có thời gian chờ hợp lệ đến 30 giây, bot thử lại đúng tệp đó một lần. Nếu vẫn không gửi được, bot dừng bộ ảnh và báo số tệp đã được Telegram xác nhận nếu có thể gửi thông báo an toàn; không tự lặp POST chưa rõ. Kiểm tra chat trước khi dùng lại `/get`. Bot ghi nhận lệnh có phản hồi và thông báo tự động ngay trước POST đầu tiên. Nếu chưa gửi được do đang chờ hoặc đang tắt, lệnh vẫn còn chờ và bot không xử lý lệnh sau vượt qua nó. Nếu POST đã bắt đầu, bot không phát lại lệnh khi khởi động lại. Với thông báo tự động bị Telegram từ chối bằng 429, bot lưu hạn thử lại trong SQLite thay vì chờ và gửi lại ngay trong lượt đó. Biên nhận và offset ở `.telegram/delivery.sqlite`, không có outbox sao ảnh hay kịch bản.

Chạy `npm run check` để kiểm cấu hình và ImageMagick cục bộ (không gọi mạng). Bot tạo `.telegram` với quyền `0700`; thư mục cũ phải được đặt quyền riêng trước khi khởi động (`chmod 700 .telegram`). Chạy `npm run service:start` để khởi động một instance qua `ecosystem.config.cjs`.

Khi nâng cấp từ bản bridge cũ, chạy `pm2 delete buddhism-telegram` một lần trước `npm run service:start` để PM2 đăng ký lại đúng entry point; chỉ restart có thể giữ đường dẫn cũ `bridge/main.ts`. Lệnh `pm2 delete` chỉ xóa đăng ký PM2: giữ nguyên `.telegram` và `delivery.sqlite`. Nếu dùng PM2 để tự khởi động sau reboot, chạy `pm2 save` sau khi kiểm bot mới đã chạy.

Log nằm ở thư mục mặc định của PM2, không nằm trong `.telegram`. Kiểm với `pm2 status buddhism-telegram` và tìm dòng `Telegram delivery bot started.` trong `pm2 logs buddhism-telegram --lines 20 --nostream`; không chạy thêm bot trực tiếp cùng token. Bot tắt không cản agent sản xuất.

Offset hết hạn sau 5 ngày kể từ lúc nhận update cuối đã xử lý, trước khi Telegram có thể đổi dãy ID. Offset từ bản cũ không có thời điểm, nên bot thăm dò hàng đợi mà không xác nhận update nào. Nếu log báo `Telegram legacy cursor conflicts with pending updates`, có update ID thấp hơn offset cũ và bot không thể biết đó là lệnh đã xử lý hay ID mới. Kiểm tra chat trước. Nếu chắc chắn các lệnh còn chờ đều cần chạy, dừng bot rồi đặt lại riêng offset với `sqlite3 .telegram/delivery.sqlite 'DELETE FROM cursor WHERE id = 1;'` và khởi động lại; không xóa bảng `notices`. Nếu không chắc, để update cũ hết hạn (Telegram giữ tối đa 24 giờ) rồi gửi lại lệnh cần dùng.
