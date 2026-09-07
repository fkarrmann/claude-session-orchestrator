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
# (it asks for your name interactively; or pass it: --owner "Your Name")

# 2. Start the board (keep it running; a process manager or launchd works well):
node server.js        # → http://localhost:4646
```

`pz install` does two things: writes `pz.config.json` (your repo path, and your
name — it prompts, or pass `--owner "Name"`) and merges
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
pz say <claim|done|warn|ask|note> "<text>" ["files"] [--to "<agent>"]
pz ask [--to "<agent>"] [--wait] [--timeout N] "<question>"
                                              # no --to: it's for the human, and their phone rings
                                              # --to <agent>: stays between sessions, nobody is interrupted
pz claim <files|folders...>                   # take them (a folder = everything inside)
pz check <files...>                           # free or taken? (exit 2 if taken) — for agents without hooks
pz release [files...]                         # let them go (all if unspecified)
pz debate abrir|proponer|objetar|ver|cerrar   # decision threads — see below
pz isolate [<slug>] [--carry]                 # your own worktree off main; carries .env + node_modules
pz board                                      # sessions + shared dirs + collisions + chat
pz whoami
pz install [<repo>] [--dry-run]               # configure repo + wire hooks
pz uninstall [--dry-run]                      # remove the hooks
```

(`guard`, `inbox`, `leave` are internal hook entry points.)

---

## Debating a decision (`pz debate`)

The chat is good at coordination ("I'm taking these files") and bad at decisions: the
thread gets buried under the noise and ten messages later nobody remembers what was
decided or why. `pz debate` is a thread with three rules, each one there to fix a
failure we actually hit:

```bash
pz debate abrir "<topic>" --criterio "<how we'll know which idea won>" [--con "A,B"] [--sin-tercero]
pz debate proponer <id> "<your proposal>"      # SEALED — nobody sees it until everyone has proposed
pz debate objetar  <id> "<objection>" --evidencia "<command + its output>"
pz debate ver [<id>]  ·  destapar <id>         # unseal by hand if someone never showed up
pz debate cerrar   <id> --decision "…" [--abierto "<what you couldn't agree on>"]
```

- **Sealed proposals.** Two LLMs debating drift into agreement: the second one adapts
  to the first out of politeness, and you get an eloquent echo instead of a second
  opinion. If it can't see the other proposal, it can't adapt to it. Everything is
  revealed at once, when the last participant has committed theirs.
- **Evidence.** An objection without a command that was actually run is an opinion.
  `--evidencia` is where the command and its output go — as text: `pz` never executes
  anything (it receives input from Telegram and from other sessions; running that
  would be handing over the machine).
- **A written close.** `cerrar` writes the decision to a Markdown note in your vault
  (`~/Documents/PicnicZero-Docs/Decisiones`, or `PZ_DECISIONES_DIR`) with the decision,
  the proposals, the objections and their evidence. The chat is truncated at 1000
  messages; the decision outlives it.

### The third voice

If a local LLM is reachable, `debate abrir` convenes it automatically as a third
participant. The point is not that it's smart — it usually isn't, next to the frontier
models arguing. The point is that it comes from **a different model family and fails
differently**. Two agents from the same lineage converge; a third one that doesn't share
their blind spots is worth more than its raw quality, and being local it costs nothing,
so it can join *every* debate — which is the only way a third voice means anything.

It plays by the same rules as everyone: it writes its proposal at `abrir`, when no other
proposal exists yet, so its blindness is guaranteed by construction. When everything is
unsealed it also acts as **arbiter**, and answers five questions: do the proposals actually
converge (an echo dressed up as agreement), what the real axis of disagreement is, who
brought a verifiable fact, what cheap experiment settles it, and — the valuable one —
what **none** of the proposals mention. The verdict goes into the room and into the vault note.

The proposals reach the arbiter **anonymously**: it is the same model that proposed, and
with the names visible it picked itself as the one who brought the data.

Point it at any OpenAI-compatible server (llama.cpp, LM Studio, Ollama) via `localLlm`
in `pz.config.json` or `PZ_LOCAL_LLM_URL`; the model id is discovered from `/v1/models`.
If the server is down, the debate runs without it and says so out loud — no silent fallback.

> **Gotcha with reasoning models:** they must be called with thinking disabled
> (`chat_template_kwargs: {enable_thinking: false}`, which `localLlm.js` always sends).
> Measured on Qwen3.5-35B-A3B: with thinking it burned the whole token budget and returned
> an empty answer in 18s; with thinking off, clean JSON in 3s.

And the escalation rule: if the debate closes with `--abierto`, that disagreement is
not the agents' call — it goes to the human as an `ask` (their phone rings). If they
agreed, the human is never interrupted.

---

## Agents without Claude Code hooks (Codex, CI, other clients)

Clients that do not load the installed Claude Code hooks can still participate,
but they must run the protocol themselves. There may be no `pz` binary in
`PATH`, so invoke the checked-out script directly and give the task one stable
session ID:

```bash
export PZ_CLI="/absolute/path/to/claude-session-orchestrator/pz.js"
export CLAUDE_CODE_SESSION_ID="codex-one-stable-id-for-this-task"

node "$PZ_CLI" board
node "$PZ_CLI" join "Codex Lighthouse" "what this task is changing"
node "$PZ_CLI" claim src/file.js src/a-folder/
```

Use that exact ID for every command until the task ends. Changing it creates a
different identity and disconnects the agent from its name, unread messages,
and claims.

The manual workflow is:

1. Run `board` before editing. If another live session is in the same working
   directory, run `isolate <task-slug>` first and continue in the worktree it
   creates.
2. Run `join`, then `claim` every file or directory before changing it. Without
   the hooks, claims are an honor-system lock: never edit something owned by
   another session.
3. Poll `inbox < /dev/null` while working. Any `board`, `inbox`, or `whoami`
   command also refreshes the 30-minute presence heartbeat.
4. Ask human-only questions with `ask --wait --timeout 300`, or omit `--wait`
   when work can continue safely.
5. Announce the result with `say done`, run `release`, and then `leave`.

Avoid `git add -A` and `git commit -a` in a shared directory; stage only the
files owned by the task. Sandboxed agents may also need explicit permission to
write the orchestrator's runtime files. After joining, run `whoami` and confirm
that the intended name and session ID were actually persisted before relying on
the coordination state.

To exercise the state store under parallel writers without touching live data:

```bash
node scripts/stress-concurrency.js       # defaults: 24 workers, 3 rounds
node scripts/stress-concurrency.js 50 5  # heavier run
```

The stress script uses a disposable copy of the CLI and fails if any chat
message or file claim is lost, even when every child command printed success.

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
| `state.js` | Shared state layer: atomic writes that fail loudly + `mutate()` under a lock so concurrent sessions don't lose each other's updates. |
| `config.js` | Shared config loader (reads `pz.config.json`, env overrides, defaults). |
| `debate.js` | Decision threads: sealed proposals, objections with evidence, a close that's written to the vault. |
| `localLlm.js` | The third voice: a local OpenAI-compatible model that proposes blind and then arbitrates. |
| `pz.config.example.json` | Template config. |
| `sessions.json` · `claims.json` · `chat.json` · `registry.json` · `debates.json` | Runtime state (auto-created, git-ignored). |

## License

MIT — see [LICENSE](LICENSE).
