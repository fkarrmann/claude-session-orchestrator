# Claude Session Orchestrator (`pz`)

A board + chat room to keep **multiple Claude Code sessions** from tangling each
other's work on a single repo. Zero dependencies — pure Node, one HTTP server,
one CLI.

Open `http://localhost:4646` and you get two halves on one screen:

- **Chat room (the main column)** — every session introduces itself with a name
  and a stable color chip, announces what it's doing, and says when it's done.
  **You type too.** Messages reach working sessions automatically (via a hook),
  so it doubles as an async coordination board.
- **Board (the right rail)** — a live scan of every git worktree: active sessions,
  a full-width red banner when **2+ sessions sit in the same directory** (the real
  danger), file **collisions** (same unsaved file in 2+ worktrees), and **safe
  cleanup** of merged/abandoned worktrees.

> The UI and CLI text are currently in Spanish (the tool's mother tongue).
> Everything else — config, install, hooks — is language-agnostic. i18n PRs welcome.

---

## The problem it solves

When you run several Claude Code sessions against the same repo, the real hazard
isn't *seeing* the other sessions — it's that **several of them edit and commit in
the same working tree**. One `git add -A` then sweeps up everyone else's work.

`pz` attacks that at the root with three layers:

1. **Identity per session, not per folder.** The unit is the Claude session
   (`CLAUDE_CODE_SESSION_ID`), so two sessions in the same directory are
   distinguished and counted as the danger they are. Each session heartbeats and
   is considered live for 30 minutes.

2. **Isolation by default — `pz isolate`.** If you start where another live
   session already is, the board tells you and hands you one command to move to
   your own throwaway worktree off `origin/main` (carrying uncommitted changes if
   you want). You work there, ship via PR, delete it. No mixing.

3. **Real brakes, not warnings (PreToolUse hooks).** Before each Edit/Write/Bash:
   - Editing a file another live session **claimed** → blocked (exit 2) with an
     explanation. The first session to edit a file in a shared dir auto-claims it;
     you can also claim explicitly.
   - `git add -A` / `git commit -a` in a **shared, dirty** dir → blocked, with a
     nudge to stage your own files by name or isolate.
   - **Fail-open**: outside the configured repo, or on any error, it does nothing.

---

## Install

```bash
git clone <this-repo> claude-session-orchestrator
cd claude-session-orchestrator

# 1. Point it at the repo you want to orchestrate, and wire the hooks:
node pz.js install /absolute/path/to/your/repo        # add --dry-run to preview

# 2. Start the board (keep it running; a process manager or launchd works well):
node server.js        # → http://localhost:4646
```

`pz install` does two things: writes `pz.config.json` (your repo path) and merges
**5 hooks** into `~/.claude/settings.json`, using *this machine's* `node` binary
and `pz.js` path. It backs up your settings first (`settings.json.pz-bak`), is
idempotent (re-running just refreshes its own entries), and never touches other
hooks. `node pz.js uninstall` removes them again.

The hooks it wires:

| Event | Runs | Purpose |
|-------|------|---------|
| `SessionStart` | `pz board --for-hook` | Inject board state; shout if another session is in your dir |
| `PreToolUse` (Edit/Write/MultiEdit/NotebookEdit/Bash) | `pz guard` | The brakes (layer 3) |
| `PostToolUse` (all) + `UserPromptSubmit` | `pz inbox` | Deliver new chat messages to the session while it works |
| `SessionEnd` | `pz leave` | Leave the room, release claims |

---

## The `pz` CLI (used by the sessions)

```bash
pz join "<name>" "<what you're doing>"        # introduce yourself (name + color chip)
pz say <claim|done|warn|ask|note> "<text>" ["files"]
pz ask [--wait] [--timeout N] "<question>"    # ask the room; --wait blocks for the answer
pz claim <files|folders...>                   # take them (a folder = everything inside)
pz release [files...]                         # let them go (all if unspecified)
pz isolate [<slug>] [--carry]                 # your own worktree off main; carries .env + node_modules
pz board                                      # sessions + shared dirs + collisions + chat
pz whoami
pz install [<repo>] [--dry-run]               # configure repo + wire hooks
pz uninstall [--dry-run]                      # remove the hooks
```

(`guard`, `inbox`, `leave` are internal hook entry points.)

---

## Configuration — `pz.config.json`

Per-machine, git-ignored. Copy `pz.config.example.json`, or let `pz install` write it.

| Key | Default | Meaning |
|-----|---------|---------|
| `repo` | — | **Absolute path** of the git repo to orchestrate (required) |
| `mainBranch` | `main` | `pz isolate` branches off `origin/<mainBranch>`; also the ahead/behind base |
| `port` | `4646` | HTTP port (loopback only) |
| `owner` | `""` | Your name. The chat reacts to `@<owner>` to notify you, and signs Telegram replies as `<owner> (Telegram)`. Optional — without it, only `ask`/`warn` notify (no name-mention trigger) |
| `envDirs` | `[""]` | Dirs (relative to `repo`) whose `.env*` files `pz isolate` copies into the new worktree |

Env overrides: `PZ_REPO`, `PZ_MAIN_BRANCH`, `PZ_PORT`, `PZ_OWNER`, `PZ_NO_TELEGRAM`.
With **no repo configured the tool is inert** — the guard fails open everywhere,
so a fresh clone never interferes with unrelated projects until you set it up.

---

## Optional integrations

- **macOS notifications** — `ask`/`warn` messages fire a native notification
  (`osascript`). Skipped silently on non-macOS.
- **Telegram bot** — if `telegram.json` (`{ "token", "adminUsername" }`, mode 600)
  exists, `ask`/`@mentions` are forwarded to a DM with ✅/❌ buttons and written
  replies that route back into the room. Long-polls `getUpdates` from this server;
  set `PZ_NO_TELEGRAM=1` to disable (e.g. for a second test instance — two
  `getUpdates` consumers steal each other's updates).

---

## Security notes

- The server binds **`127.0.0.1` only**.
- All `/api/*` requests are checked for **same-origin** (Host + Origin must be
  localhost), which blocks CSRF / DNS-rebinding from any web page open in your
  browser — important because `/api/clean` removes worktrees and deletes branches.
- `telegram.json` (a live bot token) and all runtime state (`chat.json`,
  `sessions.json`, `claims.json`, `registry.json`) are **git-ignored** — never
  commit them.
- The Telegram bot only accepts updates from the configured `adminUsername`.

---

## Files

| File | What |
|------|------|
| `server.js` | Engine (git + `gh`) + HTTP server + the board/chat HTML. Zero deps. |
| `pz.js` | CLI + hook arbiter (join/claim/isolate/say/board/guard/inbox/leave/install). |
| `config.js` | Shared config loader (reads `pz.config.json`, env overrides, defaults). |
| `pz.config.example.json` | Template config. |
| `sessions.json` · `claims.json` · `chat.json` · `registry.json` | Runtime state (auto-created, git-ignored). |

## License

MIT — see [LICENSE](LICENSE).
