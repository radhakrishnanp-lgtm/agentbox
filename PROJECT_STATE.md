# Project state

Updated 2026-09-29. Plan: `MASTER_PLAN.md` (in the project files).

## Milestones

| #   | Milestone                                                                          | State    |
| --- | ---------------------------------------------------------------------------------- | -------- |
| 1   | Foundation: setup link, passkey, TOTP, recovery codes, sessions, audit log, web UI | **Done** |
| 1b  | Key gateway: AI keys stay on the VPS, machines get a revocable pass                | **Done** |
| 2   | Web terminal over tmux (agentbox-termd as `dev`) with an encrypted vault           | **Done** |
| 3   | Device approval with number matching, sessions list, IP re-check, fail2ban         | Next     |
| 4   | GPU nodes: enrollment, connect.sh, tunnel-keys, tunnelctl, sshd test in CI         | Planned  |
| 5   | Panic button, audit UI filters, Telegram alerts                                    | Planned  |
| 6   | install.sh, backups, README / ARCHITECTURE / API / SECURITY / RUNBOOK              | Planned  |
| 7   | Hardening and ship check                                                           | Planned  |

## How to check the code

```sh
pnpm install
pnpm check                      # format, lint, typecheck, unit/integration tests
pnpm --filter @agentbox/web build
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium pnpm test:e2e   # real browser + virtual passkey
```

Coverage (Milestone 1): 92% statements, 81% branches, 93% functions, 95% lines.

## Milestone 1 quality gate

Red-team pass on the UI and API (attack → defence → proof):

1. Setup link leaks through history or Referer → token lives in the URL fragment (never sent to the server), is moved out of the address bar on load, Referrer-Policy is no-referrer, and the link is single-use for 30 min → e2e reuses the link and gets "not valid".
2. Stored XSS through device names or user agents shown in Activity → React escaping only, no raw-HTML sinks in the UI, CSP `script-src 'self'` → e2e fails on any console CSP violation.
3. CSRF from another site → Origin must match, Sec-Fetch-Site same-origin, custom `X-Agentbox` header, SameSite=Strict → http-security tests.
4. Stolen session cookie used from another browser → session is bound to the device cookie; a new browser needs passkey plus TOTP → auth tests and e2e second device.
5. TOTP code replay → per-owner last-step compare-and-set → auth test; the e2e has to use the next time step.
6. Locking yourself out by deleting the last passkey → server refuses, UI disables the button → security tests.
7. Clickjacking the approve/remove buttons → `frame-ancestors 'none'` and X-Frame-Options DENY.

Fixed during review: setup token survives blocked storage (memory fallback); HEAD requests for app pages no longer 404.

Known gaps carried forward:

- CSP still allows inline styles (Radix, xterm.js); revisit in Milestone 2.
- Web bundle is ~500 KB (154 KB gzipped) because Zod validation is shared with the browser.
- Recovery codes can't be regenerated from the UI yet (Milestone 3).
- Approving a new device from an already signed-in device comes in Milestone 3; today it's passkey + TOTP.

## Key gateway test record (2026-09-29)

Installed in the Ubuntu 24.04 lab in Caddy mode over HTTPS, with an HTTPS stand-in provider that records what it receives. A machine user ran `curl … /machine.sh | sh`, then each real CLI:

| CLI                                        | Result                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Claude Code 2.1.284                        | Answer streamed back; provider got the real key in `x-api-key`, never the pass.                                          |
| Codex 0.159                                | Answer over `/v1/responses`; usage counted.                                                                              |
| Official xAI grok and open-source Grok CLI | Both answered; `/v1/models` and `/v1/api-key` passed through.                                                            |
| Kimi Code 2.1.1                            | Answer over `/v1/chat/completions` with the key's model.                                                                 |
| Gemini CLI 0.61                            | Answer over `generateContent` and `streamGenerateContent` (SSE).                                                         |
| All, after Stop                            | Refused at once with "this machine was stopped in agentbox" (403, so Claude Code no longer retries a 401 for 3 minutes). |

The provider log never contained `abx_`. Recipes were first checked in an isolated network namespace, which showed no other traffic (telemetry, update checks, stored logins). Not covered: real provider endpoints (no real keys were used) and interactive TUIs in the lab (checked only in the isolated runner).

## Terminals test record (2026-09-29)

Automated: termd with real tmux and gocryptfs (create, rename, kill, unsafe names, clean environment, detach keeps the session, vault create/lock/unlock/reset, only ciphertext on disk after lock); the web API and WebSocket against a real termd (session and origin checks, cut-off at sign-out, typing keeps the session alive, service down, fresh passkey for vault create/reset/auto-unlock, wrong-password lockout, auto-unlock after restart); and the Playwright journey (open a terminal, type, see output, detach, close).

Lab (Ubuntu 24.04, Caddy mode, installed with `deploy/install.sh`, real Chromium and a virtual passkey):

| Check                                   | Result                                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Create the vault in the browser         | Home is a `fuse.gocryptfs` mount owned by `dev`.                                                                                                |
| Install Claude Code in the web terminal | `npm install -g @anthropic-ai/claude-code` → `~/.local/bin/claude`, `2.1.284 (Claude Code)`; its first-run screen renders on desktop and phone. |
| Root reads the unlocked vault           | `ls /home/dev` and `cat /home/dev/.npmrc` as root: Permission denied.                                                                           |
| Restart agentbox-termd                  | The session keeps running.                                                                                                                      |
| Lock                                    | Sessions stop, home is empty, the ciphertext has no readable names or contents.                                                                 |
| Unlock (wrong, then right password)     | Wrong one refused; after unlock Claude Code is still installed.                                                                                 |

Not covered: the native Claude Code installer (`claude.ai/install.sh`; its download host is blocked in the lab), signing in to a real CLI account (no real credentials are used in tests), and real reboots with auto-unlock (covered by the integration test of the auto-unlock loop).

## Installer test record (2026-09-29)

Tested in a systemd lab (privileged containers), with a real Chromium and a virtual passkey going through the installed proxy:

| Case                               | Result                                                                                                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ubuntu 24.04, Caddy mode           | Install, re-run (secrets kept, 3 releases kept), reboot recovery, and full setup + passkey sign-in over HTTPS. Cookies are `__Host-`, Secure, SameSite=Strict, and the real client IP is recorded. |
| Ubuntu 26.04, Caddy mode           | Install and full sign-in journey. systemd 259 can't boot on the lab's cgroup v1 host, so services ran through a lab-only systemctl stand-in; the unit itself was verified on 24.04.                |
| Traefik v3.6 mode (Dokploy layout) | File-provider route, secure cookies, and the client IP taken from X-Forwarded-For only when it comes from the trusted subnet. Upstream detection verified for bridge and Swarm overlay networks.   |
| Proxy mode switches                | traefik → external → re-run: old routes removed, and trusted proxies not carried across modes.                                                                                                     |

Not covered by the lab: real Let's Encrypt issuance (the lab uses `tls internal`), and Caddy's official apt repository (blocked by the lab's network, so the Ubuntu-package fallback was used).
