# API ảnh

Chỉ dùng `scripts/draw-image.mjs`, không gọi thủ công và không thử mạng bằng một lượt tạo ảnh. Wrapper giữ API cục bộ đã cấu hình: `POST http://localhost:20128/v1/images/generations?response_format=binary`, model `cx/gpt-image-2.6-flare`, `1024x1536`, output JPEG, ảnh tham chiếu thật. Chuẩn hóa cục bộ thành JPEG quality 95, 4:4:4, 1080 × 1440, fit và chừa lề nếu cần. Không ghép chữ, crop, kéo méo hay nén lại khi xuất. Nếu endpoint cần khóa, dùng biến môi trường `NINEROUTER_KEY` đã cấu hình, không đọc/in/lưu giá trị.

## Lượt vẽ

- Slide: `node scripts/draw-image.mjs --slide episodes/Tn N`. Wrapper chỉ xử lý trang chưa chốt đầu tiên; tái dùng ảnh đã kiểm hoặc JPEG nháp còn đúng. Ảnh lỗi thị giác cần ghi `reject` cụ thể trước khi vẽ sửa, tối đa ba lượt cho cùng nội dung trang.
- Nhân vật: chuẩn bị **đủ kịch bản 1–35 slide** trong trạng thái `draft`, rồi `node scripts/draw-image.mjs --character episodes/Tn ID/v1 PROMPT_FILE [REF ...]`. Tìm trong kho trước khi gọi. Prompt cục bộ chỉ dùng để vào lệnh; bản đã gửi nằm trong lượt gọi. Ảnh mẫu không chữ: mô tả đúng một nhân vật, vai trò, mặt/tuổi, tóc, vóc dáng, y phục, màu, dáng đơn giản và đặc điểm phân biệt. Nêu rõ vai trò ảnh tham chiếu theo thứ tự, dùng ảnh phong cách cho nét/màu, không chép người/chữ trong ảnh phong cách. Sau kiểm, lưu JSON mô tả diện mạo thực và ảnh thật với `generated`, ghim cùng ảnh cho các slide. Mẫu không đòi người dùng duyệt trước.
- Mỗi lượt vẽ slide gửi mẫu phong cách và ảnh định danh của từng nhân vật kèm `identity`/`keep` của đúng phiên bản. Không chỉ gửi mã, đường dẫn hoặc yêu cầu “giữ giống lần trước”.
- Mỗi POST được ghi `drafts/<lượt>/request.json` và `status.json` trước khi gửi. Raw ở `response.bin`; ảnh cần mở ở `image.jpg`. Không sinh nhiều request/lô hay retry tự động.

## Khi Dừng

- Chạy `node scripts/episode-tools.mjs handoff episodes/Tn`. Mọi lượt API lỗi/chưa rõ chặn cả tập. Giữ ảnh đã chốt và hồ sơ. Bot báo mã an toàn; không chuyển response/prompt lỗi ra Telegram.
- Nếu `raw_recoverable`, chạy `node scripts/draw-image.mjs --normalize episodes/Tn ATTEMPT` để xử lý raw có hash cục bộ, không POST. Sau đó mở JPEG và kiểm như thường.
- Nếu chưa rõ lần trước đã tạo ảnh/tính phí chưa, đối chiếu phía API trước. Nếu có thể xác nhận không dùng được kết quả và đã xử lý nguyên nhân, ghi `node scripts/draw-image.mjs --reconcile episodes/Tn ATTEMPT --note "kết quả đã đối soát"`. Lệnh chỉ ghi nhận, không gọi ảnh. Không dùng để bỏ qua raw còn phục hồi được hoặc kết quả chưa rõ.
