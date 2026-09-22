// content.js - YouTube Subtitle TTS với Pre-fetch (Network Interceptor) & WebSocket Audio Stream
(function () {
  console.log("YouTube Subtitle TTS Extension (WebSocket & Pre-fetch) loaded!");

  // --- Cấu hình & Biến Trạng Thái ---
  let enabled = true;
  let engineType = "webspeech"; // 'webspeech' hoặc 'localserver'
  let wsServerUrl = "ws://127.0.0.1:8000/ws/tts";
  let selectedVoiceName = "";
  let rate = 1.0;
  let pitch = 1.0;
  let ducking = 20;

  let socket = null;
  let isWsConnected = false;

  // Quản lý Audio & Pre-fetch Cache
  const PREFETCH_COUNT = 5;
  const MAX_AUDIO_CACHE_SIZE = 30;
  let audioCache = new Map(); // Key (text) -> AudioBuffer
  let pendingPlayText = null;
  let currentSourceNode = null;
  let subtitleTrack = []; // Danh sách toàn bộ sub track lấy tự động
  let lastSubText = "";
  let currentIncomingId = null;

  // --- 1. Đồng bộ Cài đặt từ Chrome Storage ---
  chrome.storage.sync.get(
    ["enabled", "engineType", "wsServerUrl", "voice", "rate", "pitch", "ducking"],
    (data) => {
      enabled = data.enabled !== undefined ? data.enabled : true;
      engineType = data.engineType || "webspeech";
      wsServerUrl = data.wsServerUrl || "ws://127.0.0.1:8000/ws/tts";
      selectedVoiceName = data.voice || "";
      rate = parseFloat(data.rate) || 1.0;
      pitch = parseFloat(data.pitch) || 1.0;
      ducking = data.ducking !== undefined ? parseInt(data.ducking) : 20;

      if (engineType === "localserver") {
        initWebSocket();
      }
    }
  );

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) enabled = changes.enabled.newValue;
    if (changes.engineType) {
      engineType = changes.engineType.newValue;
      if (engineType === "localserver" && !socket) initWebSocket();
    }
    if (changes.wsServerUrl) {
      wsServerUrl = changes.wsServerUrl.newValue;
      if (socket) socket.close();
      initWebSocket();
    }
    if (changes.voice) selectedVoiceName = changes.voice.newValue;
    if (changes.rate) rate = parseFloat(changes.rate.newValue) || 1.0;
    if (changes.pitch) pitch = parseFloat(changes.pitch.newValue) || 1.0;
    if (changes.ducking) ducking = parseInt(changes.ducking.newValue) || 20;
  });

  // --- 2. Quản lý WebSocket Server ---
  function initWebSocket() {
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;

    socket = new WebSocket(wsServerUrl);
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      isWsConnected = true;
      console.log("[TTS WS] Đã kết nối Local WebSocket Server thành công.");
    };

    socket.onmessage = async (event) => {
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data);
        if (msg.type === "audio_start") {
          currentIncomingId = msg.id;
        }
      } else if (event.data instanceof ArrayBuffer) {
        if (currentIncomingId) {
          audioCache.set(currentIncomingId, event.data);

          if (pendingPlayText === currentIncomingId) {
            playBufferedAudio(currentIncomingId);
            pendingPlayText = null;
          }
        }
      }
    };

    socket.onclose = () => {
      isWsConnected = false;
      console.warn("[TTS WS] Mất kết nối WebSocket Server. Thử lại sau 3 giây...");
      setTimeout(() => {
        if (engineType === "localserver") initWebSocket();
      }, 3000);
    };

    socket.onerror = (err) => {
      console.error("[TTS WS] Lỗi kết nối WebSocket:", err);
    };
  }

  // --- 3. Yêu cầu TTS & Thuật toán Pre-fetching ---
  function requestTTS(text, type = "read") {
    if (!isWsConnected || audioCache.has(text) || !text) return;

    console.log(`[TTS Req] Gửi yêu cầu (${type}): "${text}"`);
    socket.send(JSON.stringify({
      type: type,
      id: text,
      text: text,
      voice: selectedVoiceName
    }));
  }

  // Hàm dọn dẹp bộ nhớ cache nếu vượt ngưỡng
  function cleanupAudioCache() {
    if (audioCache.size > MAX_AUDIO_CACHE_SIZE) {
      // Xóa bớt các câu cũ nhất trong Map
      const keysToDeleteCount = audioCache.size - MAX_AUDIO_CACHE_SIZE;
      const keys = Array.from(audioCache.keys());

      for (let i = 0; i < keysToDeleteCount; i++) {
        // Tránh xóa câu hiện tại đang phát
        if (keys[i] !== lastSubText) {
          audioCache.delete(keys[i]);
        }
      }
    }
  }

  // Pre-fetch trước phụ đề tiếp theo
  function prefetchSubtitles(currentIndex) {
    if (!subtitleTrack || subtitleTrack.length === 0) return;

    // Dọn dẹp cache cũ nếu đầy
    cleanupAudioCache();

    for (let i = 1; i <= PREFETCH_COUNT; i++) {
      const nextIndex = currentIndex + i;

      if (nextIndex < subtitleTrack.length) {
        const nextItem = subtitleTrack[nextIndex];
        const nextText = nextItem.text;

        // Chỉ gửi request pre-fetch nếu câu này chưa có trong Cache
        if (nextText && !audioCache.has(nextText)) {
          // console.log(`🚀 [Pre-fetch ${i}/${PREFETCH_COUNT}] Gửi request cho câu: "${nextText}"`);
          requestTTS(nextText, "prefetch");
        }
      }
    }
  }

  // --- 2. Hàm phát âm thanh hỗ trợ rate/playbackRate chuẩn ---
  let currentAudioElement = null;

  function playBufferedAudio(textKey) {
    stopAudio();

    const arrayBuffer = audioCache.get(textKey);
    if (!arrayBuffer) return;

    // 🟢 Tạo Blob đúng định dạng WAV từ ArrayBuffer nhận từ Server
    const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
    const audioUrl = URL.createObjectURL(blob);

    const audio = new Audio(audioUrl);

    // 🟢 Áp dụng tốc độ phát (rate) ép kiểu Float rõ ràng
    const currentRate = parseFloat(rate) || 1.0;
    audio.playbackRate = currentRate;

    applyDucking();

    audio.onended = () => {
      resetVolume();
      URL.revokeObjectURL(audioUrl); // Dọn dẹp RAM
      audioCache.delete(textKey);
    };

    audio.onerror = (err) => {
      console.error("[TTS Audio] Lỗi phát file WAV:", err);
      resetVolume();
    };

    // Đảm bảo thiết lập lại rate nếu trình duyệt tự reset khi load metadata
    audio.onloadedmetadata = () => {
      audio.playbackRate = currentRate;
    };

    audio.play().catch(err => console.error("[TTS Audio] Lỗi Play:", err));
    currentAudioElement = audio;
  }

  function stopAudio() {
    if (currentAudioElement) {
      currentAudioElement.pause();
      currentAudioElement.currentTime = 0;
      currentAudioElement = null;
    }
    if (currentSourceNode) {
      try { currentSourceNode.stop(); } catch (e) { }
      currentSourceNode = null;
    }
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    resetVolume();
  }

  function speakViaWebSpeech(text) {
    stopAudio();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate;
    utterance.pitch = pitch;

    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find(v => v.name === selectedVoiceName);
    if (voice) utterance.voice = voice;

    utterance.onstart = () => applyDucking();
    utterance.onend = () => resetVolume();
    utterance.onerror = () => resetVolume();

    window.speechSynthesis.speak(utterance);
  }

  // --- 5. Audio Ducking ---
  function applyDucking() {
    const video = document.querySelector('video');
    if (video) {
      if (video.dataset.origVol === undefined) {
        video.dataset.origVol = video.volume;
      }
      video.volume = parseFloat(video.dataset.origVol) * (ducking / 100);
    }
  }

  function resetVolume() {
    const video = document.querySelector('video');
    if (video && video.dataset.origVol !== undefined) {
      video.volume = parseFloat(video.dataset.origVol);
    }
  }

  // --- 6. Nhận Diện & Xử Lý Phụ Đề Trực Tiếp ---
  function processSubtitleChange(fullText) {
    if (!enabled || !fullText || fullText === lastSubText) return;

    lastSubText = fullText;

    if (engineType === "localserver") {
      if (audioCache.has(fullText)) {
        console.log(`⚡ [Cache Hit] Phát âm thanh pre-fetch cho: "${fullText}"`);
        playBufferedAudio(fullText);
      } else {
        console.log(`⚠️ [Cache Miss] Đang chờ server trả về câu: "${fullText}"`);
        pendingPlayText = fullText;
        requestTTS(fullText, "read");

        if (!isWsConnected) {
          speakViaWebSpeech(fullText);
        }
      }

      // Tìm vị trí câu hiện tại trong danh sách SubtitleTrack để kích hoạt Pre-fetch
      const currentIndex = subtitleTrack.findIndex(item => item.text === fullText || item.text.includes(fullText) || fullText.includes(item.text));
      if (currentIndex !== -1) {
        prefetchSubtitles(currentIndex);
      }
    } else {
      speakViaWebSpeech(fullText);
    }
  }

  // Quan sát DOM Phụ đề trên trình phát video YouTube
  const observer = new MutationObserver(() => {
    const captionSegments = document.querySelectorAll('.ytp-caption-segment');
    if (captionSegments.length > 0) {
      const fullSubtitle = Array.from(captionSegments)
        .map(el => el.textContent.trim())
        .join(' ');

      processSubtitleChange(fullSubtitle);
    }
  });

  function setupSubtitleObserver() {
    // Ngắt quan sát cũ (nếu có) trước khi tạo mới
    observer.disconnect();

    // Ưu tiên quan sát khung phát player, nếu chưa nạp xong thì quan sát document.body
    const targetNode = document.querySelector('.html5-video-player')
      || document.querySelector('#movie_player')
      || document.body
      || document.documentElement;

    if (targetNode && targetNode instanceof Node) {
      observer.observe(targetNode, { childList: true, subtree: true });
      console.log("🟢 [TTS] Đã gắn MutationObserver thành công trên Node:", targetNode.className || targetNode.nodeName);
    } else {
      // Trường hợp hiếm khi DOM chưa sẵn sàng, thử lại sau 500ms
      setTimeout(setupSubtitleObserver, 500);
    }
  }

  // 🟢 Kích hoạt Observer an toàn khi tải trang hoặc khi YouTube chuyển video (SPA)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupSubtitleObserver);
  } else {
    setupSubtitleObserver();
  }

  // --- 7. CƠ CHẾ BẮT CHẶN NETWORK (INTERCEPTOR) ĐỂ TẢI SUBTITLE TRACK ---
  function injectSubtitleInterceptor() {
    const script = document.createElement('script');
    // 🟢 Nạp bằng URL hợp lệ được cấp phép qua Manifest thay vì dùng Inline Script
    script.src = chrome.runtime.getURL('src/interceptor.js');

    script.onload = function () {
      this.remove(); // Dọn dẹp DOM sau khi script đã nạp xong
    };

    (document.head || document.documentElement).appendChild(script);
  }

  // Lắng nghe dữ liệu phụ đề từ script inject gửi về
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'YT_SUBTITLES_LOADED') {
      const items = event.data.data;
      if (Array.isArray(items) && items.length > 0) {
        subtitleTrack = items; // Lưu toàn bộ mảng [{start: ..., text: ...}]
        console.log(`✅ [TTS Pre-fetch] Đã nạp thành công ${subtitleTrack.length} câu phụ đề vào bộ nhớ!`);

        // Nếu video đang chạy và đã có câu phụ đề hiện tại, kích hoạt pre-fetch ngay
        if (lastSubText) {
          const idx = subtitleTrack.findIndex(item => item.text === lastSubText || item.text.includes(lastSubText));
          if (idx !== -1) prefetchSubtitles(idx);
        }
      }
    }
  });

  // Lắng nghe sự kiện chuyển video của YouTube để đảm bảo Interceptor luôn hoạt động
  window.addEventListener('yt-navigate-finish', () => {
    subtitleTrack = [];
    lastSubText = "";
    console.log("🔄 [TTS] Đã chuyển video YouTube mới, làm sạch bộ đệm sub.");
  });

  injectSubtitleInterceptor();
})();