# Telegram → Pi → album ảnh và tệp ảnh đã chốt

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
6. Chờ tin “Mình sẵn sàng rồi” trên điện thoại, rồi nhắn nội dung muốn làm.

Bot được ghim vào **`cx/gpt-6.2-sol`**, provider **`9router`**, thinking
**`medium`**; không dùng `PI_MODEL` hoặc model mặc định để chọn ngầm.
[model.ts](model.ts) áp dụng model và mức suy luận có sẵn cho session bot,
không bổ sung hay sửa metadata model. Giữ nguyên endpoint, auth, các model
khác và mặc định Pi toàn cục; không thay provider. Mỗi lần mở session, RPC
phải xác nhận đúng model và `medium`, sai thì dừng trước prompt, không tự thay
mức suy luận. `npm run check` in lựa chọn hiệu lực này, không chứng minh
upstream đã chấp nhận một request thực với `medium`.

Bridge tắt extension, MCP, skill và prompt template tự nạp. Pi RPC nạp đích danh
`bridge/model.ts` và extension `pi-web-access` từ thư mục agent Pi, ngoài các tool
cơ bản `read/bash/edit/write`. Nếu thiếu, cài bằng Pi trên cùng máy/chủ tài khoản
chạy bridge; bridge không tự cài hoặc cập nhật package khi khởi động.

```sh
pi install npm:pi-web-access
```

AGENTS.md và hướng dẫn bàn giao vẫn được nạp. Bridge chuyển yêu cầu bằng chữ
và đường dẫn, không lọc ảnh hay đặt giới hạn dung lượng ngữ cảnh riêng. Pi tự
chọn công cụ và tệp cần đọc; Pi tự quản lý ngữ cảnh theo mặc định, bridge không
nạp extension nén ngữ cảnh hay lọc ảnh riêng. Pi child không nhận giá trị biến
`TELEGRAM_*`. Bridge không thay đổi cấu hình Pi khi bạn chạy trực tiếp.

Bot chỉ chấp nhận đồng thời `from.id == chat.id == TELEGRAM_USER_ID` và
`chat.type == private`; nhóm, người lạ, bot khác không được giao việc. Bot
này không dùng chung với ứng dụng polling/webhook khác. Nếu đã có webhook,
bridge dừng thay vì tự xóa nó. Lệnh identify không chạy khi service giữ khóa.

## Cách dùng bằng điện thoại

Nhắn bình thường: “Minh họa nguyên văn đoạn kinh sau, chia trang theo nội
dung và giữ đúng lời trích: [văn bản và nguồn]”. Pi tự làm
và gửi **album ảnh đúng thứ tự**: 2–10 ảnh/album, một ảnh gửi riêng; hơn 10
thì chia nhóm. Mỗi nhóm có chú thích theo thứ tự, chẳng hạn “Ảnh 1–10/20”.
Telegram có thể nén/đổi định dạng ảnh, không bảo đảm giữ nguyên
chất lượng chữ. Artifact đã chốt vẫn lưu trên máy; `/files` tải revision mới nhất dưới
dạng document, không tạo lại ảnh. Chỉ hỗ trợ tin nhắn chữ; ảnh/voice/file đầu
vào chưa được tiếp nhận. **Mỗi tập/revision tối đa 35 ảnh**, tính cả bìa/trang
kết nếu có, theo [giới hạn bài đăng ảnh TikTok](https://support.tiktok.com/en/using-tiktok/creating-videos/making-a-post).
Không có số slide mặc định: số trang theo đúng nội dung và độ dễ đọc. Lời
Đức Phật/lời kinh phải nguyên văn từ nguồn đã đối chiếu; không rút gọn hay
diễn giải để ép số trang, lời bình phải tách rõ. Agent đếm khi lập kịch bản;
service từ chối manifest quá 35, không cắt ảnh để gửi thiếu nội dung. Nếu
không vừa mà vẫn dễ đọc/giữ nguyên nguồn, bot yêu cầu chốt phạm vi/chia nhiều
tập. Album Telegram vẫn tối đa 10 ảnh/nhóm: 35 ảnh gửi thành 10 + 10 + 10 + 5.
Ảnh album tối đa 10 MB/ảnh, tệp gốc tối đa 49 MB/file. Ảnh quá giới hạn album dừng gửi để bạn dùng `/files`,
không tự giảm chất lượng hoặc âm thầm chuyển sang tệp.

| Lệnh | Ý nghĩa |
| --- | --- |
| `/status` | Xem tiến độ và số tin nhắn đang chờ, ảnh chưa gửi hoặc chưa xác nhận (nếu có) |
| `/trace_on` | Theo dõi trực tiếp bằng một tin nhắn được cập nhật, tối đa 10 dòng mới nhất |
| `/trace_off` | Tắt cập nhật trực tiếp, vẫn giữ bộ đệm log |
| `/log` | Xem ngay 10 dòng mới nhất, kể cả khi Pi đang chạy |
| `/cancel` | Dừng lượt đang làm/gửi; giữ dữ liệu và các tin bổ sung, không tự chạy lại |
| `/done` | Kết thúc tập hiện tại; tập tiếp theo dùng session Pi mới |
| `/new` | Tạm cất tập hiện tại (chưa kết thúc), mở session mới cho tập tiếp theo |
| `/episodes` | Liệt kê tập chưa kết thúc; bấm nút để chọn lại đúng session của tập. Dùng `/episodes 2` để xem trang 2 nếu có |
| `/reopen` | Liệt kê tập đã `/done`; bấm nút để mở lại cùng thư mục, ảnh và kịch bản bằng session Pi mới. Dùng `/reopen 2` để xem trang 2 nếu có |
| `/files` | Gửi toàn bộ tệp JPEG/PNG đã chốt của revision đã chốt mới nhất trong tập hiện tại; đợi lượt đang chạy/gửi xong trước |
| `/resend` | Gửi lại phần chưa nhận, hoặc bàn giao bản thủ công đã có biên bản hợp lệ; không gọi Pi |

`/start` hoặc lệnh chưa biết hiển thị hướng dẫn. Tin nhắn sau mặc định sửa
**cùng tập**, cùng session/snapshot nhân vật, xuất revision mới. Muốn tập mới:
`/done` nếu đã kết thúc tập cũ, `/new` nếu còn muốn quay lại. Dùng `/episodes`
và bấm nút để chuyển tập; thao tác này không gọi GPT hay tự chạy lại yêu cầu.
Sau khi chọn, nhắn để làm tiếp hoặc `/done` để kết thúc. Ảnh còn chờ khi
chuyển tập được giữ lại; dùng `/resend` để gửi tiếp. Nếu đang chạy/gửi,
bridge không cho đổi hay đóng tập. Các nút cũ từ `/episodes` không mở tập đã
`/done`; dùng `/reopen` và chọn tập. Lệnh này không gọi Pi, không phát lại
yêu cầu cũ hay tự gửi ảnh. Sau khi chọn, gửi lại toàn bộ văn bản và nguồn:
Pi đối chiếu với kịch bản và ảnh trong thư mục cũ, giữ phần đã kiểm tra còn
khớp và chỉ làm nốt phần thiếu hoặc thay đổi. Bản đã hoàn chỉnh nhưng chưa
được bridge chốt có thể bàn giao mà không vẽ lại; nếu bridge đã chốt và nội
dung không đổi, dùng `/resend` nếu còn thiếu ảnh hoặc `/files` để tải tệp gốc.
Transcript cũ vẫn được giữ, không nạp vào session mới.

Tin bổ sung lúc đang bận được lưu SQLite và xử lý tuần tự **sau lượt hiện tại**,
không chen vào prompt đang chạy. Muốn đổi hướng ngay: `/cancel`, đợi xác nhận,
rồi nhắn lại yêu cầu đã đủ thông tin. Tin chờ bị giữ (`held`) khi hủy, lỗi hoặc
phục hồi run gián đoạn; không tự phát lại. Tin vẫn trong lịch sử Telegram/SQLite;
bạn gửi lại phần còn muốn làm. Tin trạng thái có thể mất nếu mạng lỗi; ảnh có
sổ bàn giao riêng. `/status` không phát lại raw log, prompt hay khóa.

Trace mặc định tắt; `/trace_on` bật cho đến khi bạn tắt (lưu qua restart).
Log luôn chỉ giữ **10 dòng mới nhất của lượt hiện tại** trong SQLite, mỗi dòng
có giờ và độ dài giới hạn. Sự kiện dồn nhanh được gộp, cập nhật khoảng 3 giây
một lần và khi lượt kết thúc; không gửi một tin mới cho mỗi tool. Bật/tắt bình
thường dùng lại tin theo dõi; restart hoặc bật lại sau lỗi mạng tạo tin mới.
Bắt đầu lượt mới sẽ xóa bộ đệm lượt trước.
Chỉ hiện trạng thái Pi, tên tool, một số tên file quen thuộc và tiến độ gửi ảnh;
không gửi lệnh bash, đầu ra tool, nội dung tệp, prompt hoặc nội dung suy luận.
Đây là log sự kiện thực, không phải bản sao transcript hoặc bằng chứng chất lượng.
Nếu Telegram không xác nhận cập nhật, trace live tự tắt, không retry mù;
`/log` vẫn xem được, `/trace_on` để chủ động bật lại.

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
  drafts tạm và `output/rNN/` mới nhất đã gửi đủ; `handoff/<run-id>/` chứa request/result
  và `failure.json` với loại lỗi/lý do an toàn nếu lượt bị ngắt
  theo [giao thức Pi](agent.md).
- `.telegram/state.sqlite`: inbox/update offset chống nhận trùng, session/task,
  từng run, kiểu bàn giao và từng ảnh/tệp đã gửi (`message_id`, hash, trạng thái).
- `.telegram/sessions/`: lịch sử hội thoại Pi; không sao chép transcript vào DB.
- `.telegram/outbox/<run-id>/`: bản sao JPEG/PNG đã chốt và hash; gửi lại không phụ
  thuộc việc Pi đang sửa file nguồn. Kiểm tra lại hash trước mỗi lần gửi.
- `.telegram/bridge-lock.sqlite`: SQLite giữ khóa liên tiến trình; tự nhả khi
  tiến trình chết, không có thao tác xóa stale PID file có thể đua nhau.

SQLite và filesystem không tạo một giao dịch chung: file outbox chưa commit
DB sau crash có thể còn dư, nhưng không tự gửi hay gọi lại API. Giữ lại để
kiểm tra nếu chưa xác định được kết quả. Sao lưu `.telegram/`, `episodes/` và
`characters/` khi bridge đã dừng; không chỉ copy SQLite khi WAL đang hoạt động.
Các thư mục runtime, node_modules và .env đều bị Git bỏ qua.

**Lưu tối thiểu:** sau khi run mới nhất tự kiểm tra và Telegram xác nhận đủ
ảnh, bridge giữ output/snapshot, kịch bản hiện tại, nguồn, notes, references,
handoff và outbox mới nhất. Dọn output cũ, drafts/raw, prompts và handoff/outbox
đã bị thay thế; `/files`/`/resend` vẫn dùng bytes mới nhất, không gọi Pi.
Không dọn khi run sau còn lỗi/chưa hoàn tất, gửi thiếu, file đổi hash hoặc
draft API unknown/in_flight/response chưa xử lý. Thư mục còn chứa nguồn được
tham chiếu (kể cả qua symlink) được giữ. Nguồn/kho nhân vật/hồ sơ lịch sử và
Pi sessions không bị xóa; dọn file không tự rút ngắn context hội thoại.

Dọn cả các tập cũ đã hoàn tất bằng cùng cổng an toàn, không gọi Telegram/API:

```sh
pm2 stop buddhism-telegram
npm run prune             # Xem trước các mục sẽ dọn và tập phải giữ
npm run prune -- --apply   # Xóa thật; không thể rollback bản đã dọn
npm run service:start
```

Pi không tự xóa file qua bash. Luôn đọc kịch bản/output hiện hành thay vì
quét mọi lịch sử; bridge sở hữu việc dọn sau bàn giao.

**Crash/timeout Pi:** run đang chạy thành `interrupted`/`needs_attention`;
không tự phát lại prompt, không tự retry ảnh. Tác vụ mới sau đó phải đọc
checkpoint/draft trước. Request API đã gửi có thể còn chạy trên máy chủ;
`/cancel` không hoàn tiền hoặc bảo đảm hủy được yêu cầu từ xa. Giới hạn một
lượt Pi là 2 giờ để bộ dài có thời gian tạo và kiểm tra từng ảnh; vẫn có thể
`/cancel` bất kỳ lúc nào. Sự kiện tool chỉ cho biết hoạt động, không chứng minh
API đã xong. Nếu yêu cầu ảnh chưa rõ, Pi phải dừng hỏi, không tự gọi lại.

**Tạo ảnh mới:** Pi bắt buộc dùng [draw-image.mjs](../scripts/draw-image.mjs)
theo [hướng dẫn API](../references/painter-local-api.md). Phải lưu đầy đủ
kịch bản JSON trước: `--slide EPISODE_JSON N ...` hoặc `--character EPISODE_JSON
...`; wrapper chặn trước POST nếu JSON không có 1-35 slide/text hoặc N ngoài
kịch bản. Kiểm tra ảnh cuối chỉ là đối chiếu lại. Wrapper giữ raw response,
fit/padding rồi xuất JPEG quality 95 (4:4:4), 1080 x 1440 trong cùng script;
không ghép chữ. Không mã hóa lại khi xuất revision; PNG cũ vẫn được nhận nguyên
bytes. `/files` gửi JPEG/PNG artifact đã chốt, không phải response.bin của API.
JPEG95 có mất dữ liệu nên Pi vẫn phải kiểm tra chữ/dấu sau nén.

**Lỗi model:** `message_end` có lỗi không được coi là thành công khi Pi settled.
`/status`, thông báo dừng và `handoff/<run-id>/failure.json` ghi lý do đã lọc
(HTTP, JSON bị từ chối, mất kết nối, timeout hoặc lỗi manifest), không gửi raw
provider response hay bí mật. Sau khi xử lý nguyên nhân, nhắn hướng tiếp tục
cùng tập; `/new` chỉ để mở tập khác, không phải cách bắt buộc để cứu ảnh cũ.

**Bàn giao thủ công sau khi Pi lỗi:** chốt `episode.json`, snapshot revision và
`notes.md` theo WORKFLOW như thường. Chỉ sau khi đã kiểm tra ảnh, lưu
`handoff/manual.json` trong chính thư mục tập. Dùng các trường manifest thường
(`task_id`, `status: "ready_for_review"`, `checked: true`, `revision`, `message`,
`files`) và thêm `snapshot_sha256` (SHA-256 của snapshot, cũng phải khớp
`episode.json` hiện tại), cùng mảng `sha256` của ảnh theo thứ tự `files`. Bridge
tự cấp `run_id` khi chủ bot gửi `/resend` cho tập đang báo lỗi và chưa có ảnh
trong hàng đợi. Bridge đối chiếu hash, tạo lượt bàn giao như thường và không
mở Pi. Nếu thiếu biên bản, `/resend` báo không có ảnh chờ thay vì tự quét thư
mục. Chỉ báo hoàn tất khi Telegram xác nhận đủ ảnh; `/done` vẫn là bước riêng
để đóng tập và mở session mới.

**Gửi Telegram:** ghi `sending` cho cả nhóm trong một transaction trước POST;
chỉ ghi `sent` và từng message_id cùng lúc sau khi nhận đủ xác nhận. Mất mạng,
timeout, thiếu xác nhận hoặc crash lúc gửi → cả nhóm `unknown`, không tự retry;
lỗi Telegram xác định → cả nhóm `failed`. Dừng tại nhóm lỗi để không đảo trang.
File `pending` an toàn có thể tiếp tục khi khởi động lại. `/resend` là sự cho
phép gửi lại phần chưa nhận, có thể **trùng cả album** nếu Telegram đã nhận nhưng
mất xác nhận; không có bảo đảm exactly-once. Hủy khi đang gửi vẫn ghi xác nhận
nhóm đang bay nếu nhận được, nhưng không gửi nhóm tiếp theo.

`/files` chủ động mở lại bàn giao cho revision đã chốt mới nhất: đặt lại trạng
thái gửi của revision đó và chọn document, không đổi ảnh/hash hay gọi Pi. Nếu
bị gián đoạn, `/resend` tiếp tục dạng tệp, không tự quay về ảnh nén. Gửi lại
bản cũ không thay đổi trạng thái của lượt làm mới hơn. Revision mới vẫn mặc
định album; run cũ trước khi nâng cấp giữ kiểu document để tiếp tục an toàn.
Không tạo lại ảnh để sửa lỗi bàn giao.

## Kiểm tra và giới hạn

```sh
npm run typecheck
npm test
npm run check
```

Test dùng SQLite thật, subprocess RPC giả và JPEG/PNG tạo cục bộ trong thư
mục tạm; không gọi Telegram, model hoặc API tạo ảnh. Bao phủ private owner,
nhận trùng, session/task, revision, hủy/khởi động lại, upload chưa rõ, resend,
đường dẫn/symlink, file ảnh, đóng băng outbox, khóa tiến trình đồng thời và trace
10 dòng (quyền truy cập, gộp/edit tin nhắn, ẩn nội dung nhạy cảm, lỗi mạng),
mức suy luận `medium` (`BOT_MODEL.thinking`) chỉ trong session bot, không sửa metadata/provider/mặc định;
không đăng ký bộ lọc ngữ cảnh riêng trong extension của bridge, lỗi model trước settlement,
thông báo lỗi đã lọc và deadline 2 giờ.
Wrapper được thử với HTTP giả cục bộ và ImageMagick thật: request/reference
MIME, giữ raw, JPEG95/4:4:4, normalize-only, trạng thái lỗi và không tự retry.
Kiểm thử album bao phủ multipart/MIME JPEG và PNG, 1/2/10 ảnh, tách nhóm 11 ảnh,
chấp nhận đủ 35 ảnh theo đúng thứ tự, từ chối 0/36 ảnh trước bàn giao, giới hạn 10 MB,
xác nhận thiếu/trùng, hủy nhóm đang gửi, `/files`/`/resend` và run cũ dạng tệp.
`npm run check` kiểm tra RPC thật nhưng không chứng minh model có thể trả lời
hay 9Router vẽ được; cần thử một yêu cầu thực từ điện thoại để xác nhận đầu-cuối.

Service kiểm tra task/run, revision, danh sách/thứ tự theo episode snapshot,
JPEG/PNG đọc được 1080 x 1440, khớp MIME/đuôi file và hash. **Không chứng minh chữ/nhân vật đúng từ byte
ảnh**: việc mở ảnh và đối chiếu vẫn do Pi theo WORKFLOW, có giới hạn thị giác.
Không có hard gate cho ngân sách hoặc API ảnh vì Pi còn dùng bash. Đây là
adapter cho chủ máy tin cậy, **không phải sandbox**: cùng tài khoản OS, Pi vẫn
có khả năng đọc file/đụng dịch vụ mà tài khoản đó truy cập được, kể cả .env.
Chặn biến môi trường và câu nhắc không thay thế cách ly OS. Không đưa bot cho
người lạ; khi cần ranh giới mạnh hơn, chạy dưới tài khoản/VM tách biệt.
