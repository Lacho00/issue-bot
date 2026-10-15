# issue-bot guide

English · [Español](GUIDE.es.md)

This guide takes you from an empty machine to a first fixed QA issue. It covers setup, a sample
chat, the report, groups, updates, troubleshooting and removal. The [README](../README.md) has the
short version and the security and permission details.

## Contents

1. [What it does](#1-what-it-does)
2. [Requirements](#2-requirements)
3. [How sites are found](#3-how-sites-are-found)
4. [Create the Telegram bot and configure it](#4-create-the-telegram-bot-and-configure-it)
5. [First run](#5-first-run)
6. [Your first job](#6-your-first-job)
7. [The report](#7-the-report)
8. [Using a Telegram group](#8-using-a-telegram-group)
9. [Updating](#9-updating)
10. [Troubleshooting](#10-troubleshooting)
11. [Security and uninstall](#11-security-and-uninstall)

## 1. What it does

issue-bot is a Telegram bot that runs on your Linux machine. A QA person reports problems on a
local WordPress site. You forward those messages to the bot. The bot drives Claude Code, which
reads the site, proposes a plan, and, once you approve it, fixes the code and measures the result.

It is for developers who receive QA feedback as chat messages with screenshots and want a first
fix and a written report without leaving Telegram.

> **Warning: local development copies only.** The bot runs Claude Code on the files of your sites,
> controlled by Telegram messages. Never point it at a production server or at a site you cannot
> afford to break. It leaves every change uncommitted in the working tree so you can review it,
> but treat the bot as remote access to the machine it runs on.

The flow:

1. Forward the QA messages (text, screenshots, albums) to the bot.
2. The bot reads the host names in the URLs and detects which site they belong to.
3. It collects the messages into a batch. The batch closes after a pause, or when you send `/plan`.
4. Claude reads the site and sends a plan. You can discuss it in the chat.
5. You press **Approve plan**.
6. Claude fixes the code, takes after screenshots and writes the report data.
7. The bot sends an HTML report with the QA screenshot and the new screenshot side by side.
8. Anything you type next is a correction and starts another round. `/close` ends the job.

## 2. Requirements

The bot runs on Linux only. You need a user account with systemd user services.

| Requirement | Why |
|---|---|
| Node.js 22 or later | Runs the bot. nvm works. |
| Claude Code CLI, logged in | The bot runs `claude` headless for each turn. |
| bubblewrap (`bwrap`) | The Claude Code sandbox for shell commands. |
| WP-CLI (`wp`) | Claude uses it to inspect and change the site. |
| Chromium | Claude uses it to render pages. |
| ImageMagick (`magick`) | Claude crops screenshots with it. |
| systemd user services | Keeps the bot running. |

Optional but recommended:

- The Playwright MCP server, configured in Claude Code. The bot's prompts tell Claude to measure
  and take screenshots with the `mcp__playwright` tools.
- The codebase-memory MCP server. Claude uses it when it is available.

The prompts ask Claude to use `mcp__playwright` tools and `magick`. Without Playwright MCP, the
before and after screenshots will be poor or missing.

### Arch Linux

```
sudo pacman -S --needed nodejs npm bubblewrap chromium imagemagick git
# WP-CLI is in the AUR (wp-cli), or install the phar (see below)
```

### Ubuntu / Debian

```
sudo apt update
sudo apt install -y bubblewrap imagemagick git curl
```

Chromium. On Debian, `sudo apt install chromium` gives the `chromium` binary. On Ubuntu, the
`chromium-browser` package is a snap wrapper. It is allowed, but you must set
`CHROMIUM_BIN=chromium-browser` in `.env` (step 4). Snap confinement can block Chromium from
reading local files, so test it after installing. Google Chrome (`google-chrome-stable`) also
works.

### Node.js 22 (any distribution, with nvm)

```
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# open a new shell, then:
nvm install 22
nvm alias default 22
```

`bin/start.sh` uses the node of nvm's `default` alias, or the one on `PATH` if there is no nvm.

### WP-CLI

If your distribution has no package:

```
curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
chmod +x wp-cli.phar
sudo mv wp-cli.phar /usr/local/bin/wp
wp --info
```

### Claude Code

Install the CLI as described in the Claude Code documentation, then log in as the user that will
run the bot:

```
claude login
claude --version
```

The service runs as that same user and reads the same login.

### Playwright MCP (optional)

Add the server to Claude Code at user scope, using the Chromium you already have. Do not let it
download another browser.

```
claude mcp add --scope user playwright -- npx @playwright/mcp@latest --browser chromium --executable-path /usr/bin/chromium
claude mcp list
```

Adjust `--executable-path` to your Chromium. Check your own Claude Code version for the exact
`mcp add` syntax if the command fails.

### Check the tools

```
node --version        # v22 or later
claude --version
bwrap --version
wp --version
chromium --version    # or chromium-browser / google-chrome-stable
magick -version
```

### Keep the bot running without a login session

```
loginctl enable-linger "$USER"
```

Without this, systemd stops your user services when you log out.

## 3. How sites are found

The bot looks for sites in `SITES_ROOT` (default `/srv/http`). Each site is one folder:
`SITES_ROOT/<site>`. The folder name is the site name you use in `/new <site>`.

Each site should be a git repository or working tree. The bot checks `git status` when it opens
a job and warns if there are uncommitted changes. Claude leaves its changes uncommitted. The bot
denies `git commit` and `git push`.

To pick the site from the QA messages, the bot extracts host names from the URLs and looks them up
in two places.

**1. `.wp-create.json` in the site folder.** The bot reads these keys:

- `project.domain`
- `wordpress.url`
- `wordpress.url_origin` (a string with space-separated URLs, or a list)

A minimal example:

```json
{
  "project": { "domain": "shop-demo.local" },
  "wordpress": {
    "url": "https://shop-demo.local",
    "url_origin": "https://shop-demo.example.com"
  }
}
```

The file is created by the claude-wp-builder plugin. You can write it by hand. Only the keys above
are used.

**2. Apache vhosts.** The bot reads `httpd-*.conf` files in `VHOST_DIR` (default
`/etc/httpd/conf/extra`). It reads `ServerName` and `ServerAlias`. It links a vhost to a site
through its `DocumentRoot` when that is inside `SITES_ROOT`. A vhost without `DocumentRoot` (for
example a redirect file) is linked by file name: `httpd-shop-demo.conf` or
`httpd-shop-demo-redirect.conf` belongs to the site `shop-demo`.

Debian and Ubuntu keep vhosts in `/etc/apache2/sites-enabled/` with other file names, so set
`VHOST_DIR` only if your files match `httpd-*.conf`. Otherwise rely on `.wp-create.json`.

**nginx is not parsed.** With nginx, add a `.wp-create.json` to each site, or open jobs by hand
with `/new <site>` (Spanish alias: `/nuevo <site>`).

Outcomes of detection:

- One site matches: the bot opens the job.
- Several sites match, or none: the bot shows buttons to choose, or you use `/new <site>`.
- The bot never creates a site and never guesses.

## 4. Create the Telegram bot and configure it

### Create the bot with BotFather

1. In Telegram, open a chat with `@BotFather`.
2. Send `/newbot`.
3. Send a display name, for example `Issue Bot`.
4. Send a username that ends in `bot`, for example `my_issue_helper_bot`.
5. BotFather replies with a token like `123456789:AA...`. Copy it. Treat it as a password.

### Get the code

```
git clone https://github.com/<owner>/issue-bot.git
cd issue-bot
```

Use the real URL of the repository you found. The clone can live anywhere. Step 5 writes its
path into the service.

### Write `.env`

```
cat > .env <<'EOF2'
TELEGRAM_TOKEN=123456789:AA...paste-your-token
OWNER_ID=
CHAT_ID=
BOT_LANG=en
SITES_ROOT=/srv/http
EOF2
chmod 600 .env
```

Leave `OWNER_ID` and `CHAT_ID` empty. The bot fills them in when you first write to it (step 5).
`.env` is in `.gitignore`. Never commit it.

### `.env` reference

All keys except `TELEGRAM_TOKEN` are optional. The bot reads `.env` only at startup, so restart it
after any change.

| Key | Default | What it does |
|---|---|---|
| `TELEGRAM_TOKEN` | none (required) | Bot token from BotFather. Without it the bot exits with code 1. |
| `OWNER_ID` | empty | Telegram user ID of the only person the bot obeys. Empty: the first message registers its sender. |
| `CHAT_ID` | empty | The one chat the bot answers in. Empty: the owner's private chat. A group message registers it. |
| `BOT_LANG` | `es` | `es` or `en`. Language of the bot's messages and buttons, of Claude's replies and of the HTML report. |
| `SITES_ROOT` | `/srv/http` | Folder with one subfolder per site. |
| `AUDITS_ROOT` | `~/audits` | Where job folders and reports go. |
| `CLAUDE_BIN` | `claude` | Claude Code executable. Set a full path if the service cannot find it. |
| `CHROMIUM_BIN` | `chromium` | Browser Claude launches. Must be one of `chromium`, `chromium-browser`, `google-chrome`, `google-chrome-stable`. Any other value makes the bot exit at startup. |
| `BOT_SOCKET` | `<clone>/bot.sock` | Unix socket the permission bridge uses between the bot and Claude. |
| `BATCH_IDLE_MS` | `120000` | Milliseconds without new messages before the batch closes. Must be a positive integer. |
| `VHOST_DIR` | `/etc/httpd/conf/extra` | Folder with the Apache vhosts (`httpd-*.conf`) used for site detection. |

Command names work in both languages. English: `/new <site>`, `/status`, `/cancel`, `/close`.
Spanish: `/nuevo <sitio>`, `/estado`, `/cancelar`, `/cerrar`. `/plan` and `/start` are the same in
both. Typing `that's all` (or `eso es todo`) closes the batch, like `/plan`.

## 5. First run

1. Install dependencies and run the tests:

   ```
   npm install
   npm test
   ```

   All tests must pass.

2. Install and start the service:

   ```
   bin/install-service.sh
   ```

   The script writes `~/.config/systemd/user/issue-bot.service` from `systemd/issue-bot.service.in`,
   with the real path of your clone. Then it runs `systemctl --user daemon-reload` and
   `systemctl --user enable --now issue-bot`. Use `bin/install-service.sh --no-start` to write the
   unit without starting it.

3. Register yourself as the owner. **Do this at once.** While `OWNER_ID` is empty, the first
   person who messages the bot becomes its owner. Open your bot in Telegram and send `/start`.
   The bot answers with the owner and chat it registered and stores them in `.env`.

4. Check the logs:

   ```
   systemctl --user status issue-bot
   journalctl --user -u issue-bot -f
   ```

If you move the clone to another folder, run `bin/install-service.sh` again.

## 6. Your first job

This is a sample session with a fictional site `shop-demo`, served at `shop-demo.local`. The
folder `SITES_ROOT/shop-demo` exists. Lines starting with `You` are yours. Lines starting with
`Bot` are the bot's replies. Exact wording may differ a little in your version.

```
You (forwarded from QA, with a screenshot):
    The "Add to cart" button on https://shop-demo.local/product/mug/ is
    gray on mobile. It should be white text on the blue background.
    [photo]

You (forwarded from QA):
    The footer links overlap at 375 px width on
    https://shop-demo.local/contact/

Bot:
    Job opened on shop-demo (detected from shop-demo.local).
    Folder: /home/you/audits/shop-demo/results/qa-2026-10-15
    I have 3 items. Keep forwarding; I close the batch with /plan or
    after 2 min without messages.

You:
    that's all

Bot:
    Analyzing…
```

Claude reads the screenshots and the code. It does not edit anything in this phase. Then:

```
Bot:
    1. "Add to cart" button text color on mobile
    Cause: .btn--cart sets color via a more specific rule in the mobile
    media query.
    Fix: move the color to the base rule and drop the override.
    Files: wp-content/themes/shop/assets/css/styles.css
    Measured: color rgb(120, 120, 120), 44x48 px at 375 px.
    Proposed: color #fff.

    2. Footer links overlap at 375 px
    ...
    [ Approve plan ]
```

You can write in the chat to change the plan. Claude answers with a new plan and a new button. When
the plan is right:

```
You:
    [press Approve plan]

Bot:
    Implementing…
```

While Claude works, it may need a command that no allow list covers. You get a message:

```
Bot:
    Permission: Bash: wp post list --post_type=product --format=ids
    [ Allow ] [ Deny ]
    [ Allow "wp post list" for this job ]
```

- **Allow** lets this one request through.
- **Deny** refuses it. Claude carries on without it.
- **Allow ... for this job** remembers the command until the job closes. It is offered only for
  single commands, never for `chromium`, `wp eval`, `wp shell`, `wp db` or `--exec`.

The bot edits the message to show what you chose. Some actions are always denied (for example
`git commit`), and you get no button for them.

```
You:
    [press Allow "wp post list" for this job]

Bot:
    Permission: Bash: wp post list --post_type=product --format=ids
    → Allowed for this job: wp post list
```

When Claude finishes, the bot sends the report file and a summary:

```
Bot:
    Done. Both issues are fixed. The changes are uncommitted in the theme.
    [file] report-shop-demo-2026-10-15.html

Bot:
    1. "Add to cart" button text color on mobile - Fixed
    2. Footer links overlap at 375 px - Mitigated

Bot:
    Review the diff in the repo. If there are corrections, write them; otherwise /close.
```

Open the diff in the site's repo. If something is wrong, write a correction:

```
You:
    The footer is better, but the links still touch at 360 px.

Bot:
    Analyzing…

Bot:
    1. Footer links at 360 px
    Cause: ...
    [ Approve plan ]

You:
    [press Approve plan]

Bot:
    Implementing…
    ...
    [file] report-shop-demo-2026-10-15.html
```

A correction starts a new round of the same job, with its own plan and its own approval. The new
report replaces the earlier one in the job folder.

When you are happy, commit the changes yourself and close the job:

```
You:
    /close

Bot:
    Job in shop-demo closed.
```

Useful at any time:

- `/status` shows the site, phase, round, pending items and the job folder.
- `/cancel` stops the running Claude turn. Write `continue`, to resume it.
- Forwarding messages from another site while a batch is open asks whether to switch to that site
  or add the messages to the current one.
- Forwards that arrive while Claude works, or while a plan waits for approval, are saved for the
  next batch.
- After the report, a new forward starts a new QA batch and a new job.

If the site's repo has uncommitted changes when the job opens, the bot lists them and asks
**Continue** or **Cancel**. The batch does not close until you answer.

## 7. The report

Each job has its own folder:

```
AUDITS_ROOT/<site>/results/qa-YYYY-MM-DD/
```

A second job on the same day gets `-2`, `-3` and so on. Inside:

- `img/` holds the QA screenshots (`qa-NN`) and the screenshots Claude takes (`NN-...png`).
- `informe.json` is what Claude writes at the end of the implementation turn. The file name is
  fixed, whatever `BOT_LANG` is.
- `informe.html` is what the bot renders from the JSON. The copy sent to you embeds the images, so
  it is one self-contained file you can open anywhere or forward.

The report contains:

- the context: where and how it was tested, the branch and the git state;
- KPIs per status: fixed, mitigated, not a code issue, pending;
- one card per issue: the QA's message, the QA screenshots as **Before**, the cause, the fix, the
  files changed, a table of measurements (element, viewport, property, before, after), and the
  **After** screenshots from Claude, side by side;
- optional notes per issue.

If Claude writes no `informe.json`, the bot falls back to an `informe.md` and tells you when it
finds no report at all. Write `continue`, and Claude produces it.

## 8. Using a Telegram group

The bot can work in a group instead of a private chat.

1. In BotFather, send `/setprivacy`, pick your bot and choose **Disable**. Otherwise the bot only
   receives commands in groups, not plain text or screenshots.
2. Remove the bot from the group and add it again, so the change applies.
3. Stop the bot, or make sure `OWNER_ID` and `CHAT_ID` are empty, then write in the group. The
   first message the bot receives there registers its sender as the owner and the group as the
   only chat. From then on it answers only the owner, only in that group.
4. Everyone in the group can read what the bot posts, including plans and reports.
5. Forwards by the owner are accepted whoever wrote the original message. Forwards by anyone
   else are ignored.

If you already registered in a private chat and want to move to a group, edit `.env`, clear
`OWNER_ID` and `CHAT_ID`, run `systemctl --user restart issue-bot` and write in the group.

## 9. Updating

```
cd issue-bot
git pull --ff-only
npm install
systemctl --user restart issue-bot
```

Restarting while a turn runs cuts that turn. The job survives in `state.json`; write `continue` to resume.

If your clone follows `main` with no local changes, `npm run deploy` does the update more
carefully. It checks that the clone is on `main` and clean, fetches `origin/main`, runs the tests
on it in a temporary worktree, and then waits for the bot to finish its current turn before
fast-forwarding the clone and restarting it. If anything fails after the bot stops, it returns to
the previous commit and starts the bot anyway. It needs the service installed first. The bot
announces the new commit on Telegram.

Re-run `bin/install-service.sh` when `systemd/issue-bot.service.in` changes or when you move the
clone. It overwrites the unit file, so do not hand-edit the installed copy.

## 10. Troubleshooting

Start with the logs:

```
journalctl --user -u issue-bot -n 100 --no-pager
```

**The bot does not answer.**
- The service is not running: `systemctl --user status issue-bot`.
- Another person or chat registered first. Check `OWNER_ID` and `CHAT_ID` in `.env`. The bot ignores
  every other user and chat without a message. Fix the values and restart.
- In a group, privacy mode is on. See step 8.
- The token is wrong or revoked. The log shows a 401 error. Fix `TELEGRAM_TOKEN`.

**Exit code 1 or 70.**
- Code 1 is a configuration error: missing `TELEGRAM_TOKEN`, an invalid `CHROMIUM_BIN`, or no
  `node`. systemd does not retry it. Read the log line, fix `.env`, and run
  `systemctl --user restart issue-bot`.
- Code 70 is an unexpected crash. systemd restarts the bot with an increasing delay, from 10 s up
  to 5 min.

**Two processes with the same token.** If you started `node src/bot.js` by hand while the service
runs, they fight over Telegram updates. Stop the manual one. Use only the service.

**"Site not detected" or the bot asks which site.**
- Check that `SITES_ROOT/<site>` exists and has a `.wp-create.json` with the host (section 3).
- For Apache, check that `VHOST_DIR` contains `httpd-*.conf` files and that the `DocumentRoot` is
  inside `SITES_ROOT`.
- With nginx, or anything else, use `/new <site>`.
- The index is rebuilt on every detection. No restart is needed.

**`claude` is not logged in for the service user.** The service runs as your user, but it does not
read your shell profile. Run `claude login` as that user. If the bot cannot find the binary, set
`CLAUDE_BIN` to the full path (`command -v claude`). The unit's `PATH` is
`/usr/local/bin:/usr/bin`, and `bin/start.sh` adds `~/.local/bin` and the node folder.

**The sandbox fails or `bwrap` is missing.** The bot starts Claude with a sandbox that must be
available. Install bubblewrap (section 2) and test `bwrap --version`. Some distributions restrict
unprivileged user namespaces, which bubblewrap needs (Ubuntu 24.04 and later do this through
AppArmor). If `bwrap --version` works but the sandbox still fails, check your distribution's
documentation for allowing `bwrap` to create user namespaces.

**Chromium cannot be found, or fails.** Set `CHROMIUM_BIN` to a name that exists on your `PATH`
and is in the allowed list: `chromium`, `chromium-browser`, `google-chrome`,
`google-chrome-stable`. A full path is not accepted. On Ubuntu use `chromium-browser`.

**Permission buttons stop working.** A permission request waits 30 minutes. After that it is
denied and the message reads "Denied (timed out)". A turn is cut after 45 minutes. Both limits are
in `src/config.js` (`permissionTimeoutMs`, `turnTimeoutMs`). A restart also drops pending
requests and the "allow for this job" memory. Write `continue`, and Claude asks again.

**The bot refuses to start the turn: `disableAllHooks` or `sandbox`.** The bot enforces its policy
with a hook and defines the sandbox itself. If the site's settings, your user settings or managed
settings set `disableAllHooks`, or any `sandbox` key, the bot refuses to run Claude. Remove the
setting (check `.claude/settings.json` and `.claude/settings.local.json` in the site, and
`~/.claude/settings.json`), then write `continue`.

**An image is missing from the report.** The bot lists the images it could not find after the
report. Claude must save them under the job's `img/` folder. Write a correction asking for them.

## 11. Security and uninstall

Read the **Security** and **Permission policy** sections of the [README](../README.md#security).
In short:

- The bot gives Telegram-driven access to your sites' files. Use it on local copies only.
- Only the owner is obeyed, in one chat.
- The token is the key. Keep `.env` at mode 600 and out of git.
- Claude cannot commit or push, and shell commands run in a sandbox with no network.

### Uninstall

```
systemctl --user disable --now issue-bot
rm ~/.config/systemd/user/issue-bot.service
systemctl --user daemon-reload
```

Then delete the clone folder. Job folders and reports stay in `AUDITS_ROOT`. Delete them if you no
longer need them. If you do not use other user services, you can also run
`loginctl disable-linger "$USER"`. In BotFather, send `/revoke` or `/deletebot` to retire the
token.
