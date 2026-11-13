# Telegram → Pi → PNG gốc

Một chủ bot, một private chat, một lượt thực thi tại một thời điểm. Service
TypeScript chỉ nhận tin, giữ trạng thái và bàn giao; Pi tự lên kịch bản, tạo
nhân vật còn thiếu, vẽ cả tranh/chữ, kiểm tra và sửa theo [WORKFLOW](../WORKFLOW.md).
Không duyệt trung gian, không tự đăng TikTok, không webhook/public server.

## Cấu hình một lần trên máy

Cần Node **24.19+**, ImageMagick (`magick`), cấu hình model/auth Pi đang dùng
và 9Router local. Dependency Pi được ghim ở **1.5.2** trong package-lock.json.
Không cần framework hoặc SQLite package riêng; dùng `node:sqlite`.

```sh
cd /Users/tungdoan/Projects/tiktok/buddhism
npm ci --ignore-scripts
cp .env.example .env  # Chỉ khi chưa có .env; không ghi đè cấu hình cũ
chmod 600 .env
```

1. Mở **@BotFather** chính thức trên Telegram, `/newbot` để tạo bot riêng.
2. Tự điền token vào `TELEGRAM_BOT_TOKEN` trong `.env` bằng editor cục bộ.
   **Không gửi token vào chat với Pi**, không đưa vào lệnh curl/history/Git.
3. Từ tài khoản Telegram của bạn, mở private chat của bot và gửi `/start`.
4. Chạy `npm run identify`. Lệnh này chỉ lấy update, in numeric ID của các
   private chat đã gửi `/start`, không in token hoặc nội dung tin nhắn và
   không tự cấp quyền cho ai. Điền **ID của chính bạn** vào `TELEGRAM_USER_ID`.
   Nếu nhiều ID, tự đối chiếu; không chọn người gửi đầu tiên theo phỏng đoán.
5. Chạy `npm run check`, rồi `npm start`. Check mở RPC và đọc state, **không**
   prompt model, gọi Telegram hoặc tạo ảnh. Exit 2 nghĩa thiếu cấu hình bot.
6. Chờ tin “Bridge sẵn sàng” trên điện thoại, nhắn yêu cầu làm slide.

Có thể đặt `PI_MODEL=provider/model` trong `.env`; không đặt thì dùng model
mặc định đã cấu hình trong Pi. Bridge dùng CLI/auth/model của Pi nhưng tắt
extension, MCP, skill và prompt template tự nạp, chỉ bật read/bash/edit/write;
AGENTS.md và hướng dẫn nội dung vẫn được nạp. Pi child không nhận biến
`TELEGRAM_*`. Chạy trực tiếp Pi như trước không bị thay đổi.

Bot chỉ chấp nhận đồng thời `from.id == chat.id == TELEGRAM_USER_ID` và
`chat.type == private`; nhóm, người lạ, bot khác không được giao việc. Bot
này không dùng chung với ứng dụng polling/webhook khác. Nếu đã có webhook,
bridge dừng thay vì tự xóa nó. Lệnh identify không chạy khi service giữ khóa.

## Cách dùng bằng điện thoại

Nhắn bình thường: “Làm 5 slide về lắng nghe trước khi phản ứng”. Pi tự làm
và gửi **document PNG**, đúng thứ tự, để tải bản gốc. Chỉ hỗ trợ tin nhắn chữ;
ảnh/voice/file đầu vào chưa được tiếp nhận. Mỗi lượt tối đa 20 slide, 49 MB/file.

| Lệnh | Ý nghĩa |
| --- | --- |
| `/status` | Task hiện tại, giai đoạn gần nhất, số tin chờ/giữ lại và file gửi thiếu/lỗi |
| `/cancel` | Dừng lượt đang làm/gửi; giữ dữ liệu và các tin bổ sung, không tự chạy lại |
| `/done` | Kết thúc tập hiện tại; tập tiếp theo vẫn dùng hội thoại Pi này |
| `/new` | Mở hội thoại Pi và tập mới; không xóa ảnh hoặc lịch sử cũ |
| `/resend` | Chỉ gửi lại ảnh đã chốt nhưng chưa gửi/đã lỗi/bị dừng của tập hiện tại; không gọi Pi |

`/start` hoặc lệnh chưa biết hiển thị hướng dẫn. Tin nhắn sau mặc định sửa
**cùng tập**, cùng session/snapshot nhân vật, xuất revision mới. Muốn tập mới
thì `/done` rồi giao nội dung mới; muốn cả hội thoại mới thì `/new`. Hai lệnh
này bị từ chối khi đang chạy/gửi, không âm thầm bỏ việc.

Tin bổ sung lúc đang bận được lưu SQLite và xử lý tuần tự **sau lượt hiện tại**,
không chen vào prompt đang chạy. Muốn đổi hướng ngay: `/cancel`, đợi xác nhận,
rồi nhắn lại yêu cầu đã đủ thông tin. Tin chờ bị giữ (`held`) khi hủy, lỗi hoặc
phục hồi run gián đoạn; không tự phát lại. Tin vẫn trong lịch sử Telegram/SQLite;
bạn gửi lại phần còn muốn làm. Tin trạng thái có thể mất nếu mạng lỗi; ảnh có
sổ bàn giao riêng. `/status` không phát lại raw log, prompt hay khóa.

`ready_for_review` nghĩa Pi báo đã kiểm tra, chưa có nghĩa bạn đã duyệt.
Bridge không suy ra chất lượng từ `agent_settled` hay chữ “done”. Bạn tự xem
thành phẩm và tự đăng; không có command duyệt tự động hay cổng kiểm soát chi phí.

## Chạy nền bằng PM2

Dùng PM2 đã cài trên máy. Nếu đang chạy `npm start`, Ctrl+C và đợi thoát trước:

```sh
npm run service:start
pm2 status buddhism-telegram
```

[ecosystem.config.cjs](../ecosystem.config.cjs) chạy đúng một instance, dùng
Node hiện tại và nạp `.env` ngay trong Node, không nhúng token vào config PM2.
PM2 được phép chờ 180 giây để bridge hủy Pi và hoàn tất upload đang gửi trước
khi buộc dừng. Có khóa SQLite để ngăn chạy trùng dù vô tình start thêm.

```sh
pm2 restart buddhism-telegram  # Sau khi sửa .env hoặc code
pm2 stop buddhism-telegram     # Cũng dừng trước npm run check/npm start
pm2 logs buddhism-telegram --lines 30
```

Log ở `.telegram/service.log`; kiểm tra/dọn khi cần, không gửi log/session
chứa dữ liệu riêng ra ngoài. Di chuyển Node/repo thì xóa đúng process này
khỏi PM2 và chạy lại config bằng Node mới. Không sửa hoặc restart app khác.
`pm2 save`/`pm2 startup` là tùy chọn để phục hồi sau reboot; cân nhắc toàn bộ
danh sách app PM2 trước khi lưu. Repo không cài LaunchAgent riêng.

Mac và 9Router vẫn phải bật, không ngủ; PM2 không giữ máy thức hoặc tự bật
9Router. Đăng xuất, tắt máy, sleep hay đóng nắp có thể ngắt bot.

## Dữ liệu và phục hồi

- `episodes/telegram-<task-id>/`: episode.json, nguồn, notes, snapshot nhân vật,
  drafts và các `output/rNN/` bất biến; `handoff/<run-id>/` chứa request/result
  theo [giao thức Pi](agent.md).
- `.telegram/state.sqlite`: inbox/update offset chống nhận trùng, session/task,
  từng run và từng document đã gửi (`message_id`, hash, trạng thái).
- `.telegram/sessions/`: lịch sử hội thoại Pi; không sao chép transcript vào DB.
- `.telegram/outbox/<run-id>/`: bản sao PNG đã chốt và hash; gửi lại không phụ
  thuộc việc Pi đang sửa file nguồn. Kiểm tra lại hash trước mỗi lần gửi.
- `.telegram/bridge-lock.sqlite`: SQLite giữ khóa liên tiến trình; tự nhả khi
  tiến trình chết, không có thao tác xóa stale PID file có thể đua nhau.

SQLite và filesystem không tạo một giao dịch chung: file outbox chưa commit
DB sau crash có thể còn dư, nhưng không tự gửi hay gọi lại API. Giữ lại để
kiểm tra, không dọn dữ liệu mặc định. Sao lưu `.telegram/`, `episodes/` và
`characters/` khi bridge đã dừng; không chỉ copy SQLite khi WAL đang hoạt động.
Các thư mục runtime, node_modules và .env đều bị Git bỏ qua.

**Crash/timeout Pi:** run đang chạy thành `interrupted`/`needs_attention`;
không tự phát lại prompt, không tự retry ảnh. Tác vụ mới sau đó phải đọc
checkpoint/draft trước. Request API đã gửi có thể còn chạy trên máy chủ;
`/cancel` không hoàn tiền hoặc bảo đảm hủy được yêu cầu từ xa. Giới hạn một
lượt Pi là 45 phút; sự kiện tool chỉ cho biết hoạt động, không chứng minh API
đã xong. Nếu yêu cầu ảnh chưa rõ, Pi phải dừng hỏi, không tự gọi lại.

**Gửi Telegram:** ghi `sending` trước POST, `sent` và message_id sau xác nhận.
Mất mạng/timeout/khởi động lại lúc đang gửi → `unknown`, không tự retry; lỗi
Telegram xác định → `failed`. Dừng chuỗi tại file lỗi để không đảo trang.
File `pending` an toàn có thể tiếp tục khi khởi động lại. `/resend` là sự cho
phép gửi lại phần chưa nhận, có thể **trùng ảnh** nếu lần trước Telegram đã
nhận nhưng mất xác nhận; không có bảo đảm exactly-once. Revision đã chốt vẫn
gửi lại được sau khi dừng service; không tạo lại ảnh để sửa lỗi bàn giao.

## Kiểm tra và giới hạn

```sh
npm run typecheck
npm test
npm run check
```

Test dùng SQLite thật, subprocess RPC giả và PNG trắng tạo cục bộ trong thư
mục tạm; không gọi Telegram, model hoặc API tạo ảnh. Bao phủ private owner,
nhận trùng, session/task, revision, hủy/khởi động lại, upload chưa rõ, resend,
đường dẫn/symlink, file ảnh, đóng băng outbox và khóa tiến trình đồng thời.
`npm run check` kiểm tra RPC thật nhưng không chứng minh model có thể trả lời
hay 9Router vẽ được; cần thử một yêu cầu thực từ điện thoại để xác nhận đầu-cuối.

Service kiểm tra task/run, revision, danh sách/thứ tự theo episode snapshot,
PNG đọc được 1080 x 1440 và hash. **Không chứng minh chữ/nhân vật đúng từ byte
ảnh**: việc mở ảnh và đối chiếu vẫn do Pi theo WORKFLOW, có giới hạn thị giác.
Không có hard gate cho ngân sách hoặc API ảnh vì Pi còn dùng bash. Đây là
adapter cho chủ máy tin cậy, **không phải sandbox**: cùng tài khoản OS, Pi vẫn
có khả năng đọc file/đụng dịch vụ mà tài khoản đó truy cập được, kể cả .env.
Chặn biến môi trường và câu nhắc không thay thế cách ly OS. Không đưa bot cho
người lạ; khi cần ranh giới mạnh hơn, chạy dưới tài khoản/VM tách biệt.
