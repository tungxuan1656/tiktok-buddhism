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

### Cổng biên tập: chữ phải sẵn sàng đăng

Trước khi chốt `text` và gọi API, đọc từng câu như một người xem không biết
cuộc trò chuyện giao việc. Đúng chính tả hoặc khớp JSON chưa đủ: mọi chữ trên
ảnh phải có lý do xuất hiện trong bài đăng.

- Chỉ giữ nội dung, tiêu đề và thông tin nguồn thực sự dành cho người xem.
  Không tự thêm lời dẫn, lời xác nhận, lời hứa, ghi chú kỹ thuật hoặc lời
  nói với người giao việc như "Nguyên văn theo bản bạn cung cấp", "Theo yêu
  cầu của bạn", "Bản nháp", "Đã kiểm tra".
- Mã tập/phần người dùng tự đặt để nhớ, ID, số revision, tên file, tiến độ
  và chỉ dẫn sản xuất là metadata: giữ trong request/notes/source metadata,
  không chép từ `title`, `request` hay `evidence` vào `text`. Ví dụ
  "Tập 1 - phần 1.1" không phải tiêu đề công khai mặc định. Chỉ in tiêu đề
  chương/phần khi xác định đó là nội dung thật của nguồn hoặc người dùng
  nói rõ muốn nó xuất hiện trong bài đăng; không suy ra từ nhãn quản lý.
- Nếu ghi nguồn trên ảnh, ghi gọn đúng tên sách/kinh đã đối chiếu; không
  dùng "bản bạn cung cấp" thay cho tên nguồn, không bịa tên hoặc xuất xứ.
  Dịch giả, ấn bản, URL, vị trí trích và căn cứ kiểm chứng lưu trong metadata;
  chỉ đưa thêm lên ảnh khi cần ghi công/quyền sử dụng hoặc được yêu cầu rõ.
- Tách ghi chú giao việc khỏi phần nguồn cần trích trước khi chốt kịch bản.
  Giữ yêu cầu và nguồn nhận được để truy nguyên; không làm sạch bằng cách
  tự sửa/lược lời trích thật. Với `verbatim`, vẫn đối chiếu phần nguồn đã
  xác định và kiểm tra nối text như trên; không rõ ranh giới thì hỏi.
- Không bỏ nhãn cần thiết để tránh gây hiểu lầm như "diễn giải" hoặc
  "minh họa hư cấu". Viết chúng ngắn, hướng tới độc giả, không thành lời
  trao đổi nội bộ hoặc một lời cam kết đã xác minh không có căn cứ.

Ghi kết quả biên tập vào notes: không còn lời nội bộ/nhãn quản lý, nguồn đúng
và mọi câu phù hợp để đăng. Sau đó mới khóa `text` để vẽ.

## 3. Nhân vật: dùng lại trước, tự tạo khi thiếu

Theo [characters/README.md](characters/README.md). Mở JSON **và ảnh thật**.
Thiếu thì dùng [prompt nhân vật](prompts/character.md) tạo ảnh mẫu không chữ,
tự xem/sửa, lưu `generated` và tiếp tục, không xin duyệt riêng.

Chốt ID/version cho tập. Lưu snapshot JSON + ảnh mẫu dưới
`references/<ID>/<version>/` trong tập; ghi đường dẫn/hash vào notes.
Mọi lượt vẽ/sửa dùng snapshot đó dù kho nhân vật đã có bản mới. Ảnh phong cách
chỉ định nét/màu; không thay thế ảnh định danh nhân vật.

## 4. API vẽ cả tranh lẫn chữ

Dùng [prompt slide](prompts/illustration.md) và [wrapper API](references/painter-local-api.md).
Bắt buộc chạy `node scripts/draw-image.mjs`; không tự gọi curl/fetch. Wrapper
gọi API một lần, giữ raw response, tự fit/padding và nén JPEG quality 95.
Điền hết chỗ giữ chỗ, gửi đúng text và đủ ảnh tham chiếu thực theo thứ tự đã ghi.
Không gửi toàn bộ nguồn khi chỉ cần chữ của một trang. Bố cục linh hoạt theo
nội dung, không bắt buộc tỷ lệ vùng chữ/tranh hoặc vị trí trên/dưới cố định;
ưu tiên tranh và chữ đầy đủ, rõ ràng, dễ đọc.

Tạo từng trang rồi **mở ảnh ngay** để tránh nhân lỗi qua cả tập. Lưu request,
prompt, phản hồi gốc, MIME/kích thước thật và ảnh vào drafts. Điền đường dẫn
ảnh vào `image` trong episode.json. Không để AI tự sửa chữ để vừa bố cục.

## 5. Đọc ảnh và sửa có mục tiêu

Mở ảnh đầy đủ, rồi phóng to/crop vùng chữ nếu cần. Đọc từng dòng và đối chiếu
với `text`, không kiểm tra dựa vào việc prompt đã gửi đúng:

- Đúng từng từ, dấu tiếng Việt/dấu câu, không thiếu câu, lặp chữ hoặc thêm chữ.
- Đạt cổng biên tập: không có lời nói với chủ bot, nhãn quản lý hay câu thừa
  không phù hợp đăng, kể cả khi những chữ đó đã có sẵn trong JSON. Nếu kịch
  bản chứa chúng, sửa kịch bản có ghi lý do rồi vẽ lại trang bị ảnh hưởng ở
  revision mới; không hợp thức hóa ảnh sai bằng cách sửa nguồn cho khớp.
- Tranh và chữ đầy đủ, rõ trên điện thoại, bố cục phù hợp; không che nhau
  hoặc bị cắt. Không chữ rác, tiêu đề phụ, watermark.
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

Wrapper đã xuất JPEG95 1080 × 1440, chỉ fit + padding, không thêm chữ bằng
phần mềm, không crop hoặc kéo méo. Kiểm tra chữ sau nén; sao chép nguyên bytes
ảnh đạt sang output, không mã hóa JPEG thêm lần nữa. Mở lại **từng ảnh cuối**
để chắc không mờ/chặt chữ. PNG và revision cũ giữ nguyên, vẫn dùng được.

Lưu `output/r01/001.jpg`… và snapshot `episode.json` của revision. Ghi kết quả
tự kiểm tra/giới hạn vào notes, đặt `ready_for_review` chỉ khi đủ trang đã đạt.
Đưa ảnh trong chat nếu hỗ trợ và đường dẫn tuyệt đối. Không giả vờ đã đính kèm
nếu giao diện chỉ có đường dẫn, không tự gửi qua dịch vụ khác. Với tác vụ
Telegram đã được giao, Pi ghi manifest theo [bridge/agent.md](bridge/agent.md);
bridge kiểm tra rồi gửi album ảnh về đúng private chat chủ bot; Telegram có
thể nén ảnh, `/files` gửi nguyên JPEG/PNG đã chốt, không phải response API thô. Không dùng việc gửi thành công hoặc
agent_settled làm bằng chứng đã đạt chất lượng.

Người dùng sửa: giữ bản cũ, chỉ tạo lại trang cần sửa, dùng cùng references,
xuất revision mới. Text đổi thì cần sửa ảnh vì chữ do model tạo, không có bước
chèn chữ riêng. Người dùng xác nhận thì ghi `approved` cho **đúng revision**
trong notes. Duyệt tập không tự đồng nghĩa duyệt mọi mẫu nhân vật. Không tự đăng.
