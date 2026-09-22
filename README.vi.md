# YouTube Subtitle TTS Reader

Một tiện ích Chrome đọc phụ đề YouTube bằng giọng nói thông qua:

- Web Speech API có sẵn trong trình duyệt, hoặc
- máy chủ TTS AI cục bộ chạy bằng VieNeu.

Tiện ích theo dõi văn bản phụ đề trên YouTube, có thể tải trước các câu phụ đề gần đó và phát âm thanh theo engine đã chọn.

## Tính năng

- Đọc phụ đề YouTube khi đang xem video
- Chuyển đổi giữa chế độ Web Speech và máy chủ cục bộ
- Điều chỉnh tốc độ phát và cao độ giọng nói
- Giảm âm lượng video khi đang phát TTS (audio ducking)
- Tải trước âm thanh phụ đề để giảm độ trễ giữa các câu
- Máy chủ WebSocket cục bộ cho việc tổng hợp giọng nói nhanh hơn

## Cấu trúc dự án

```text
YoutubeTTS/
├── server.py                 # Máy chủ TTS cục bộ bằng FastAPI + WebSocket
├── package.json              # Script build Tailwind
├── chrome/
│   ├── manifest.json         # Manifest tiện ích Chrome
│   ├── popup.html            # Giao diện popup của tiện ích
│   └── src/
│       ├── content.js        # Theo dõi phụ đề YouTube và phát âm thanh
│       ├── interceptor.js    # Script chặn dữ liệu phụ đề từ YouTube
│       ├── popup.js          # Cài đặt popup và trạng thái WebSocket
│       ├── input.css         # File nguồn Tailwind
│       └── styles.css        # File CSS đã build
└── README.md
```

## Yêu cầu

### Python

- Python 3.10+
- pip

Cài đặt thư viện Python:

```bash
pip install fastapi uvicorn scipy numpy vieneu
```

### Node.js (dùng để build CSS cho extension)

- Node.js và npm

Cài đặt phụ thuộc frontend:

```bash
npm install
```

## Khởi chạy máy chủ TTS cục bộ

Từ thư mục gốc của dự án:

```bash
python server.py
```

Máy chủ sẽ chạy tại:

- HTTP: http://127.0.0.1:8000
- WebSocket: ws://127.0.0.1:8000/ws/tts

Nếu muốn test endpoint HTTP trực tiếp:

```bash
curl -X POST http://127.0.0.1:8000/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Xin chao","voice":"Mai Anh"}'
```

## Build CSS cho extension

```bash
npm run build
```

Nếu muốn build tự động khi thay đổi file CSS trong quá trình phát triển:

```bash
npm run dev
```

## Nạp tiện ích Chrome

1. Mở Chrome và truy cập `chrome://extensions`
2. Bật chế độ Developer mode
3. Chọn Load unpacked
4. Chọn thư mục `chrome` trong dự án

Manifest của tiện ích đã được cấu hình để hoạt động với YouTube và cho phép kết nối cục bộ tới `127.0.0.1`.

## Sử dụng tiện ích

### Chế độ Web Speech

- Chọn engine Web Speech trong popup
- Chọn ngôn ngữ và giọng đọc
- Tiện ích sẽ đọc phụ đề bằng giọng nói của trình duyệt

### Chế độ máy chủ cục bộ

- Chọn Local Server trong popup
- Thiết lập URL WebSocket nếu cần (mặc định là `ws://127.0.0.1:8000/ws/tts`)
- Chọn một giọng đọc local trong danh sách VieNeu
- Đảm bảo `server.py` đang chạy trước khi dùng TTS cục bộ

## Cách hoạt động

- Script content theo dõi các thay đổi trong DOM của trình phát YouTube để lấy văn bản phụ đề hiện tại.
- Script interceptor tải dữ liệu phụ đề từ YouTube và gửi ngược về extension.
- Extension kiểm tra xem phụ đề hiện tại đã có trong bộ đệm hay chưa.
- Với chế độ TTS cục bộ, extension gửi văn bản phụ đề tới server WebSocket Python, server sẽ tạo WAV và trả về dưới dạng stream âm thanh.
- Trình duyệt sau đó phát âm thanh đã tạo và giảm âm lượng video trong lúc đọc.

## Ghi chú

- Dự án này được thiết kế cho môi trường phát triển và kiểm thử cục bộ.
- Extension yêu cầu YouTube phải có phụ đề khả dụng cho video đang phát.
- Nếu máy chủ cục bộ không chạy, extension có thể tự động chuyển sang giọng đọc của trình duyệt nếu được cấu hình.
- Dự án hiện đang sử dụng tên giọng đọc tiếng Việt và các tên giọng local trong giao diện popup.

## Xử lý sự cố

### Kết nối WebSocket thất bại

- Kiểm tra `server.py` đã chạy chưa.
- Xác nhận URL đang là `ws://127.0.0.1:8000/ws/tts`.
- Đảm bảo Chrome cho phép kết nối đến localhost.

### Không phát được âm thanh

- Kiểm tra phụ đề có hiển thị trên trang YouTube không.
- Kiểm tra tiện ích đã được bật chưa.
- Xác nhận engine và giọng đọc đã chọn hợp lệ.
- Mở console trình duyệt để xem lỗi WebSocket hoặc lỗi phát âm.

## Ủng hộ dự án

Nếu dự án hữu ích với bạn, bạn có thể ủng hộ một khoản nhỏ để mình tiếp tục phát triển. Cảm ơn bạn rất nhiều!

![Ủng hộ qua TPBank](assets/tpbank.jpg)

## Giấy phép

Dự án này được cung cấp theo dạng "as-is" cho mục đích học tập và sử dụng cá nhân.
