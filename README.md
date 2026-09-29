# agentbox

A self-hosted gateway that keeps your AI coding CLI logins (Claude Code, Grok, Kimi and others) on one VPS you control. You reach them from any browser through a web terminal protected by passkeys, and GPU servers join through locked-down reverse SSH tunnels that never see your AI credentials.

**Status:** Milestone 1 of 7 is done (setup, passkey sign-in, authenticator app, recovery codes, sessions, audit log, web UI). The web terminal comes next, then the installer. See [PROJECT_STATE.md](PROJECT_STATE.md).

Installing on a server isn't supported yet. The installer (`deploy/install.sh` for Ubuntu 24.04) arrives right after the web terminal.

## Development

Needs Node 24 and pnpm 10.

```sh
pnpm install
cp .env.example .env            # then fill in the two secrets it describes
pnpm dev:server                 # API on 127.0.0.1:8080
pnpm dev:web                    # UI on http://localhost:5173
pnpm --filter @agentbox/server admin setup-link   # prints the one-time setup link
```

Checks:

```sh
pnpm check                      # format, lint, typecheck, unit and integration tests
pnpm --filter @agentbox/web build && pnpm test:e2e   # real browser with a virtual passkey
```

## License

BSD 3-Clause. See [LICENSE](LICENSE).
