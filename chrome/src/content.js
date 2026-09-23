// content.js - YouTube Subtitle TTS Hybrid Engine (Time-Sync & Live DOM Fallback)
(function () {
  console.log("🟢 YouTube Subtitle TTS Hybrid Engine Loaded!");

  // --- Cấu hình & Biến Trạng Thái ---
  let enabled = true;
  let engineType = "webspeech"; // 'webspeech' hoặc 'localserver'
  let wsServerUrl = "ws://127.0.0.1:8000/ws/tts";
  let selectedVoiceName = "";
  let rate = 1.0;
  let pitch = 1.0;
  let ducking = 20;
  let sequentialQueue = true;

  let socket = null;
  let isWsConnected = false;

  // Quản lý Subtitle & Audio
  const PREFETCH_COUNT = 5;
  const MAX_AUDIO_CACHE_SIZE = 30;
  let audioCache = new Map(); // Key (text) -> ArrayBuffer
  let subtitleTrack = [];     // Track sub đã xử lý từ Interceptor
  let lastPlayedIndex = -1;   // Index câu vừa phát theo Time Sync
  let lastSubText = "";       // Text vừa phát (cho DOM Fallback)
  let pendingTTSKey = null;   // Key câu đang đợi WS phản hồi
  let syncTimer = null;       // Timer đồng bộ thời gian
  let debounceTimer = null;   // Debounce cho sub DOM tự động

  // Quản lý Hàng chờ Audio
  let audioQueue = [];
  let isPlayingAudio = false;
  let currentAudioElement = null;
  let currentVideoElement = null;
  let isSeeking = false;
  let currentIncomingId = null;

  // --- 1. Đồng bộ Storage ---
  chrome.storage.sync.get(
    ["enabled", "engineType", "wsServerUrl", "voice", "rate", "pitch", "ducking", "sequentialQueue"],
    (data) => {
      enabled = data.enabled !== undefined ? data.enabled : true;
      engineType = data.engineType || "webspeech";
      wsServerUrl = data.wsServerUrl || "ws://127.0.0.1:8000/ws/tts";
      selectedVoiceName = data.voice || "";
      rate = parseFloat(data.rate) || 1.0;
      pitch = parseFloat(data.pitch) || 1.0;
      ducking = data.ducking !== undefined ? parseInt(data.ducking) : 20;
      sequentialQueue = data.sequentialQueue !== undefined ? data.sequentialQueue : true;

      if (engineType === "localserver") {
        initWebSocket();
      }
    }
  );

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) enabled = changes.enabled.newValue;
    if (changes.sequentialQueue) sequentialQueue = changes.sequentialQueue.newValue;
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

  // --- 2. WebSocket Manager ---
  function initWebSocket() {
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;

    socket = new WebSocket(wsServerUrl);
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      isWsConnected = true;
      console.log("[TTS WS] Đã kết nối Local WebSocket Server.");
    };

    socket.onmessage = async (event) => {
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data);
        if (msg.type === "audio_start") {
          currentIncomingId = msg.id;
        }
      } else if (event.data instanceof ArrayBuffer) {
        if (currentIncomingId && event.data.byteLength > 44) {
          audioCache.set(currentIncomingId, event.data);

          const video = currentVideoElement || document.querySelector('video');
          if (video && !video.paused && !video.seeking) {
            // NẾU ĐÂY LÀ CÂU ĐANG CHỜ PHÁT -> ĐẨY VÀO QUEUE NGAY
            if (pendingTTSKey === currentIncomingId || !isPlayingAudio) {
              enqueueAudio(currentIncomingId);
              pendingTTSKey = null;
            }
          }
        }
      }
    };

    socket.onclose = () => {
      isWsConnected = false;
      setTimeout(() => {
        if (engineType === "localserver") initWebSocket();
      }, 3000);
    };

    socket.onerror = (err) => {
      console.error("[TTS WS] Lỗi kết nối WebSocket:", err);
    };
  }

  function requestTTS(text, type = "read") {
    if (!isWsConnected || audioCache.has(text) || !text) return;

    socket.send(JSON.stringify({
      type: type,
      id: text,
      text: text,
      voice: selectedVoiceName
    }));
  }

  function cleanupAudioCache() {
    if (audioCache.size > MAX_AUDIO_CACHE_SIZE) {
      const keysToDeleteCount = audioCache.size - MAX_AUDIO_CACHE_SIZE;
      const keys = Array.from(audioCache.keys());

      for (let i = 0; i < keysToDeleteCount; i++) {
        if (keys[i] !== lastSubText) {
          audioCache.delete(keys[i]);
        }
      }
    }
  }

  function prefetchSubtitles(currentIndex) {
    if (!subtitleTrack || subtitleTrack.length === 0) return;
    cleanupAudioCache();

    for (let i = 1; i <= PREFETCH_COUNT; i++) {
      const nextIndex = currentIndex + i;
      if (nextIndex < subtitleTrack.length) {
        const nextText = subtitleTrack[nextIndex].text;
        if (nextText && !audioCache.has(nextText)) {
          requestTTS(nextText, "prefetch");
        }
      }
    }
  }

  // --- 3. Hàm Làm Sạch & Khử Trùng Lặp Chuỗi ---
  function cleanSubtitleText(text) {
    if (!text) return "";
    return text
      .replace(/\[.*?\]|\(.*?\)/g, '') // Lọc sạch [âm nhạc], [cười], (nhạc)...
      .replace(/\s+/g, ' ')           // Thu gọn khoảng trắng
      .trim();
  }

  // --- 4. ENGINE 1: Time-Sync Sync Engine (Uu tiên dùng khi có Track Sub) ---
  function startSubSyncTimer() {
    if (syncTimer) clearInterval(syncTimer);

    syncTimer = setInterval(() => {
      const video = currentVideoElement || document.querySelector('video');
      if (!video || video.paused || video.seeking || !enabled || subtitleTrack.length === 0) return;

      const currentTimeMs = video.currentTime * 1000;

      // Tìm câu phụ đề kế tiếp chưa đọc phù hợp với mốc thời gian hiện tại (+ 2.5s bù trễ)
      const currentIndex = subtitleTrack.findIndex((item, idx) => {
        if (idx <= lastPlayedIndex) return false;
        return currentTimeMs >= item.start && currentTimeMs <= (item.end + 2500);
      });

      if (currentIndex !== -1) {
        lastPlayedIndex = currentIndex;
        const subItem = subtitleTrack[currentIndex];
        
        console.log(`🎯 [TTS Time-Sync] Phát câu [${currentIndex}]: "${subItem.text}"`);
        speakOrFetchText(subItem.text);
        prefetchSubtitles(currentIndex);
      }
    }, 150);
  }

  // --- 5. ENGINE 2: Live DOM Observer Fallback (Cho Sub Auto đang gõ trực tiếp) ---
  function processDOMSubtitleChange(rawText) {
    // Nếu đã có Track Sub từ Interceptor thì Engine 1 sẽ đảm nhận, ngắt Observer
    if (subtitleTrack.length > 0) return;

    const cleanText = cleanSubtitleText(rawText);
    const video = currentVideoElement || document.querySelector('video');

    if (!enabled || !cleanText || cleanText === lastSubText ||
      isSeeking || (video && video.paused)
    ) return;

    // Lọc trùng gối đầu (Nếu câu mới chứa nguyên văn câu cũ đang mở rộng)
    if (cleanText.startsWith(lastSubText) && cleanText.length - lastSubText.length < 15) {
      // Câu chưa hoàn chỉnh (chỉ mới thêm 1-2 từ), hủy bỏ timer cũ
      if (debounceTimer) clearTimeout(debounceTimer);
    }

    if (debounceTimer) clearTimeout(debounceTimer);

    // Chờ 450ms không có từ mới xuất hiện mới bắt đầu phát âm thanh
    debounceTimer = setTimeout(() => {
      lastSubText = cleanText;
      console.log(`👁️ [TTS DOM Fallback] Đọc câu: "${cleanText}"`);
      speakOrFetchText(cleanText);
    }, 450);
  }

  function speakOrFetchText(text) {
    if (!text) return;

    if (engineType === "localserver") {
      if (audioCache.has(text)) {
        enqueueAudio(text);
      } else {
        pendingTTSKey = text;
        requestTTS(text, "read");

        if (!isWsConnected) {
          speakViaWebSpeech(text);
        }
      }
    } else {
      speakViaWebSpeech(text);
    }
  }

  // --- 6. Queue Audio Engine ---
  function enqueueAudio(textKey) {
    if (sequentialQueue) {
      if (!audioQueue.includes(textKey)) {
        audioQueue.push(textKey);
      }
      if (!isPlayingAudio) {
        processNextInQueue();
      }
    } else {
      stopAudio();
      playBufferedAudioDirectly(textKey);
    }
  }

  function processNextInQueue() {
    if (audioQueue.length === 0) {
      isPlayingAudio = false;
      currentAudioElement = null;
      return;
    }

    const video = currentVideoElement || document.querySelector('video');
    if (video && (video.paused || video.seeking)) {
      isPlayingAudio = false;
      return;
    }

    isPlayingAudio = true;
    const textKey = audioQueue.shift();

    const arrayBuffer = audioCache.get(textKey);
    if (!arrayBuffer) {
      processNextInQueue();
      return;
    }

    const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);

    audio.playbackRate = parseFloat(rate) || 1.0;
    applyDucking();

    audio.onended = () => {
      resetVolume();
      URL.revokeObjectURL(audioUrl);
      audioCache.delete(textKey);
      processNextInQueue();
    };

    audio.onerror = (err) => {
      console.error("[TTS Queue Error]:", err);
      resetVolume();
      URL.revokeObjectURL(audioUrl);
      processNextInQueue();
    };

    audio.play().catch(err => {
      console.error("[TTS Queue Play Error]:", err);
      processNextInQueue();
    });

    currentAudioElement = audio;
  }

  function playBufferedAudioDirectly(textKey) {
    const arrayBuffer = audioCache.get(textKey);
    if (!arrayBuffer) return;

    const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);

    audio.playbackRate = parseFloat(rate) || 1.0;
    applyDucking();

    audio.onended = () => {
      resetVolume();
      URL.revokeObjectURL(audioUrl);
      audioCache.delete(textKey);
      currentAudioElement = null;
    };

    audio.play().catch(console.error);
    currentAudioElement = audio;
  }

  function pauseAudio() {
    if (currentAudioElement && !currentAudioElement.paused) {
      currentAudioElement.pause();
    }
  }

  function resumeAudio() {
    if (currentAudioElement && currentAudioElement.paused && currentAudioElement.src) {
      const video = currentVideoElement || document.querySelector('video');
      if (video && !video.paused) {
        currentAudioElement.play().catch(console.error);
        return true;
      }
    }
    return false;
  }

  function stopAudio() {
    audioQueue = [];
    isPlayingAudio = false;

    if (currentAudioElement) {
      try {
        currentAudioElement.pause();
        currentAudioElement.currentTime = 0;
        currentAudioElement.src = "";
      } catch (e) { }
      currentAudioElement = null;
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

  // --- 7. Audio Ducking ---
  function applyDucking() {
    const video = currentVideoElement || document.querySelector('video');
    if (video) {
      if (video.dataset.origVol === undefined) {
        video.dataset.origVol = video.volume;
      }
      video.volume = parseFloat(video.dataset.origVol) * (ducking / 100);
    }
  }

  function resetVolume() {
    const video = currentVideoElement || document.querySelector('video');
    if (video && video.dataset.origVol !== undefined) {
      video.volume = parseFloat(video.dataset.origVol);
    }
  }

  // --- 8. Sự Kiện Video & Observer ---
  function attachVideoListeners(video) {
    if (!video || video === currentVideoElement) return;

    currentVideoElement = video;

    video.addEventListener('pause', () => {
      if (!video.seeking) pauseAudio();
    });

    video.addEventListener('play', () => {
      resumeAudio();
    });

    video.addEventListener('seeking', () => {
      isSeeking = true;
      pendingTTSKey = null;
      lastSubText = "";
      stopAudio();
    });

    video.addEventListener('seeked', () => {
      isSeeking = false;
      const currentTimeMs = video.currentTime * 1000;
      
      // Đồng bộ lại câu gần nhất theo vị trí tua video
      if (subtitleTrack.length > 0) {
        lastPlayedIndex = subtitleTrack.findLastIndex(item => item.start < currentTimeMs);
      }
    });

    startSubSyncTimer();
  }

  function observeVideoElement() {
    const video = document.querySelector('video');
    if (video) {
      attachVideoListeners(video);
    } else {
      setTimeout(observeVideoElement, 500);
    }
  }

  // Observer quét thẻ Subtitle DOM
  const domObserver = new MutationObserver(() => {
    // Nếu đã có Track Sub chuẩn từ Interceptor thì ngắt DOM Observer để tiết kiệm tài nguyên
    if (subtitleTrack.length > 0) return;

    const captionSegments = document.querySelectorAll('.ytp-caption-segment');
    if (captionSegments.length > 0) {
      const fullSubtitle = Array.from(captionSegments)
        .map(el => el.textContent.trim())
        .join(' ');

      processDOMSubtitleChange(fullSubtitle);
    }
  });

  function setupSubtitleObserver() {
    domObserver.disconnect();
    const targetNode = document.querySelector('.html5-video-player')
      || document.querySelector('#movie_player')
      || document.body;

    if (targetNode) {
      domObserver.observe(targetNode, { childList: true, subtree: true });
    } else {
      setTimeout(setupSubtitleObserver, 500);
    }
  }

  // --- 9. Nhận dữ liệu từ Interceptor ---
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'YT_SUBTITLES_LOADED') {
      const items = event.data.data;
      if (Array.isArray(items) && items.length > 0) {
        subtitleTrack = items;
        lastPlayedIndex = -1;
        console.log(`✅ [TTS Content] Đã nạp ${subtitleTrack.length} câu sub từ Interceptor. Chuyển sang Time-Sync Engine.`);
      }
    }
  });

  window.addEventListener('yt-navigate-finish', () => {
    subtitleTrack = [];
    lastPlayedIndex = -1;
    lastSubText = "";
    stopAudio();
    observeVideoElement();
    setupSubtitleObserver();
  });

  function injectSubtitleInterceptor() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/interceptor.js');
    script.onload = function () { this.remove(); };
    (document.head || document.documentElement).appendChild(script);
  }

  // Kích hoạt Engine
  observeVideoElement();
  setupSubtitleObserver();
  injectSubtitleInterceptor();
})();