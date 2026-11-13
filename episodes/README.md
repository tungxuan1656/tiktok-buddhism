# Nội dung từng lần làm

Mỗi lần làm một thư mục, Pi tự tạo; người dùng không phải điền file.

	2026-11-12-lang-nghe/
	  episode.json        Nội dung/kịch bản theo templates/episode.json
	  notes.md            Yêu cầu gốc, quyết định, tự kiểm tra, phản hồi/duyệt
	  source.txt          Chỉ cần khi trích nguyên văn
	  references/         Snapshot JSON + ảnh nhân vật đã dùng
	  prompts/            Prompt thực tế từng lượt
	  drafts/             Request, phản hồi gốc, ảnh AI tạo cả tranh/chữ
	  output/r01/         001.png… và episode.json snapshot, bản để người dùng xem
	  output/r02/         Revision mới, không ghi đè r01

Chỉ tạo thứ có dùng. `episode.json` là kịch bản duy nhất, không cần thêm
storyboard/source/review JSON riêng khi thông tin đã có ở đó và notes.
Mỗi revision giữ một bản episode JSON để biết đúng chữ, ảnh và phiên bản nhân
vật đã dùng. Văn bản trong JSON là nội dung chuẩn, không phải bản tự chép lại
từ ảnh model tạo sai.

- `draft`: đang làm; `ready_for_review`: Pi đã đọc/so đủ PNG, chờ người dùng;
  `approved`: người dùng đã xác nhận revision cụ thể, ghi vào notes.
- Nhân vật `generated` dùng được, không cần duyệt mẫu trước.
- Với nguyên văn, nối toàn bộ text phải bằng source.txt, kể cả khoảng trắng;
  giữ nguyên dữ liệu nguồn. Ảnh được kiểm tra thị giác, không chứng minh mã
  Unicode hoặc khoảng trắng vô hình từ pixel.
- AI tạo cả tranh lẫn chữ. Pi đọc chữ và so nội dung/dấu; sai thì sửa ảnh,
  không thêm renderer ghép chữ hoặc sửa nguồn để hợp thức hóa lỗi.
- Lưu kết quả tự kiểm tra từng trang vào notes: chữ, nhân vật, bố cục, lỗi/lượt
  sửa, đường dẫn PNG đã xem. Không gọi tập thiếu ảnh/ảnh lỗi là hoàn thành.
- Đưa ảnh/đường dẫn trực tiếp trong phiên Pi, không tự đăng/gửi dịch vụ khác.
  Ngoại lệ tác vụ Telegram: bridge gửi PNG gốc về đúng private chat chủ bot
  sau khi kiểm tra manifest; không mở quyền gửi tới người nhận khác.

Tác vụ Telegram dùng `telegram-<task-id>/` với cấu trúc trên và thêm
`handoff/<run-id>/request.json`, `result.json` cho giao tiếp máy đọc. Session
và tiến độ gửi nằm riêng trong `.telegram/`; xem [bridge](../bridge/README.md).

Dữ liệu tập bị Git bỏ qua mặc định: sao lưu riêng khi chuyển máy. Git không
khôi phục được file chưa commit; không dọn/xóa dữ liệu tùy tiện. Giữ nguyên tập
thử `local-api-e2e-20261111-v1` làm hồ sơ lịch sử, không phải mẫu bắt buộc.
