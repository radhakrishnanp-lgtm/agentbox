# Project state

Updated 2026-09-29. Plan: `MASTER_PLAN.md` (in the project files).

## Milestones

| #   | Milestone                                                                          | State    |
| --- | ---------------------------------------------------------------------------------- | -------- |
| 1   | Foundation: setup link, passkey, TOTP, recovery codes, sessions, audit log, web UI | **Done** |
| 2   | Web terminal over tmux (agentbox-termd as `dev`)                                   | Next     |
| 3   | Device approval with number matching, sessions list, IP re-check, fail2ban         | Planned  |
| 4   | GPU nodes: enrollment, connect.sh, tunnel-keys, tunnelctl, sshd test in CI         | Planned  |
| 5   | Panic button, audit UI filters, Telegram alerts                                    | Planned  |
| 6   | install.sh, backups, README / ARCHITECTURE / API / SECURITY / RUNBOOK              | Planned  |
| 7   | Hardening and ship check                                                           | Planned  |

## How to check the code

```sh
pnpm install
pnpm check                      # format, lint, typecheck, 58 unit/integration tests
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

## Installer test record (2026-09-29)

Tested in a systemd lab (privileged containers), with a real Chromium and a virtual passkey going through the installed proxy:

| Case                               | Result                                                                                                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ubuntu 24.04, Caddy mode           | Install, re-run (secrets kept, 3 releases kept), reboot recovery, and full setup + passkey sign-in over HTTPS. Cookies are `__Host-`, Secure, SameSite=Strict, and the real client IP is recorded. |
| Ubuntu 26.04, Caddy mode           | Install and full sign-in journey. systemd 259 can't boot on the lab's cgroup v1 host, so services ran through a lab-only systemctl stand-in; the unit itself was verified on 24.04.                |
| Traefik v3.6 mode (Dokploy layout) | File-provider route, secure cookies, and the client IP taken from X-Forwarded-For only when it comes from the trusted subnet. Upstream detection verified for bridge and Swarm overlay networks.   |
| Proxy mode switches                | traefik → external → re-run: old routes removed, and trusted proxies not carried across modes.                                                                                                     |

Not covered by the lab: real Let's Encrypt issuance (the lab uses `tls internal`), and Caddy's official apt repository (blocked by the lab's network, so the Ubuntu-package fallback was used).
