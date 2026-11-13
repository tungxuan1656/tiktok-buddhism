# Từ yêu cầu tới slide có chữ

Checklist cho chính Pi, không phải việc giao lại cho người dùng. Bình thường
một lần nhận yêu cầu, một lần bàn giao; không chèn duyệt kịch bản/nhân vật.

## 1. Hiểu yêu cầu và lưu việc đang làm

- Đọc AGENTS, phong cách và kho nhân vật. Sửa tập cũ thì mở tập đó, dùng đúng
  snapshot đã có. Ghi phản hồi và quyết định vào `notes.md`.
- Tạo `episodes/<ngày>-<tên-ngắn>/`, trùng thì thêm hậu tố, không ghi đè.
  Lưu yêu cầu nguyên gốc; dùng [mẫu tập](templates/episode.json) tạo `episode.json`.
  Qua Telegram, dùng nguyên `episode_dir` do bridge cấp thay vì tự đặt thư mục.
  [Giao thức bridge](bridge/agent.md) bổ sung handoff, không thay các bước này.
- Mặc định 5 trang, mỗi trang một ý, khoảng 20–40 từ dễ đọc. Đoạn dài thì
  thêm trang hoặc rút gọn khi được diễn giải, không nhồi chữ để đủ 5 trang.

Chọn đúng `mode`:

| Mode | Cách làm |
| --- | --- |
| `original` | Pi viết theo chủ đề; không gán thành lời kinh/trích dẫn thật. `source` có thể `null`. |
| `adaptation` | Tóm tắt/diễn giải tài liệu; ghi nguồn và rõ đó là diễn giải. |
| `verbatim` | Giữ nguyên văn bản đã đối chiếu; lưu source.txt UTF-8, nối text các slide phải bằng nguồn. |

Nếu chỉ có tên bài kinh, tìm đúng bản dịch; hỏi khi không xác định được bản
người dùng muốn. Không lấy trí nhớ làm nguồn trích dẫn. Ghi tên, dịch giả/ấn bản
nếu có, URL/vị trí và cơ sở quyền dùng, không suy ra bản dịch hiện đại là miễn
bản quyền. Quyền chưa rõ thì báo giới hạn, không tự ghi đã được phép xuất bản.

## 2. Kịch bản ngắn và nội dung chữ chính xác

Dùng [prompts/storyboard.md](prompts/storyboard.md). Mỗi slide có `text`,
`scene`, `scene_type`, `evidence`, `characters` và `image`.

- `event`: sự kiện có căn cứ; `simile`: ví dụ/ẩn dụ; `concept`: hình
  biểu trưng/không khẳng định lịch sử. Truyện tự viết ghi rõ hư cấu/minh họa.
- Một hành động chính, ít người/đồ vật. Tư thế đổi được, diện mạo/y phục không.
- Chốt `text` trước khi vẽ. Đây là văn bản duy nhất được phép xuất hiện trên
  ảnh, gửi nguyên đoạn đó vào phần CHỮ CẦN IN của prompt. Không thêm nhãn trang,
  tiêu đề, dấu ngoặc kép hoặc lời kêu gọi nếu text không có.
- Nguyên văn dài: chia đoạn liên tiếp, không sửa/bỏ chữ, dấu hoặc khoảng trắng
  ở dữ liệu gốc để ép vừa. Kiểm tra nối text khớp source.txt trước khi gọi API.
  Xuống dòng thị giác có thể khác, nhưng ảnh không được thiếu/thừa từ hoặc dấu.

## 3. Nhân vật: dùng lại trước, tự tạo khi thiếu

Theo [characters/README.md](characters/README.md). Mở JSON **và ảnh thật**.
Thiếu thì dùng [prompt nhân vật](prompts/character.md) tạo ảnh mẫu không chữ,
tự xem/sửa, lưu `generated` và tiếp tục, không xin duyệt riêng.

Chốt ID/version cho tập. Lưu snapshot JSON + ảnh mẫu dưới
`references/<ID>/<version>/` trong tập; ghi đường dẫn/hash vào notes.
Mọi lượt vẽ/sửa dùng snapshot đó dù kho nhân vật đã có bản mới. Ảnh phong cách
chỉ định nét/màu; không thay thế ảnh định danh nhân vật.

## 4. API vẽ cả tranh lẫn chữ

Dùng [prompt slide](prompts/illustration.md) và [hướng dẫn API](references/painter-local-api.md).
Điền hết chỗ giữ chỗ, gửi đúng text và đủ ảnh tham chiếu thực theo thứ tự đã ghi.
Không gửi toàn bộ nguồn khi chỉ cần chữ của một trang.

Tạo từng trang rồi **mở ảnh ngay** để tránh nhân lỗi qua cả tập. Lưu request,
prompt, phản hồi gốc, MIME/kích thước thật và ảnh vào drafts. Điền đường dẫn
ảnh vào `image` trong episode.json. Không để AI tự sửa chữ để vừa bố cục.

## 5. Đọc ảnh và sửa có mục tiêu

Mở ảnh đầy đủ, rồi phóng to/crop vùng chữ nếu cần. Đọc từng dòng và đối chiếu
với `text`, không kiểm tra dựa vào việc prompt đã gửi đúng:

- Đúng từng từ, dấu tiếng Việt/dấu câu, không thiếu câu, lặp chữ hoặc thêm chữ.
- Không chữ rác, tiêu đề phụ, watermark; chữ rõ trên điện thoại, không đè tranh.
- Mặt, tóc, tỷ lệ, y phục đúng mẫu; số người, hành động, tay/chân và bối cảnh đúng.
- Nếu đọc không chắc, đánh dấu chưa đạt, không tự đoán hoặc coi OCR là chứng cứ
  tuyệt đối. Có thể dùng OCR hỗ trợ nếu sẵn có, nhưng vẫn xem ảnh thật.

Sai thì yêu cầu sửa lỗi cụ thể, gửi lại text chuẩn + đúng mẫu nhân vật; có thể
kèm ảnh nháp với vai trò bố cục cần sửa. Không sửa JSON/nguồn để hợp thức hóa
lỗi model. Tối đa 2 lượt sửa/trang trong một lượt giao việc; vẫn sai thì nói rõ
phần chưa đạt để người dùng quyết định tiếp. Không tự retry sau timeout.

Đây là kiểm tra thị giác, không thể xác minh mã Unicode/khoảng trắng vô hình
từ pixel. Giữ văn bản gốc trong repo, không tuyên bố kiểm tra ảnh là so byte.

## 6. Xuất file và bàn giao

Ảnh đạt nội dung thì đổi sang PNG 1080 × 1440 theo hướng dẫn API. Chỉ fit +
padding, không thêm chữ bằng phần mềm, không crop hoặc kéo méo. Mở lại **từng
PNG cuối** để chắc không mờ/chặt chữ sau đổi kích thước.

Lưu `output/r01/001.png`… và snapshot `episode.json` của revision. Ghi kết quả
tự kiểm tra/giới hạn vào notes, đặt `ready_for_review` chỉ khi đủ trang đã đạt.
Đưa ảnh trong chat nếu hỗ trợ và đường dẫn tuyệt đối. Không giả vờ đã đính kèm
nếu giao diện chỉ có đường dẫn, không tự gửi qua dịch vụ khác. Với tác vụ
Telegram đã được giao, Pi ghi manifest theo [bridge/agent.md](bridge/agent.md);
bridge kiểm tra và gửi PNG gốc về đúng private chat chủ bot. Không dùng việc
gửi thành công hoặc agent_settled làm bằng chứng đã đạt chất lượng.

Người dùng sửa: giữ bản cũ, chỉ tạo lại trang cần sửa, dùng cùng references,
xuất revision mới. Text đổi thì cần sửa ảnh vì chữ do model tạo, không có bước
chèn chữ riêng. Người dùng xác nhận thì ghi `approved` cho **đúng revision**
trong notes. Duyệt tập không tự đồng nghĩa duyệt mọi mẫu nhân vật. Không tự đăng.
