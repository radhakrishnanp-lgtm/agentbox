# Install agentbox on a server that already runs websites: instructions for an AI agent

> **Human:** give this whole file to an AI agent that has a **root shell on the server itself** (for example Claude Code or Codex over SSH). An agent that runs inside a Docker container can't do this safely. Fill in the two values below first. The agent will check the server, show you a plan, wait for your "yes", install, and hand back to you for the passkey step.

```
DOMAIN   = agent.example.com        # a NEW subdomain just for agentbox
REPO_URL = https://github.com/radhakrishnanp-lgtm/agentbox
```

Use this guide when something already owns ports 80 and 443: Dokploy, Coolify, a Traefik container, nginx, Apache or Caddy. For an empty server, use [AGENT_INSTALL_PLAIN_VPS.md](AGENT_INSTALL_PLAIN_VPS.md).

> **Important security note:** on a server shared with other apps, anything that can control Docker, or any compromised app running as root, can read the AI logins that agentbox keeps. That includes Dokploy admins and AI agents with the Docker socket. A small dedicated VPS is safer, and this server can later join it as a node. Make sure the owner knows this before you continue.

---

## Agent: your job and your rules

You are installing **agentbox**, a self-hosted gateway that keeps the owner's AI coding tool logins behind passkey sign-in. Follow these rules exactly:

1. **Ask before you change anything.** First run the read-only checks, show the owner the plan, and wait for an explicit "yes".
2. **Never read, print, copy or send secrets.** That includes `/etc/agentbox/secrets.env`, `/var/lib/agentbox/`, `acme.json`, SSH keys, tokens, `.env` files and passwords in proxy configs.
3. **Never create the setup link yourself.** Don't run `agentbox setup-link`. The owner runs it in their own SSH session.
4. **Only use the official installer** (`deploy/install.sh` from `REPO_URL`).
5. **Don't break the existing sites.** Don't restart, remove or reconfigure other containers or services. Don't edit other apps' proxy routes. Before you edit any shared config file (nginx or Apache), back it up and test the config (`nginx -t` or `apachectl configtest`) before reloading.
6. **Don't weaken security.** Don't open ports, disable firewalls or change SSH. If a step fails, stop and report the exact error and the last 30 log lines.
7. You need a **real root shell on the host** (`id -u` prints `0`, or `sudo -n true` works). If `/.dockerenv` exists, you are in a container: **stop**. Never use the Docker socket, `docker run --privileged` or host bind mounts to reach the host.

## Step 1: check the server (read-only)

```bash
id -u; test -f /.dockerenv && echo "INSIDE A CONTAINER: stop"
. /etc/os-release; echo "$PRETTY_NAME $(uname -m)"
df -h / | tail -1; free -h | sed -n 2p
sudo ss -Hltnp '( sport = :80 or sport = :443 )'
command -v docker >/dev/null && sudo docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
getent ahosts "$DOMAIN" | awk '{print $1}' | sort -u
```

Work out which **proxy mode** applies:

| What owns 80/443                                                    | Mode       | Notes                                                                                                                                               |
| ------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A container named `dokploy-traefik` (Dokploy)                       | `traefik`  | Detected automatically. The route goes in `/etc/dokploy/traefik/dynamic/`.                                                                          |
| Another Traefik container with a file provider (Coolify and others) | `traefik`  | Pass `--traefik-dir <host path of its dynamic config dir>`. If its cert resolver isn't called `letsencrypt`, also pass `--traefik-resolver <name>`. |
| nginx, Apache, Caddy or anything else on the host                   | `external` | agentbox listens on `127.0.0.1:8787`, and you add a site to the existing proxy in step 5.                                                           |

**DNS:** `DOMAIN` must resolve to this server's public IP. If it doesn't, ask the owner to add an **A record**. On Cloudflare, use **DNS only (grey cloud)**, because the existing proxy issues the certificate with Let's Encrypt HTTP-01.

## Step 2: get the code

```bash
sudo git clone "$REPO_URL" /opt/agentbox-src
cd /opt/agentbox-src
```

## Step 3: show the plan and wait

```bash
sudo ./deploy/install.sh --domain "$DOMAIN" --check                  # Dokploy: detects Traefik
sudo ./deploy/install.sh --domain "$DOMAIN" --proxy external --check  # nginx, Apache...
```

Send the owner the "install plan" block. Say it will:

- install Node.js 24, tmux and git;
- create the service users `agentbox` and `agentbox-build`;
- run agentbox on a private address only the proxy can reach;
- add one route for `DOMAIN` to the existing proxy;
- in Traefik mode with ufw active, add one firewall rule letting only the proxy's Docker network reach agentbox's port.

It does **not** install Caddy, change existing routes, or enable or disable the firewall. **Wait for "yes".**

## Step 4: install

```bash
sudo ./deploy/install.sh --domain "$DOMAIN" --yes                    # traefik (auto)
sudo ./deploy/install.sh --domain "$DOMAIN" --proxy external --yes   # external
```

## Step 5: connect the proxy (external mode only)

Traefik mode needs nothing here: Traefik picks up `agentbox.yml` by itself within a few seconds.

For **nginx**, the installer prints a server block. Save it as `/etc/nginx/sites-available/agentbox`, fill in the certificate lines the way the other sites on this server do (for example certbot: `sudo certbot --nginx -d $DOMAIN`), link it into `sites-enabled`, then run `sudo nginx -t && sudo systemctl reload nginx`. Make sure a `map $http_upgrade $connection_upgrade` block exists in the `http {}` section, because the terminal needs WebSockets.

For **Apache** or **Caddy**, set up an equivalent reverse proxy to `http://127.0.0.1:8787` that:

- passes the `Host` header;
- sets `X-Forwarded-For` to the client IP;
- sets `X-Forwarded-Proto: https`;
- supports WebSocket upgrades;
- does not buffer or compress responses under `/gw/`, and accepts request bodies up to 32 MB there, because the key gateway streams AI answers through it.

## Step 6: verify

```bash
curl -fsS "https://$DOMAIN/healthz"   # expect {"ok":true}
sudo agentbox status | head -5         # expect active (running)
```

Also check that the owner's other sites still load, and say so in your report.

- **Traefik returns 404:** check that `agentbox.yml` is in the dynamic directory and that the Traefik logs show no error (`sudo docker logs --tail 50 dokploy-traefik`).
- **Traefik returns 502:** a firewall is blocking the Docker network from reaching agentbox's port. Report it; don't open ports yourself.

## Step 7: hand over to the owner

Tell the owner, word for word:

> agentbox is installed at https://DOMAIN. To finish, connect to the server over SSH yourself (not through me) and run:
>
> `sudo agentbox setup-link`
>
> Open the link it prints on the phone or computer where you want your passkey. It works once, for 30 minutes. You'll create a passkey, scan a QR code with an authenticator app, and save 10 recovery codes somewhere safe.
>
> Please back up `/etc/agentbox/secrets.env` and `/var/lib/agentbox` together, somewhere off this server.
>
> To use claude, codex, grok, kimi or gemini directly on another computer without keeping keys there, open agentbox → Machines, add your AI keys, then add a machine and follow the steps it shows (docs/MACHINES.md in the repository).

## Step 8: report

Send one short report:

- the proxy mode used and the route you added;
- the installer's ✓ and `!` lines;
- the results from step 6;
- confirmation that the existing sites still work.

Also list, without fixing them, any ports you saw open to the internet that aren't 22, 80 or 443. Docker publishes ports around ufw, so recommend that the owner restrict them with the cloud provider's firewall.

## Later

- **Update:** `sudo agentbox update`.
- **Logs:** `sudo agentbox logs`.
- **Remove the route:** delete `agentbox.yml` from the Traefik dynamic directory, or the nginx site, then `sudo systemctl disable --now agentbox-web`.
