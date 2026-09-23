document.addEventListener('DOMContentLoaded', () => {
  const toggleBtn = document.getElementById('toggle-enable');
  const sequentialQueueBtn = document.getElementById('toggle-sequential');
  const engineSelect = document.getElementById('select-engine');
  const serverInput = document.getElementById('input-serverurl');
  const wsStatusBadge = document.getElementById('ws-status-badge');
  const wsStatusDot = document.getElementById('ws-status-dot');
  const wsStatusText = document.getElementById('ws-status-text');
  const boxLocal = document.getElementById('box-localserver');
  const boxWeb = document.getElementById('box-webspeech');
  const langSelect = document.getElementById('select-lang');
  const voiceSelect = document.getElementById('select-voice');
  const rateInput = document.getElementById('input-rate');
  const rateLabel = document.getElementById('rate-label');
  const pitchInput = document.getElementById('input-pitch');
  const pitchLabel = document.getElementById('pitch-label');
  const duckingInput = document.getElementById('input-ducking');
  const duckingLabel = document.getElementById('ducking-label');

  let engineType = null;
  let savedVoice = null;
  let savedLang = null;
  let allVoices = [];
  let testSocket = null;

  // Danh sách giọng VieNeu-TTS Local Server
  const LOCAL_VOICES = [
    'Adam', 'Ái Hân', 'Mỹ Duyên', 'Đức Trí', 'Hữu Quân',
    'Xuân Tiên', 'Mai Anh', 'Trúc Ly', 'Anh Khôi', 'Minh Quân', 'Mạnh Dũng'
  ];

  // Tự động chuyển đổi tên mã ngôn ngữ (VD: 'vi-VN' -> 'Tiếng Việt (vi-VN)')
  function getLanguageName(langCode) {
    try {
      const languageNames = new Intl.DisplayNames(['vi'], { type: 'language' });
      const name = languageNames.of(langCode);
      return name ? `${name} (${langCode})` : langCode;
    } catch (e) {
      return langCode;
    }
  }

  // Đổ danh sách giọng đọc theo ngôn ngữ đã chọn (Web Speech API)
  function populateVoicesForSelectedLang() {
    const selectedLang = langSelect.value;
    voiceSelect.innerHTML = '';

    const filteredVoices = allVoices.filter(v => (v.lang || 'Other') === selectedLang);

    filteredVoices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = v.name;
      voiceSelect.appendChild(opt);
    });

    if (savedVoice && filteredVoices.some(v => v.name === savedVoice)) {
      voiceSelect.value = savedVoice;
    } else if (filteredVoices.length > 0) {
      voiceSelect.value = filteredVoices[0].name;
      savedVoice = voiceSelect.value;
      chrome.storage.sync.set({ voice: savedVoice });
    }
  }

  // Nạp danh sách các giọng đọc
  function loadVoices() {
    voiceSelect.innerHTML = '';

    if (engineType === 'localserver') {
      // Nạp giọng VieNeu Local
      LOCAL_VOICES.forEach(voice => {
        const opt = document.createElement('option');
        opt.value = voice;
        opt.textContent = `${voice} (Local VieNeu)`;
        if (voice === savedVoice) opt.selected = true;
        voiceSelect.appendChild(opt);
      });

      if (!savedVoice || !LOCAL_VOICES.includes(savedVoice)) {
        voiceSelect.value = LOCAL_VOICES[0];
        savedVoice = LOCAL_VOICES[0];
        chrome.storage.sync.set({ voice: savedVoice });
      }
      return;
    }

    // Nạp giọng WebSpeech API
    allVoices = speechSynthesis.getVoices();
    if (!allVoices || allVoices.length === 0) return;

    const uniqueLangs = [...new Set(allVoices.map(v => v.lang || 'Other'))];

    // Ưu tiên đưa Tiếng Việt lên đầu
    uniqueLangs.sort((a, b) => {
      if (a.startsWith('vi')) return -1;
      if (b.startsWith('vi')) return 1;
      return a.localeCompare(b);
    });

    langSelect.innerHTML = '';
    uniqueLangs.forEach(lang => {
      const opt = document.createElement('option');
      opt.value = lang;
      opt.textContent = getLanguageName(lang);
      langSelect.appendChild(opt);
    });

    if (savedLang && uniqueLangs.includes(savedLang)) {
      langSelect.value = savedLang;
    } else {
      const defaultVi = uniqueLangs.find(l => l.startsWith('vi'));
      langSelect.value = defaultVi || uniqueLangs[0];
      savedLang = langSelect.value;
    }

    populateVoicesForSelectedLang();
  }

  if (typeof speechSynthesis !== 'undefined' && speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = () => {
      if (engineType === 'webspeech') loadVoices();
    };
  }

  // Chuyển đổi ẩn/hiện hộp cấu hình theo Chế độ Engine
  function updateEngineUI(engine) {
    engineType = engine;
    if (engine === 'webspeech') {
      boxWeb.classList.remove('hidden');
      boxLocal.classList.add('hidden');
      if (langSelect.parentElement) langSelect.parentElement.classList.remove('hidden');
    } else {
      boxWeb.classList.remove('hidden'); // Giữ lại boxWeb để dùng voiceSelect
      boxLocal.classList.remove('hidden');
      if (langSelect.parentElement) langSelect.parentElement.classList.add('hidden'); // Ẩn chọn ngôn ngữ vì Local chỉ dùng danh sách VieNeu
    }
    loadVoices();
  }

  // Kiểm tra kết nối WebSocket
  function checkWebSocketConnection(url) {
    if (!url || !url.startsWith('ws')) {
      updateStatusUI('offline', 'Invalid URL');
      return;
    }

    updateStatusUI('connecting', 'Connecting...');

    if (testSocket) {
      testSocket.close();
    }

    try {
      testSocket = new WebSocket(url);

      const connectionTimeout = setTimeout(() => {
        if (testSocket.readyState !== WebSocket.OPEN) {
          testSocket.close();
          updateStatusUI('offline', 'Offline');
        }
      }, 2500);

      testSocket.onopen = () => {
        clearTimeout(connectionTimeout);
        updateStatusUI('online', 'WS Active');
        setTimeout(() => testSocket.close(), 1000);
      };

      testSocket.onerror = () => {
        clearTimeout(connectionTimeout);
        updateStatusUI('offline', 'Offline');
      };
    } catch (e) {
      updateStatusUI('offline', 'Offline');
    }
  }

  // Cập nhật giao diện Đèn báo (Badge)
  function updateStatusUI(status, message) {
    wsStatusText.textContent = message;

    if (status === 'online') {
      wsStatusBadge.className = "inline-flex items-center text-[10px] text-emerald-400 bg-emerald-950/60 border border-emerald-800/50 px-1.5 py-0.5 rounded";
      wsStatusDot.className = "w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1 animate-pulse";
    } else if (status === 'offline') {
      wsStatusBadge.className = "inline-flex items-center text-[10px] text-rose-400 bg-rose-950/60 border border-rose-800/50 px-1.5 py-0.5 rounded";
      wsStatusDot.className = "w-1.5 h-1.5 rounded-full bg-rose-500 mr-1";
    } else {
      wsStatusBadge.className = "inline-flex items-center text-[10px] text-amber-400 bg-amber-950/60 border border-amber-800/50 px-1.5 py-0.5 rounded";
      wsStatusDot.className = "w-1.5 h-1.5 rounded-full bg-amber-400 mr-1 animate-ping";
    }
  }

  // Tải cấu hình từ chrome.storage.sync
  chrome.storage.sync.get(
    ['enabled', 'sequentialQueue', 'engineType', 'wsServerUrl', 'lang', 'voice', 'rate', 'pitch', 'ducking'],
    (d) => {
      if (d.enabled !== undefined) toggleBtn.checked = d.enabled;
      if (d.sequentialQueue !== undefined) sequentialQueueBtn.checked = d.sequentialQueue !== undefined ? d.sequentialQueue : true;

      if (d.lang) savedLang = d.lang;
      if (d.voice) savedVoice = d.voice;

      engineType = d.engineType || 'webspeech';
      engineSelect.value = engineType;
      updateEngineUI(engineType);

      if (d.wsServerUrl) serverInput.value = d.wsServerUrl;
      checkWebSocketConnection(serverInput.value);

      if (d.rate) {
        rateInput.value = d.rate;
        rateLabel.textContent = parseFloat(d.rate).toFixed(1) + 'x';
      }

      if (d.pitch) {
        pitchInput.value = d.pitch;
        pitchLabel.textContent = parseFloat(d.pitch).toFixed(1);
      }

      if (d.ducking !== undefined) {
        duckingInput.value = d.ducking;
        duckingLabel.textContent = d.ducking + '%';
      }
    }
  );

  // --- Lắng nghe các sự kiện thay đổi trên giao diện UI ---
  sequentialQueueBtn.onchange = (e) => {
    chrome.storage.sync.set({ sequentialQueue: e.target.checked });
  };

  langSelect.onchange = () => {
    savedLang = langSelect.value;
    chrome.storage.sync.set({ lang: savedLang });
    populateVoicesForSelectedLang();
  };

  voiceSelect.onchange = () => {
    savedVoice = voiceSelect.value;
    chrome.storage.sync.set({ voice: savedVoice });
  };

  engineSelect.onchange = () => {
    const newEngine = engineSelect.value;
    updateEngineUI(newEngine);
    chrome.storage.sync.set({ engineType: newEngine });
  };

  serverInput.onchange = () => {
    chrome.storage.sync.set({ wsServerUrl: serverInput.value.trim() });
    checkWebSocketConnection(serverInput.value.trim());
  };

  toggleBtn.onchange = () => {
    chrome.storage.sync.set({ enabled: toggleBtn.checked });
  };

  rateInput.oninput = () => {
    const newRate = parseFloat(rateInput.value);
    rateLabel.textContent = newRate.toFixed(1) + 'x';
    chrome.storage.sync.set({ rate: newRate });
  };

  pitchInput.oninput = () => {
    const newPitch = parseFloat(pitchInput.value);
    pitchLabel.textContent = newPitch.toFixed(1);
    chrome.storage.sync.set({ pitch: newPitch });
  };

  duckingInput.oninput = () => {
    const newDucking = parseInt(duckingInput.value);
    duckingLabel.textContent = newDucking + '%';
    chrome.storage.sync.set({ ducking: newDucking });
  };
});