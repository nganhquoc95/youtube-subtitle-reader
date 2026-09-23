// src/interceptor.js - Interceptor bắt chặn & tối ưu Subtitle Track (bao gồm Sub tự động)
(function () {
  console.log("🟢 [TTS Interceptor] Đã nạp script bắt chặn phụ đề.");

  // Bắt chặn Fetch API
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = args[0] ? (typeof args[0] === 'string' ? args[0] : args[0].url) : '';

    if (url && url.includes('/api/timedtext')) {
      try {
        const clone = response.clone();
        const data = await clone.json();

        // Phân tích và gộp sub tự động
        const parsedSubtitles = parseAndMergeSubtitles(data);

        if (parsedSubtitles.length > 0) {
          window.postMessage({
            type: 'YT_SUBTITLES_LOADED',
            data: parsedSubtitles
          }, '*');
        }
      } catch (err) {
        console.error("❌ [TTS Interceptor] Lỗi xử lý JSON phụ đề:", err);
      }
    }
    return response;
  };

  // Bắt chặn XMLHttpRequest (Dự phòng cho một số phiên bản YouTube cũ/nhúng)
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.addEventListener('load', function () {
      if (url && url.includes('/api/timedtext')) {
        try {
          const data = JSON.parse(this.responseText);
          const parsedSubtitles = parseAndMergeSubtitles(data);

          if (parsedSubtitles.length > 0) {
            window.postMessage({
              type: 'YT_SUBTITLES_LOADED',
              data: parsedSubtitles
            }, '*');
          }
        } catch (err) { }
      }
    });
    return originalXhrOpen.apply(this, arguments);
  };

  // --- HÀM THUẬT TOÁN GỘP PHỤ ĐỀ TỰ ĐỘNG ---
  function parseAndMergeSubtitles(json) {
    if (!json || !json.events) return [];

    // Ngưỡng gộp:
    // MAX_GAP_MS: Khoảng thời gian tối đa giữa 2 event để gộp (tăng lên 1200ms)
    // MIN_CHAR_LENGTH: Một câu hoàn chỉnh nên có ít nhất khoảng 60-80 ký tự (trừ khi ngắt nghỉ quá lâu)
    const MAX_GAP_MS = 500;

    let rawList = [];

    // BƯỚC 1: Thu thập và gom tất cả segs thô của từng Event
    for (const event of json.events) {
      if (!event.segs || event.segs.length === 0) continue;

      let text = event.segs
        .map(seg => seg.utf8 || '')
        .join('')
        .replace(/\n/g, ' ');

      text = cleanText(text);

      if (!text || text === '♪') continue;

      const start = event.tStartMs;
      const duration = event.dDurationMs || 0;

      rawList.push({ start, end: start + duration, text });
    }

    if (rawList.length === 0) return [];

    // BƯỚC 2: Xử lý Lặp từ / Overlap và Gộp câu dài
    let mergedList = [];
    let currentItem = null;

    for (let i = 0; i < rawList.length; i++) {
      const item = rawList[i];

      if (!currentItem) {
        currentItem = { ...item };
        continue;
      }

      const timeGap = item.start - currentItem.end;

      // Kiểm tra xem câu mới có bị lặp lại phần cuối của câu cũ không (Cơ chế Rolling Sub của YT)
      const overlapIndex = findOverlapIndex(currentItem.text, item.text);
      let addedText = item.text;

      if (overlapIndex > -1) {
        // Nếu có lặp, chỉ lấy phần chữ mới nối thêm vào
        addedText = item.text.substring(overlapIndex).trim();
      }

      // Nếu không có chữ mới được thêm vào (chỉ là event duplicate mốc thời gian), bỏ qua
      if (!addedText) {
        currentItem.end = Math.max(currentItem.end, item.end);
        continue;
      }

      // Điều kiện gộp câu:
      // 1. Khoảng cách thời gian nhỏ hơn MAX_GAP_MS
      const hasEndingPunctuation = /[.!?]$/.test(currentItem.text);

      if (timeGap <= MAX_GAP_MS && !hasEndingPunctuation) {
        // Gộp câu
        currentItem.text = (currentItem.text + ' ' + addedText).replace(/\s+/g, ' ').trim();
        currentItem.end = Math.max(currentItem.end, item.end);
      } else {
        // Đủ điều kiện ngắt câu -> Đẩy câu cũ vào danh sách
        currentItem.text = cleanText(currentItem.text);
        mergedList.push(currentItem);

        // Tạo câu mới
        currentItem = { ...item, text: addedText || item.text };
      }
    }

    // Đẩy câu cuối cùng vào danh sách
    if (currentItem) {
      currentItem.text = cleanText(currentItem.text);
      mergedList.push(currentItem);
    }

    console.log(`✅ [TTS Interceptor] Đã khử trùng & gộp từ ${rawList.length} event thô -> ${mergedList.length} câu chuẩn.`);
    return mergedList;
  }

  // Hàm hỗ trợ tìm phần chữ bị lặp gối đầu giữa 2 đoạn sub
  function findOverlapIndex(prevText, nextText) {
    const prevWords = prevText.toLowerCase().split(' ');
    const nextWords = nextText.toLowerCase().split(' ');

    // So sánh từ 1 đến 5 từ cuối của prevText xem có khớp với đầu nextText không
    for (let len = Math.min(prevWords.length, 5); len > 0; len--) {
      const prevTail = prevWords.slice(-len).join(' ');
      const nextHead = nextWords.slice(0, len).join(' ');

      if (prevTail === nextHead) {
        // Tìm thấy vị trí trùng lặp trong nextText
        let charCount = 0;
        for (let i = 0; i < len; i++) {
          charCount += nextWords[i].length + 1;
        }
        return charCount;
      }
    }
    return -1;
  }

  function cleanText(str) {
    if (!str) return '';

    return str
      .replace(/\[.*?\]|\(.*?\)/g, '') // Xóa các chú thích trong [] và ()
      .replace(/\s+/g, ' ')           // Thu gọn nhiều khoảng trắng thành 1
      .trim();                         // Xóa khoảng trắng 2 đầu
  }
})();