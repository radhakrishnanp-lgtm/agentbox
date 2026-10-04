# agentbox

A self-hosted gateway that keeps your AI coding CLI logins (Claude Code, Grok, Kimi and others) on one VPS you control. You reach them from any browser through a web terminal protected by passkeys, and GPU servers join through locked-down reverse SSH tunnels that never see your AI credentials.

**Status:** Milestones 1 and 2 of 7 are done: setup, passkey sign-in, authenticator app, recovery codes, sessions, audit log, the key gateway below, and web terminals with an encrypted vault for CLI logins. Device approval comes next. See [PROJECT_STATE.md](PROJECT_STATE.md).

## Signing in

Sign in with a passkey. On a computer that has none, you can also use a password plus the code from your authenticator app, once you turn that on in **Security**. The password is stored only as a scrypt hash, it never works without a fresh authenticator code, and 5 wrong tries pause it while passkeys keep working. Actions that change your sign-in methods, like adding a passkey or changing the password, still ask for your passkey unless you signed in within the last 5 minutes.

## Terminals in your browser

Open a terminal on the server from any browser, phone included. Sessions keep running when you close the tab. Install your AI CLIs there and sign in once: their logins live in an encrypted vault on the server, locked with a password only you know. See [docs/TERMINALS.md](docs/TERMINALS.md), including what the vault can and can't protect against.

## Use the AI CLIs directly on any computer

Add your AI keys to agentbox once, then run one command on a GPU server or laptop:

```sh
curl -fsSL https://agent.example.com/machine.sh | sh      # Linux, macOS
irm https://agent.example.com/machine.ps1 | iex          # Windows (PowerShell)
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
