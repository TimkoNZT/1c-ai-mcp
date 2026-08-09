/**
 * SSE Stream Parser — низкоуровневый парсинг Server-Sent Events.
 * Только чтение чанков и split по "data: ".
 * Не содержит логики обработки событий — только raw парсинг.
 */

/**
 * Создаёт SSE reader из свежего Response.
 */
export function createSSEReader(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  return {
    async read() {
      const { done, value } = await reader.read();
      if (done) return { done: true, events: [] };
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      const events = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        try { events.push(JSON.parse(trimmed.slice(6))); } catch { /* skip malformed */ }
      }
      return { done: false, events };
    },
    getState() {
      return { reader, decoder, buf };
    },
  };
}

/**
 * Создаёт SSE reader из существующего reader + decoder + buf.
 * Используется для продолжения чтения после deferred-таймаута.
 */
export function createSSEReaderFrom(reader, decoder, initialBuf) {
  let buf = initialBuf || "";

  return {
    async read() {
      const { done, value } = await reader.read();
      if (done) return { done: true, events: [] };
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      const events = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        try { events.push(JSON.parse(trimmed.slice(6))); } catch { /* skip malformed */ }
      }
      return { done: false, events };
    },
    getState() {
      return { reader, decoder, buf };
    },
  };
}
