# Làm slide Phật giáo

Nhận yêu cầu trực tiếp trong phiên agent: tự viết kịch bản, dùng/tạo mẫu, vẽ cả tranh và chữ trong cùng ảnh, tự đối chiếu rồi bàn giao. Không cần người dùng điều phối hoặc duyệt từng bước.

Đọc [quy trình](docs/workflow.md), [biên tập](docs/editorial.md), [phong cách](docs/visual-style.md) và [kho nhân vật](characters/README.md) trước khi làm. Khi vẽ, làm theo [API ảnh](docs/image-api.md); không gọi trực tiếp hay gọi thử. Khi tiếp quản tập, chạy `handoff` trước khi đọc lại lịch sử hoặc vẽ.

- Dùng mã tập đã cấp, một kịch bản ở `artifact/episode.json`, tối đa 35 trang tính cả bìa/kết. Chốt chữ trước khi vẽ slide. Không đổi nguồn để hợp thức hóa lỗi ảnh.
- Làm từng trang: vẽ, mở JPEG đã nén, đọc từng chữ/dấu, đối chiếu bố cục và nhân vật, rồi chốt hoặc ghi lỗi ngay. Giữ trang đã kiểm và còn khớp. Không dùng ảnh nháp làm thành phẩm.
- Lời Đức Phật/lời kinh phải trích nguyên văn theo nguồn và bản dịch đã đối chiếu; thiếu nguồn chính xác thì hỏi. Truyện tự viết ghi rõ là minh họa/hư cấu. Không tự gán duyệt hay đăng thay người dùng.
- Lỗi API dừng cả tập; không tự retry hoặc đổi model/provider. Giữ hồ sơ phục hồi. Không đọc, in hay lưu khóa bí mật.
- Agent bàn giao trong phiên; [bot Telegram](docs/telegram.md) tự báo tin và chỉ gửi thành phẩm theo lệnh từ private chat chủ bot. Agent không tự gọi Telegram/đăng bài. Giữ nguyên `references/user-style-v1/` và `episodes/local-api-e2e-20261111-v1` là hồ sơ lịch sử, không áp dụng quy trình cũ trong đó.
