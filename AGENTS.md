# Làm slide Phật giáo

Nhận yêu cầu trực tiếp trong phiên agent: tự viết kịch bản, dùng/tạo mẫu, vẽ cả tranh và chữ trong cùng ảnh, tự đối chiếu rồi bàn giao. Không cần người dùng điều phối hoặc duyệt từng bước.

Đọc [quy trình](docs/workflow.md), [biên tập](docs/editorial.md), [phong cách](docs/visual-style.md) và [kho nhân vật](characters/README.md) trước khi làm. Khi vẽ, làm theo [API ảnh](docs/image-api.md); không gọi trực tiếp hay gọi thử. Khi tiếp quản tập, chạy `handoff` trước khi đọc lại lịch sử hoặc vẽ.

- Soạn từ [mẫu](templates/episode.json) vào một `artifact/episode.json` với mã đã cấp, tối đa 35 trang tính cả bìa/kết. Không đọc hàng loạt tập cũ hay mã CLI nếu luồng chuẩn đủ dùng. Chốt chữ trước khi vẽ slide; không đổi nguồn để hợp thức hóa lỗi ảnh. Telegram gửi nguyên văn `request`: lưu đúng phần nội dung người dùng gửi, không kèm chỉ dẫn sản xuất. Chỉ cập nhật `request` theo bản sửa người dùng đã cho phép, trước khi khóa.
- Có thể [vẽ gối đầu đúng một trang](docs/workflow.md#vẽ-gối-đầu-kiểm-từng-trang) khi đang kiểm trang hiện tại; không chạy hai request cùng lúc. Vẫn mở từng JPEG đã nén, so chữ/dấu, bố cục và nhân vật, rồi dùng `--checked` hoặc `reject` theo thứ tự. Không chép lại kết quả từng trang vào `notes.md`. Giữ trang đạt còn khớp; không dùng ảnh nháp làm thành phẩm.
- Báo tiến độ gọn mỗi 5–10 trang mới đạt hoặc khi cần báo việc bị chặn, không báo từng lượt ảnh.
- Dùng nguyên văn bản người dùng gửi nếu đầy đủ, rõ ràng; không tự tra lại kho nguồn hay web. Hỏi nếu thiếu đoạn, chưa rõ lời trích hay người nói, hoặc cần sửa mà chưa được phép. Truyện tự viết ghi rõ là minh họa/hư cấu. Không tự gán đã đăng thay người dùng.
- Lỗi API dừng cả tập; không tự retry hoặc đổi model/provider. Giữ hồ sơ phục hồi. Không đọc, in hay lưu khóa bí mật.
- Agent bàn giao trong phiên; [bot Telegram](docs/telegram.md) tự báo tin và chỉ gửi thành phẩm theo lệnh từ private chat chủ bot. Agent không tự gọi Telegram/đăng bài. Giữ nguyên `references/user-style-v1/` và `episodes/local-api-e2e-20261111-v1` là hồ sơ lịch sử, không áp dụng quy trình cũ trong đó.
