# API ảnh — 9Router local

Pi tự gọi API khi được giao làm/sửa slide, không cần chuyển việc sang bot khác.
Đọc [phong cách](style.md) và [prompt](../prompts/README.md) trước khi vẽ.
Không gọi API sinh ảnh chỉ để kiểm tra setup.

## Cấu hình đang dùng

| Mục | Giá trị |
| --- | --- |
| URL mặc định | `http://localhost:20128` |
| Model | `ag/gemini-3.1-flash-image` |
| Endpoint | `POST /v1/images/generations?response_format=binary` |
| Request | JSON: `model`, `prompt`, `aspect_ratio`, `reference_images` |
| Tỉ lệ slide | `aspect_ratio: "3:4"` |
| Ảnh mẫu | Data URL có MIME thật, tối đa 10 ảnh |
| Khóa nếu server yêu cầu | Biến môi trường `NINEROUTER_KEY` |

Đã có lần tạo thành công trên gateway này **không gửi Authorization**. Vì vậy
không chặn từ đầu chỉ vì chưa có biến khóa. Nếu có `NINEROUTER_KEY`, gửi qua
header. Nếu server hiện trả 401/403, dừng và yêu cầu cấp khóa qua kênh bí mật;
không dò tìm bí mật, đổi cấu hình xác thực hoặc tự chuyển provider.

`localhost` là máy chạy Pi. Không tự mở cổng Internet, đổi URL/model, thêm tài
khoản hoặc mua dịch vụ. Không bật `set -x`, `curl -v`, in môi trường hoặc lưu
Authorization. Khóa từng lộ trong chat cần được người dùng thay mới.

## Chuẩn bị đầu vào

1. Lưu prompt đã điền thật, dùng [character](../prompts/character.md) khi thiết
   kế mẫu hoặc [illustration](../prompts/illustration.md) khi vẽ slide.
2. Mở từng ảnh mẫu; ghi thứ tự ảnh → ID/version/vai trò trong prompt và
   `notes.md`. Với slide, đưa đúng `text` của trang vào prompt để AI in chữ;
   không gửi toàn bộ nguồn hoặc phần kinh không cần in.
3. Dùng ảnh snapshot của tập cho nhân vật. Mẫu `generated` được dùng ngay;
   không cần duyệt riêng. Thiếu nhân vật thì tạo trước, không vẽ text-only rồi
   hy vọng model nhớ mặt. Cảnh không có nhân vật có thể dùng chỉ ảnh phong cách.
4. Chạy từ repo bằng `bash`, có `curl`, `jq`, `file`, `base64`; thời hạn tool
   dài hơn 300 giây. Thay hai đường dẫn và mảng `refs` theo công việc thật.
   Không chạy nguyên các đường dẫn ví dụ dưới đây.

## Lệnh cho một lượt vẽ

```bash
(
  set -euo pipefail
  url="${NINEROUTER_URL:-http://localhost:20128}"
  prompt_file='episodes/TEN-TAP/prompts/001-r01.txt'
  drafts='episodes/TEN-TAP/drafts'
  refs=( 'episodes/TEN-TAP/references/PHAT_01/v1/reference.jpg' )

  test -s "$prompt_file"
  test "${#refs[@]}" -le 10
  mkdir -p "$drafts"
  work="$(mktemp -d "$drafts/001-r01-XXXXXX")"
  : > "$work/references.txt"
  : > "$work/reference-paths.txt"
  for ref in "${refs[@]}"; do
    mime="$(file --brief --mime-type "$ref")"
    case "$mime" in
      image/png|image/jpeg) ;;
      *) printf 'Reference is not PNG/JPEG: %s\n' "$ref" >&2; exit 1 ;;
    esac
    printf '%s\n' "$ref" >> "$work/reference-paths.txt"
    printf 'data:%s;base64,' "$mime" >> "$work/references.txt"
    base64 < "$ref" | tr -d '\r\n' >> "$work/references.txt"
    printf '\n' >> "$work/references.txt"
  done
  jq -n --rawfile prompt "$prompt_file" --rawfile refs "$work/references.txt" '{
    model: "ag/gemini-3.1-flash-image",
    prompt: $prompt,
    aspect_ratio: "3:4",
    reference_images: ($refs | split("\n") | map(select(length > 0)))
  }' > "$work/request.json"

  # Pass the optional secret via stdin, never curl arguments or saved headers.
  {
    if [ -n "${NINEROUTER_KEY:-}" ]; then
      printf 'Authorization: Bearer %s\n' "$NINEROUTER_KEY"
    fi
  } | curl --silent --show-error --fail \
    --connect-timeout 5 --max-time 300 \
    --request POST "$url/v1/images/generations?response_format=binary" \
    --header 'Content-Type: application/json' --header @- \
    --data-binary "@$work/request.json" \
    --output "$work/response.bin" \
    --write-out 'HTTP %{http_code}; seconds %{time_total}\n' > "$work/result.txt"

  case "$(file --brief --mime-type "$work/response.bin")" in
    image/png) extension='png' ;;
    image/jpeg) extension='jpg' ;;
    *) printf 'Response is not PNG/JPEG; inspect failure\n' >&2; exit 1 ;;
  esac
  cp "$work/response.bin" "$work/image.$extension"
  printf 'Draft: %s/image.%s\n' "$work" "$extension"
)
```

`refs` có thể rỗng (`refs=()`) chỉ khi thiết kế lần đầu mà không có ảnh phong
cách, hoặc cảnh thực sự không cần ảnh tham chiếu. Với nhân vật có sẵn phải gửi
đủ ảnh định danh. Thường thiết kế mới dùng
`references/user-style-v1/example-01-original.png` làm **ảnh phong cách**.
Ghi rõ vai trò đó để model không sao chép chữ/người phụ trong ảnh.

Gateway có thể bỏ qua ảnh không hợp lệ hoặc chỉ nhận 10 ảnh đầu. Kiểm tra số
lượng, giải mã Data URL đối chiếu ảnh gốc khi có nghi ngờ; request thành công
không chứng minh model đã giữ đúng mặt. Data URL phải đúng MIME thực, không
base64 thô bị mặc định nhầm PNG.

## Sau khi nhận ảnh

- Đọc `result.txt`, mở ảnh thật, đo MIME/kích thước. Trên macOS dùng
  `sips -g pixelWidth -g pixelHeight DUONG_DAN_ANH` hoặc `magick identify`.
- Mở ảnh và đọc từng dòng, so từng từ/dấu với `text` trong episode.json. Sai
  chữ thì sửa ảnh bằng API với toàn bộ text đúng và cùng mẫu nhân vật. Nếu
  không đọc chắc, chưa được coi là đạt. OCR nếu có chỉ là hỗ trợ.
- Kiểm tra nhân vật/cảnh/bố cục theo WORKFLOW; lưu ảnh lỗi và lý do sửa. Điền
  đường dẫn ảnh đạt vào `image` trong episode.json; không sửa text/mẫu để hợp
  thức hóa kết quả sai.
- API không bảo đảm PNG hay chính xác 1080 × 1440. Đổi định dạng và fit ảnh
  theo lệnh dưới; không đổi đuôi JPEG thành PNG, crop hoặc kéo méo ảnh.
- Model không có trí nhớ nhân vật giữa các request. **Mọi lượt vẽ/sửa đều gửi
  lại ảnh mẫu và đặc điểm khóa**, kể cả cùng một phiên chat.

## Xuất PNG đúng khung, không thêm chữ

Dùng ImageMagick đã có trên máy. Lệnh chỉ đổi kích thước/định dạng của ảnh AI
đã có chữ; không dàn trang hay chèn chữ mới. Tạo revision mới một lần trước
khi xuất các trang, không ghi đè revision cũ:

```bash
out='episodes/TEN-TAP/output/r01'
test ! -e "$out" && mkdir -p "$out"
```

Chỉ tiếp tục khi tạo thư mục thành công. Với từng trang đã kiểm tra:

```bash
magick 'episodes/TEN-TAP/drafts/THU-MUC/image.jpg' \
  -auto-orient -resize 1080x1440 -background white -gravity center \
  -extent 1080x1440 "$out/001.png"
```

Đổi tên trang 001, 002… đúng thứ tự; không chạy lệnh với đường dẫn giữ chỗ.
`-resize` ở đây giữ tỷ lệ, `-extent` chỉ đệm do ảnh đã fit trong khung. Không
thêm dấu `^` hoặc resize ép tỷ lệ. Sau khi xuất đủ trang, lưu snapshot:

```bash
cp 'episodes/TEN-TAP/episode.json' "$out/episode.json"
```

Mở lại từng PNG cuối, đọc so chữ và kiểm tra 1080 × 1440, không mờ/chặt chữ.
Thiếu `magick` thì báo môi trường và chỉ dùng công cụ resize/đổi định dạng
sẵn có khác nếu bảo đảm không crop/méo; không cài hoặc thêm renderer chữ ngầm.

## Khi lỗi

| Lỗi | Xử lý |
| --- | --- |
| 401/403 | Dừng, xin cấp khóa an toàn; không in khóa, không thử lách xác thực |
| 400/model | Xem `/v1/models/image` và `/v1/models/info?id=ag%2Fgemini-3.1-flash-image`; không đổi model ngầm |
| 503 | Báo tài khoản/provider chưa sẵn sàng; không tự thêm tài khoản |
| Timeout/mất kết nối | Lưu request, báo trạng thái chưa biết; kiểm tra server trước khi gửi lại |
| JSON/HTML thay vì ảnh | Dừng và đọc lỗi an toàn; không coi là ảnh |
| Tranh/chữ sai | Sửa lỗi cụ thể, gửi lại text đúng và references; tối đa 2 lần sửa/trang rồi báo giới hạn |

Không thêm retry tự động. Trả rõ phần nào đã làm, phần nào bị chặn; không
đặt `ready_for_review` cho tập còn ảnh lỗi/chưa đủ trang.

## Bằng chứng và giới hạn đã biết

- Lần thử 2026-11-11 tại `episodes/local-api-e2e-20261111-v1/` có request,
  response và báo cáo. Ảnh phong cách trong Data URL khớp file gốc; prompt
  khớp file đã lưu; đầu ra JPEG **896 × 1200** dù header ghi `image/png`.
  Đây là thử tạo mẫu không chữ, không chứng minh giữ diện mạo qua nhiều cảnh
  hoặc khả năng in đúng toàn bộ chữ tiếng Việt của quy trình mới.
- Mẫu tạo ở lần thử đó đã được đưa vào kho dưới trạng thái `generated`,
  không sửa báo cáo cũ và không coi là người dùng đã duyệt.
- Ảnh mèo thử cũ được giữ nguyên bytes tại
  [archive/cat-api-original.jpg](archive/cat-api-original.jpg), JPEG 1024 × 1024.
- Trước đây đã đối chiếu nhánh `antigravity` của 9Router local: đọc
  `aspect_ratio`, xử lý `reference_images` thành `inlineData`. Không suy diễn
  các trường `quality`, `background`, `watermark`, `output_format` của provider
  khác sang model này. Không dùng chúng làm bằng chứng điều khiển đầu ra.
- Nguồn tham khảo: [9router-image skill](https://github.com/decolua/9router/blob/master/skills/9router-image/SKILL.md).
  API local có thể thay đổi theo bản cài; khi kết quả khác tài liệu, kiểm tra
  bản thực tế thay vì tuyên bố đã xác minh lại upstream.
