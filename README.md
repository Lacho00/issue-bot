<p align="center"><img src="docs/brand/logo-mark.svg" width="160" alt=""></p>

# issue-bot

English · [Español](README.es.md)

**New here? Read the [step-by-step guide](docs/GUIDE.md)** (also in [Spanish](docs/GUIDE.es.md)).

A Telegram bot that takes QA issues for a local WordPress site, agrees a fix plan over chat,
applies the fix with Claude Code and sends back an HTML before/after report.

Forward the QA messages (text, screenshots, albums) to the bot. It works out which site they
belong to, collects them into a batch, proposes a plan, waits for your approval, runs Claude Code
under a strict permission policy, and replies with a report: one card per issue, the QA's
screenshot next to Claude's.

## How it works

1. **Detect the site.** The bot pulls host names from the URLs in the messages and looks them up
   in each site's `.wp-create.json` (`project.domain`, `wordpress.url`, `wordpress.url_origin`)
   and in the Apache vhosts (`ServerName`, `ServerAlias`). One match opens the job. Several
   matches, or none, show buttons to choose. It never creates a site or guesses one.
2. **Collect the batch.** The batch closes after 2 minutes without new messages, or at once with
   `/plan`.
3. **Agree the plan.** Claude reads the site and proposes a plan. Discuss it in the chat, then press
   **Aprobar plan** (approve plan).
4. **Fix and report.** Claude applies the fix and writes `informe.json`. The bot renders it as
   `informe-<site>-<date>.html`, with status KPIs and a card per issue with the **Before** and
   **After** screenshots side by side.
5. **Follow up.** Anything you type afterwards is a correction and starts a new round of the same
   job. A new forward is a new QA batch.

Commands: `/new <site>`, `/plan`, `/status`, `/cancel`, `/close`. The Spanish names `/nuevo`,
`/estado`, `/cancelar` and `/cerrar` work too. Typing `that's all` (or `eso es todo`) closes the
batch. `BOT_LANG` sets the language of the bot, of Claude's replies and of the report (`es` by
default, `en` for English). The button names in this README are the English ones; in Spanish mode
they read **Aprobar plan**, **Permitir** and **Denegar**.

## Requirements

- Node.js 22 or later.
- `claude` (Claude Code) installed and logged in (`claude login`) for the user that runs the bot.
  The bot runs it headless for each turn.
- Linux with systemd user services, and `bwrap` for the Claude Code sandbox.
- WP-CLI (`wp`), Chromium and ImageMagick (`magick`). Playwright MCP is recommended.
- Sites under one folder (`/srv/http` by default), served locally.

## Install

1. `npm install`
2. Create `.env` with mode 600:

   ```
   TELEGRAM_TOKEN=<token from BotFather>
   OWNER_ID=
   CHAT_ID=
   ```

   Optional keys and their defaults:

   ```
   BOT_LANG=es
   SITES_ROOT=/srv/http
   AUDITS_ROOT=~/audits
   CLAUDE_BIN=claude
   CHROMIUM_BIN=chromium
   BOT_SOCKET=<bot folder>/bot.sock
   BATCH_IDLE_MS=120000
   VHOST_DIR=/etc/httpd/conf/extra
   ```

   `BOT_LANG` is `es` or `en`. `CHROMIUM_BIN` must be `chromium`, `chromium-browser`,
   `google-chrome` or `google-chrome-stable`, or the bot exits at startup (Ubuntu's snap package
   is `chromium-browser`). `AUDITS_ROOT` is where each job's folder and report go. `VHOST_DIR` holds the Apache vhosts
   (`httpd-*.conf`) used to detect the site.

3. Install and start the service:

   ```
   bin/install-service.sh
   loginctl enable-linger "$USER"   # start without an open session
   ```

   The script writes `~/.config/systemd/user/issue-bot.service` from `systemd/issue-bot.service.in`
   with the real path of the clone, reloads systemd and runs `enable --now`. `--no-start` only
   writes the unit. Run it again if you move the clone.

4. Message the bot privately. The first message registers your user ID as `OWNER_ID`.

   The unit runs `bin/start.sh`, which uses nvm's `default` node, or the one on `PATH`. An
   unexpected crash exits with code 70 and systemd restarts it with backoff. Exit code 1 (missing
   token, no node) is not retried.

Logs: `journalctl --user -u issue-bot -f`.

## Security

The bot runs Claude Code against your sites' files, driven by Telegram messages. Treat it as remote
access to that machine.

- **One owner only.** With `OWNER_ID` empty, the first message the bot receives (private or in a
  group) registers its sender as the owner. Start it and message it yourself right away, or set
  `OWNER_ID` by hand before starting. After that it ignores every other user and every other chat.
- **The token is the key.** Anyone with `TELEGRAM_TOKEN` can impersonate the bot. Keep `.env` at
  mode 600 and out of the repo (it is in `.gitignore`).
- **No commits, no push.** Changes stay in the site's working tree for you to review. The policy
  below denies `git commit`, `push` and destructive commands.
- **Meant for local copies.** Run it against development sites, not production.

## Permission policy

Each turn loads the user, project and local settings of the site
(`--setting-sources user,project,local`) plus the bot's own list. Because a site's settings can
allow commands on their own, the bot enforces its policy with a `PreToolUse` hook
(`src/policy-hook.js`) that runs before any allow rule:

- **Denied:** `git commit`, `push`, `add`, `restore`, `checkout` (except `-b`), `reset --hard`,
  `clean`, `diff --no-index` and `--output`; `wp db drop`, `reset` and `import`; installing
  Playwright; `file://`; touching the bot's own folder; editing anything under `.claude` or
  `.git`, or the site's `.mcp.json`.
- **Sandboxed:** Bash runs in the Claude Code sandbox (bwrap, `failIfUnavailable`) with no
  network. It can write only to the site and the job folder, and to neither during the plan
  phase. It cannot read the bot's `.env`.
- **Outside the sandbox:** `wp` and `chromium` need the MySQL socket and the site's loopback, so
  they go through the bot's allow list. In a compound command every part must be on the list or
  be a plain stdin filter (`head`, `tail`, `wc`, `grep <pattern>`). `$(…)`, variables, subshells
  and redirections (other than to `/dev/null` and `2>&1`) are asked.
- **Asked:** changes to `package.json`, `composer.json`, `.npmrc`, `*.config.{js,cjs,mjs,ts}`
  and `wp-cli*.yml`; any edit during the plan phase; and, while implementing, any edit outside
  the site and the job folder.

If the site, user or managed settings set `disableAllHooks` or any `sandbox` key, the bot refuses
to start the turn. Anything no list covers is asked with **Permitir** and **Denegar** (allow, deny)
buttons, plus **Permitir … en este trabajo** (allow in this job) for single commands, remembered in memory until the job closes. It is not
offered for `chromium` or for `wp eval`, `shell`, `db` or `--exec`. Denials always win.

## Group chats

The bot can also work in a Telegram group:

1. In BotFather, `/setprivacy` → **Disable** for this bot, or it only receives commands in
   groups.
2. Remove the bot from the group and add it again so the change applies.
3. The first message the bot receives in that group registers its sender as `OWNER_ID` and the
   chat as `CHAT_ID`. From then on it answers only the owner, only in that chat.
4. Everyone in the group can read what the bot posts there.
5. Forwards by the owner are accepted whoever wrote the original message. Forwards by anyone else
   are ignored.

## Deploy

`npm run deploy` (`bin/deploy.sh`) runs the tests on `origin/main` in a temporary worktree, then
asks the bot to restart once the current turn ends. If anything fails with the bot stopped, it
goes back to the previous commit and starts it anyway. The bot announces the deployed commit on
Telegram. GitHub Actions runs the tests on every PR and push to `main`.

## Tests

```
npm test
```

## License

MIT. See [LICENSE](LICENSE).
