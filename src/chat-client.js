import { LOCAL_TOOLS, TOOL_CONTENT_MAX_CHARS } from "./config.js";
import { randomUUID } from "crypto";
import { trace, log } from "./logger.js";
import { RetrySessionError, resetSession, addConversation, removeConversation, sleep } from "./session.js";
import { executeLocalTool } from "./tools.js";
import { createSSEReader } from "./sse-reader.js";
import {
  TRANSPORT_CAPABILITIES,
  createConversationRequest,
  setConversationTitle,
  sendUserMessageRequest,
  sendToolResultsRequest,
  deleteConversationRequest,
  ApiError,
} from "./transport.js";


/**
 * Санитизация текста: NFKC-нормализация + удаление управляющих ASCII-символов,
 * кроме табуляции, переноса строки и возврата каретки.
 */
export function sanitizeText(text) {
  return text ? text.normalize("NFKC").replace(/\\t/g, "").replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, "") : text;
}

// ── Deferred jobs (таймаут MCP + GetResult) ──
// Одно задание = один запрос к Напарнику со своим стримом, сегментами и курсором.
const JOB_TTL_MS = 30 * 60 * 1000;          // завершённые задания живут 30 минут
const JOB_ACTIVE_TIMEOUT_MS = 15 * 60 * 1000; // watchdog активного задания
const JOB_MAX = 20;

const jobs = new Map();
let lastJobId = null;

function newJobId() {
  return "req_" + randomUUID().slice(0, 8);
}

function trimJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finished && job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
  if (jobs.size > JOB_MAX) {
    const done = [...jobs.values()]
      .filter(j => j.finished)
      .sort((a, b) => a.finishedAt - b.finishedAt);
    for (const job of done) {
      if (jobs.size <= JOB_MAX) break;
      jobs.delete(job.id);
    }
  }
  if (lastJobId && !jobs.has(lastJobId)) lastJobId = null;
}

function notify(job) {
  const waiters = job.waiters.splice(0);
  for (const wake of waiters) wake();
}

export function createJob({ kind = "ask", convUuid = null, opts = {} } = {}) {
  const job = {
    id: newJobId(),
    kind,
    convUuid,
    opts,
    segments: [],
    toolCalls: [],
    cursor: 0,
    partial: "",
    partialDelivered: "",
    usage: null,
    maxContext: null,
    active: true,
    finished: false,
    error: null,
    createdAt: Date.now(),
    finishedAt: 0,
    waiters: [],
    controller: new AbortController(),
    timer: null,
  };
  job.timer = setTimeout(() => {
    if (job.finished) return;
    try { job.controller.abort(); } catch { /* ignore */ }
    finishJob(job, new ApiError("Превышено время ожидания ответа (15 мин)", { status: 0 }));
  }, JOB_ACTIVE_TIMEOUT_MS);
  if (job.timer.unref) job.timer.unref();

  jobs.set(job.id, job);
  lastJobId = job.id;
  trimJobs();
  return job;
}

export function finishJob(job, error = null) {
  if (!job || job.finished) return;
  job.error = error || null;
  job.finished = true;
  job.active = false;
  job.finishedAt = Date.now();
  if (job.timer) clearTimeout(job.timer);
  notify(job);
  trimJobs();
}

export function dropJob(job) {
  if (!job) return;
  if (job.timer) clearTimeout(job.timer);
  try { job.controller?.abort(); } catch { /* ignore */ }
  jobs.delete(job.id);
  if (lastJobId === job.id) lastJobId = null;
}

export function dropJobs(predicate) {
  for (const job of [...jobs.values()]) {
    if (predicate(job)) dropJob(job);
  }
}

export function activeJob(kind) {
  return [...jobs.values()].find(j => j.kind === kind && j.active) || null;
}

function pickJob(requestId) {
  if (requestId) return jobs.get(requestId) || null;
  const byDate = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  return (lastJobId && jobs.get(lastJobId)) || byDate[0] || null;
}

function formatK(n) {
  const v = Math.round(Number(n) || 0);
  return v >= 1000 ? `${Math.round(v / 1000)}k` : String(v);
}

function contextLine(job) {
  if (!job.opts?.showContext || !job.usage) return "";
  const used = (job.usage.prompt_tokens || 0) + (job.usage.completion_tokens || 0);
  const max = job.maxContext || 0;
  const pct = max ? ` (${Math.round((used / max) * 100)}%)` : "";
  return `📊 Контекст: ≈${formatK(used)}${max ? ` / ${formatK(max)}` : ""}${pct}`;
}

/**
 * Результат задания для GetResult.
 * Возвращает { text, finished, failed?, jobId } или null, если задания нет.
 */
export async function getJobResult({ requestId, waitSeconds = 0 } = {}) {
  const job = pickJob(requestId);
  if (!job) return null;

  const waitMs = Math.min(Math.max(Number(waitSeconds) || 0, 0), 25) * 1000;
  const deadline = Date.now() + waitMs;
  while (true) {
    const hasSegments = job.cursor < job.segments.length;
    if (hasSegments || job.finished || job.error) break;
    const left = deadline - Date.now();
    if (left <= 0) break;
    await new Promise(resolve => {
      const timer = setTimeout(resolve, left);
      job.waiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  if (job.error) {
    return { text: `❌ ${job.error.message || job.error}`, finished: true, failed: true, jobId: job.id, error: job.error };
  }

  const segments = job.segments.slice(job.cursor);
  job.cursor = job.segments.length;

  if (!segments.length) {
    if (job.finished) {
      const parts = [];
      if (job.opts?.showContext && !job.contextDelivered) {
        job.contextDelivered = true;
        const line = contextLine(job);
        if (line) parts.push(line);
      }
      if (!job.finishedNoticeDelivered) {
        job.finishedNoticeDelivered = true;
        parts.push("✅ Модель закончила ответ.");
      }
      return { text: parts.join("\n"), finished: true, jobId: job.id };
    }
    return { text: "⏳ Модель ещё думает...", finished: false, jobId: job.id };
  }

  let text = buildResult(segments, job.toolCalls.slice(), job.opts || {});
  // Часть текста уже отдавали в deferred-ответе Ask — не дублируем её.
  if (job.partialDelivered && text.startsWith(job.partialDelivered)) {
    text = text.slice(job.partialDelivered.length).trimStart();
  }
  if (!text && !job.finished) {
    return { text: "⏳ Модель ещё думает...", finished: false, jobId: job.id };
  }
  if (job.finished) {
    const tailParts = [];
    if (!job.finishedNoticeDelivered) {
      job.finishedNoticeDelivered = true;
      tailParts.push("⚠️ **Модель закончила ответ.**");
    }
    if (job.opts?.showContext && !job.contextDelivered) {
      job.contextDelivered = true;
      const line = contextLine(job);
      if (line) tailParts.push(line);
    }
    if (tailParts.length) {
      const tail = tailParts.join("\n");
      text = text ? `${text}\n\n${tail}` : tail;
    }
  }
  return { text, finished: job.finished, jobId: job.id };
}

/**
 * ChatClient — управляет конверсацией и tool ACK циклом.
 * Создаёт новый экземпляр на каждый независимый диалог.
 */
export class ChatClient {
  constructor() {
    this.convUuid = null;
    this.lastAssistantUuid = null;
  }

  restoreConv(uuid, lastAssistantUuid) {
    this.convUuid = uuid || null;
    this.lastAssistantUuid = lastAssistantUuid || null;
  }

  getConvState() {
    return this.convUuid ? { uuid: this.convUuid, lastAssistantUuid: this.lastAssistantUuid } : null;
  }

  async createConversation(skillName = "custom", title) {
    log(`  💬 askAI: создание конверсации (mode=${TRANSPORT_CAPABILITIES.mode}, skill=${skillName})...`);
    const uuid = await createConversationRequest({ skillName, title });
    this.convUuid = uuid;

    // Устанавливаем название чата
    if (title) {
      try {
        await setConversationTitle(uuid, title);
      } catch { /* ignore errors on title set */ }
    }

    // Регистрируем в кэше (на случай краша)
    addConversation({ uuid, title, skill: skillName });
    log(`  💬 askAI: конверсация ${uuid.slice(0, 8)}…`);
    return uuid;
  }

  async sendUserMessage(text, code, skillName, signal) {
    log(`  💬 askAI: отправка (parent=${this.lastAssistantUuid ? this.lastAssistantUuid.slice(0, 8) + "…" : "null"})...`);
    return await sendUserMessageRequest(this.convUuid, {
      text,
      code,
      skillName,
      parentUuid: this.lastAssistantUuid,
      signal,
    });
  }

  async sendToolAck(assistantUuid, calls, signal) {
    const entries = [];

    for (const tc of calls) {
      const name = tc.function?.name || tc.name;
      const id = tc.id || tc.tool_call_id;
      if (LOCAL_TOOLS.has(name)) {
        try {
          const args = JSON.parse(tc.function?.arguments || "{}");
          log(`  💻 локальный тул: ${name}(${JSON.stringify(args).slice(0, 100)})`);
          const result = executeLocalTool(name, args);
          const content = (result.content || "").slice(0, TOOL_CONTENT_MAX_CHARS);
          entries.push({ content, tool_call_id: id, name, status: "ok" });
        } catch (err) {
          log(`  ❌ ошибка тула ${name}: ${err.message}`);
          entries.push({ content: `Error: ${err.message}`, tool_call_id: id, name, status: "error" });
        }
      } else {
        entries.push({ content: null, tool_call_id: id, name, status: "accepted" });
      }
    }

    if (!entries.length) return null;

    const local = entries.filter(e => e.status !== "accepted");
    const server = entries.filter(e => e.status === "accepted");
    if (local.length) log(`  💬 askAI: результат локальных тулов (${local.map(e => e.name).join(", ")})`);
    if (server.length) log(`  💬 askAI: ACK серверных тулов (${server.map(e => e.name).join(", ")})`);

    return await sendToolResultsRequest(this.convUuid, { parentUuid: assistantUuid, entries, signal });
  }

  /**
   * Единый обработчик SSE-события.
   * Модифицирует ctx { segments, toolCalls, answer, reasoning, assistantUuid, pendingToolName } на месте.
   */
  processEvent(event, ctx) {
    // Ошибка может прийти отдельным SSE-пакетом при HTTP 200.
    if (event.error || event.error_type) {
      const msg = typeof event.error === "string"
        ? event.error
        : (event.error?.message || (event.error ? JSON.stringify(event.error) : "ошибка в потоке ответа"));
      throw new ApiError(`stream: ${event.error_type ? event.error_type + ": " : ""}${msg}`, {
        status: 0,
        type: event.error_type || "",
      });
    }

    // Эхо пользовательского сообщения (первый пакет) и прочие role: user не относятся к ответу.
    if (event.role === "user") return;

    if (event.uuid && event.role === "assistant") {
      ctx.assistantUuid = event.uuid;
      ctx.pendingToolName = null;
    }

    if (event.role === "tool") {
      this.flushAccumulated(ctx);
      const toolName = event.content?.name || event.render_info?.[0]?.tool_name || null;
      if (event.content?.content) {
        let text = typeof event.content.content === "string" ? event.content.content : event.content.content?.text || "";
        if (text) {
          try { const p = JSON.parse(text); if (p && typeof p.content === "string") text = p.content; } catch {}
          text = sanitizeText(text.replace(/\\n/g, "\n"));
          ctx.segments.push({ type: "tool_result", toolName: toolName || "unknown_tool", text, toolCallId: event.content?.tool_call_id || null });
        }
      } else if (toolName && event.content_delta?.content) {
        const delta = sanitizeText(event.content_delta.content.replace(/\\n/g, "\n"));
        ctx.segments.push({ type: "tool_result", toolName, text: delta, toolCallId: event.content?.tool_call_id || null });
        ctx.pendingToolName = null;
      } else {
        ctx.pendingToolName = toolName;
        ctx.pendingToolCallId = event.content?.tool_call_id || null;
      }
      return;
    }

    if (event.content_delta) {
      if (event.content_delta.content) {
        const delta = sanitizeText(event.content_delta.content.replace(/\\n/g, "\n"));
        if (ctx.pendingToolName) {
          ctx.segments.push({ type: "tool_result", toolName: ctx.pendingToolName, text: delta, toolCallId: ctx.pendingToolCallId });
          ctx.pendingToolName = null;
          ctx.pendingToolCallId = null;
        } else {
          ctx.answer += delta;
        }
      }
      if (event.content_delta.reasoning_content) {
        const delta = sanitizeText(event.content_delta.reasoning_content.replace(/\\n/g, "\n"));
        ctx.reasoning += delta;
      }
      if (event.content_delta.tool_calls?.length) {
        for (const tc of event.content_delta.tool_calls) {
          const existing = ctx.toolCalls.find(t => t.index === tc.index);
          if (existing) {
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) { existing.function = existing.function || {}; existing.function.name = tc.function.name; }
            if (tc.function?.arguments) { existing.function = existing.function || {}; existing.function.arguments = (existing.function.arguments || "") + tc.function.arguments; }
          } else {
            ctx.toolCalls.push(JSON.parse(JSON.stringify(tc)));
          }
        }
      }
    }

    if (event.finished) {
      if (event.details) {
        if (event.details.usage) ctx.usage = event.details.usage;
        if (event.details.max_context_length) ctx.maxContext = event.details.max_context_length;
      }
      if (event.content?.content && event.role !== "tool") {
        let text = typeof event.content.content === "string" ? event.content.content : event.content.content?.text || "";
        if (text) {
          text = sanitizeText(text.replace(/\\n/g, "\n"));
          // По контракту финальный content приоритетнее накопленных дельт.
          ctx.answer = text;
        }
      }
      if (ctx.reasoning) {
        ctx.segments.push({ type: "reasoning", text: ctx.reasoning });
        ctx.reasoning = "";
      }
      if (ctx.answer && ctx.toolCalls.length > 0) {
        ctx.segments.push({ type: "content", text: ctx.answer });
        ctx.answer = "";
        ctx.segments.push({ type: "boundary", finishReason: event.details?.finish_reason || null, renderInfo: event.render_info || null });
      } else {
        ctx.segments.push({ type: "boundary", finishReason: event.details?.finish_reason || null, renderInfo: event.render_info || null });
        if (ctx.answer) {
          ctx.segments.push({ type: "content", text: ctx.answer });
          ctx.answer = "";
        }
      }
    }
  }

  flushAccumulated(ctx) {
    if (ctx.reasoning || ctx.answer) {
      if (ctx.reasoning) ctx.segments.push({ type: "reasoning", text: ctx.reasoning });
      ctx.segments.push({ type: "content", text: ctx.answer });
      ctx.reasoning = "";
      ctx.answer = "";
    }
  }

  /**
   * Фоновый цикл чтения SSE: читает стрим, обрабатывает события,
   * самостоятельно отправляет tool ACK.
   * Всё накопленное пишет в своё задание (job), а не в глобальное состояние.
   */
  async bgLoop(job, response) {
    let currentRes = response;
    let assistantUuid = null;

    try {
      while (true) {
        const reader = createSSEReader(currentRes);
        const ctx = {
          segments: [], toolCalls: [], answer: "", reasoning: "",
          assistantUuid: null, pendingToolName: null, pendingToolCallId: null,
          usage: null, maxContext: null,
        };

        while (true) {
          const { done, events } = await reader.read();
          if (done) break;
          for (const event of events) {
            trace("sse_event", event);
            this.processEvent(event, ctx);
            for (const seg of ctx.segments) job.segments.push(seg);
            ctx.segments = [];
            if (ctx.usage) job.usage = ctx.usage;
            if (ctx.maxContext) job.maxContext = ctx.maxContext;
            job.partial = ctx.answer;
            notify(job);
          }
        }

        this.flushAccumulated(ctx);
        for (const seg of ctx.segments) job.segments.push(seg);
        ctx.segments = [];
        job.partial = "";
        if (ctx.usage) job.usage = ctx.usage;
        if (ctx.maxContext) job.maxContext = ctx.maxContext;

        if (ctx.assistantUuid) {
          assistantUuid = ctx.assistantUuid;
          this.lastAssistantUuid = assistantUuid;
        }

        for (const tc of ctx.toolCalls) {
          job.toolCalls.push({
            id: tc.id || tc.tool_call_id,
            name: tc.function?.name || tc.name || "?",
            args: (() => { try { return JSON.stringify(JSON.parse(tc.function?.arguments || "{}")); } catch { return tc.function?.arguments || ""; } })(),
          });
        }

        if (ctx.toolCalls.length > 0) {
          trace("tool_ack_loop", { toolCallsCount: ctx.toolCalls.length, assistantUuid: (assistantUuid || this.lastAssistantUuid)?.slice(0, 8) });
          currentRes = await this.sendToolAck(assistantUuid || this.lastAssistantUuid, ctx.toolCalls, job.controller?.signal);
          if (!currentRes?.body) { finishJob(job); break; }
          continue;
        }

        finishJob(job);
        trace("all_segments", job.segments);
        return;
      }
    } catch (err) {
      log(`  ⚠️ bgLoop error: ${err.message || err}`);
      finishJob(job, err);
    }
  }

  /**
   * Полный цикл чата: conv → message → bgLoop → результат.
   * bgLoop запускается в фоне; при deferredMs > 0 ask ждёт не дольше таймаута,
   * затем возвращает накопленное (deferred). bgLoop продолжает читать SSE
   * и отправлять tool ACK в фоне — GetResult забирает новые сегменты.
   */
  async ask(question, code, opts = {}) {
    const deferredMs = opts.deferredMs || 0;
    const showReasoning = opts.showReasoning ?? false;
    const showToolLog = opts.showToolLog ?? false;
    const jobOpts = { showReasoning, showToolLog, stripMarkdown: true, showContext: opts.showContext ?? false };

    for (let attempt = 0; attempt < 2; attempt++) {
      let job = null;
      try {
        if (opts.freshConv || !this.convUuid) {
          if (this.convUuid && opts.freshConv) {
            await this.deleteConversation().catch(() => {});
            this.convUuid = null; this.lastAssistantUuid = null;
          }
          await this.createConversation(opts.skillName || "custom", opts.title);
        } else {
          log(`  💬 askAI: конверсация ${this.convUuid.slice(0, 8)}… (существующая)`);
        }

        job = createJob({ kind: opts.kind || "ask", convUuid: this.convUuid, opts: jobOpts });
        let res;
        try {
          res = await this.sendUserMessage(question, code, opts.skillName, job.controller.signal);
        } catch (err) {
          finishJob(job, err);
          throw err;
        }

        const bgPromise = this.bgLoop(job, res);
        if (opts.freshConv) {
          bgPromise.finally(() => {
            if (this.convUuid) return this.deleteConversation().catch(() => {});
          });
        }

        let wasDeferred = false;
        if (deferredMs > 0) {
          const winner = await Promise.race([
            bgPromise.then(() => "bg"),
            sleep(deferredMs).then(() => "timeout"),
          ]);
          wasDeferred = (winner === "timeout");
        } else {
          await bgPromise;
        }

        if (job.error) {
          if (job.error instanceof RetrySessionError || job.error.retrySession || job.error.conversationGone || job.error.status === 404) {
            throw job.error;
          }
          if (!wasDeferred) throw job.error;
        }

        if (wasDeferred) {
          const segText = buildResult(job.segments, job.toolCalls.slice(), jobOpts);
          // Сегменты уже отданы в deferred-ответе — сдвигаем курсор.
          job.cursor = job.segments.length;
          const partial = job.partial ? `🤖 ${job.partial}` : "";
          job.partialDelivered = partial;
          const text = [segText, partial].filter(Boolean).join("\n\n") || "⏳ Модель ещё думает...";
          log(`  💬 askAI: deferred ${job.id} (${text.length} символов)`);
          trace("askAI_deferred", { jobId: job.id, length: text.length });
          return { text, deferred: true, jobId: job.id };
        }

        let result = buildResult(job.segments, job.toolCalls.slice(), jobOpts);
        if (!result) {
          if (job.toolCalls.length > 0) {
            result = "⚠️ Модель исчерпала лимит итераций инструментов. Финальный ответ не получен.\n"
              + (showToolLog ? `🔧 Использованы инструменты: ${[...new Set(job.toolCalls.map(t => t.name))].join(", ")}\n` : "");
          } else {
            throw new Error("AI не вернул текстовый ответ");
          }
        }

        const ctxLine = contextLine(job);
        if (ctxLine) result += `\n\n${ctxLine}`;

        // Ответ уже отдан целиком — помечаем задание прочитанным.
        job.cursor = job.segments.length;
        job.finishedNoticeDelivered = true;
        job.contextDelivered = true;

        log(`  💬 askAI: ответ (${result.length} символов, ${job.id})`);
        trace("askAI_result", { jobId: job.id, length: result.length, answerPreview: result.slice(0, 500), toolCalls: job.toolCalls.map(t => t.name) });
        return { text: result, deferred: false, jobId: job.id };
      } catch (err) {
        if (job && attempt === 0) dropJob(job);
        if (attempt === 0) {
          if (err instanceof RetrySessionError || err.retrySession) {
            log(`  🔄 Пересоздание сессии (попытка 2)...`);
            resetSession();
            this.convUuid = null;
            this.lastAssistantUuid = null;
            continue;
          }
          if (err.conversationGone || err.status === 404) {
            log(`  🔄 Диалог не найден, создаю новый (попытка 2)...`);
            this.convUuid = null;
            this.lastAssistantUuid = null;
            continue;
          }
        }
        throw err;
      }
    }
  }

  async deleteConversation() {
    if (!this.convUuid) return;
    const uuid = this.convUuid;
    this.convUuid = null;
    removeConversation(uuid);
    await deleteConversationRequest(uuid);
  }
}

/**
 * Форматирует финальный ответ из массива сегментов.
 * tool_result — не показываем (эхо тула)
 * content — основной ответ модели
 * boundary — граница, влияет на layout
 * reasoning — показываем/скрываем по showReasoning
 */
function cleanToolText(text) {
  return text
    .replace(/&nbsp;?/gi, "")
    .replace(/Выполнить\s+\*{1,3}[^*]+\*{1,3}:\s*/g, "")
    .replace(/- _?Ищем_?:\s*/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function formatToolEntry(name, requestText, responseText, details, { stripMarkdown, TOOL_ICONS, TOOL_LABELS, SEARCH_BASE }) {
  const label = TOOL_LABELS[name] || name.replace(/^mcp__[^_]+__/, "");
  const icon = TOOL_ICONS[name] || "🛠️";
  let line = `${icon} **${label}**`;
  if (requestText) {
    let text = cleanToolText(requestText);
    if (stripMarkdown) text = text.replace(/\*\*/g, "");
    line += `: ${text}`;
  }
  if (responseText) {
    let text = cleanToolText(responseText);
    if (stripMarkdown) text = text.replace(/\*\*/g, "");
    line += ` → ${text}`;
  }
  if (details?.response_details?.length) {
    const searchBase = SEARCH_BASE[name];
    const docs = details.response_details.map(d => {
      if (d.includes("](")) return d;
      if (searchBase) return `[${d}](${searchBase}${d})`;
      return d;
    });
    line += `\n  - ${docs.join("\n  - ")}`;
  }
  return line;
}

function buildResult(allSegments, toolCalls, { showReasoning, showToolLog, stripMarkdown = false }) {
  const segmentParts = [];

  const TOOL_ICONS = {
    "Read": "📄",
    "Write": "📝",
    "Edit": "📝",
    "Delete": "🗑️",
    "Execute": "⚡",
    "Glob": "🧩",
    "List": "📂",
    "SearchFiles": "🔎",
    "SearchText": "📜",
    "Find": "🔎",
    "mcp__knowledge-hub__Search_Documentation": "📖",
    "mcp__knowledge-hub__Search_ITS": "🔍",
    "mcp__knowledge-hub__Fetch_ITS": "📥",
    "mcp__knowledge-hub__Diff_Documentation_Versions": "🔄",
    "mcp__syntax-checker__validate": "✅",
    "mcp__web__fetch": "🌐",
    "FindRelated_in_Project": "🔗",
    "GetObject_in_Project": "🎯",
    "FindSimilar_in_Project": "👥",
    "Task": "📋",
  };
  const TOOL_LABELS = {
    "mcp__knowledge-hub__Search_Documentation": "Поиск в документации",
    "mcp__knowledge-hub__Search_ITS": "Поиск в ИТС",
    "mcp__knowledge-hub__Fetch_ITS": "Загрузка ИТС",
    "mcp__knowledge-hub__Diff_Documentation_Versions": "Сравнение версий документации",
    "mcp__syntax-checker__validate": "Проверка синтаксиса",
    "FindRelated_in_Project": "Поиск связанного кода",
    "GetObject_in_Project": "Получение объекта метаданных",
    "FindSimilar_in_Project": "Поиск похожего кода",
  };
  const SEARCH_BASE = {
    "mcp__knowledge-hub__Search_Documentation": "https://code.1c.ai/doc/search?q=",
  };
  const fmtOpts = { stripMarkdown, TOOL_ICONS, TOOL_LABELS, SEARCH_BASE };

  // Pass 1: collect tool info from boundaries + tool results by call_id
  const callArgs = new Map();
  for (const tc of toolCalls || []) {
    if (tc.id) callArgs.set(tc.id, tc.args);
  }
  const calls = new Map();
  const toolLastIdx = new Map();
  const toolResultsByCallId = new Map();
  const rawToolBuffer = new Map();

  for (let i = 0; i < allSegments.length; i++) {
    const seg = allSegments[i];
    if (seg.type === "boundary" && seg.renderInfo) {
      for (const r of seg.renderInfo) {
        const id = r.tool_call_id;
        if (!id) continue;
        if (!calls.has(id)) calls.set(id, { name: r.tool_name, request: null, response: null, details: null });
        const entry = calls.get(id);
        if (callArgs.has(id)) entry.request = callArgs.get(id);
        else if (r.request_markdown && !entry.request) entry.request = r.request_markdown;
        if (r.response_markdown && !entry.response) entry.response = r.response_markdown;
        if (r.details) entry.details = r.details;
        toolLastIdx.set(id, i);
      }
    }
    if (seg.type === "tool_result") {
      if (seg.toolCallId) {
        if (!toolResultsByCallId.has(seg.toolCallId)) toolResultsByCallId.set(seg.toolCallId, []);
        toolResultsByCallId.get(seg.toolCallId).push(seg.text);
      } else {
        const key = seg.toolName || "__unknown";
        if (!rawToolBuffer.has(key)) rawToolBuffer.set(key, []);
        rawToolBuffer.get(key).push(seg.text);
      }
    }
  }

  // Pass 2: build output
  for (let i = 0; i < allSegments.length; i++) {
    const seg = allSegments[i];
    switch (seg.type) {
      case "content":
        if (seg.text) {
          const prevRaw = i > 0 ? allSegments[i - 1] : null;
          if (prevRaw?.type === "content" && segmentParts.length > 0) {
            segmentParts[segmentParts.length - 1] += seg.text;
          } else {
            segmentParts.push(`🤖 ${seg.text}`);
          }
        }
        break;
      case "reasoning":
        if (showReasoning && seg.text) {
          const arr = seg.text.split("\n");
          const formatted = arr.map((l, i) => i === 0 ? `> 💭 ${l}` : `> ${l}`).join("\n");
          segmentParts.push(formatted);
        }
        break;
      case "boundary":
        if (seg.renderInfo) {
          for (const r of seg.renderInfo) {
            const id = r.tool_call_id;
            if (!id) continue;
            if (toolLastIdx.get(id) !== i) continue;
            const name = r.tool_name;
            if (name === "mcp__knowledge-hub__Fetch_ITS" || name === "TodoWrite" || name === "Skill" || name === "NoCall") continue;
            const entry = calls.get(id);
            if (!entry) continue;
            if (showToolLog) {
              segmentParts.push(formatToolEntry(name, entry.request, entry.response, entry.details, fmtOpts));
              if (toolResultsByCallId.has(id)) {
                for (const t of toolResultsByCallId.get(id)) segmentParts.push(`🔧 ${t}`);
              }
              if (rawToolBuffer.has(name)) {
                for (const t of rawToolBuffer.get(name)) segmentParts.push(`🔧 ${t}`);
                rawToolBuffer.delete(name);
              }
            } else {
              segmentParts.push(formatToolEntry(name, entry.request, null, null, fmtOpts));
            }
          }
        }
        break;
    }
  }

  // В public API нет render_info — показываем хотя бы имена и аргументы вызванных тулов.
  if (showToolLog && calls.size === 0 && toolCalls?.length) {
    segmentParts.push(toolCalls.map(tc =>
      `🛠️ **${tc.name}**${tc.args ? `: ${String(tc.args).slice(0, 300)}` : ""}`
    ).join("\n"));
  }

  if (showToolLog) {
    for (const texts of rawToolBuffer.values()) {
      for (const t of texts) segmentParts.push(`🔧 ${t}`);
    }
  }

  return segmentParts.join("\n\n") || "";
}
