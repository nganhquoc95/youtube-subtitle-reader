# YouTube Subtitle TTS Reader

A Chrome extension that reads YouTube subtitles aloud using either:

- the browser's built-in Web Speech API, or
- a local AI TTS server powered by VieNeu.

The extension watches YouTube subtitle text, optionally prefetches nearby subtitle lines, and plays them through the selected audio engine.

## Features

- Read YouTube subtitle text aloud while watching a video
- Switch between Web Speech and local server mode
- Adjust playback rate and pitch
- Reduce video volume while TTS is playing (audio ducking)
- Prefetch subtitle audio to reduce delay between subtitle changes
- Local WebSocket server for low-latency TTS generation

## Project structure

```text
YoutubeTTS/
├── server.py                 # FastAPI + WebSocket local TTS server
├── package.json              # Tailwind build script
├── chrome/
│   ├── manifest.json         # Chrome extension manifest
│   ├── popup.html            # Extension popup UI
│   └── src/
│       ├── content.js        # YouTube subtitle monitoring and playback logic
│       ├── interceptor.js    # Subtitle tracking injection script
│       ├── popup.js          # Popup settings and WebSocket status UI
│       ├── input.css         # Tailwind source
│       └── styles.css        # Generated CSS
└── README.md
```

## Requirements

### Python

- Python 3.10+
- pip

Install Python dependencies:

```bash
pip install fastapi uvicorn scipy numpy vieneu
```

For NVIDIA GPU support, install the CUDA extra and the GPU build of ONNX
Runtime:

```bash
pip install "vieneu[cuda]" onnxruntime-gpu fastapi uvicorn scipy numpy pystray Pillow
```

For CPU-only use:

```bash
pip install vieneu fastapi uvicorn scipy numpy pystray Pillow
```

`v3nano` is CPU-only in VieNeu. To use GPU, select the PyTorch-backed v3 Turbo
backend before starting the server:

Windows PowerShell:

```powershell
$env:VIENEU_MODE="v3turbo"
$env:VIENEU_DEVICE="cuda"
$env:VIENEU_BACKEND="pytorch"
python server.py
```

The default remains `v3nano` for compatibility with the existing 24 kHz model.

The VieNeu model is downloaded automatically from Hugging Face on the first
server launch. The downloaded files are kept in `%LOCALAPPDATA%\YoutubeTTS\huggingface`
on Windows (or the equivalent `LOCALAPPDATA` location), so subsequent launches
reuse the local cache.

### Node.js (for extension CSS build)

- Node.js and npm

Install frontend dependencies:

```bash
npm install
```

## Run the local TTS server

From the project root:

```bash
python server.py
```

To build the server as a one-file executable:

```bash
pyinstaller --clean --noconfirm server.spec
```

Build the executable in the same environment where `vieneu[cuda]` and
`onnxruntime-gpu` are installed. The generated `dist\server.exe` includes the
available VieNeu, ONNX Runtime, and Torch native libraries; the target machine
still needs a compatible NVIDIA driver.

## GUI launcher

The GUI launcher can toggle GPU use, show or hide the server console, minimize
to the system tray, start with Windows, and quit the application.

Run during development:

```bash
python launcher.py
```

Build the launcher as a one-file executable:

```bash
pyinstaller --clean --noconfirm launcher.spec
```

The build creates `dist\launcher.exe` and `dist\server.exe`. Keep both files
under the same `dist\` directory, then run `dist\launcher.exe`.

Run `dist/server.exe` while connected to the internet the first time. Model
download and initialization happen before the server starts; later launches
reuse the cached model.

The server starts on:

- HTTP: http://127.0.0.1:8000
- WebSocket: ws://127.0.0.1:8000/ws/tts

If you want to test the HTTP endpoint directly:

```bash
curl -X POST http://127.0.0.1:8000/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Xin chao","voice":"Mai Anh"}'
```

## Build the extension CSS

```bash
npm run build
```

For live CSS watching during development:

```bash
npm run dev
```

## Load the Chrome extension

1. Open Chrome and go to `chrome://extensions`
2. Enable Developer mode
3. Click Load unpacked
4. Select the `chrome` folder from this project

The extension manifest points to the YouTube domain and allows local connections to `127.0.0.1`.

## Using the extension

### Web Speech mode

- Select the Web Speech engine in the popup
- Choose a language and voice
- The extension will read subtitles using the browser voice engine

### Local server mode

- Select Local Server in the popup
- Set the WebSocket URL if needed (default is `ws://127.0.0.1:8000/ws/tts`)
- Choose a local voice from the VieNeu list
- Make sure `server.py` is running before using local TTS

## How it works

- The content script monitors the active YouTube player DOM for subtitle text updates.
- The interceptor script loads subtitle data from YouTube and sends it back to the extension.
- The extension checks whether the current subtitle is already cached.
- For local TTS, the extension sends the subtitle text to the Python WebSocket server, which generates WAV audio and streams it back.
- The browser then plays the generated audio while ducking the video volume.

## Notes

- This project is designed for local development and testing.
- The extension requires YouTube subtitles to be available for the currently playing video.
- If the local server is not running, the extension can fall back to browser speech synthesis if configured.
- The project currently uses Vietnamese TTS names and local voice names in the popup UI.

## Troubleshooting

### WebSocket connection fails

- Confirm `server.py` is running.
- Check that the URL is set to `ws://127.0.0.1:8000/ws/tts`.
- Ensure the extension is allowed to connect to localhost in Chrome.

### No audio plays

- Verify that subtitles are visible on the YouTube page.
- Check whether the extension is enabled.
- Confirm the selected engine and voice are valid.
- Inspect the browser console for any WebSocket or playback errors.

## Support the project

If this project is useful to you, you can support its continued development with a small donation. Thank you for your support!

![Donate via TPBank](assets/tpbank.jpg)

## License

This project is provided as-is for educational and personal use.
