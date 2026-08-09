import { readFileSync, writeFileSync, readdirSync, rmSync, globSync, mkdirSync, existsSync, statSync } from "fs";
import { execSync } from "child_process";
import * as path from "path";
import {
  PROJECT_ROOT, EXECUTE_BLOCKLIST, DANGEROUS_PATTERNS,
  READ_MAX_LINES, EXECUTE_OUTPUT_LINES, EXECUTE_OUTPUT_CHARS,
  EXECUTE_TIMEOUT, EXECUTE_MAX_BUFFER, SEARCH_TEXT_MAX_RESULTS,
} from "./config.js";
import { log } from "./logger.js";

/** Проверить, что путь находится в пределах разрешённой директории */
export function isPathSafe(targetPath) {
  const resolved = path.resolve(targetPath);
  if (!resolved.toLowerCase().startsWith(PROJECT_ROOT.toLowerCase())) {
    throw new Error(`Access denied: path "${resolved}" is outside project root "${PROJECT_ROOT}"`);
  }
  return resolved;
}

/** Проверить команду на опасные паттерны */
export function isCommandSafe(cmd) {
  for (const blockRx of EXECUTE_BLOCKLIST) {
    if (blockRx.test(cmd.trim())) {
      throw new Error(`Command blocked: "${cmd.slice(0, 100)}" matches dangerous pattern "${blockRx}"`);
    }
  }
  for (const p of DANGEROUS_PATTERNS) {
    if (cmd.includes(p)) {
      throw new Error(`Command blocked: piping/chaining operators not allowed ("${p}" in command)`);
    }
  }
  return true;
}

/** Выполнить локальный инструмент EDT */
export function executeLocalTool(toolName, args) {
  switch (toolName) {
    case "Read": {
      const fp = isPathSafe(args.path || args.filePath || args.file_path);
      const content = readFileSync(fp, "utf8");
      const lines = content.split("\n");
      const offset = (args.offset || 1) - 1;
      const limit = args.limit || READ_MAX_LINES;
      const selected = lines.slice(offset, offset + limit);
      return { content: selected.join("\n") + (lines.length > offset + limit ? "\n... (truncated)" : "") };
    }
    case "Write": {
      const fp = isPathSafe(args.path || args.filePath || args.file_path);
      const content = args.content;
      if (!fp || content === undefined) throw new Error("Write: path and content required");
      mkdirSync(path.dirname(fp), { recursive: true });
      writeFileSync(fp, content, "utf8");
      return { content: `Written ${content.length} chars to ${fp}` };
    }
    case "Edit": {
      const fp = isPathSafe(args.path || args.filePath || args.file_path);
      const oldStr = args.oldString ?? args.find ?? args.search;
      const newStr = args.newString ?? args.replace ?? "";
      if (!fp || oldStr === undefined) throw new Error("Edit: path and oldString required");
      const current = readFileSync(fp, "utf8");
      const updated = current.replace(oldStr, newStr);
      if (current === updated) throw new Error(`Edit: "${oldStr.slice(0, 40)}" not found in ${fp}`);
      writeFileSync(fp, updated, "utf8");
      return { content: `Edited ${fp} (${current.length} → ${updated.length} chars)` };
    }
    case "Delete": {
      const fp = isPathSafe(args.path || args.filePath || args.file_path);
      if (!fp) throw new Error("Delete: path required");
      rmSync(fp, { recursive: true, force: true });
      return { content: `Deleted ${fp}` };
    }
    case "Execute": {
      const cmd = args.command || args.cmd || args.script;
      if (!cmd) throw new Error("Execute: command required");
      isCommandSafe(cmd);
      const cwd = args.cwd || ".";
      isPathSafe(cwd);
      const result = execSync(cmd, { encoding: "utf8", timeout: EXECUTE_TIMEOUT, maxBuffer: EXECUTE_MAX_BUFFER, cwd });
      const lines = result.split("\n");
      return { content: lines.slice(0, EXECUTE_OUTPUT_LINES).join("\n") + (lines.length > EXECUTE_OUTPUT_LINES ? "\n... (truncated)" : "") };
    }
    case "Glob": {
      const pattern = args.pattern ?? args.glob ?? args.path ?? "*";
      const root = isPathSafe(args.root ?? args.cwd ?? ".");
      const files = globSync(pattern, { cwd: root });
      return { content: files.join("\n") || `No matches for "${pattern}" in ${root}` };
    }
    case "List": {
      const dir = isPathSafe(args.path ?? args.dir ?? args.directory ?? ".");
      const entries = readdirSync(dir, { withFileTypes: true });
      const lines = entries.map(e => e.isDirectory() ? `${e.name}/` : e.name);
      return { content: lines.join("\n") };
    }
    case "Find":
    case "SearchFiles": {
      const name = (args.name ?? args.pattern ?? "").toLowerCase();
      const root = isPathSafe(args.root ?? args.cwd ?? ".");
      const results = [];
      function walk(dir) {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name.startsWith(".")) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.isFile() && (!name || e.name.toLowerCase().includes(name))) results.push(full);
        }
      }
      walk(root);
      return { content: results.join("\n") || "No matches" };
    }
    case "SearchText": {
      const pattern = args.pattern ?? args.text ?? args.query ?? args.search_query ?? args.searchQuery ?? "";
      const root = isPathSafe(args.root ?? args.cwd ?? ".");
      const incRaw = args.include ?? args.file_pattern ?? args.filePattern ?? args.file_path_patterns ?? args.filePatterns;
      const filePatterns = Array.isArray(incRaw) ? incRaw : null;
      const suffixFilter = !filePatterns && incRaw ? incRaw : null;
      const firstIndex = args.first_index ?? args.firstIndex ?? 0;
      const maxCount = args.max_count ?? args.maxCount ?? SEARCH_TEXT_MAX_RESULTS;
      if (!pattern) throw new Error("SearchText: pattern required");
      const regex = new RegExp(pattern, "gi");
      const results = [];

      function searchFile(full) {
        try {
          const content = readFileSync(full, "utf8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              results.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            }
          }
        } catch { /* skip unreadable */ }
      }

      if (filePatterns) {
        for (const fp of filePatterns) {
          try {
            const norm = fp.trim().replace(/^[/\\]+/, "").replace(/[/\\]+$/, "");
            const abs = path.resolve(root, norm);
            let files;
            if (norm.includes("*") || norm.includes("?")) {
              files = globSync(norm, { cwd: root }).map(f => path.resolve(root, f));
            } else if (existsSync(abs) && statSync(abs).isFile()) {
              files = [abs];
            } else {
              files = globSync(`${norm}/**/*`, { cwd: root }).map(f => path.resolve(root, f));
            }
            for (const f of files) searchFile(f);
          } catch { /* skip invalid pattern */ }
        }
      } else {
        function walk(dir) {
          let entries;
          try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (e.name.startsWith(".") || e.name === "node_modules") continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            if (!e.isFile()) continue;
            if (suffixFilter && !e.name.endsWith(suffixFilter.replace(/^\*\.?/, ""))) continue;
            searchFile(full);
          }
        }
        walk(root);
      }
      const sliced = results.slice(firstIndex, firstIndex + maxCount);
      const total = results.length;
      return { content: sliced.join("\n") + (total > firstIndex + maxCount ? `\n... (${total - firstIndex - maxCount} more)` : "") || "No matches" };
    }
    default:
      throw new Error(`Unknown local tool: ${toolName}`);
  }
}
