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
  let sequentialQueue = true;

  let socket = null;
  let isWsConnected = false;

  // Quản lý Audio & Pre-fetch Cache
  const PREFETCH_COUNT = 5;
  const MAX_AUDIO_CACHE_SIZE = 30;
  let audioCache = new Map(); // Key (text) -> AudioBuffer
  let pendingPlayText = null;
  let subtitleTrack = []; // Danh sách toàn bộ sub track
  let lastSubText = "";
  let currentIncomingId = null;

  // --- Quản lý Hàng chờ Audio Tuần tự (Queue Engine) ---
  let audioQueue = []; 
  let isPlayingAudio = false;
  let currentAudioElement = null;
  let currentVideoElement = null;
  let isSeeking = false;
  let seekSessionId = 0;

  // --- 1. Đồng bộ Cài đặt từ Chrome Storage ---
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
        if (currentIncomingId && event.data.byteLength > 44) {
          audioCache.set(currentIncomingId, event.data);

          const video = currentVideoElement || document.querySelector('video');
          if (video && !video.paused && !video.seeking) {
            enqueueAudio(currentIncomingId);
          }
          pendingPlayText = null;
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

  // --- 3. Yêu cầu TTS & Pre-fetching ---
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
        const nextItem = subtitleTrack[nextIndex];
        const nextText = nextItem.text;

        if (nextText && !audioCache.has(nextText)) {
          requestTTS(nextText, "prefetch");
        }
      }
    }
  }

  // --- 4. Queue Audio Engine (Xử lý Phát Tuần Tự hoặc Đè Trực Tiếp) ---

  // Đẩy câu TTS mới vào luồng phát
  function enqueueAudio(textKey) {
    if (sequentialQueue) {
      // [CHẾ ĐỘ TUẦN TỰ]: Thêm vào hàng chờ nếu chưa tồn tại
      if (!audioQueue.includes(textKey)) {
        audioQueue.push(textKey);
        console.log(`📥 [TTS Queue] Thêm vào hàng chờ: "${textKey}". Số câu chờ: ${audioQueue.length}`);
      }
      if (!isPlayingAudio) {
        processNextInQueue();
      }
    } else {
      // [CHẾ ĐỘ ĐÈ TRỰC TIẾP]: Dừng audio cũ, đọc câu mới ngay lập tức
      stopAudio();
      playBufferedAudioDirectly(textKey);
    }
  }

  // Phát câu kế tiếp trong hàng chờ
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

    const currentRate = parseFloat(rate) || 1.0;
    audio.playbackRate = currentRate;

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

    audio.onloadedmetadata = () => {
      audio.playbackRate = currentRate;
    };

    audio.play().catch(err => {
      console.error("[TTS Queue Play Error]:", err);
      processNextInQueue();
    });

    currentAudioElement = audio;
  }

  // Phát trực tiếp (khi tắt sequentialQueue)
  function playBufferedAudioDirectly(textKey) {
    const arrayBuffer = audioCache.get(textKey);
    if (!arrayBuffer) return;

    const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);

    const currentRate = parseFloat(rate) || 1.0;
    audio.playbackRate = currentRate;

    applyDucking();

    audio.onended = () => {
      resetVolume();
      URL.revokeObjectURL(audioUrl);
      audioCache.delete(textKey);
      currentAudioElement = null;
    };

    audio.onerror = () => {
      resetVolume();
      URL.revokeObjectURL(audioUrl);
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

  // Dừng & làm sạch hoàn toàn Audio lẫn Hàng chờ (dùng khi Seek, Video Pause hoặc Chuyển Trang)
  function stopAudio() {
    // 1. Dọn dẹp hàng chờ
    audioQueue = [];
    isPlayingAudio = false;

    // 2. Ngắt audio đang phát
    if (currentAudioElement) {
      try {
        currentAudioElement.onerror = null;
        currentAudioElement.onended = null;
        currentAudioElement.pause();
        currentAudioElement.currentTime = 0;
        currentAudioElement.src = "";
        currentAudioElement.load();
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

  // --- 6. Nhận Diện Phụ Đề & Bắt Sự Kiện Video ---
  function processSubtitleChange(fullText) {
    const video = currentVideoElement || document.querySelector('video');

    if (!enabled || !fullText || fullText === lastSubText ||
      isSeeking || (video && video.paused)
    ) return;

    lastSubText = fullText;
    speakOrFetchText(fullText);
  }

  function speakOrFetchText(text) {
    if (!text) return;

    if (engineType === "localserver") {
      if (audioCache.has(text)) {
        enqueueAudio(text);
      } else {
        pendingPlayText = text;
        requestTTS(text, "read");

        if (!isWsConnected) {
          speakViaWebSpeech(text);
        }
      }

      const currentIndex = subtitleTrack.findIndex(item =>
        item.text === text || item.text.includes(text) || text.includes(item.text)
      );
      if (currentIndex !== -1) {
        prefetchSubtitles(currentIndex);
      }
    } else {
      speakViaWebSpeech(text);
    }
  }

  function attachVideoListeners(video) {
    if (!video || video === currentVideoElement) return;

    currentVideoElement = video;

    video.addEventListener('pause', () => {
      if (!video.seeking) {
        pauseAudio();
      }
    });

    video.addEventListener('play', () => {
      const resumed = resumeAudio();
      if (!resumed) {
        // Nếu không resume được audio cũ và hàng chờ rỗng, phát phụ đề hiện tại
        if (!isPlayingAudio && audioQueue.length === 0) {
          const captionSegments = document.querySelectorAll('.ytp-caption-segment');
          if (captionSegments.length > 0) {
            const activeText = Array.from(captionSegments)
              .map(el => el.textContent.trim())
              .join(' ');
            if (activeText) speakOrFetchText(activeText);
          }
        }
      }
    });

    video.addEventListener('seeking', () => {
      isSeeking = true;
      seekSessionId++;
      pendingPlayText = null;
      lastSubText = "";
      stopAudio();
    });

    video.addEventListener('seeked', () => {
      isSeeking = false;
    });
  }

  function observeVideoElement(onVideoFound) {
    const existingVideo = document.querySelector('video');
    if (existingVideo) {
      onVideoFound(existingVideo);
      return;
    }

    let videoObserver = new MutationObserver((mutations, observer) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const video = node.tagName === 'VIDEO' ? node : node.querySelector('video');
            if (video) {
              observer.disconnect();
              onVideoFound(video);
              return;
            }
          }
        }
      }
    });

    videoObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  observeVideoElement((videoNode) => {
    attachVideoListeners(videoNode);
  });

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
    observer.disconnect();

    const targetNode = document.querySelector('.html5-video-player')
      || document.querySelector('#movie_player')
      || document.body
      || document.documentElement;

    if (targetNode && targetNode instanceof Node) {
      observer.observe(targetNode, { childList: true, subtree: true });
    } else {
      setTimeout(setupSubtitleObserver, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupSubtitleObserver);
  } else {
    setupSubtitleObserver();
  }

  // --- 7. Interceptor & Navigation ---
  function injectSubtitleInterceptor() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/interceptor.js');

    script.onload = function () {
      this.remove();
    };

    (document.head || document.documentElement).appendChild(script);
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'YT_SUBTITLES_LOADED') {
      const items = event.data.data;
      if (Array.isArray(items) && items.length > 0) {
        subtitleTrack = items;
        if (lastSubText) {
          const idx = subtitleTrack.findIndex(item => item.text === lastSubText || item.text.includes(lastSubText));
          if (idx !== -1) prefetchSubtitles(idx);
        }
      }
    }
  });

  window.addEventListener('yt-navigate-finish', () => {
    subtitleTrack = [];
    lastSubText = "";
    currentVideoElement = null;
    stopAudio();
    setupSubtitleObserver();
  });

  injectSubtitleInterceptor();
})();