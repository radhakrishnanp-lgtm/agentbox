# agentbox

A self-hosted gateway that keeps your AI coding CLI logins (Claude Code, Grok, Kimi and others) on one VPS you control. You reach them from any browser through a web terminal protected by passkeys, and GPU servers join through locked-down reverse SSH tunnels that never see your AI credentials.

**Status:** Milestone 1 of 7 is done (setup, passkey sign-in, authenticator app, recovery codes, sessions, audit log, web UI), the installer is ready, and so is the key gateway below. The web terminal comes next. See [PROJECT_STATE.md](PROJECT_STATE.md).

## Use the AI CLIs directly on any computer

Add your AI keys to agentbox once, then run one command on a GPU server or laptop:

```sh
curl -fsSL https://agent.example.com/machine.sh | sh
```

After that, `claude`, `codex`, `grok`, `kimi` and `gemini` work there as usual, but the computer only holds an agentbox pass that you can stop from your phone. The real keys never leave the VPS. See [docs/MACHINES.md](docs/MACHINES.md).

## Install

See [docs/install](docs/install/README.md). There are two step-by-step guides you can hand to an AI agent on your server: one for a fresh VPS and one for a server that already runs websites (Dokploy, Traefik, nginx...). The installer supports Ubuntu 24.04 and 26.04.

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
