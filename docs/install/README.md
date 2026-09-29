# Installing agentbox

agentbox runs on Ubuntu 24.04 or 26.04 (x86_64 or arm64) and needs about 1 GB of RAM and 2 GB of disk.

**Pick one guide.** Each is written so you can hand it to an AI agent that has a root shell on the server. The agent checks the server, shows you a plan, waits for your "yes", installs, then hands the passkey step back to you.

| Your server                                                         | Guide                                                                | What happens                                                            |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| New or empty VPS (recommended)                                      | [AGENT_INSTALL_PLAIN_VPS.md](AGENT_INSTALL_PLAIN_VPS.md)             | Installs Caddy for HTTPS, a firewall and fail2ban.                      |
| Already runs websites (Dokploy, Coolify, Traefik, nginx, Apache...) | [AGENT_INSTALL_EXISTING_SERVER.md](AGENT_INSTALL_EXISTING_SERVER.md) | Adds one route to your existing proxy and leaves everything else alone. |

**Why a dedicated server is recommended:** agentbox keeps your AI tools' logins. On a server that also runs other apps, anything that controls Docker or gets root through another app can read them.

## Doing it by hand

```bash
sudo git clone https://github.com/radhakrishnanp-lgtm/agentbox /opt/agentbox-src
cd /opt/agentbox-src
sudo ./deploy/install.sh --domain agent.example.com --check   # plan only, changes nothing
sudo ./deploy/install.sh --domain agent.example.com           # install (asks to confirm)
sudo agentbox setup-link                                      # run this yourself, then open the link
```

Before you start, point the domain's DNS **A record** at the server. On Cloudflare, use **DNS only (grey cloud)**.

`./deploy/install.sh --help` lists every option. Running the installer again updates in place and never replaces your secrets. `sudo agentbox update` does the same after pulling the latest code.

## What the installer sets up

| Where                                 | What                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `/opt/agentbox/node`                  | Node.js 24, checksum-verified from nodejs.org                                               |
| `/opt/agentbox/releases/*`, `current` | Built app, owned by root and read-only to the service. The three newest releases are kept.  |
| `/etc/agentbox/secrets.env`           | Encryption key and session secret. Root only, generated once. **Back it up.**               |
| `/etc/agentbox/agentbox.env`          | Non-secret settings (domain, listen address)                                                |
| `/var/lib/agentbox`                   | Database, readable only by the `agentbox` user. **Back it up** together with `secrets.env`. |
| `agentbox-web.service`                | Runs as `agentbox` in a systemd sandbox (`systemd-analyze security` score 1.5, "OK")        |
| `/usr/local/sbin/agentbox`            | Root-only admin command: `setup-link`, `audit-verify`, `status`, `logs`, `update`           |

The build runs as the unprivileged `agentbox-build` user, so package build scripts never run as root. No sudo is used at runtime.
