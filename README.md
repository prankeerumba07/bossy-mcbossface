# Bossy McBossface

> Your Claude, but with a clipboard, a stopwatch and trust issues.

Bossy McBossface is a Claude plugin called **Work Manager**. It turns Claude into a main agent that:

- **remembers** what you did in past Claude Code conversations (days, months, years ago) and picks up where you stopped,
- **watches** your terminal windows — what is running, which Claude model each conversation uses, what failed,
- **picks the right model for every request — and every step of it** automatically: each prompt (and each step of a multi-step prompt) is graded easy / medium / hard before Claude sees it, and Claude is told to hand the work to **Haiku 5.5** for easy chores, **Sonnet 5.5** for real work, **Opus 5.5** for the hard stuff, each at a matching effort level so the easy parts don't burn tokens (it stays quiet when your model already fits or the grade is unsure),
- **reads your other conversations when you ask** — "go and read this conversation about the login page", "read my last conversation" — no links or pasting,
- **delegates** big jobs to those helpers and runs them side by side,
- **checks everything** they hand back with independent checker helpers (it does not take "done" for an answer),
- and **shows it all live** on a local dashboard: who is working, on which model, doing what, how long it took, how long is left, and what needs you.

No helper gets to say "trust me, it works". Evidence or it didn't happen.

## Add it to your Claude

### Option 1 — claude.ai (adds it to your whole account)

1. Open **[claude.ai → Customize → Plugins](https://claude.ai/customize/plugins)** (or the same page in the Claude desktop app).
2. Choose **Add → Add marketplace** and paste:
   ```
   https://github.com/prankeerumba07/bossy-mcbossface
   ```
3. Find **Work Manager** in the list and choose **Add**.
4. Open Claude Code on any computer signed in to that account. It arrives as a synced plugin the next time a session starts (or run `/reload-plugins`).

On Team and Enterprise plans an Owner may need to allow members to add marketplaces.

### Option 2 — Claude Code only (one computer)

Inside Claude Code:

```
/plugin marketplace add prankeerumba07/bossy-mcbossface
/plugin install work-manager@bossy-mcbossface
```

Or from a terminal:

```bash
claude plugin marketplace add prankeerumba07/bossy-mcbossface
claude plugin install work-manager@bossy-mcbossface
```

## Use it

In Claude Code:

- `/work-manager:work-manager` — where things stand and where you stopped
- `/work-manager:work-manager continue the checkout page` — finds that work and carries on
- `/work-manager:work-manager <a big job>` — plans it, hands it out, checks it, reports back
- or just ask: "show me the dashboard", "what's running in my terminals?", "find the chat where we fixed the email bug"

Dashboard: http://127.0.0.1:4777 (local only).

The full guide is in [`plugins/work-manager/skills/work-manager/GUIDE.md`](plugins/work-manager/skills/work-manager/GUIDE.md): what works where, the optional terminal log, keeping transcripts longer, and importing claude.ai chats.

## What's inside

| Part | What it does |
|---|---|
| `skills/work-manager` | the main agent's playbook, plus the scripts and the dashboard |
| `agents/wm-quick`, `wm-worker`, `wm-expert` | helpers pinned to Haiku 5.5, Sonnet 5.5 and Opus 5.5 |
| `agents/wm-checker`, `wm-expert-checker` | read-only checkers on Sonnet 5.5 and Opus 5.5 |
| `hooks/hooks.json` | grades every request and points Claude to the right model, records helper activity for the dashboard, and adds a short "where things stand" note when a conversation starts |

## Requirements

- Claude Code, signed in to an account that can use the Claude 5.5 models (if a model isn't available, the main agent falls back to a general helper and says so)
- Node.js 18 or newer (`node --version`)
- macOS or Linux. Tested on macOS. Windows is untested: the terminal features need macOS or Linux

The first time each script runs, Claude Code may ask you to allow it — choose "always allow". For scripted use (`claude -p`), pass `--allowedTools "Bash(node *)"` or answer the prompt once interactively.

## Privacy

Everything stays on your computer. The dashboard only answers 127.0.0.1 and only reads. The optional terminal log keeps only the program and up to two plain words after it (`npm run build`, `git push origin`, `python3 manage.py`) — options, paths, links and anything with digits or capitals are dropped, which is where passwords and tokens live. Nothing is sent anywhere by this plugin.

## Remove it

1. If you turned on the terminal log, ask Claude "turn off the Work Manager terminal log" first (it also stops by itself once the plugin is gone).
2. Ask Claude to "stop the Work Manager dashboard" (or it closes itself after 6 idle hours).
3. Turn it off or remove it in **claude.ai → Customize → Plugins**, or with `/plugin` in Claude Code.

Your data stays in `~/.claude/work-manager/` until you delete that folder.

## Updating (for whoever maintains this repo)

Raise `version` in `plugins/work-manager/.claude-plugin/plugin.json` and in `.claude-plugin/marketplace.json`, then push. People get it when their Claude checks the marketplace for updates.

## License

MIT
