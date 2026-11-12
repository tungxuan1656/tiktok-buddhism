# Quy chuẩn minh họa do người dùng cung cấp — v1

Ngày nhận: 2026-11-11. Phạm vi: phong cách, ảnh ví dụ và cách làm việc cho các tập mới. Đây không phải bản duyệt kinh văn hay bộ ảnh mẫu nhân vật đã khóa. Không thay đổi hồ sơ/ảnh mẫu hoặc bản dựng đã có.

## Phong cách hình ảnh

- Tranh minh họa Phật giáo 2D, nét bút mảnh kết hợp chất liệu chì màu, bảng màu dịu nhẹ, nền trắng thoáng đãng, bố cục tối giản, biểu cảm trang nghiêm và tiết chế.
- Tỉ lệ dọc 3:4, thành phẩm 1080 × 1440 px. Bản hình chưa ghép chữ phải chừa trống hoàn toàn 30–35% phía trên (432–504 px); hình minh họa tập trung ở nửa dưới. Không viền khung tranh, không bong bóng thoại, không logo.
- Chỉ vẽ đúng nhân vật/vật thể có trong mô tả đã kiểm chứng; không tự thêm chi tiết thừa. Ảnh ví dụ không cho phép tự thêm cây, hào quang, bệ đá hoặc nhân vật vào những cảnh khác.
- Giữ nguyên diện mạo, tóc, tỉ lệ cơ thể, trang phục và màu sắc của từng nhân vật theo mã định danh và bộ ảnh tham chiếu phiên bản cố định xuyên suốt các cảnh/tập.
- Cảnh lợi ích, ví dụ (cây, chim) hoặc cõi trời thể hiện khái quát và biểu trưng khi có căn cứ nguồn. Không biến ví dụ thành sự kiện lịch sử, không sáng tác thêm tình tiết.

## Mã nhân vật dùng chung

| Mã | Vai trò | Trạng thái trong bộ tài liệu này |
| --- | --- | --- |
| PHAT_01 | Đức Phật | Cần gắn bộ ảnh mẫu tạo trước, được duyệt và cố định phiên bản |
| TYKHEO_01 | Một vị Tỷ kheo đại diện, diện mạo phân biệt với Đức Phật | Cần gắn bộ ảnh mẫu tạo trước, được duyệt và cố định phiên bản |
| CUSI_01 | Thiện nam tử có lòng tin | Cần gắn bộ ảnh mẫu tạo trước, được duyệt và cố định phiên bản |
| NHOM_01 | Các mẫu phụ gồm Tỷ kheo, Tỷ kheo ni, nam cư sĩ và nữ cư sĩ | Cần ảnh nhận diện từng mẫu thành phần; không dùng một mã nhóm để thay đổi diện mạo tùy cảnh |

Diện mạo cụ thể là quy ước minh họa của dự án, không phải khẳng định lịch sử. Các mã trên do người dùng chỉ định; việc ghi mã không chứng minh đã có ảnh mẫu được duyệt. Không tự đồng nhất mã này với các hồ sơ nhân vật cũ. Khi bàn giao cảnh có nhóm, chỉ định mẫu thành phần thực sự xuất hiện và gửi đủ ảnh tham chiếu tương ứng.

## Ảnh ví dụ đã lưu

- Tệp: `example-01-original.png`, bản sao nguyên byte của ảnh người dùng đính kèm trong yêu cầu này.
- Kích thước gốc kiểm tra từ tệp: **765 × 1024 px**; không phải 1080 × 1440 và không đúng tuyệt đối 3:4. Giữ nguyên bản gốc để tham khảo, không đổi kích thước hay cắt ảnh rồi gọi là ảnh gốc.
- SHA-256: `66bfc2c98e49e5d3e441b2ee6f94b6d14002ff8f71525d89e1c52ff9bb8ffa7a`.
- Quan sát ảnh thực: chữ nâu sẫm ở phía trên, nền sáng có chất giấy; Đức Phật ngồi bên trái dưới cây, các Tỷ kheo bên phải; màu y vàng đất/nâu, nét mảnh và bố cục thoáng.
- Mô tả ví dụ người dùng: PHAT_01 ngồi thuyết pháp; một nhóm Tỷ kheo ngồi đối diện lắng nghe; nền tối giản.
- Vai trò tệp: tham khảo phong cách và bố cục. Không tự coi đây là bộ mẫu đủ cho cả bốn mã nhân vật, bản duyệt xuất bản, bằng chứng lịch sử hoặc nguồn kinh đã xác minh.
- Phần chữ ví dụ chưa có tên kinh, dịch giả, ấn bản, vị trí trích và quyền sử dụng trong yêu cầu này; chưa được khóa làm nguồn sản xuất. Không lấy chữ từ ảnh hoặc trí nhớ để bù vào nguồn.

## Cách làm việc được lưu theo yêu cầu này

1. Người dùng chọn bản kinh/bản dịch và duyệt mẫu nhân vật. Creator nhận diện nguồn, đối chiếu nguyên văn và quyền dùng, khóa nguồn rồi phân trang liên tục, không viết lại hay sửa dấu câu.
2. Creator lập yêu cầu từng ảnh: số trang, đoạn nguyên văn riêng, mô tả cảnh tối thiểu, căn cứ nguồn, loại cảnh (event/simile/non_narrative), mã nhân vật và phiên bản bộ mẫu, bố cục 1080 × 1440 theo quy chuẩn này.
3. Painter tạo **phần minh họa không chữ**, để trống vùng chữ ở trên; nhận ảnh tham chiếu thật, không chỉ tên tệp. Mỗi lượt sửa dùng lại đúng bộ mẫu. Chưa có mẫu hợp lệ thì tạo/duyệt mẫu trước, không coi tập đã đủ điều kiện sản xuất.
4. Chữ được ghép bằng phần mềm từ nguyên văn đã khóa, không để mô hình ảnh vẽ kinh văn. Chỉ dàn dòng thị giác; không tự đổi ký tự, dấu câu hoặc thứ tự. Đây là cách làm người dùng vừa chỉ định, khác hướng dẫn cũ để Painter tạo cả hình và chữ trực tiếp.
5. Creator xem từng ảnh thực sau ghép chữ: đối chiếu từng ký tự với nguồn, xem độ rõ trên điện thoại, vị trí chữ, cảnh và tính nhất quán nhân vật. Ghi lỗi cụ thể, sửa thành revision mới rồi kiểm tra lại; không ghi đè bản đã duyệt hoặc tự ghi duyệt thay người dùng.
6. Người dùng duyệt bản cuối trước khi đăng. Không tự đăng bài.

## Giới hạn áp dụng

Đây là bản quy chuẩn đã lưu, **không phải công cụ ghép chữ**. Khi triển khai tập mới phải dùng phần mềm dàn trang đáp ứng 1080 × 1440, chữ trên, hình dưới và kiểm tra ảnh thực. Không sửa nguồn đã khóa hoặc hồ sơ duyệt để vượt kiểm tra.

Tài liệu trong thư mục dự án cũ ở task-workspaces vẫn mô tả Painter tạo chữ trực tiếp. Lần lưu này không sửa thư mục đang được bên khác sử dụng và không thay đổi thiết lập bot; khi bàn giao phải dẫn bản quy chuẩn v1 này và nêu rõ yêu cầu ghép chữ riêng.
