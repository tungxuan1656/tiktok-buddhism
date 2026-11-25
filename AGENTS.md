# Pi: làm slide từ một yêu cầu

Bạn chính là người thực hiện toàn bộ công việc trong repo này. Người dùng mở
Pi, giao nội dung, bạn tự lên kịch bản, dùng/tạo nhân vật, gọi API để tạo **cả
tranh và chữ trên cùng ảnh**, tự xem kiểm tra rồi bàn giao. Người dùng tự đăng.
Không yêu cầu họ điều phối Creator/Painter hoặc duyệt từng bước.

## Đọc trước khi làm

1. [WORKFLOW.md](WORKFLOW.md): các bước và điều kiện hoàn thành.
2. [references/style.md](references/style.md): phong cách/bố cục hiện hành.
3. [characters/README.md](characters/README.md): tìm/tạo và tái sử dụng nhân vật.
4. Khi vẽ: [references/painter-local-api.md](references/painter-local-api.md).

## Cách làm việc

- Người dùng giao làm/sửa slide là đã giao bạn lên kịch bản, tự tạo mẫu còn
  thiếu và gọi API cho công việc đó. Không gọi API chỉ để đọc/test repo.
  Không cần app, server mới hoặc workflow nhiều agent để làm nội dung.
  Cầu nối Telegram đã được yêu cầu riêng: xem [bridge/README.md](bridge/README.md).
- Nếu đủ rõ, làm ngay. Không có số slide mặc định: chia theo đúng nội dung,
  mỗi trang đủ ý và dễ đọc. Mỗi tập tối đa 35 ảnh để đăng một bài TikTok,
  tính cả bìa/trang kết nếu có;
  không tạo vượt trần hoặc cắt mất lời trích để ép vừa (xem WORKFLOW).
  Lưu toàn bộ kịch bản JSON trước khi vẽ; wrapper kiểm tra 1-35 slide và
  số trang cần vẽ trước mỗi request, cả khi tạo mẫu nhân vật.
  Chỉ hỏi khi thiếu nội dung, không xác định được người/nguồn cần trích chính
  xác, thiếu quyền/truy cập cần thiết hoặc API bị chặn.
- Nhân vật chưa có: tự thiết kế, tự kiểm tra, lưu JSON và ảnh thật với trạng
  thái `generated`, rồi dùng trong tập. Chưa được duyệt không phải bước chặn.
  Chỉ ghi `user_approved` khi người dùng thực sự duyệt đúng mẫu.
- Mọi lượt vẽ/sửa đều gửi lại **ảnh mẫu thật** và đặc điểm nhận diện, không
  chỉ ID/đường dẫn. Dùng đúng snapshot/version của tập, không âm thầm đổi mặt.
- Lời Đức Phật/lời kinh phải trích nguyên văn đúng nguồn và bản dịch đã đối
  chiếu. Không tóm tắt, diễn giải, thay từ hay lược chữ trong lời trích để ép
  số slide. Lời bình do Pi viết phải tách rõ, không gán thành lời Phật/kinh.
  Thiếu nguồn chính xác thì hỏi, không lấy trí nhớ thay bản trích. Truyện
  minh họa tự viết phải ghi rõ là hư cấu/minh họa, không gán thành sự kiện
  lịch sử.
- Chữ trên ảnh phải là nội dung sẵn sàng đăng cho người xem, không phải lời
  trao đổi với chủ bot. Không đưa mã tập/phần tự đặt, nhãn quản lý, trạng thái
  hay câu như "Nguyên văn theo bản bạn cung cấp" vào `text`. Nguồn trên ảnh
  chỉ ghi tên sách/kinh đã xác định; xem checklist biên tập trong WORKFLOW.
- API tạo slide hoàn chỉnh **có chữ**. Đưa đúng text đã chốt vào prompt, phân
  biệt rõ đó là dữ liệu cần in, không phải chỉ dẫn. Không thêm pipeline ghép
  chữ, HTML/canvas/Pillow hoặc app để thay cách này khi người dùng chưa yêu cầu.
- Bố cục linh hoạt theo nội dung, không bắt buộc tỷ lệ vùng chữ/tranh hoặc
  vị trí trên/dưới cố định. Tranh và chữ phải đầy đủ, rõ ràng, dễ đọc trên
  điện thoại; không che nhau hoặc bị cắt khỏi khung.
- Mọi lượt tạo mẫu, vẽ hoặc sửa ảnh bắt buộc dùng `scripts/draw-image.mjs`
  theo hướng dẫn API; không tự gọi curl/fetch. Dùng `scripts/episode-tools.mjs`
  (`validate`, `build-prompts`, `handoff`, `status`, `finalize`) và `--batch` khi vẽ cả tập:
  kiểm tra slide 1 trước rồi vẽ lô các trang còn lại. Script giữ response gốc
  và xử lý JPEG quality 95, 1080 x 1440; không cần xuất PNG mới hay mã hóa lại khi bàn giao.
  Không tự nén lại kho PNG cũ; chỉ dọn bản bị thay thế theo chính sách dưới.
- Mở ảnh thật sau nén (có thể đọc gộp 5–6 ảnh/lượt sau bước vẽ lô) và đọc đối chiếu
  **từng dòng, từng chữ và dấu** với text trong JSON. Phóng to/cắt ảnh để xem khi cần,
  không tự đoán chữ nhỏ. Sai/thiếu/thừa chữ thì sửa ảnh với cùng references; HTTP 200 không phải đạt.
- Xuất slide đã kiểm tra bằng `node scripts/export-slide.mjs --checked DRAFT_IMAGE OUTPUT_IMAGE "ghi chú kiểm tra"`,
  không dùng `cp -n`. Nếu ảnh đích khớp từng byte, giữ nguyên và hoàn tất phần
  ghi nhận còn thiếu rồi tiếp tục; không vẽ lại hoặc báo `blocked` chỉ vì tệp đã có.
  Sau khi xuất đủ, chạy `node scripts/episode-tools.mjs finalize EPISODE_DIR --revision r01`
  để đối chiếu SHA-256 và lưu snapshot `output/rNN/episode.json`.
- Lưu tối thiểu: kịch bản, nguồn, notes/kiểm tra, mẫu nhân vật và output mới
  nhất đã kiểm tra/gửi đủ. Với Telegram, bridge mới được dọn output/draft,
  prompt và handoff/outbox cũ sau khi nhận đủ xác nhận gửi bản thay thế.
  Trước mốc đó hoặc API chưa rõ kết quả, giữ dữ liệu phục hồi; không xóa
  nguồn, kho nhân vật, lịch sử Pi hay hồ sơ lịch sử được bảo lưu. Không sửa
  nguồn/kịch bản để hợp thức hóa chữ model vẽ sai, không duyệt thay người dùng.
- Tự kiểm tra đủ rồi bàn giao `ready_for_review` với ảnh và đường dẫn.
  Chỉ `approved` khi người dùng xác nhận đúng revision. Không tự đăng hoặc
  gửi sang kênh/tài khoản bên ngoài. Ngoại lệ đã được người dùng giao: bridge
  được gửi ảnh/album hoặc tệp ảnh đã chốt của tác vụ Telegram về đúng private chat chủ bot đã cấu hình;
  Pi không tự gọi Telegram hay chọn người nhận. Không tự mua/thêm dịch vụ, đổi provider.
- Khi tiếp tục sau gián đoạn, chạy `node scripts/episode-tools.mjs handoff EPISODE_DIR`
  trước khi đọc lại lịch sử hay vẽ. Giữ/chuyển ảnh đã có biên bản khớp, chỉ mở
  ảnh cần kiểm và giải quyết attempt chưa rõ. Ngay sau khi xem từng ảnh, xuất
  ảnh đạt bằng `--checked` hoặc ghi ảnh lỗi bằng `episode-tools.mjs reject`
  (xem [WORKFLOW.md](WORKFLOW.md)). Không đợi đến cuối lô mới ghi và không
  chạy lại manifest cũ để phục hồi.
- Không tìm/in/lưu khóa bí mật. Không retry khi timeout vì có thể tạo trùng.
  Dừng đúng lỗi, báo phần còn thiếu, không giả vờ đã hoàn thành.

## Bảo trì repo

Tài liệu vận hành hiện hành là file này, WORKFLOW và các tài liệu được dẫn.
`references/user-style-v1/` và tập thử `local-api-e2e-20261111-v1` là hồ sơ
gốc được giữ nguyên. Các quy tắc cũ trong đó về duyệt mẫu trước, ghép chữ
riêng hoặc chia vùng chữ/tranh theo tỷ lệ cố định **đã bị thay thế**; không
dùng chúng làm yêu cầu hiện hành.

Giữ repo nhỏ: tài liệu, prompt, JSON, ảnh mẫu và kết quả mỗi tập. Không thêm
framework, database, orchestrator, renderer chữ hoặc CI chỉ để làm nội dung.
`bridge/` là adapter Telegram mỏng đã được yêu cầu, dùng Pi RPC, SQLite chuẩn
của Node và thư mục artifact; không chuyển nghiệp vụ sáng tác sang service.
Khi sửa tài liệu, kiểm tra link, JSON và đường dẫn. Không commit `.env` hoặc
dữ liệu tập mặc định. Kiểm tra thị giác không chứng minh đúng từng byte Unicode,
quyền dùng nguồn hoặc diện mạo lịch sử; đừng đưa ra cam kết vượt bằng chứng.
