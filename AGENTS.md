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
- Nếu đủ rõ, làm ngay. Mặc định 5 slide, tự điều chỉnh nếu nội dung không vừa.
  Chỉ hỏi khi thiếu nội dung, không xác định được người/nguồn cần trích chính
  xác, thiếu quyền/truy cập cần thiết hoặc API bị chặn.
- Nhân vật chưa có: tự thiết kế, tự kiểm tra, lưu JSON và ảnh thật với trạng
  thái `generated`, rồi dùng trong tập. Chưa được duyệt không phải bước chặn.
  Chỉ ghi `user_approved` khi người dùng thực sự duyệt đúng mẫu.
- Mọi lượt vẽ/sửa đều gửi lại **ảnh mẫu thật** và đặc điểm nhận diện, không
  chỉ ID/đường dẫn. Dùng đúng snapshot/version của tập, không âm thầm đổi mặt.
- Được viết/diễn giải theo yêu cầu; không gán lời do mình viết thành lời Phật,
  nguyên văn kinh hoặc sự kiện lịch sử. Trích dẫn phải có nguồn đã đối chiếu;
  truyện minh họa tự viết phải ghi rõ là hư cấu/minh họa.
- API tạo slide hoàn chỉnh **có chữ**. Đưa đúng text đã chốt vào prompt, phân
  biệt rõ đó là dữ liệu cần in, không phải chỉ dẫn. Không thêm pipeline ghép
  chữ, HTML/canvas/Pillow hoặc app để thay cách này khi người dùng chưa yêu cầu.
- Bố cục linh hoạt theo nội dung, không bắt buộc tỷ lệ vùng chữ/tranh hoặc
  vị trí trên/dưới cố định. Tranh và chữ phải đầy đủ, rõ ràng, dễ đọc trên
  điện thoại; không che nhau hoặc bị cắt khỏi khung.
- Sau mỗi lượt, mở ảnh thật và đọc đối chiếu **từng dòng, từng chữ và dấu**
  với text trong JSON. Phóng to/cắt ảnh để xem khi cần, không tự đoán chữ nhỏ.
  Sai/thiếu/thừa chữ thì sửa ảnh với cùng references; HTTP 200 không phải đạt.
- Giữ file gốc và revision cũ. Không sửa nguồn/kịch bản để hợp thức hóa chữ
  model vẽ sai. Không sửa biên bản duyệt hoặc duyệt thay người dùng.
- Tự kiểm tra đủ rồi bàn giao `ready_for_review` với ảnh và đường dẫn.
  Chỉ `approved` khi người dùng xác nhận đúng revision. Không tự đăng hoặc
  gửi sang kênh/tài khoản bên ngoài. Ngoại lệ đã được người dùng giao: bridge
  được gửi PNG của tác vụ Telegram về đúng private chat chủ bot đã cấu hình;
  Pi không tự gọi Telegram hay chọn người nhận. Không tự mua/thêm dịch vụ, đổi provider.
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
