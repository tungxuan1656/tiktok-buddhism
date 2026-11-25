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
3. Từ gốc repo, chọn **thư mục draft chưa tồn tại**. Với slide, chạy
   `build-prompts` để tạo prompt, `.meta.json` và manifest; dùng đúng danh sách
   ảnh trong manifest theo thứ tự. Thời hạn tool phải dài hơn 300 giây.
   Ví dụ (tập có một ảnh mẫu nhân vật):

```bash
node scripts/episode-tools.mjs build-prompts 'episodes/TEN-TAP' --revision r01
node scripts/draw-image.mjs --slide 'episodes/TEN-TAP/episode.json' 1 \
  'episodes/TEN-TAP/prompts/001-r01.txt' \
  'episodes/TEN-TAP/drafts/001-r01-a1' \
  'references/user-style-v1/example-01-original.png' \
  'episodes/TEN-TAP/references/PHAT_01/v1/reference.jpg'
```

Tạo/sửa mẫu nhân vật dùng `--character EPISODE_JSON PROMPT_FILE NEW_DRAFT_DIR
[REFERENCE ...]` thay cho `--slide EPISODE_JSON SLIDE_NUMBER ...`. Khi vẽ nhiều
trang sau khi đã chốt slide 1, có thể dùng `--batch EPISODE_JSON BATCH_MANIFEST_JSON`
(do `scripts/episode-tools.mjs build-prompts` tạo) để kiểm tra manifest trước,
bỏ qua trang đã `succeeded` và dừng ngay tại trang lỗi mà không tự retry. Tất cả
chế độ vẽ đều đọc JSON, kiểm tra 1-35 slide và text trước POST; `--slide` và
`--batch` còn kiểm tra số trang có trong kịch bản. CLI cũ không có JSON bị từ chối.
`--normalize` chỉ xử lý response đã có nên không yêu cầu kịch bản.

Slide bắt buộc có ảnh phong cách ở vị trí đầu và đúng các ảnh mẫu nhân vật
trong manifest (nếu có). Có thể thêm ảnh nháp làm tham chiếu sửa ở cuối và
mô tả vai trò của nó trong prompt. Khi sửa tay prompt, chạy `build-prompts
--override` để ghi nhận thay đổi. Chỉ thêm `--allow-repeat` ở cuối lệnh
`--slide` nếu đã xem ảnh cũ và thực sự cần gửi lại **cùng** request đã thành
công. Dùng `--replace-unverified` ở cuối lệnh `--slide` chỉ khi đã đối chiếu
ảnh cũ/nháp của đúng trang và xác định không đạt hoặc không thể phục hồi.
Không cờ nào bỏ chốt ảnh đã kiểm, giới hạn lượt hoặc attempt chưa rõ kết quả.
Không gửi cả nguồn kinh khi chỉ cần in một trang.

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

Mở `image.jpg` để đối chiếu từng dòng/từ/dấu với `text` trong JSON, kiểm tra
mặt/y phục/cảnh/bố cục (với mẫu nhân vật, slide 1 hoặc lượt sửa thì mở ngay;
khi vẽ lô bằng `--batch`, đọc gộp 5–6 ảnh/lượt sau khi xong lô). Không đoán
chữ nhỏ, không coi OCR là chứng cứ tuyệt đối. Sai thì lưu lý do, tạo lượt sửa
mới bằng cùng script/references; tối đa 3 lần gọi API cho mỗi trang trong một
revision (1 lượt đầu + tối đa 2 lượt sửa; mọi HTTP rejection, timeout hay
normalize failure đã gửi request đều tính vào giới hạn 3 lượt này, riêng
`--normalize` cục bộ không gọi API nên không tính thêm). Không sửa
nguồn/kịch bản để hợp thức hóa chữ sai. Lưu kết quả kiểm tra ngay sau khi đối chiếu.

Wrapper đã tạo đúng 1080 × 1440; **không mã hóa JPEG lại khi xuất**. Dùng bước
cục bộ này cho ảnh đã kiểm tra, không gọi API và không dùng `cp -n`:

```bash
node scripts/export-slide.mjs \
  'episodes/TEN-TAP/drafts/001-r01-a1/image.jpg' \
  'episodes/TEN-TAP/output/r01/001.jpg'
```

`exported` (tạo ảnh đích) và `reused` (đích đã khớp từng byte) đều thành công.
Nếu ảnh đích khác, lệnh dừng mà không ghi đè; đối chiếu lại draft và revision.
Sau khi đã tự xem ảnh đạt, có thể thêm `--checked` trước hai đường dẫn và
truyền ghi chú kiểm tra làm đối số cuối. Cùng một lệnh xuất ảnh, đối chiếu
SHA-256 và lưu biên bản trong `output/rNN/checks/TÊN_ẢNH.json`. Nếu byte ảnh
cuối khớp ảnh đã đối chiếu và biên bản vẫn đúng với kịch bản/snapshot, không
cần mở lại ảnh cuối chỉ vì nó đã được xuất; nếu không, phải xem ảnh thật.
Điền đúng đường dẫn JPG vào episode.json, bổ sung phần kiểm tra còn thiếu
trong notes, rồi lưu snapshot vào `output/rNN/episode.json`. Đặt `ready_for_review` chỉ khi
đủ trang đã đạt. `/files` gửi nguyên artifact JPEG đã chốt, không phải raw
response. Không nén lại PNG cũ. Với Telegram, chỉ giữ output/snapshot mới
nhất sau khi gửi đủ; raw/draft/prompt và bản bị thay thế được bridge dọn theo
WORKFLOW. Giữ dữ liệu lỗi/unknown và mọi file còn là nguồn/nhân vật cần dùng.

## Lỗi và tiếp tục không tạo ảnh trùng

Chạy `node scripts/episode-tools.mjs handoff EPISODE_DIR` trước khi tiếp tục.
Wrapper chặn POST nếu có output đã kiểm khớp kịch bản ở bất kỳ revision nào;
output chưa kiểm hoặc draft còn khớp phải được xem trước khi thay. Batch
không có cờ bỏ chốt; dùng `build-prompts --slides ...` cho các trang thật sự thiếu.

- `invalid_input`: chưa gọi API; sửa prompt/đường dẫn/môi trường, dùng draft mới.
- `failed`: HTTP từ chối xác định; giữ response để xem lỗi an toàn. Không tự
  đổi model, thêm tài khoản hay retry.
- `in_flight`/`unknown`: request có thể đã được xử lý (kể cả timeout, mất kết
  nối, HTTP 5xx/408); dừng, kiểm tra server trước khi gửi lại. Wrapper chặn tạo
  attempt mới cho cùng slide khi còn `unknown`/`in_flight`; chỉ sau khi đối soát
  xong mới chạy `node scripts/draw-image.mjs --reconcile DRAFT_DIR --resolution reconciled_failed|reconciled_superseded --note "..."`. Không tự retry.
- `normalize_failed`/`received`: nếu `status.json` có SHA-256 của response,
  sửa vấn đề cục bộ rồi phục hồi **chính attempt gốc**, không gọi lại API:

```bash
node scripts/draw-image.mjs --normalize \
  'episodes/TEN-TAP/drafts/001-r01-a1/response.bin'
```

Chỉ phục hồi khi hash của raw còn khớp. Nếu không có hash hoặc trạng thái
chưa xác định, giữ nguyên bằng chứng và đối soát server trước. Tập đang có
lượt xử lý sẽ từ chối reconcile hoặc normalize đồng thời. `--normalize
FILE NEW_DRAFT_DIR` chỉ chuyển ảnh rời, không gọi mạng và không cấp provenance
cho `export-slide --checked`. Không tự nén lại kho ảnh. Thiếu `magick` thì báo
môi trường; không tìm/in/lưu khóa, raw lỗi không gửi vào Telegram.

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
