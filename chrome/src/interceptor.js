// interceptor.js - Bắt chặn mọi định dạng phụ đề YouTube (JSON & XML)
(function () {
  console.log("🟢 [YT TTS Interceptor] Script đã khởi chạy trong Main World.");

  function parseAndSendSubtitles(responseText) {
    if (!responseText) return;

    let parsedEvents = [];

    // 1. Thử Parse theo định dạng JSON (fmt=json3)
    try {
      const data = JSON.parse(responseText);
      if (data && data.events) {
        parsedEvents = data.events
          .filter(e => e.segs)
          .map(e => ({
            start: e.tStartMs,
            text: e.segs.map(s => s.utf8).join('').trim()
          }))
          .filter(e => e.text.length > 0);
      }
    } catch (e) {
      // 2. Nếu không phải JSON, thử Parse theo định dạng XML (TimedText)
      try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(responseText, "text/xml");
        const textNodes = xmlDoc.getElementsByTagName("text");

        if (textNodes && textNodes.length > 0) {
          for (let i = 0; i < textNodes.length; i++) {
            const node = textNodes[i];
            const startMs = parseFloat(node.getAttribute("start") || 0) * 1000;
            const text = node.textContent.trim();
            if (text) {
              parsedEvents.push({ start: startMs, text: text });
            }
          }
        }
      } catch (xmlErr) {
        // Không phải file sub hợp lệ
      }
    }

    if (parsedEvents.length > 0) {
      console.log(`⚡ [YT TTS Interceptor] Đã bóc tách thành công ${parsedEvents.length} câu phụ đề.`);
      window.postMessage({ type: 'YT_SUBTITLES_LOADED', data: parsedEvents }, '*');
    }
  }

  // Intercept XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (url && typeof url === 'string' && url.includes('/api/timedtext')) {
      this.addEventListener('load', function () {
        parseAndSendSubtitles(this.responseText);
      });
    }
    return origOpen.apply(this, arguments);
  };

  // Intercept Fetch API
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await origFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
    if (url && typeof url === 'string' && url.includes('/api/timedtext')) {
      try {
        const clone = response.clone();
        const text = await clone.text();
        parseAndSendSubtitles(text);
      } catch (e) {}
    }
    return response;
  };
})();