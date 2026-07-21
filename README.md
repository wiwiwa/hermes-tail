# hermes-tail

Tails [Hermes Agent](https://hermes-agent.nousresearch.com) chat history in near real-time.

```
21:02:21 YOU: what is your $HOME?
21:02:25 Hermes: `$HOME` is **/home/user**.
21:02:25 🔧 terminal: echo $HOME
21:02:25 📄 result: /home/user
```

One line per message, color-coded, 1024-char cap. Zero dependencies.

## Install

```bash
# Run directly (no clone needed)
curl -sSL https://github.com/wiwiwa/hermes-tail/raw/refs/heads/master/hermes-tail.ts | npx tsx -
```


## Requirements

- **Node.js 20+** with `npx tsx`, **or** Deno
- **sqlite3** CLI on `$PATH`

```bash
which sqlite3 || apt install sqlite3   # Debian / Ubuntu
which sqlite3 || brew install sqlite3  # macOS
```

## Usage

```bash
npx tsx hermes-tail.ts                              # pick a session interactively
npx tsx hermes-tail.ts --session <id>               # tail a specific session
npx tsx hermes-tail.ts --db /path/to/state.db       # explicit DB path
deno run -A hermes-tail.ts                           # Deno runtime
```

### CLI flags

| Flag | Description |
|------|-------------|
| `--session <id>` | Tail a specific session by ID |
| `--db <path>` | Path to Hermes `state.db` (discovery: `$HERMES_HOME` → `$HOME/.hermes`) |
| `--help` | Show usage |

## Output format

```
18:45:31 YOU: Could you check the nginx config?
18:45:33 Hermes: Let me look at that.
18:45:34 🔧 terminal: cat /etc/nginx/nginx.conf
18:45:36 📄 result: user  www-data; worker_processes 4; ...
```

| Role | Color | Example |
|------|-------|---------|
| User message | Green | `18:45:31 YOU: ...` |
| Assistant text | Blue | `18:45:33 Hermes: ...` |
| Tool call | Yellow bold | `18:45:34 🔧 terminal: ...` |
| Tool result | Dim gray | `18:45:36 📄 result: ...` |

- Tool calls show the **primary argument** (command, path, query, etc.)
- Tool results are parsed from JSON — terminal output, file paths, search result counts
- All lines capped at 1024 characters
- Sessions sorted by last message time (most recent first)

## How it works

- **fs.watch** (`inotify` on Linux) + 50ms debounce catches new rows instantly
- **3s poll fallback** catches anything the watcher may miss
- **sqlite3 CLI** via subprocess — no native modules, zero npm dependencies
- Single `.ts` file, runs under **Node** (`npx tsx`) or **Deno** natively
- Session DB path discovery: `--db` → `$HERMES_HOME` → `$HOME/.hermes/state.db`
