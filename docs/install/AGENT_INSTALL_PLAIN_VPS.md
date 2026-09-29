# Install agentbox on a fresh VPS: instructions for an AI agent

> **Human:** give this whole file to the AI agent that has a root shell on your new server (for example Claude Code or Codex over SSH). Fill in the two values below first. The agent will check the server, show you a plan, wait for your "yes", install, and hand back to you for the passkey step, which only you can do.

```
DOMAIN   = agent.example.com        # the address you will open agentbox at
REPO_URL = https://github.com/radhakrishnanp-lgtm/agentbox
```

Use this guide for a server that runs nothing else, or nothing on ports 80 and 443. If the server already hosts websites (Dokploy, Coolify, Traefik, nginx, Apache...), use [AGENT_INSTALL_EXISTING_SERVER.md](AGENT_INSTALL_EXISTING_SERVER.md) instead.

---

## Agent: your job and your rules

You are installing **agentbox**, a self-hosted gateway that keeps the owner's AI coding tool logins on this one server behind passkey sign-in. Security is the whole point, so follow these rules exactly:

1. **Ask before you change anything.** First run the read-only checks, show the owner the plan, and wait for an explicit "yes".
2. **Never read, print, copy or send secrets.** That includes `/etc/agentbox/secrets.env`, anything in `/var/lib/agentbox/`, SSH private keys, tokens and `.env` files. Don't paste file contents that might hold them.
3. **Never create the setup link yourself.** Don't run `agentbox setup-link`. Whoever opens that link first becomes the owner, so the owner must run it in their own SSH session.
4. **Only use the official installer** (`deploy/install.sh` from `REPO_URL`). Don't pipe scripts from other sites into a shell, and don't hand-edit what the installer manages.
5. **Don't weaken security to make something work.** Don't open extra ports, disable the firewall, turn off TLS, or change SSH settings. If a step fails, stop and report the exact error and the last 30 log lines.
6. **Don't touch other software** on the server beyond what the installer does.
7. You need a **real root shell on the host** (`id -u` prints `0`, or `sudo -n true` works). If `/.dockerenv` exists or you are otherwise inside a container, **stop**. Tell the owner to run the commands over SSH themselves. Never use the Docker socket or privileged containers to reach the host.

## Step 1: check the server (read-only)

Run these and keep the output for your report:

```bash
id -u; test -f /.dockerenv && echo "INSIDE A CONTAINER: stop"
. /etc/os-release; echo "$PRETTY_NAME $(uname -m)"
df -h / | tail -1; free -h | sed -n 2p
sudo ss -Hltnp '( sport = :80 or sport = :443 )'
getent ahosts "$DOMAIN" | awk '{print $1}' | sort -u
hostname -I
```

What to look for:

- **OS:** must be Ubuntu 24.04 or 26.04 on x86_64 or arm64.
- **Ports 80 and 443:** must be free. If a program is listening on them, stop and switch to the other guide.
- **DNS:** `DOMAIN` must resolve to this server's public IP. If it doesn't, ask the owner to add an **A record** (and AAAA for IPv6) at their DNS provider. On **Cloudflare**, set it to **DNS only (grey cloud)**, not proxied. Then wait until it resolves.
- **Provider firewall:** if the cloud provider has one (Hetzner, AWS, Oracle, DigitalOcean...), ask the owner to allow TCP 22, 80 and 443, plus UDP 443.

## Step 2: get the code

```bash
sudo git clone "$REPO_URL" /opt/agentbox-src
cd /opt/agentbox-src
```

If the repository is private, ask the owner how they want you to authenticate. Don't ask them to paste a token into chat.

## Step 3: show the plan and wait

```bash
sudo ./deploy/install.sh --domain "$DOMAIN" --check
```

Send the owner the "install plan" block. Say it will:

- install Caddy for HTTPS, Node.js 24, tmux and git;
- create the service users `agentbox` and `agentbox-build`;
- set the firewall to allow only SSH, 80 and 443;
- set up fail2ban for SSH.

**Wait for "yes".** If the owner wants a Let's Encrypt contact email, add `--email them@example.com` in the next step.

## Step 4: install

```bash
sudo ./deploy/install.sh --domain "$DOMAIN" --yes
```

This takes a few minutes and ends with "agentbox is installed". It is safe to run again.

## Step 5: verify

```bash
curl -fsS "https://$DOMAIN/healthz"      # expect {"ok":true}
sudo agentbox status | head -5            # expect active (running)
sudo ufw status                           # expect 22, 80, 443 allowed
```

If HTTPS doesn't work yet, the cause is almost always one of these: DNS isn't pointing here, Cloudflare is proxying (orange cloud), or the provider firewall blocks port 80 or 443. Caddy keeps retrying the certificate by itself. Its log is at `sudo journalctl -u caddy -n 50`.

## Step 6: hand over to the owner

Tell the owner, word for word:

> agentbox is installed at https://DOMAIN. To finish, connect to the server over SSH yourself (not through me) and run:
>
> `sudo agentbox setup-link`
>
> Open the link it prints on the phone or computer where you want your passkey. It works once, for 30 minutes. You'll create a passkey, scan a QR code with an authenticator app, and save 10 recovery codes somewhere safe.
>
> Please back up `/etc/agentbox/secrets.env` and `/var/lib/agentbox` together, somewhere off this server.

## Step 7: report

Send one short report:

- the server (OS, CPU architecture) and the domain;
- what was installed (the installer's ✓ lines);
- the result of each check in step 5;
- any warnings (`!` lines), each with a one-line explanation.

## Later

- **Update:** `sudo agentbox update` pulls the latest code and reinstalls, keeping data and secrets.
- **Logs:** `sudo agentbox logs`.
- **Lost all passkeys and the authenticator app:** `sudo agentbox setup-link --reset` (over SSH).
- **Advice for the owner:** don't leave AI agents running as root on this server. The AI tools will run inside agentbox as the unprivileged `dev` user.
