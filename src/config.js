import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CWD = process.cwd();

// ── Parse CLI args ──
const args = process.argv.slice(2);
const isMcpMode = args.includes("--mcp");

// ── Token ──
const TOKEN_ENV_VAR = "AI_TOKEN";
const TOKEN_ARG = "--token";
let token = process.env[TOKEN_ENV_VAR];
const tokenIdx = args.findIndex(a => a.startsWith(TOKEN_ARG));
if (tokenIdx >= 0) {
  const val = args[tokenIdx];
  token = val.includes("=") ? val.split("=")[1] : args[tokenIdx + 1];
}

export function setToken(t) { token = t; }

// ── Flags ──
const globalFullLog = args.includes("--full-log")
  || process.env.AI_FULL_LOG === "1"
  || process.env.AI_FULL_LOG === "true";

// ── IDs & paths ──
const BASE_URL = "https://code.1c.ai";
const UNIQUE_ID = createHash("md5").update(randomUUID()).digest("hex");
const PLUGIN_VERSION = "1.0.5.v202607161518";
const EDT_VERSION = "2026.2.0";
const PLATFORM_VERSION = "8.3.27";
const SESSION_FILE = process.env.AI_SESSION_FILE || path.join(__dirname, ".session-cache.json");
const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const TRACE_LOG = process.env.AI_TRACE_LOG || path.join(__dirname, `proxy_trace_${TS}.log`);
const PROJECT_ROOT = process.env.AI_PROJECT_ROOT
  ? path.resolve(process.env.AI_PROJECT_ROOT)
  : process.cwd();

// ── Timeouts ──
const EXECUTE_TIMEOUT = 30000;
const EXECUTE_MAX_BUFFER = 1_000_000;

// ── Limits ──
const READ_MAX_LINES = 5000;
const EXECUTE_OUTPUT_LINES = 1000;
const EXECUTE_OUTPUT_CHARS = 50000;
const TOOL_CONTENT_MAX_CHARS = 10000;
const SEARCH_TEXT_MAX_RESULTS = 500;
// ── Security ──
const EXECUTE_BLOCKLIST = [
  /^rm\b/i, /^del\b/i, /^rd\b/i, /^rmdir\b/i, /^format\b/i,
  /^shutdown\b/i, /^reg\b/i, /^attrib\b/i, /^cacls\b/i, /^icacls\b/i,
  /^takeown\b/i, /^diskpart\b/i, /^diskcomp\b/i, /^diskcopy\b/i,
  /^fdisk\b/i, /^mkfs\b/i, /^dd\b/i, /^sudo\b/i,
  /^chmod\b/i, /^chown\b/i, /^mv\s+\/|move\s+\//i,
];

const DANGEROUS_PATTERNS = ["&&", "|", ";", "`", "$(", ">", "2>"];

// ── Configuration parameters (маркер EDT-проекта для сервера) ──
function buildConfigurationParameters() {
  return {
    name: "УправлениеТорговлей",
    type: "Configuration",
    script_language: "ru",
    version: "3.0.1.123",
    platform_version: PLATFORM_VERSION,
    available_platform_versions: ["8.3.23", "8.3.24", "8.3.25", "8.3.26", "8.3.27"],
    vendor: "1С",
    compatibility: "8.3.27",
    comment: "",
    brief_information: {},
    parent_project: null,
  };
}

// ── Tool definitions ──

const EDT_TOOLS = [
  {
    name: "Ask",
    description: "Задать произвольный вопрос AI-ассистенту (1C:Напарник) по разработке на платформе 1С:Предприятие. ВНУТРЕННИЕ ИНСТРУМЕНТЫ: server-side тулы (mcp__knowledge-hub__Search_Documentation, mcp__knowledge-hub__Search_ITS, mcp__knowledge-hub__Fetch_ITS, mcp__syntax-checker__validate, mcp__web__fetch, FindRelated_in_Project, GetObject_in_Project, FindSimilar_in_Project, Task, TodoWrite) и локальные инструменты (Read, Write, Edit, Glob, SearchText). ФАКТИЧЕСКИ ЯВЛЯЕТСЯ СУБАГЕНТОМ: может самостоятельно декомпозировать задачу, выполнять многошаговые сценарии — проанализировать код через Read+SearchText, найти баг, найти документацию, исправить через Write/Edit, написать новый модуль, запустить тесты, закоммитить результат. Параметры: question (обязательный), code, showReasoning, showToolLog.",
    inputSchema: {
      type: "object",
       properties: {
          question: { type: "string", description: "Вопрос к AI-ассистенту" },
          resetChat: { type: "boolean", description: "Сбросить диалог перед вопросом (очистить историю, начать новый чат)." },
          showReasoning: { type: "boolean", description: "Показать блок рассуждений модели (💭)." },
          showToolLog: { type: "boolean", description: "Показать список вызванных server-side тулов (🧰)." },
          code: { type: "string", description: "Код на 1С для анализа/исправления." },
        },
      required: ["question"],
    },
  },
  {
    name: "ReviewCode",
    description: "Проверить код на ошибки, проблемы производительности, нарушения стандартов. Анализирует код и возвращает список замечаний с рекомендациями. Параметры: code, showReasoning, showToolLog.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Код 1С для анализа." },
        showReasoning: { type: "boolean", description: "Показать блок рассуждений модели" },
        showToolLog: { type: "boolean", default: true, description: "Показать список вызванных server-side тулов" },
      },
    },
  },
  {
    name: "FixCode",
    description: "Исправить ошибки в коде. Анализирует проблему и возвращает исправленный код. Параметры: code, showReasoning, showToolLog.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Код 1С для исправления." },
        showReasoning: { type: "boolean", description: "Показать блок рассуждений модели" },
        showToolLog: { type: "boolean", default: true, description: "Показать список вызванных server-side тулов" },
      },
    },
  },
  {
    name: "ExplainCode",
    description: "Объяснить назначение и логику кода простым языком. Параметры: code, showReasoning, showToolLog.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Код 1С для анализа." },
        showReasoning: { type: "boolean", description: "Показать блок рассуждений модели" },
        showToolLog: { type: "boolean", default: true, description: "Показать список вызванных server-side тулов" },
      },
    },
  },
  // {
  //   name: "NewChat",
  //   description: "Создать новый чат (очищает историю разговора). Следующий вызов Ask начнёт новый диалог с чистого листа. Полезно если модель перестала видеть доступные инструменты или зациклилась. Заменён параметром reset у Ask.",
  //   inputSchema: {
  //     type: "object",
  //     properties: {},
  //     required: [],
  //   },
  // },
  {
    name: "GetResult",
    description: "Получить продолжение ответа модели, если вызов инструмента (Ask, ReviewCode, FixCode, ExplainCode) не уложился в 30с и вернул сообщение 'Модель не закончила вывод за 30с'. Без параметров. Вызывать повторно пока модель не закончит.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

const LOCAL_TOOLS = new Set([
  "Read", "Write", "Edit", "Glob", "SearchText",
]);

const LOCAL_TOOL_DEFS = [
  { name: "Read", description: "Read file contents from disk. Specify the absolute path.", parameters: { type: "object", properties: { filePath: { type: "string", description: "Absolute path to the file" }, path: { type: "string", description: "Absolute path" }, offset: { type: "number", description: "Start line (1-indexed)", default: 1 }, limit: { type: "number", description: "Max lines" } }, required: ["filePath"] } },
  { name: "Write", description: "Create or overwrite a file with content.", parameters: { type: "object", properties: { filePath: { type: "string", description: "Absolute path" }, path: { type: "string", description: "Absolute path" }, content: { type: "string", description: "Content to write" } }, required: ["filePath", "content"] } },
  { name: "Edit", description: "Modify a file by replacing text. Provide path, find, replace.", parameters: { type: "object", properties: { filePath: { type: "string", description: "Absolute path" }, path: { type: "string" }, find: { type: "string", description: "Text to find" }, replace: { type: "string", description: "Replacement text" } }, required: ["filePath", "find"] } },
  { name: "Glob", description: "Find files using glob patterns. Supports **, *, ? wildcards.", parameters: { type: "object", properties: { pattern: { type: "string", description: "Glob pattern (e.g. **/*.js)" }, glob: { type: "string" }, root: { type: "string", description: "Root directory" }, cwd: { type: "string" } }, required: ["pattern"] } },
  { name: "SearchText", description: "Search file contents using plain text or regex. Returns matches with line numbers.", parameters: { type: "object", properties: { search_query: { type: "string", description: "Text to search for" }, pattern: { type: "string", description: "Regex pattern (alternative to search_query)" }, file_path_patterns: { type: "array", items: { type: "string" }, description: "Glob patterns to filter which files to search" }, first_index: { type: "number", description: "Index of first result (0-based)" }, max_count: { type: "number", description: "Maximum number of results to return" }, root: { type: "string", description: "Root directory" }, cwd: { type: "string" } }, required: ["search_query"] } },
];

// Серверные тулы (встроены в модель, не требуют content.tools)
const SERVER_TOOLS = new Set([
  "mcp__knowledge-hub__Search_Documentation", "mcp__knowledge-hub__Search_ITS",
  "mcp__knowledge-hub__Fetch_ITS", "mcp__knowledge-hub__Diff_Documentation_Versions",
  "mcp__syntax-checker__validate", "mcp__web__fetch",
  "Task", "TodoWrite",
]);

// Маппинг EDT → opencode удалён: HTTP-режим не поддерживается (MCP only)

export {
  isMcpMode, token, TOKEN_ENV_VAR, TOKEN_ARG,
  BASE_URL, UNIQUE_ID, SESSION_FILE, TRACE_LOG, PROJECT_ROOT,
  PLUGIN_VERSION, EDT_VERSION, PLATFORM_VERSION, buildConfigurationParameters,
  globalFullLog,
  EXECUTE_TIMEOUT, EXECUTE_MAX_BUFFER,
  READ_MAX_LINES, EXECUTE_OUTPUT_LINES, EXECUTE_OUTPUT_CHARS,
  TOOL_CONTENT_MAX_CHARS, SEARCH_TEXT_MAX_RESULTS,
  EXECUTE_BLOCKLIST, DANGEROUS_PATTERNS,
  EDT_TOOLS, LOCAL_TOOLS, LOCAL_TOOL_DEFS, SERVER_TOOLS,
};
