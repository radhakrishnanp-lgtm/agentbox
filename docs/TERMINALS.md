# Terminals and the vault

agentbox gives you terminals on the server in your browser. Sessions run in tmux, so they keep going when you close the tab, and you can pick them up again from any signed-in device, phone included.

This is where you install your AI CLIs (Claude Code, Codex, Grok, Kimi, Gemini or anything else) and sign in to them once. Their logins stay on this server.

## Using it

1. Open **Terminals** and create the vault. Pick a password of at least 12 characters and keep it in your password manager. Creating the vault asks for your passkey.
2. Open a **Shell** session and install what you need. No sudo is needed: installs go into your home folder, which is inside the vault.

   ```sh
   curl -fsSL https://claude.ai/install.sh | bash   # Claude Code (native installer)
   npm install -g @anthropic-ai/claude-code         # or with npm; agentbox's Node.js is on PATH
   ```

3. Run the CLI and sign in. Sign-in links open in a new browser tab.
4. Next time, pick a preset (Claude Code, Codex, Grok, Kimi, Gemini) to start a session straight into that CLI. When the CLI exits, a normal shell stays open.

On a phone, the bar under the terminal has the keys phones lack: Esc, Tab, Shift-Tab, Ctrl and Alt (tap, then the next key), arrows, Ctrl-C, Paste and a keyboard toggle.

## What the vault protects

The terminals run as their own Linux user (`dev` by default). Its home folder, where CLIs keep their logins, settings and installed tools, is a [gocryptfs](https://nuetzlich.net/gocryptfs/) encrypted folder:

- **Locked** (after a restart, or when you press Lock): only ciphertext on disk, in `/var/lib/agentbox-vault/cipher`. File names are encrypted too. A copied disk, snapshot or backup shows nothing useful.
- **Unlocked**: the files are readable only by the terminal service itself. Other users, other services and root processes that simply read files get "Permission denied". This was tested with root running `ls` and `cat` on the unlocked home.
- The password is never stored, unless you turn on **auto-unlock after restart**. Then agentbox keeps a copy encrypted with its own key (`/etc/agentbox/secrets.env`, root only), and anyone who has both the database and that key can open the vault. Turning it off deletes the copy.
- Wrong passwords are counted: 5 in 15 minutes pause unlocking, and the pause doubles each time.

### What it can't protect against

**A determined root user can still get in while the vault is unlocked**, for example by running a program as the terminal user with the right groups, or by reading the memory of the running processes. No software on a server can stop its own root. So anything that has root on the host can reach your CLI logins while the vault is open, and that includes anything that controls Docker: on a Docker host, every container with the Docker socket mounted is effectively root.

What helps:

- Keep the number of things with root or Docker access small. Remove the Docker socket from containers that don't strictly need it.
- Lock the vault when you won't use the terminals for a while. Locking stops every session.
- Leave auto-unlock off, so a reboot always locks it.
- Sign in to CLIs with scoped or revocable credentials where the provider offers them, and revoke them if the server is ever compromised.

## How it works

```
browser ──wss──▶ agentbox-web ──unix socket──▶ agentbox-termd (user dev) ──▶ tmux ──▶ bash / CLIs
                 (passkey session,              group agentbox-term only       │
                  same-origin check)                                           └── home = gocryptfs mount
```

- `agentbox-web` checks the session and device on connect, re-checks every 30 seconds, and cuts the connection the moment you sign out or the session ends. Typing counts as activity for the idle timeout. Connections must come from agentbox's own origin, at most 10 a minute, and input is capped at 256 KB/s.
- `agentbox-termd` runs as `dev` and holds no agentbox secrets. It passes session names and preset commands to tmux as single arguments, never through a shell.
- Terminals start with a clean environment: nothing from the services' own environment (keys, secrets) leaks in.
- Restarting or updating agentbox keeps sessions running and the vault unlocked.

## Troubleshooting

| Problem                                            | What to do                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| "The terminal service isn't running"               | `sudo agentbox status`, then `sudo agentbox logs`.                                                            |
| Unlock fails with "fusermount … Permission denied" | `/dev/fuse` must be mode 0666 (Ubuntu's default). The installer fixes this; re-run it.                        |
| Forgot the vault password                          | There is no recovery. On the locked screen, choose "Forgot the password?" to delete the vault and start over. |
