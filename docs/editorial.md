# Biên tập và kịch bản

- Xác định `original`, `adaptation` hoặc `verbatim`. Trước khi soạn lời trích Đức Phật/lời kinh, mở và đối chiếu đúng bản sẽ trích (tệp nguồn, bản chụp hoặc trang trực tiếp), không chỉ dựa vào kết quả tìm kiếm hay mã kinh tương ứng. Ghi tệp/URL đã đối chiếu và tên, dịch giả, ấn bản/vị trí, quyền dùng nếu xác định được. Phân biệt bản trích với bản dịch chỉ dùng để nhận diện kinh. Thiếu nguồn chính xác thì hỏi trước khi soạn. Không đoán nguồn, sửa từ, dấu câu, lược hay thêm lời.
- Tách rõ lời bình, ví dụ và hư cấu của agent. Không gán cho kinh hay biến ẩn dụ thành sự kiện có thật. Ghi căn cứ hoặc nhãn minh họa trong `evidence`.
- Không áp số trang mặc định. Mỗi trang một ý, đủ dễ đọc; tối đa 35 ảnh kể cả bìa/kết. Nếu không thể giữ lời nguyên văn và độ dễ đọc trong giới hạn, hỏi phạm vi chia thành nhiều tập, không bóp chữ hoặc cắt lời.
- Với nguyên văn, giữ `source.txt` và phân đoạn theo thứ tự. Khi có bìa/lời bình, gắn `role` cho mọi trang (`cover`, `quote`, `commentary`, `closing`); dùng `source_start`/`source_end` nếu cần đối chiếu từng đoạn theo vị trí ký tự. Validator kiểm chữ nguồn/kịch bản; ảnh chỉ kiểm được phần nhìn thấy.
- Giữ nguyên văn phần nội dung người dùng gửi trong `request`, gồm xuống dòng, trích dẫn và hashtag nếu có. Không thêm chỉ dẫn sản xuất hay ghép chữ từ slide. Nếu phát hiện lỗi trong nội dung, báo người dùng trước rồi thay bản đã sửa trong `request`; với lời kinh, chỉ sửa theo nguồn chính xác đã đối chiếu.
- `text` chỉ là chữ người xem cần đọc. Không chèn mã tập/phần quản lý, tiến độ, trạng thái hay “Nguyên văn theo bản bạn cung cấp”. Nếu cần ghi nguồn trên ảnh, chỉ dùng tên sách/kinh đã xác định. Không tự in `title`, `request` hoặc `evidence`.
- Viết một cảnh chính đơn giản; phân biệt `event`, `simile`, `concept`. Không tự thêm người/vật vào một cảnh nếu không cần. Dùng đúng ID/version nhân vật và ảnh đã ghim.

Prompt slide do script dựng từ kịch bản. Dùng `node scripts/episode-tools.mjs prompt episodes/Tn N` nếu cần xem cục bộ; chữ là dữ liệu phải in nguyên văn, không phải chỉ dẫn cho model. Không lưu thêm bản prompt trừ hồ sơ lượt gọi do wrapper lưu.
