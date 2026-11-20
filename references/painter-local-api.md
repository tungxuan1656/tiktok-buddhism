# API ảnh — wrapper 9Router local

Pi gọi API khi được giao làm/sửa slide, không gọi chỉ để thử setup. **Mọi lượt
tạo mẫu nhân vật, vẽ và sửa ảnh phải dùng [scripts/draw-image.mjs](../scripts/draw-image.mjs)**.
Không tự viết lại curl/fetch, đổi provider hay bỏ qua bước xử lý ảnh trong script.
Đọc [phong cách](style.md) và [prompt](../prompts/README.md) trước khi vẽ.

## Cấu hình đang dùng

| Mục | Giá trị |
| --- | --- |
| URL cố định | `http://localhost:20128` |
| Model | `cx/gpt-image-2.6-flare` |
| Endpoint | `POST /v1/images/generations?response_format=binary` |
| Request | `model`, `prompt`, `size: "1024x1536"`, `output_format: "jpeg"`, `images` |
| Thành phẩm | JPEG **1080 × 1440**, quality **95**, chroma **4:4:4**, nền trắng, sRGB |
| Bố cục khi đổi kích thước | Fit + padding, không crop/méo/chèn chữ |
| Ảnh mẫu | PNG/JPEG thật, Data URL đúng MIME, tối đa 10 ảnh, giữ thứ tự |
| Khóa nếu server yêu cầu | `NINEROUTER_KEY` từ môi trường; không lưu header/khóa |
| Thời hạn | 300 giây cho HTTP; không retry hoặc tự đổi model |

Theo [skill 9Router chính thức](https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-image/SKILL.md),
nhánh Codex dùng `image`/`images`, `size`, `output_format`; không dùng
`aspect_ratio`/`reference_images` của Gemini cũ. Metadata/skill hiện chưa xác
nhận `output_compression`: script **không giả gửi tham số 0.95 cho API**.
Sau khi giữ nguyên response, ImageMagick có sẵn mã hóa JPEG quality 95 ngay
trong wrapper. Đây là tham số encoder, không có nghĩa giữ chính xác 95% chất
lượng. JPEG có mất dữ liệu; phải mở ảnh sau nén để đọc lại từng dấu tiếng Việt.

Không yêu cầu khóa khi biến chưa có: gateway từng nhận request không có
Authorization. 401/403 thì dừng, xin cấp khóa qua kênh an toàn, không dò tìm
bí mật, in môi trường hoặc sửa xác thực. Skill nêu Codex cần ChatGPT Plus/Pro;
không tự mua gói/tài khoản. Không mở cổng Internet hoặc đổi URL/model để lách lỗi.

## Một lệnh cho mỗi lượt tạo/sửa

1. Lưu toàn bộ kịch bản vào episode.json (1-35 slide, text không rỗng), rồi
   lưu prompt thực tế, đúng text và chỉ dẫn nhận diện theo
   [character](../prompts/character.md) hoặc [illustration](../prompts/illustration.md).
2. Mở các ảnh mẫu thật; ghi thứ tự → ID/version/vai trò trong prompt và notes.
   Nhân vật có sẵn phải dùng snapshot đã chốt, không chỉ gửi đường dẫn/ID.
3. Từ gốc repo, chọn **thư mục draft chưa tồn tại**. Thời hạn tool dài hơn
   300 giây để còn xử lý ảnh sau HTTP. Thay đường dẫn ví dụ bằng dữ liệu thật:

```bash
node scripts/draw-image.mjs --slide 'episodes/TEN-TAP/episode.json' 1 \
  'episodes/TEN-TAP/prompts/001-r01.txt' \
  'episodes/TEN-TAP/drafts/001-r01' \
  'episodes/TEN-TAP/references/PHAT_01/v1/reference.jpg'
```

Tạo/sửa mẫu nhân vật dùng `--character EPISODE_JSON PROMPT_FILE NEW_DRAFT_DIR
[REFERENCE ...]` thay cho `--slide EPISODE_JSON SLIDE_NUMBER ...`. Cả hai
chế độ đều đọc JSON, kiểm tra 1-35 slide và text trước POST; `--slide` còn
kiểm tra số trang có trong kịch bản. CLI cũ không có JSON bị từ chối.
`--normalize` chỉ xử lý response đã có nên không yêu cầu kịch bản.

Các đối số sau thư mục draft là ảnh tham chiếu, đúng thứ tự. Có thể không có
ảnh mẫu khi thiết kế mới/cảnh không cần; thường dùng
`references/user-style-v1/example-01-original.png` làm **ảnh phong cách**, không
phải định danh mọi nhân vật. Mọi lần sửa vẫn gửi lại mẫu thật và toàn bộ text
đúng; không gửi cả nguồn kinh khi chỉ cần in một trang.

Script tự tạo thư mục độc quyền, lưu request/reference metadata, gọi **một**
POST rồi xử lý ảnh. Nếu thư mục đã có thì từ chối trước API; không xóa thư mục
để chạy lại. Kết quả một lượt:

- `request.json`: prompt/tham số, kịch bản/số slide và số mẫu; không lưu Data
  URL/base64 trùng lặp hay Authorization. Payload gửi mạng vẫn có ảnh thật.
- `references.json`: đường dẫn/MIME/kích thước thật của từng mẫu.
- `response.bin`: bytes phản hồi API nguyên vẹn, không ghi đè bằng JPEG đã nén.
- `status.json`: checkpoint lưu atomically; `in_flight`, `received`, `succeeded`,
  `invalid_input`, `failed`, `unknown` hoặc `normalize_failed`.
- `image.jpg`: ảnh đã fit/padding và mã hóa JPEG95, chỉ xuất hiện sau bước xử lý.
  Chỉ dùng khi status là `succeeded`. Status lưu MIME/kích thước/dung lượng
  nguồn và đầu ra. Không dùng thành công kỹ thuật để suy ra đúng nội dung.

Đầu vào/response tối đa 49 MB/ảnh. PNG/JPEG cũ được dùng nguyên làm references;
không đổi bytes, version hoặc provenance của kho nhân vật. Ảnh trả về được đo
MIME thực, không tin đuôi hay Content-Type; response không phải ảnh thì dừng.
Không thêm bước ghép chữ hoặc app/renderer: chữ và tranh đều đã do API tạo.

## Kiểm tra và xuất revision

Mở `image.jpg` ngay sau mỗi lượt, so từng dòng/từ/dấu với `text` trong JSON,
kiểm tra mặt/y phục/cảnh/bố cục. Không đoán chữ nhỏ, không coi OCR là chứng cứ
tuyệt đối. Sai thì lưu lý do, tạo lượt sửa mới bằng cùng script/references;
tối đa hai lần sửa/trang. Không sửa nguồn/kịch bản để hợp thức hóa chữ sai.
Lưu kết quả kiểm tra ngay sau từng ảnh, không chờ đủ cả bộ.

Wrapper đã tạo đúng 1080 × 1440; **không mã hóa JPEG lại khi xuất**. Dùng bước
cục bộ này cho ảnh đã kiểm tra, không gọi API và không dùng `cp -n`:

```bash
node scripts/export-slide.mjs \
  'episodes/TEN-TAP/drafts/001-r01/image.jpg' \
  'episodes/TEN-TAP/output/r01/001.jpg'
```

`exported` (tạo ảnh đích) và `reused` (đích đã khớp từng byte) đều thành công.
Nếu ảnh đích khác, lệnh dừng mà không ghi đè; đối chiếu lại draft và revision.
Điền đúng đường dẫn JPG vào episode.json, chỉ bổ sung dòng kiểm tra còn thiếu
trong notes, rồi lưu snapshot vào `output/rNN/episode.json`. Mở lại từng
ảnh cuối, không chỉ draft; chữ/dấu phải còn rõ. Đặt `ready_for_review` chỉ khi
đủ trang đã đạt. `/files` gửi nguyên artifact JPEG đã chốt, không phải raw
response. Không nén lại PNG cũ. Với Telegram, chỉ giữ output/snapshot mới
nhất sau khi gửi đủ; raw/draft/prompt và bản bị thay thế được bridge dọn theo
WORKFLOW. Giữ dữ liệu lỗi/unknown và mọi file còn là nguồn/nhân vật cần dùng.

## Lỗi và tiếp tục không tạo ảnh trùng

- `invalid_input`: chưa gọi API; sửa prompt/đường dẫn/môi trường, dùng draft mới.
- `failed`: HTTP từ chối xác định; giữ response để xem lỗi an toàn. Không tự
  đổi model, thêm tài khoản hay retry.
- `in_flight`/`unknown`: request có thể đã được xử lý (kể cả timeout, mất kết
  nối, HTTP 5xx/408); dừng, kiểm tra server trước khi gửi lại. Không tự retry.
- `normalize_failed`/`received`: response đã lưu nhưng chuyển đổi chưa xong;
  sửa vấn đề cục bộ rồi xử lý **file đã có**, không gọi lại API:

```bash
node scripts/draw-image.mjs --normalize \
  'episodes/TEN-TAP/drafts/001-r01/response.bin' \
  'episodes/TEN-TAP/drafts/001-r01-local-fix'
```

Chế độ `--normalize` cũng dùng thư mục mới và giữ bản nguồn, không gọi mạng.
Ảnh cũ chỉ được chuyển đổi khi công việc thật cần và phải lưu thành bản mới;
không tự nén lại toàn kho. Thiếu `magick` thì báo môi trường, không bỏ qua
wrapper/cài renderer ngầm. Không tìm/in/lưu khóa, raw lỗi không gửi vào Telegram.

## Bằng chứng và giới hạn

- GET metadata local xác nhận model ảnh, endpoint, `text2img`/`edit`/`multiImage`
  và `output_format`; không chứng minh quyền tài khoản hay chất lượng chữ.
- Wrapper được kiểm tra bằng HTTP giả cục bộ và ImageMagick thật, không gọi
  API sinh ảnh để thử setup. Chưa phải kiểm thử đầu-cuối với upstream.
- Hồ sơ `episodes/local-api-e2e-20261111-v1/` giữ nguyên: thử model cũ trả JPEG
  **896 × 1200** dù header `image/png`; không chứng minh chữ/nhân vật đúng.
- Mẫu từ lần thử cũ có trạng thái `generated`, không tự ghi người dùng duyệt.
- [Ảnh mèo thử gốc](archive/cat-api-original.jpg), JPEG 1024 × 1024, giữ nguyên bytes.
- Bằng chứng cũ cho `ag/gemini-3.1-flash-image`/nhánh `antigravity` về
  `aspect_ratio`/`reference_images` chỉ là lịch sử, không suy diễn sang Codex.
- [Skill 9Router](https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-image/SKILL.md)
  có thể khác bản cài; khi kết quả khác phải đối chiếu thực tế, không tuyên bố
  đã kiểm tra upstream chỉ vì HTTP 200.
