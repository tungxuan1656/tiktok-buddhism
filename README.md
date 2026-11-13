# Làm slide cùng Pi

Mở Pi trong repo, giao nội dung, xem slide. Pi tự lên kịch bản, dùng hoặc tạo
nhân vật, gọi API tạo **tranh và chữ trên cùng ảnh**, đọc lại ảnh để kiểm tra
rồi bàn giao. Bạn tự đăng TikTok. Không cần điều phối nhiều bot hoặc duyệt từng bước.

## Bắt đầu

	cd /Users/tungdoan/Projects/tiktok/buddhism
	pi

Ví dụ:

> Làm 5 slide về cách lắng nghe trước khi phản ứng. Nội dung ngắn, gần gũi.

> Minh họa nguyên văn đoạn kinh sau thành slide: [đoạn văn và nguồn].

> Sửa slide 3 của tập vừa làm: ít chữ hơn, giữ nguyên nhân vật.

Không chỉ định gì thêm: tranh Phật giáo 2D chì màu, nền sáng, chữ nâu ở trên,
5 slide, thành phẩm PNG 1080 × 1440. Pi tự chia nội dung và lưu quyết định để
lần sau tiếp tục được. Trích nguyên văn và diễn giải được phân biệt rõ; không
gán lời Pi viết thành lời kinh.

## Giao việc và nhận ảnh bằng điện thoại

Đã có [cầu nối Telegram](bridge/README.md): tin nhắn của bạn → Pi RPC →
PNG gốc gửi về private chat. Pi vẫn tự làm trọn bộ, không duyệt trung gian.
Cần cấu hình bot một lần trên máy; sau đó dùng điện thoại để giao việc, yêu cầu
sửa và tải ảnh đăng TikTok. Máy chạy Pi và 9Router phải còn bật, không ngủ.

## Repo nhớ những gì?

| Nơi lưu | Vai trò |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Pi tự đọc: nhiệm vụ, mặc định và giới hạn |
| [WORKFLOW.md](WORKFLOW.md) | Từ yêu cầu tới slide hoàn chỉnh |
| [references/style.md](references/style.md) | Quy chuẩn tranh và chữ do AI tạo |
| [references/painter-local-api.md](references/painter-local-api.md) | Gọi 9Router, gửi ảnh mẫu thật, nhận/xuất ảnh |
| [prompts/](prompts/README.md) | Lên kịch bản, thiết kế nhân vật và vẽ slide có chữ |
| [characters/](characters/README.md) | Hồ sơ JSON và ảnh nhận diện dùng lại giữa các tập |
| [episodes/](episodes/README.md) | Nội dung, request, ảnh nháp, kết quả và phản hồi mỗi tập |
| [templates/](templates/README.md) | Mẫu JSON cho Pi điền, không phải nội dung sản xuất |
| [bridge/](bridge/README.md) | Telegram một chủ bot, RPC, lưu task/session và bàn giao có phục hồi |

## Đã có sẵn

- Phong cách, ảnh ví dụ gốc và API local tại `http://localhost:20128`,
  model `ag/gemini-3.1-flash-image`.
- Mẫu `PHAT_01/v1` từ ảnh thử sẵn có, trạng thái `generated`: dùng được
  theo quy trình này, chưa có nghĩa bạn đã duyệt. Bạn có thể yêu cầu đổi.
- Prompt yêu cầu chữ chính xác và checklist để Pi đọc/so lại ảnh thật.

Nhân vật khác chưa có thì Pi tự tạo khi nội dung cần, không bắt bạn chuẩn bị
cả dàn trước. Các mã `TYKHEO_01`, `CUSI_01` là gợi ý, không phải mẫu đã có.
Mỗi người lặp lại có hồ sơ riêng, không dùng một mã nhóm để đổi mặt tùy cảnh.

## Môi trường và cách nhận kết quả

Pi cần truy cập được 9Router local. Máy hiện tại đã có `curl`, `jq`,
`file` và `magick`; không cần cài app, dependency Python hay dịch vụ mới.
`magick` chỉ đổi kích thước/định dạng, **không thêm chữ**. Khóa API nếu cần
chỉ cấp qua môi trường, không đặt vào repo/chat.

Pi mở từng ảnh để đối chiếu chữ, dấu tiếng Việt, bố cục và nhân vật; sai thì
sửa trước khi bàn giao. Kết quả nằm trong `episodes/<tên-tập>/output/r01/`.
Pi đưa ảnh trong phiên chat nếu giao diện hỗ trợ, nếu không sẽ đưa đường dẫn
để bạn mở. Bạn yêu cầu sửa thì giữ r01, làm r02, không ghi đè.

Kho `characters/` được lưu trong Git cùng repo khi bạn yêu cầu commit.
Dữ liệu `episodes/` mặc định không commit: sao lưu riêng khi chuyển máy.
Không có tự đăng TikTok. Cách dùng Pi trực tiếp không cần dịch vụ chạy nền;
Telegram cần chạy bridge theo hướng dẫn riêng. Sao lưu thêm `.telegram/` nếu
muốn giữ ánh xạ hội thoại, tiến độ bàn giao và các phiên Pi qua bot.

AI có thể vẽ sai chữ và lệch nhân vật. Việc Pi tự đọc ảnh là kiểm tra thị giác,
không phải bảo đảm tuyệt đối hoặc chứng minh đúng từng byte Unicode. Nếu chữ
chưa đọc chắc/không sửa đạt, Pi phải nói rõ chứ không gọi đó là bản hoàn chỉnh.
