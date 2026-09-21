# server.py - Local TTS Server bằng Python FastAPI, WebSocket & VieNeu-TTS
# Cài đặt thư viện: pip install vieneu fastapi uvicorn scipy numpy

import io
import json
import asyncio
import numpy as np
import scipy.io.wavfile as wavfile
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from vieneu import Vieneu

app = FastAPI(title="VieNeu-TTS Local WebSocket Server for YouTube Subtitles")

# Bật CORS cho phép Chrome Extension truy cập
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Khởi tạo mô hình VieNeu-TTS
print("⏳ Đang khởi tạo mô hình VieNeu-TTS...")
tts_engine = Vieneu(mode="v3nano")
print("✅ VieNeu-TTS Engine sẵn sàng!")

# Bộ đệm Cache / Pre-fetch cho âm thanh đã sinh trước
# Key: (text, voice) -> Value: bytes (WAV audio)
tts_cache = {}
MAX_CACHE_SIZE = 100


def generate_wav_bytes(text: str, voice: str = "Mai Anh", speed: float = 1.2) -> bytes:
    cache_key = (text.strip(), voice, speed)
    if cache_key in tts_cache:
        print(f"⚡ [Cache Hit] Trả về audio pre-fetch cho câu: '{text}'")
        return tts_cache[cache_key]

    print(f"🎙️ [VieNeu-TTS] Đang tổng hợp âm thanh: '{text}' (Giọng: {voice})")
    audio_data = tts_engine.infer(text, voice=voice)

    sample_rate = getattr(tts_engine, "sample_rate", 24000)
    buffer = io.BytesIO()

    if audio_data.dtype != np.int16:
        audio_int16 = (np.clip(audio_data, -1.0, 1.0) * 32767).astype(np.int16)
    else:
        audio_int16 = audio_data

    wavfile.write(buffer, sample_rate, audio_int16)
    wav_bytes = buffer.getvalue()

    if len(tts_cache) >= MAX_CACHE_SIZE:
        tts_cache.pop(next(iter(tts_cache)))
    tts_cache[cache_key] = wav_bytes

    return wav_bytes


# ==========================================
# 1. WEBSOCKET ENDPOINT (Hỗ trợ Pre-fetch & Read Realtime)
# ==========================================
@app.websocket("/ws/tts")
async def websocket_tts_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("🔌 [WebSocket] Client (Chrome Extension) đã kết nối thành công!")

    try:
        while True:
            # Nhận dữ liệu dạng JSON từ Client
            raw_data = await websocket.receive_text()
            data = json.loads(raw_data)

            msg_type = data.get("type", "read")  # 'prefetch' hoặc 'read'
            text = data.get("text", "").strip()
            voice = data.get("voice", "Mai Anh")
            sub_id = data.get("id", None)  # ID phụ đề để Client đối chiếu
            
            if data.get("rate"):
                rate = data.get("rate", 1.0)
                tts_engine.set_rate(rate)
            
            if data.get("pitch"):
                pitch = data.get("pitch", 1.0)
                tts_engine.set_pitch(pitch)

            if not text:
                continue

            # TRƯỜNG HỢP 1: Yêu cầu Pre-fetch (Sinh trước câu phụ đề sắp tới)
            if msg_type == "prefetch":
                print(f"🔮 [Pre-fetch Request] Chuẩn bị sẵn câu: '{text}'")
                # Chạy tổng hợp âm thanh trong ThreadPool để không block event loop của WebSocket
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(None, generate_wav_bytes, text, voice)

                # Phản hồi xác nhận đã Pre-fetch xong
                await websocket.send_json({
                    "type": "prefetch_done",
                    "id": sub_id,
                    "text": text
                })

            # TRƯỜNG HỢP 2: Yêu cầu Đọc ngay (Read / Speak)
            elif msg_type == "read":
                loop = asyncio.get_event_loop()
                wav_bytes = await loop.run_in_executor(None, generate_wav_bytes, text, voice)

                # Gửi thông tin Metadata trước
                await websocket.send_json({
                    "type": "audio_start",
                    "id": sub_id,
                    "text": text,
                    "size": len(wav_bytes)
                })

                # Gửi dữ liệu file âm thanh (Binary) ngay sau đó
                await websocket.send_bytes(wav_bytes)

    except WebSocketDisconnect:
        print("🔌 [WebSocket] Client ngắt kết nối.")
    except Exception as e:
        print(f"❌ [WebSocket Lỗi]: {str(e)}")


# ==========================================
# 2. HTTP POST ENDPOINT (Dùng cho test hoặc Web Speech Fallback)
# ==========================================
class TTSRequest(BaseModel):
    text: str
    rate: float = 1.0
    pitch: float = 1.0
    voice: str = "Mai Anh"


@app.post("/tts")
async def generate_tts(req: TTSRequest):
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Văn bản không được để trống")

    try:
        wav_bytes = generate_wav_bytes(req.text, req.voice)
        return StreamingResponse(
            io.BytesIO(wav_bytes),
            media_type="audio/wav",
            headers={"Content-Disposition": "inline; filename=tts.wav"}
        )
    except Exception as e:
        print(f"❌ Lỗi xử lý VieNeu-TTS: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    print("🚀 Local VieNeu-TTS WebSocket Server đang chạy tại ws://127.0.0.1:8000/ws/tts")
    uvicorn.run(app, host="0.0.0.0", port=8000)