# Làm slide cùng Pi

Mở Pi trong repo, giao nội dung, xem slide. Pi tự lên kịch bản, dùng hoặc tạo
nhân vật, gọi API tạo **tranh và chữ trên cùng ảnh**, đọc lại ảnh để kiểm tra
rồi bàn giao. Bạn tự đăng TikTok. Không cần điều phối nhiều bot hoặc duyệt từng bước.

## Bắt đầu

	cd /Users/tungdoan/Projects/tiktok/buddhism
	pi

Ví dụ:

> Minh họa nội dung về cách lắng nghe trước khi phản ứng. Chia trang theo nội dung.

> Minh họa nguyên văn đoạn kinh sau thành slide: [đoạn văn và nguồn].

> Sửa slide 3 của tập vừa làm: chữ rõ hơn, giữ nguyên lời trích và nhân vật.

Tranh Phật giáo 2D chì màu, nền sáng, chữ nâu, thành phẩm JPEG quality 95,
1080 × 1440. Không có số slide mặc định: chia theo đúng nội dung và độ dễ
đọc, tối đa 35 ảnh/tập để đăng một bài TikTok, tính cả bìa/trang kết nếu có.
Bố cục linh hoạt, không chia tỷ lệ vùng chữ/tranh cố định; ưu tiên đầy đủ
tranh và chữ, rõ ràng. Pi lưu quyết định để lần sau tiếp tục được. Lời Đức
Phật/lời kinh phải nguyên văn theo nguồn đã đối chiếu, không rút gọn hay
diễn giải để ép số trang. Lời bình phải tách rõ, không gán thành lời Phật.
Nếu không vừa trần 35 mà vẫn đủ và dễ đọc, báo cần chia nhiều tập thay vì
cắt nội dung hoặc thu nhỏ chữ.

## Giao việc và nhận ảnh bằng điện thoại

Đã có [cầu nối Telegram](bridge/README.md): tin nhắn của bạn → Pi RPC →
Album ảnh gửi về private chat; `/files` để tải tệp JPEG/PNG đã chốt vì Telegram có thể nén
ảnh trong album. Pi vẫn tự làm trọn bộ, không duyệt trung gian.
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
  model tạo ảnh `cx/gpt-image-2.6-flare`.
- Mẫu `PHAT_01/v1` từ ảnh thử sẵn có, trạng thái `generated`: dùng được
  theo quy trình này, chưa có nghĩa bạn đã duyệt. Bạn có thể yêu cầu đổi.
- Prompt yêu cầu chữ chính xác và checklist để Pi đọc/so lại ảnh thật.

Nhân vật khác chưa có thì Pi tự tạo khi nội dung cần, không bắt bạn chuẩn bị
cả dàn trước. Các mã `TYKHEO_01`, `CUSI_01` là gợi ý, không phải mẫu đã có.
Mỗi người lặp lại có hồ sơ riêng, không dùng một mã nhóm để đổi mặt tùy cảnh.

## Môi trường và cách nhận kết quả

Pi cần truy cập được 9Router local, Node 24.19+ và `magick` có sẵn.
Mọi lượt vẽ/sửa dùng [scripts/draw-image.mjs](scripts/draw-image.mjs): bắt buộc
nhận kịch bản JSON và số slide (hoặc chế độ nhân vật), kiểm tra 1-35 trang
trước khi gọi API,
giữ raw response rồi xuất JPEG95 trong cùng script; không cài dependency mới.
`magick` chỉ fit/padding và nén/đổi định dạng, **không thêm chữ**. Không mã hóa
lại khi xuất revision; PNG và ảnh mẫu cũ giữ nguyên. Khóa API nếu cần
chỉ cấp qua môi trường, không đặt vào repo/chat.

Pi mở từng ảnh để đối chiếu chữ, dấu tiếng Việt, bố cục và nhân vật; sai thì
sửa trước khi bàn giao. Kết quả nằm trong `episodes/<tên-tập>/output/r01/`.
Pi đưa ảnh trong phiên chat nếu giao diện hỗ trợ, nếu không sẽ đưa đường dẫn
để bạn mở. Bạn yêu cầu sửa thì tạm giữ bản trước, làm revision mới. Sau khi
Telegram xác nhận gửi đủ bản mới, bridge dọn output/draft/prompt và dữ liệu
tạm cũ; chỉ giữ bản mới nhất, kịch bản/nguồn/notes/mẫu nhân vật và dữ liệu
gửi lại cần thiết. Tác vụ lỗi hoặc API chưa rõ kết quả không bị dọn. Lịch sử
Pi không bị xóa; ít file hơn không tự rút ngắn hội thoại đã có.

Kho `characters/` được lưu trong Git cùng repo khi bạn yêu cầu commit.
Dữ liệu `episodes/` mặc định không commit: sao lưu riêng khi chuyển máy.
Không có tự đăng TikTok. Cách dùng Pi trực tiếp không cần dịch vụ chạy nền;
Telegram cần chạy bridge theo hướng dẫn riêng. Sao lưu thêm `.telegram/` nếu
muốn giữ ánh xạ hội thoại, tiến độ bàn giao và các phiên Pi qua bot.

AI có thể vẽ sai chữ và lệch nhân vật. Việc Pi tự đọc ảnh là kiểm tra thị giác,
không phải bảo đảm tuyệt đối hoặc chứng minh đúng từng byte Unicode. Nếu chữ
chưa đọc chắc/không sửa đạt, Pi phải nói rõ chứ không gọi đó là bản hoàn chỉnh.
