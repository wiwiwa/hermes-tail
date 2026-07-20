#!/usr/bin/env -S npx tsx
/**
 * hermes-tail — Tails Hermes chat history in near real-time.
 *
 * Usage:
 *   npx tsx this-file.ts
 *   npx tsx this-file.ts --db /path/to/state.db
 *   deno run -A https://your.host/hermes-tail.ts
 *
 * Zero dependencies. Works on Node (via tsx) and Deno.
 *
 * DB discovery order:
 *   1. --db <path> CLI flag
 *   2. $HERMES_HOME/state.db  (Hermes standard env var)
 *   3. $HOME/.hermes/state.db
 */

// ── Runtime detection ────────────────────────────────────────────────────────
const isDeno = typeof Deno !== "undefined";
const isNode = !isDeno && typeof process !== "undefined" && process.versions?.node;

function getEnv(key: string): string {
  if (isDeno) return (Deno.env.get(key) ?? "");
  return (process.env[key] ?? "");
}

const POLL_INTERVAL_MS = 3000;

function resolveDbPath(): string {
  // 1. --db flag
  const rawArgs = isDeno ? Deno.args : process.argv.slice(2);
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--db" && rawArgs[i + 1]) return rawArgs[i + 1];
  }
  // 2. $HERMES_HOME
  const hh = getEnv("HERMES_HOME");
  if (hh) return `${hh}/state.db`;
  // 3. $HOME/.hermes/state.db
  const home = getEnv("HOME");
  if (home) return `${home}/.hermes/state.db`;
  // 4. desperate fallback
  return "/root/.hermes/state.db";
}

// ── Platform abstraction ─────────────────────────────────────────────────────
const DB_PATH = resolveDbPath();

function exec(cmd: string): string {
  if (isDeno) {
    const proc = new Deno.Command("bash", {
      args: ["-c", cmd],
      stdout: "piped",
      stderr: "null",
    });
    const out = proc.outputSync();
    return new TextDecoder().decode(out.stdout);
  }
  const { execSync } = require("child_process") as typeof import("child_process");
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] });
}

function sqlRows(query: string): any[] {
  const safe = query.replace(/"/g, '\\"');
  const raw = exec(`sqlite3 -json "${DB_PATH}" "${safe}"`).trim();
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function isTTY(): boolean {
  if (isDeno) {
    try { return Deno.isatty?.(Deno.stdin.rid) ?? false; } catch { return false; }
  }
  return process.stdin.isTTY ?? false;
}

// ── ANSI colors ──────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[38;2;76;175;80m",
  blue: "\x1b[38;2;66;165;245m",
  yellow: "\x1b[38;2;255;235;59m",
  gray: "\x1b[38;2;158;158;158m",
  red: "\x1b[38;2;239;83;80m",
  cyan: "\x1b[38;2;0;229;255m",
};

function color(code: string, text: string, bold = false): string {
  return `${bold ? C.bold : ""}${code}${text}${C.reset}`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function truncate(text: string, max: number): string {
  if (!text || text.length <= max) return text ?? "";
  return text.slice(0, max) + "…";
}

function escapeNewlines(text: string): string {
  if (!text) return "";
  return text.replace(/\n/g, " ↵ ").replace(/\r/g, "");
}

function formatArgs(toolName: string, toolCallsJson: string): string {
  try {
    const calls = JSON.parse(toolCallsJson);
    const parts: string[] = [];
    for (const tc of calls) {
      const name = tc.function?.name ?? "?";
      if (name !== toolName) continue; // skip mismatched — shouldn't happen
      const raw = tc.function?.arguments;
      if (!raw) { parts.push("(no args)"); continue; }
      const args = typeof raw === "string" ? JSON.parse(raw) : raw;
      const primary = primaryArg(name, args);
      parts.push(primary ?? "(no args)");
    }
    return parts.join(", ");
  } catch {
    return truncate(toolCallsJson, 60);
  }
}

function primaryArg(toolName: string, args: Record<string, any>): string | null {
  const map: Record<string, string> = {
    terminal: "command",
    read_file: "path",
    write_file: "path",
    patch: "path",
    web_search: "query",
    web_extract: "urls",
    search_files: "pattern",
    browser_navigate: "url",
    browser_click: "ref",
    browser_type: "text",
    execute_code: "code",
    delegate_task: "goal",
    skill_view: "name",
    skills_list: "category",
    cronjob: "action",
    clarify: "question",
    text_to_speech: "text",
    image_generate: "prompt",
    vision_analyze: "question",
  };
  const key = map[toolName];
  if (!key) return null;
  const val = args[key];
  if (val === undefined || val === null) return null;
  const str = String(val);
  if (toolName === "execute_code") {
    return escapeNewlines(truncate(str, 1024));
  }
  if (toolName === "web_extract" && Array.isArray(val)) {
    return val.length === 1 ? val[0] : `${val[0]} …(+${val.length - 1})`;
  }
  if (toolName === "delegate_task" && Array.isArray(val)) {
    return `${val.length} tasks`;
  }
  return escapeNewlines(truncate(str, 1024));
}

function summariseResult(toolName: string, content: string): string {
  if (!content || content === "\u2014") return "(no output)";
  const MAX = 1024;

  // Try parse JSON — most Hermes tools return JSON
  try {
    const obj = JSON.parse(content);
    if (typeof obj !== "object" || obj === null) {
      return truncate(escapeNewlines(String(obj)), MAX);
    }

    // Terminal: show output, append exit code if non-zero
    if (toolName === "terminal") {
      const out = obj.output ?? obj.stdout ?? "";
      const code = obj.exit_code;
      const suffix = code && code !== 0 ? ` ${color(C.red, `exit ${code}`)}` : "";
      return truncate(escapeNewlines(out), MAX) + suffix;
    }

    // write_file / patch / remove_file / skill_manage: show path
    if (["write_file", "patch", "remove_file", "skill_manage"].includes(toolName)) {
      const path = obj.path ?? "";
      if (path) return truncate(path, MAX);
      if (obj.success === true) return "(done)";
      if (obj.success === false) return obj.error ? truncate(String(obj.error), MAX) : "(failed)";
    }

    // web_search / web_extract: show result count
    if (toolName === "web_search") {
      const results = obj.results ?? obj.data?.web ?? [];
      const count = Array.isArray(results) ? results.length : 0;
      return `[${count} result${count !== 1 ? "s" : ""}]`;
    }
    if (toolName === "web_extract") {
      const results = obj.results ?? [];
      const count = Array.isArray(results) ? results.length : 0;
      return `[${count} page${count !== 1 ? "s" : ""}]`;
    }

    // read_file: show content preview
    if (toolName === "read_file") {
      const text = obj.content ?? "";
      const total = obj.total_lines ?? 0;
      if (text) {
        const preview = escapeNewlines(text).slice(0, MAX);
        return total ? `${preview} ${color(C.dim, `[${total} lines]`)}` : preview;
      }
    }

    // delegate_task: show summary
    if (toolName === "delegate_task") {
      const results = obj.results ?? [];
      if (Array.isArray(results)) return `[${results.length} task result(s)]`;
    }

    // Generic: show important fields (success, error, output)
    const parts: string[] = [];
    if (obj.success === true) parts.push("✔");
    if (obj.success === false) parts.push("✘");
    if (obj.error) parts.push(truncate(escapeNewlines(String(obj.error)), MAX));
    const output = obj.output ?? obj.stdout ?? obj.stderr ?? "";
    if (output && typeof output === "string" && output !== obj.error) {
      parts.push(truncate(escapeNewlines(output), MAX));
    }
    if (parts.length > 0) return parts.join(" ");
    if (obj.data && typeof obj.data === "object") return `[data: ${Object.keys(obj.data).length} keys]`;
    return `[JSON: ${Object.keys(obj).length} keys]`;
  } catch { /* not JSON */ }

  // Plain text fallback
  return truncate(escapeNewlines(content), MAX);
}

function toolStatus(content: string): string {
  try {
    const obj = JSON.parse(content);
    if (typeof obj === "object" && obj !== null) {
      if (obj.success === true) return "✔";
      if (obj.success === false) return "✘";
      if (obj.error) return "⚠";
    }
  } catch { /* ignore */ }
  return "";
}

function formatTimestamp(unix: number): string {
  const d = new Date(unix * 1000);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatDate(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

// ── Formatting ───────────────────────────────────────────────────────────────
function formatLine(timestamp: string, roleLabel: string, content: string): string {
  return `${timestamp} ${roleLabel}: ${truncate(content, 1024)}`;
}

function renderRow(row: any): string | null {
  const time = formatTimestamp(row.timestamp);
  const raw = row.content ?? "";
  const role = row.role;

  if (role === "user") {
    const label = color(C.green, "YOU");
    return formatLine(time, label, raw);
  }

  if (role === "assistant" && !row.tool_calls) {
    return formatLine(time, color(C.blue, "Hermes"), raw || "(continued…)");
  }

  if (role === "assistant" && row.tool_calls) {
    // First render text if any
    const lines: string[] = [];
    if (raw) {
      lines.push(formatLine(time, color(C.blue, "Hermes"), raw));
    }
    try {
      const calls = JSON.parse(row.tool_calls);
      for (const tc of calls) {
        const name = tc.function?.name ?? "?";
        const argsRaw = tc.function?.arguments;
        let preview = "(no args)";
        if (argsRaw) {
          try {
            const argsObj = typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw;
            preview = primaryArg(name, argsObj) ?? "(no args)";
          } catch {
            preview = truncate(String(argsRaw), 60);
          }
        }
        const label = color(C.yellow, `🔧 ${name}`, true);
        lines.push(formatLine(time, label, preview));
      }
    } catch {
      lines.push(formatLine(time, color(C.yellow, "🔧 ?", true), truncate(row.tool_calls, 60)));
    }
    return lines.join("\n");
  }

  if (role === "tool") {
    const tName = row.tool_name ?? "tool";
    const status = toolStatus(raw);
    const sumry = summariseResult(tName, raw);
    const prefix = status ? `${status} ` : "";
    const label = color(C.gray, `📄 ${prefix}result`);
    return formatLine(time, label, sumry);
  }

  return null;
}

// ── Session picker ───────────────────────────────────────────────────────────

function listSessions(): any[] {
  return sqlRows(`
    SELECT s.id, COALESCE(s.title, '') as title,
           s.message_count, s.started_at,
           MAX(m.timestamp) as last_msg
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    WHERE s.archived = 0
    GROUP BY s.id
    ORDER BY COALESCE(MAX(m.timestamp), s.started_at) DESC
    LIMIT 20
  `);
}

async function printSessionChooser(sessions: any[]): Promise<string | null> {
  // Skip picker when not interactive
  if (!isTTY()) return null;

  console.log(`\n${color(C.cyan, "Recent sessions:", true)}\n`);
  const last = sessions.length - 1;
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const title = s.title?.trim() ? truncate(s.title, 40) : color(C.dim, "(untitled)");
    const date = formatDate(s.started_at);
    const count = s.message_count ?? 0;
    const marker = i === 0 ? color(C.green, "▸") : " ";
    console.log(`  ${marker} ${color(C.dim, `[${i}]`)}  ${s.id}  ${title}  ${color(C.gray, `${date}  ${count} msgs`)}`);
  }
  const range = last <= 9 ? `0-${last}` : `0-${last} (or session ID)`;
  console.log(`\n${color(C.dim, `Type a number ${range}, or press Enter for the latest:`)} `);

  // Read a line from stdin
  let input = "";
  try {
    if (isDeno) {
      const buf = new Uint8Array(1024);
      const n = Deno.stdin.readSync(buf);
      if (n) input = new TextDecoder().decode(buf.subarray(0, n)).trim();
    } else {
      // Node: use readline for reliable TTY input (fs.readSync can EAGAIN on wrapped TTYs)
      const readline = require("readline") as typeof import("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      input = await new Promise<string>((resolve) => {
        rl.question("", (answer: string) => {
          rl.close();
          resolve(answer);
        });
      });
      input = input.trim();
    }
  } catch {
    return null;
  }

  if (!input) return sessions[0]?.id ?? null;

  // Check if it's a numeric index
  const idx = parseInt(input, 10);
  if (!isNaN(idx) && idx >= 0 && idx < sessions.length) {
    return sessions[idx].id;
  }

  // Treat as session ID
  return input;
}

// ── Seed + tail ──────────────────────────────────────────────────────────────
function getMessages(sessionId: string, afterId: number): any[] {
  const safe = sessionId.replace(/'/g, "''");
  return sqlRows(`
    SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp
    FROM messages
    WHERE session_id = '${safe}' AND id > ${afterId} AND active = 1
    ORDER BY id ASC
  `);
}

function printSessionInfo(sessionId: string) {
  const rows = sqlRows(`SELECT id, title, started_at, message_count FROM sessions WHERE id = '${sessionId.replace(/'/g, "''")}'`);
  if (rows.length === 0) return;
  const s = rows[0];
  const title = s.title?.trim() ? s.title : color(C.dim, "(untitled)");
  console.log(`\n${color(C.cyan, `📋 ${title}`, true)}`);
  console.log(`${color(C.dim, `  ${s.id}  ·  ${formatDate(s.started_at)}  ·  ${s.message_count ?? 0} msgs\n`)}`);
}

// ── Watcher ──────────────────────────────────────────────────────────────────
type Cleanup = () => void;

function watchSession(sessionId: string): Cleanup {
  let lastId = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let running = true;

  function flush() {
    if (!running) return;
    debounceTimer = null;
    try {
      const rows = getMessages(sessionId, lastId);
      for (const row of rows) {
        const line = renderRow(row);
        if (line) console.log(line);
        if (row.id > lastId) lastId = row.id;
      }
    } catch {
      // DB locked or gone — skip
    }
  }

  // Seed: show last N messages, report total
  const totalRow = sqlRows(`SELECT COUNT(*) as c FROM messages WHERE session_id = '${sessionId.replace(/'/g, "''")}' AND active = 1`);
  const totalCount = totalRow[0]?.c ?? 0;

  const SEED_LIMIT = 20;
  const seed = sqlRows(`
    SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp
    FROM messages
    WHERE session_id = '${sessionId.replace(/'/g, "''")}' AND active = 1
    ORDER BY id DESC LIMIT ${SEED_LIMIT}
  `).reverse();

  for (const row of seed) {
    const line = renderRow(row);
    if (line) console.log(line);
    if (row.id > lastId) lastId = row.id;
  }

  const showing = seed.length;
  const skipped = totalCount - showing;
  const summary = skipped > 0
    ? `— showing last ${showing} of ${totalCount} message(s) —`
    : `— ${totalCount} message(s) —`;
  console.log(`${color(C.dim, `\n${summary} watching for new ones…\n`)}`);

  // Poll fallback
  const pollTimer = setInterval(flush, POLL_INTERVAL_MS);

  // fs.watch (best-effort, may not work in all runtimes)
  let watcher: any = null;
  try {
    if (isDeno) {
      (async () => {
        try {
          const w = Deno.watchFs(HOME + "/.hermes/");
          watcher = w;
          for await (const ev of w) {
            if (!running) break;
            if (ev.paths.some((p: string) => p.endsWith("state.db") || p.endsWith("state.db-wal"))) {
              if (!debounceTimer) debounceTimer = setTimeout(flush, 50);
            }
          }
        } catch { /* watcher failed */ }
      })();
    } else {
      const fs = require("fs") as typeof import("fs");
      watcher = fs.watch(HOME + "/.hermes/", (eventType, filename) => {
        if (!running) return;
        if (filename?.includes("state.db")) {
          if (!debounceTimer) debounceTimer = setTimeout(flush, 50);
        }
      });
    }
  } catch { /* fs.watch not available */ }

  return () => {
    running = false;
    clearInterval(pollTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    try { watcher?.close?.(); } catch { /* ignore */ }
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const rawArgs = isDeno ? Deno.args : process.argv.slice(2);
  const args = rawArgs.filter(a => !a.startsWith("-"));

  let sessionId: string | null = null;

  if (args.length > 0) {
    sessionId = args[0];
  } else {
    const sessions = listSessions();
    if (sessions.length === 0) {
      console.error(`${color(C.red, "No sessions found. Is Hermes running?")}`);
      Deno.exit?.(1);
      process.exit?.(1);
      return;
    }
    sessionId = await printSessionChooser(sessions);
    // Non-TTY fallback: if picker was skipped, use latest session
    if (!sessionId && !isTTY()) {
      sessionId = sessions[0]?.id ?? null;
    }
  }

  if (!sessionId) {
    console.error(`${color(C.red, "No session selected.")}`);
    return;
  }

  // Verify session exists
  const check = sqlRows(`SELECT id FROM sessions WHERE id = '${sessionId.replace(/'/g, "''")}'`);
  if (check.length === 0) {
    console.error(`${color(C.red, `Session not found: ${sessionId}`)}`);
    return;
  }

  printSessionInfo(sessionId);

  const cleanup = watchSession(sessionId);

  // Keep alive until Ctrl+C
  if (isDeno) {
    Deno.addSignalListener("SIGINT", () => { cleanup(); Deno.exit(0); });
    Deno.addSignalListener("SIGTERM", () => { cleanup(); Deno.exit(0); });
  } else {
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  }
}

main();
