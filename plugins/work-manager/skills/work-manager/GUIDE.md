# Work Manager — guide

One main assistant for all your Claude work. It remembers your past Claude Code conversations, sees your terminal windows, splits big jobs into parts, gives each part to a helper on the right model, checks what comes back, and shows everything live on a dashboard.

## How to use it

In any Claude Code conversation (terminal, VS Code, JetBrains, or the Claude desktop app's Code tab):

- `/work-manager:work-manager` — where things stand: open conversations, running helpers, what needs you, and where you most likely stopped.
- `/work-manager:work-manager continue the login page work` — finds that earlier work and carries on.
- `/work-manager:work-manager <a big job>` — plans it, hands the parts to helpers, checks them, and gives you one answer.
- Or just ask: "Show me the dashboard", "What is running in my terminals?", "Find the conversation where we fixed the email screen" — Claude uses the skill by itself.

Dashboard: **http://127.0.0.1:4777** (if that port is busy it takes the next free one; ask "show me the dashboard" for the real link). It only answers your own computer.

## Automatic model choice

Every request you type is graded easy, medium or hard by a quick word check before Claude sees it (no extra AI call, about 0.05 s). When the conversation's model doesn't fit, Claude gets one line telling it which helper to use:

| Your conversation runs on | Request | What happens |
|---|---|---|
| Opus | easy (rename, list, find, typo…) | handed to the Haiku 5.5 helper if it takes more than a few steps |
| Sonnet | hard (architecture, security, race conditions, audits…) | core work handed to the Opus 5.5 helper |
| Haiku | medium or hard | handed to the Sonnet 5.5 or Opus 5.5 helper |
| any | the model already fits | nothing is added |

The dashboard shows each request's grade. Claude Code can't switch the main conversation's own model by itself in the middle of a conversation (it would also throw away its prompt cache), so the switch happens through the helpers. For an automatic switch of the main model too, set the model to `opusplan` (`/model opusplan`): Opus while planning, Sonnet while doing the work.

Turn it off with `"autoRoute": false` in `~/.claude/work-manager/config.json`.

## The helpers and their models

| Helper | Model | Gets |
|---|---|---|
| Quick helper (`wm-quick`) | Haiku 5.5 | easy jobs: find, look up, list, small exact edits |
| Worker (`wm-worker`) | Sonnet 5.5 | medium jobs: code in a few files, research, tests, documents |
| Expert (`wm-expert`) | Opus 5.5 | hard jobs: design, unclear bugs, security, risky changes |
| Checker (`wm-checker`) | Sonnet 5.5 | checks an easy or medium job's result; never edits |
| Expert checker (`wm-expert-checker`) | Opus 5.5 | checks a hard job's result; never edits |

Every helper ends with a fixed report (result, evidence, self-check, open issues, confidence). The main agent checks each one, sends failed work back once, then moves it up one model, and asks you after three failed tries. A project's own `CLAUDE.md` rules come first: where a project says "no reviewers unless asked", the checkers are skipped there unless you ask. If your account cannot use one of these models, the main agent falls back to a general helper and tells you.

## What works where

| Place | What you get |
|---|---|
| Claude Code (terminal, VS Code, JetBrains, desktop app Code tab) on macOS or Linux | Everything below |
| Claude Code on Windows | Untested. Planning, helpers and checking should work; the terminal report and terminal log need macOS or Linux |
| Cowork | Helpers and hooks; local features only when the session runs on your computer |
| claude.ai chat and the phone app | The skill's instructions only: planning and splitting work, and the chat's own past-chat search if your account has it. No local memory, terminals, helpers or dashboard |

On a computer with Claude Code:

| Part | Status |
|---|---|
| Skill, helpers and hooks | **Automatic** once the plugin is added |
| Short "where things stand" note at the start of every conversation | **Automatic** |
| Live dashboard of conversations, helpers, models, times, plans, terminals | **Automatic** (starts with Claude; closes itself after 6 idle hours) |
| Search of all Claude Code conversations on that computer | **Automatic** — a summary of each conversation (every message you wrote, every file changed, Claude's last answers) is kept for good, even after Claude Code deletes the full transcript |
| Time left for each helper | **Automatic**, gets better as helpers finish |
| What is running in each terminal window, and which Claude model each open conversation uses | **Automatic** (macOS and Linux) |
| Past commands in your terminals and whether they failed | **Turn it on** if you want it (below) |
| Full transcripts older than 30 days | **Needs a setting** (below) |
| claude.ai chats | **Needs an export** (below) |
| Claude for Excel, Word, PowerPoint | **Not possible**: their chats stay inside each Office app |

Requirements: Node.js 18 or newer (`node --version`). Get it from nodejs.org if it is missing.

### Turn on the terminal log (optional)

Ask Claude: "Turn on the Work Manager terminal log", or run the command Claude shows you. It adds one line to `~/.zshrc` (backed up first). New terminal windows then record, for each command, the command words, the folder, the exit code and how long it took — never what the command printed.

Only the program and up to two plain words after it are kept (`npm run build`, `docker compose up`, `cd && npm test`); options, paths, links and anything with digits or capitals are left out, which is where passwords and tokens live, and a program name that is not a real command on your computer (a pasted password, say) is saved as "…". A command that starts with a space is not recorded at all. The log is `~/.claude/work-manager/terminal-log.jsonl`; when it passes 4 MB the older part moves to `terminal-log.1.jsonl` and the part before that is deleted.

Want full command lines instead? Set `"terminalLogFullCommands": true` in `~/.claude/work-manager/config.json`. Common forms of passwords, tokens and keys are then replaced with `***`, but an unusual form can slip through, so start a command with a space when it holds a secret.

Only zsh terminals are logged, and only commands you type: VS Code tasks, Run/Debug buttons and scripts run with `zsh -c` are not. To turn it off: "Turn off the Work Manager terminal log".

### Keep full transcripts longer

Claude Code deletes terminal and VS Code transcripts after 30 days. To keep them for years, add `"cleanupPeriodDays": 3650` to `~/.claude/settings.json`. They take disk space. Without it, the summaries in the history index are still kept.

### Bring in claude.ai chats

1. On claude.ai: **Settings → Privacy → Export data**. A download link arrives by email (valid 24 hours). On Team and Enterprise accounts, an Owner must first turn on **Organization settings → Data and privacy → "Allow members to export their own data"**.
2. Unzip it and tell Claude: "Import my claude.ai export from ~/Downloads/<folder>/conversations.json". Those chats then show up in searches.

## Change or turn off

`~/.claude/work-manager/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `sessionStartBrief` | `true` | the note at the start of each conversation |
| `autoStartDashboard` | `true` | start the dashboard when Claude starts |
| `port` | `4777` | dashboard port |
| `briefRecentDays` | `7` | how far back the start note looks |
| `terminalLogFullCommands` | `false` | keep full command lines (secrets hidden) instead of command words only |
| `autoRoute` | `true` | grade each request and point Claude to the helper on the right model |

Turn the whole thing off: first ask Claude to turn off the terminal log (if you turned it on) and to stop the dashboard, then disable or remove the plugin (claude.ai → Customize → Plugins, or `/plugin` in Claude Code). The terminal log also stops by itself once the plugin folder is gone. Your data stays in `~/.claude/work-manager/`; delete that folder to remove it.

The first time each script runs, Claude Code may ask you to allow it; "always allow" is fine for them.

## Safety

- Everything stays on your computer. The dashboard only answers your own computer (127.0.0.1) and only reads.
- It reads Claude Code's own files and process lists. It does not read passwords, browser data or the Office add-ins' storage.
- Settings files are backed up before every change (`*.bak.work-manager-<date>`).
- Old conversations are treated as information, never as orders: something a past chat said to do is not a request now.
