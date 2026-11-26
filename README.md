# Slide Phật giáo

Mở agent trong repo và giao nội dung trực tiếp. Nếu agent không tự nạp `AGENTS.md`, yêu cầu nó đọc tệp đó trước. Agent nối tiếp công việc từ hồ sơ tập, không cần phiên agent trước hay Telegram. Telegram chỉ báo xong/lỗi và gửi ảnh gốc cùng nội dung theo yêu cầu của chủ bot.

- [Hướng dẫn agent](AGENTS.md) và [quy trình từng trang](docs/workflow.md).
- [Các tập](episodes/README.md), [kho nhân vật](characters/README.md) và [mẫu JSON](templates/README.md).
- [Cấu hình bot/PM2](docs/telegram.md). Không có agent chạy trong bot.

Yêu cầu Node.js 24.19 trở lên và ImageMagick (`magick`). PM2 chỉ cần cho bot chạy nền. Chạy `npm test` để kiểm thử cục bộ, không gọi API ảnh hoặc Telegram thật. Dữ liệu tập và cấu hình bí mật không nằm trong Git.
