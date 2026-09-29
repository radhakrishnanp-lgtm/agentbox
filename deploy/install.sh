#!/usr/bin/env bash
# agentbox installer for Ubuntu 24.04 and 26.04.
#
#   sudo ./deploy/install.sh --domain agent.example.com            # plain VPS (installs Caddy)
#   sudo ./deploy/install.sh --domain agent.example.com --proxy traefik   # Dokploy / Traefik host
#   sudo ./deploy/install.sh --check --domain agent.example.com    # report only, change nothing
#
# Safe to run again: it updates in place and never regenerates your secrets.
# Every step that needs root says why in a comment. See docs/install/ for the
# guides your AI agent can follow.
set -Eeuo pipefail
umask 022

readonly PREFIX=/opt/agentbox
readonly ETC=/etc/agentbox
readonly BUILD_HOME=/var/cache/agentbox-build
readonly SOCKET=/run/agentbox/web.sock
readonly SERVICE=agentbox-web
readonly TERM_SERVICE=agentbox-termd
readonly TERM_SOCKET=/run/agentbox-termd/termd.sock
readonly VAULT_DIR=/var/lib/agentbox-vault
readonly MIN_FREE_MB=2048
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SRC_DIR

# ── Options ───────────────────────────────────────────────────────────────
DOMAIN="" PROXY="auto" EMAIL="" LISTEN="" TRUSTED="" TLS_INTERNAL=0
TRAEFIK_DIR="/etc/dokploy/traefik/dynamic" TRAEFIK_RESOLVER="letsencrypt"
TRAEFIK_ENTRY_HTTPS="websecure" TRAEFIK_ENTRY_HTTP="web" TRAEFIK_CONTAINER="dokploy-traefik"
FIREWALL=1 ASSUME_YES=0 CHECK_ONLY=0 FORCE_OS=0 UPSTREAM_PORT=8787 TERM_USER=""

usage() {
  cat <<'EOF'
Usage: sudo ./deploy/install.sh --domain <agent.example.com> [options]

  --domain NAME        Public hostname for agentbox (DNS A/AAAA record must point here)
  --proxy MODE         auto (default), caddy, traefik or external
                         caddy     plain VPS: installs Caddy on ports 80/443 with Let's Encrypt
                         traefik   an existing Traefik (Dokploy, Coolify...) owns 80/443
                         external  you run the reverse proxy yourself (nginx, Apache...)
  --email ADDR         Contact email for Let's Encrypt (caddy mode, optional)
  --listen ADDR        traefik/external: address agentbox listens on (default: detected
                       Docker gateway for traefik, 127.0.0.1:8787 for external)
  --trusted-proxies L  traefik/external: IPs/CIDRs allowed to set X-Forwarded-* headers
  --traefik-dir DIR    Traefik file-provider directory (default /etc/dokploy/traefik/dynamic)
  --traefik-resolver N Traefik certificate resolver name (default letsencrypt)
  --no-firewall        Don't touch ufw
  --check              Report what would happen, change nothing
  --yes                Don't ask for confirmation
  --term-user NAME     Linux user the browser terminals run as (default dev; created
                       by the installer, its home is the encrypted vault)
  --tls-internal       caddy: self-signed certificate (testing without public DNS)
  --force-os           Allow an OS other than Ubuntu 24.04/26.04 (untested)
EOF
}

# Previous answers are reused on re-runs and `agentbox update`. Listen address
# and trusted proxies are only reused while the proxy mode stays the same.
SAVED_PROXY=""
load_saved() {
  [[ -r "$ETC/install.conf" ]] || return 0
  local key value
  declare -A saved=()
  while IFS='=' read -r key value; do saved[$key]="$value"; done <"$ETC/install.conf"
  SAVED_PROXY="${saved[PROXY]:-}"
  [[ -n "$DOMAIN" ]] || DOMAIN="${saved[DOMAIN]:-}"
  [[ -n "$EMAIL" ]] || EMAIL="${saved[EMAIL]:-}"
  [[ "$PROXY" != auto ]] || PROXY="${SAVED_PROXY:-auto}"
  if [[ "$PROXY" == "$SAVED_PROXY" ]]; then
    [[ -n "$LISTEN" ]] || LISTEN="${saved[LISTEN]:-}"
    [[ -n "$TRUSTED" ]] || TRUSTED="${saved[TRUSTED]:-}"
  fi
  TRAEFIK_DIR="${saved[TRAEFIK_DIR]:-$TRAEFIK_DIR}"
  TRAEFIK_RESOLVER="${saved[TRAEFIK_RESOLVER]:-$TRAEFIK_RESOLVER}"
  [[ "$FIREWALL" == 0 ]] || FIREWALL="${saved[FIREWALL]:-1}"
  [[ "$TLS_INTERNAL" == 1 ]] || TLS_INTERNAL="${saved[TLS_INTERNAL]:-0}"
  [[ -n "$TERM_USER" ]] || TERM_USER="${saved[TERM_USER]:-}"
}

while (($#)); do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift ;;
    --proxy) PROXY="${2:-}"; shift ;;
    --email) EMAIL="${2:-}"; shift ;;
    --listen) LISTEN="${2:-}"; shift ;;
    --trusted-proxies) TRUSTED="${2:-}"; shift ;;
    --traefik-dir) TRAEFIK_DIR_ARG="${2:-}"; shift ;;
    --traefik-resolver) TRAEFIK_RESOLVER_ARG="${2:-}"; shift ;;
    --no-firewall) FIREWALL=0 ;;
    --check) CHECK_ONLY=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --tls-internal) TLS_INTERNAL=1 ;;
    --term-user) TERM_USER="${2:-}"; shift ;;
    --force-os) FORCE_OS=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# ── Output helpers ────────────────────────────────────────────────────────
if [[ -t 1 ]]; then B=$'\e[1m' G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' N=$'\e[0m'; else B='' G='' Y='' R='' N=''; fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok() { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die() { printf '\n%sError:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
trap 'die "step failed at line $LINENO: $BASH_COMMAND"' ERR

# ── Preflight (read-only) ─────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "run with sudo (root is needed to create service users, systemd units and the proxy config)."
load_saved
TRAEFIK_DIR="${TRAEFIK_DIR_ARG:-$TRAEFIK_DIR}"
TRAEFIK_RESOLVER="${TRAEFIK_RESOLVER_ARG:-$TRAEFIK_RESOLVER}"
[[ -n "$DOMAIN" ]] || { usage >&2; die "--domain is required."; }
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] ||
  die "--domain must be a hostname like agent.example.com (no https://, no path)."
DOMAIN="${DOMAIN,,}"
TERM_USER="${TERM_USER:-dev}"
[[ "$TERM_USER" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || die "--term-user must be a lowercase Linux user name."
TERM_HOME="/home/$TERM_USER"

# shellcheck disable=SC1091
. /etc/os-release
OS_OK=0
[[ "${ID:-}" == ubuntu && ( "${VERSION_ID:-}" == 24.04 || "${VERSION_ID:-}" == 26.04 ) ]] && OS_OK=1
case "$(uname -m)" in x86_64) NODE_ARCH=x64 ;; aarch64) NODE_ARCH=arm64 ;; *) die "unsupported CPU $(uname -m) (need x86_64 or aarch64)." ;; esac

port_owner() { # prints "process" listening on TCP port $1, or nothing
  ss -Hltnp "( sport = :$1 )" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -1 | cut -d'"' -f2 || true
}
OWNER80="$(port_owner 80)" OWNER443="$(port_owner 443)"

has_docker_traefik() {
  command -v docker >/dev/null 2>&1 &&
    docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$TRAEFIK_CONTAINER"
}

if [[ "$PROXY" == auto ]]; then
  if has_docker_traefik; then PROXY=traefik
  elif [[ -z "$OWNER80$OWNER443" || "$OWNER80$OWNER443" =~ ^(caddy)+$ ]]; then PROXY=caddy
  else
    die "ports 80/443 are used by '${OWNER80:-?}/${OWNER443:-?}'. Re-run with --proxy traefik (Dokploy/Coolify Traefik) or --proxy external (nginx, Apache, others)."
  fi
fi
[[ "$PROXY" =~ ^(caddy|traefik|external)$ ]] || die "--proxy must be auto, caddy, traefik or external."
if [[ "$PROXY" == caddy && -n "$OWNER80$OWNER443" && ! "$OWNER80$OWNER443" =~ ^(caddy)+$ ]]; then
  die "caddy mode needs ports 80 and 443, but '${OWNER80:-}${OWNER443:+/$OWNER443}' uses them. Use --proxy traefik or --proxy external."
fi

# Where agentbox listens, and which proxy it believes for client IPs.
detect_traefik_upstream() {
  # Traefik runs in Docker, so it reaches the host through a bridge gateway.
  # Overlay (Swarm) networks reach the host through docker_gwbridge.
  local net driver gw subnet
  for net in $(docker inspect "$TRAEFIK_CONTAINER" -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null); do
    driver="$(docker network inspect "$net" -f '{{.Driver}}' 2>/dev/null || true)"
    if [[ "$driver" == overlay ]]; then net=docker_gwbridge; elif [[ "$driver" != bridge ]]; then continue; fi
    gw="$(docker network inspect "$net" -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' 2>/dev/null | awk '{print $1}')"
    subnet="$(docker network inspect "$net" -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null | awk '{print $1}')"
    if [[ -n "$gw" && -n "$subnet" ]]; then echo "$gw $subnet"; return 0; fi
  done
  return 1
}
if [[ "$PROXY" == traefik ]]; then
  if [[ -z "$LISTEN" ]]; then
    read -r gw subnet < <(detect_traefik_upstream || true) || true
    [[ -n "${gw:-}" ]] || die "couldn't find how Traefik reaches this host. Pass --listen <bridge-gateway-ip>:8787 and --trusted-proxies <subnet>."
    LISTEN="$gw:$UPSTREAM_PORT"; [[ -n "$TRUSTED" ]] || TRUSTED="$subnet"
  fi
  [[ -d "$TRAEFIK_DIR" ]] || die "Traefik file-provider directory $TRAEFIK_DIR not found. Pass --traefik-dir."
elif [[ "$PROXY" == external ]]; then
  [[ -n "$LISTEN" ]] || LISTEN="127.0.0.1:$UPSTREAM_PORT"
fi
if [[ "$PROXY" != caddy ]]; then
  [[ -n "$TRUSTED" ]] || TRUSTED="${LISTEN%%:*}"
  [[ "$LISTEN" =~ ^[0-9.]+:[0-9]+$ ]] || die "--listen must look like 172.18.0.1:8787."
fi

# The terminal user's home becomes the vault's mount point, so it must be a user
# the installer made, never an existing person's account.
TERM_USER_STATE="will be created"
if id "$TERM_USER" >/dev/null 2>&1; then
  if [[ -r "$ETC/term-user" && "$(cat "$ETC/term-user")" == "$TERM_USER" ]]; then TERM_USER_STATE="exists (made by agentbox)"
  else die "a user called '$TERM_USER' already exists. Pick another with --term-user NAME (for example --term-user agentdev)."; fi
fi

SSH_PORTS="$(sshd -T 2>/dev/null | awk '$1=="port"{print $2}' | sort -u | xargs || true)"
[[ -n "$SSH_PORTS" ]] || SSH_PORTS="22"
FREE_MB="$(df -Pm / | awk 'NR==2{print $4}')"
MEM_MB="$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)"
TIME_SYNC="$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)"
if [[ "$TIME_SYNC" != yes ]] && command -v chronyc >/dev/null && chronyc -n tracking 2>/dev/null | grep -q 'Leap status *: Normal'; then TIME_SYNC=yes; fi
RESOLVED="$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
LOCAL_IPS="$(hostname -I 2>/dev/null || true)"
INSTALLED="$(readlink -f "$PREFIX/current" 2>/dev/null || true)"

step "agentbox install plan"
printf '  %-18s %s\n' \
  "Domain" "https://$DOMAIN" \
  "OS" "${PRETTY_NAME:-unknown} ($(uname -m))" \
  "Proxy mode" "$PROXY" \
  "Ports 80/443" "${OWNER80:-free}/${OWNER443:-free}" \
  "agentbox listens" "$([[ "$PROXY" == caddy ]] && echo "unix:$SOCKET (Caddy only)" || echo "$LISTEN (trusting $TRUSTED)")" \
  "DNS for domain" "${RESOLVED:-does not resolve yet}" \
  "This server's IPs" "${LOCAL_IPS:-unknown}" \
  "Terminals run as" "$TERM_USER ($TERM_USER_STATE); home $TERM_HOME is the encrypted vault" \
  "SSH port(s)" "$SSH_PORTS" \
  "Firewall (ufw)" "$([[ "$FIREWALL" == 1 && "$PROXY" == caddy ]] && echo "allow SSH, 80, 443 then enable" || echo "not changed")" \
  "Existing install" "${INSTALLED:-none}"

PROBLEMS=0
((OS_OK)) || { warn "Untested OS ${PRETTY_NAME:-?}; needs Ubuntu 24.04 or 26.04."; ((FORCE_OS)) || PROBLEMS=1; }
((FREE_MB >= MIN_FREE_MB)) || { warn "Only ${FREE_MB} MB free on /; need ${MIN_FREE_MB} MB."; PROBLEMS=1; }
((MEM_MB >= 700)) || warn "Only ${MEM_MB} MB memory available; building may be slow."
[[ "$TIME_SYNC" == yes ]] || warn "Clock sync not confirmed. Authenticator codes need an accurate clock (install chrony or enable systemd-timesyncd)."
[[ -n "$RESOLVED" ]] || warn "$DOMAIN doesn't resolve yet. Add the DNS record before HTTPS can work (Cloudflare: DNS only, grey cloud)."
if [[ "$PROXY" == traefik ]] && command -v docker >/dev/null; then
  warn "Docker hosts: any container or user that controls Docker is effectively root and can read AI logins stored here. A dedicated VPS is safer."
fi
[[ -e /dev/fuse ]] || warn "/dev/fuse is missing, so the terminal vault can't be unlocked (some containers and VPS types lack FUSE)."
if ((PROBLEMS)); then die "fix the problems above first (or pass --force-os for an untested OS)."; fi
if ((CHECK_ONLY)); then ok "Check finished. Nothing was changed."; exit 0; fi
if ((!ASSUME_YES)); then
  [[ -r /dev/tty ]] || die "no terminal to confirm on; re-run with --yes after reviewing the plan (or use --check)."
  read -r -p "Continue? [y/N] " answer </dev/tty
  [[ "$answer" =~ ^[Yy] ]] || die "cancelled, nothing was changed."
fi

# ── 1. Packages ───────────────────────────────────────────────────────────
step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
# Root: apt installs system packages. Build tools are only used to compile
# better-sqlite3 if no prebuilt binary matches.
# tmux keeps terminal sessions alive; gocryptfs and fuse3 encrypt the terminal vault.
PKGS=(ca-certificates curl git tar xz-utils tmux sqlite3 python3 make g++ iproute2 gocryptfs fuse3)
if [[ "$PROXY" == caddy ]]; then PKGS+=(debian-keyring debian-archive-keyring apt-transport-https gnupg ufw fail2ban); fi
apt-get update -qq
apt-get install -y -qq --no-install-recommends "${PKGS[@]}" >/dev/null
ok "${PKGS[*]}"

if [[ "$PROXY" == caddy ]] && ! command -v caddy >/dev/null; then
  # Root: adds Caddy's official signed apt repository so Caddy gets updates.
  # If it can't be reached, falls back to Ubuntu's own (older) caddy package.
  if curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o /tmp/caddy.key 2>/dev/null &&
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /tmp/caddy.list 2>/dev/null; then
    gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg </tmp/caddy.key
    install -m 0644 /tmp/caddy.list /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
  else
    warn "Caddy's apt repository is unreachable; using Ubuntu's caddy package instead."
  fi
  rm -f /tmp/caddy.key /tmp/caddy.list
  apt-get install -y -qq caddy >/dev/null
fi
[[ "$PROXY" != caddy ]] || ok "caddy $(caddy version | awk '{print $1}')"

# ── 2. Users ──────────────────────────────────────────────────────────────
step "Creating service users"
# Root: system users with no login shell. agentbox runs the web app,
# agentbox-build compiles releases so build scripts never run as root.
getent group agentbox-sock >/dev/null || groupadd --system agentbox-sock
id agentbox >/dev/null 2>&1 ||
  useradd --system --gid agentbox-sock --home-dir /var/lib/agentbox --no-create-home --shell /usr/sbin/nologin agentbox
id agentbox-build >/dev/null 2>&1 ||
  useradd --system --user-group --home-dir "$BUILD_HOME" --create-home --shell /usr/sbin/nologin agentbox-build
if [[ "$PROXY" == caddy ]] && ! id -nG caddy | tr ' ' '\n' | grep -qx agentbox-sock; then
  usermod -aG agentbox-sock caddy  # Caddy may connect to the socket; nobody else.
  CADDY_RESTART=1
fi
# The terminal user: a normal shell for the browser terminals, with no password,
# no sudo and no SSH login. Its home starts empty: the vault is mounted there.
# agentbox-web reaches the terminal service through group agentbox-term.
getent group agentbox-term >/dev/null || groupadd --system agentbox-term
if ! id "$TERM_USER" >/dev/null 2>&1; then
  useradd --user-group --home-dir "$TERM_HOME" --no-create-home --shell /bin/bash \
    --comment "agentbox terminals" "$TERM_USER"
  passwd --lock "$TERM_USER" >/dev/null
fi
install -d -m 0755 "$ETC"
echo "$TERM_USER" >"$ETC/term-user"
# While the vault is unlocked, its home is a mount that only that user can open.
# (findmnt reads the mount table; even root can't look inside the mount itself.)
findmnt -rno TARGET --mountpoint "$TERM_HOME" >/dev/null || install -d -m 0700 -o "$TERM_USER" -g "$TERM_USER" "$TERM_HOME"
install -d -m 0700 -o "$TERM_USER" -g "$TERM_USER" "$VAULT_DIR"
id -nG agentbox | tr ' ' '\n' | grep -qx agentbox-term || usermod -aG agentbox-term agentbox
# Root: FUSE mounts need /dev/fuse open to users (Ubuntu's default is 0666; some
# containers ship it as root-only).
if [[ -c /dev/fuse && "$(stat -c %a /dev/fuse)" != 666 ]]; then chmod 0666 /dev/fuse; fi
# Ubuntu 25.04 and later confine fusermount3 with AppArmor, which only allows
# FUSE mounts inside a home folder, /mnt, /media or /tmp: not on a home folder
# itself, where the vault goes. Allow exactly the vault's mount points through
# the profile's own local include, and leave the rest of the profile alone.
AA_PROFILE=/etc/apparmor.d/fusermount3
AA_LOCAL=/etc/apparmor.d/local/fusermount3
if [[ -f "$AA_PROFILE" ]] && grep -q 'local/fusermount3' "$AA_PROFILE"; then
  install -d -m 0755 /etc/apparmor.d/local
  touch "$AA_LOCAL"
  sed -i '/^# >>> agentbox >>>$/,/^# <<< agentbox <<<$/d' "$AA_LOCAL"
  cat >>"$AA_LOCAL" <<AA
# >>> agentbox >>>
# The agentbox terminal vault ($TERM_HOME) and its password check ($VAULT_DIR/verify-*).
mount fstype=@{fuse_types} options=(nosuid,nodev) options in (ro,rw,noatime,dirsync,nodiratime,noexec,sync) -> $TERM_HOME/,
mount fstype=@{fuse_types} options=(nosuid,nodev) options in (ro,rw,noatime,dirsync,nodiratime,noexec,sync) -> $VAULT_DIR/verify-*/,
umount $TERM_HOME/,
umount $VAULT_DIR/verify-*/,
# <<< agentbox <<<
AA
  if command -v apparmor_parser >/dev/null && [[ -d /sys/kernel/security/apparmor ]]; then
    apparmor_parser -r "$AA_PROFILE" || die "AppArmor didn't accept the fusermount3 rules for the vault ($AA_LOCAL)."
  fi
  ok "AppArmor lets fusermount3 mount the vault at $TERM_HOME"
fi
ok "agentbox, agentbox-build, $TERM_USER (terminals), groups agentbox-sock and agentbox-term"

# ── 3. Node.js 24 (verified download) ────────────────────────────────────
step "Installing Node.js 24"
install -d -m 0755 "$PREFIX"
SUMS="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt)"
NODE_TARBALL="$(awk -v a="linux-$NODE_ARCH.tar.xz" '$2 ~ a"$" {print $2}' <<<"$SUMS" | head -1)"
NODE_SHA="$(awk -v f="$NODE_TARBALL" '$2==f {print $1}' <<<"$SUMS")"
NODE_DIR="$PREFIX/${NODE_TARBALL%.tar.xz}"
[[ -n "$NODE_TARBALL" && -n "$NODE_SHA" ]] || die "couldn't read Node.js checksums."
if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/$NODE_TARBALL" -o "$tmp/node.tar.xz"
  echo "$NODE_SHA  $tmp/node.tar.xz" | sha256sum -c --quiet - || die "Node.js download failed its checksum."
  tar -xJf "$tmp/node.tar.xz" -C "$PREFIX" && rm -rf "$tmp"
  chown -R root:root "$NODE_DIR"
fi
ln -sfn "$NODE_DIR" "$PREFIX/node"
ok "$("$PREFIX/node/bin/node" --version) at $PREFIX/node (checksum verified)"

# ── 4. Build a release as the unprivileged build user ────────────────────
step "Building agentbox (this takes a few minutes)"
COMMIT="$(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo local)"
RELEASE="$PREFIX/releases/$(date -u +%Y%m%d%H%M%S)-$COMMIT"
rm -rf "$BUILD_HOME/src" "$BUILD_HOME/out"
install -d -o agentbox-build -g agentbox-build "$BUILD_HOME/src"
# Copy tracked files only: no local .env, databases or node_modules.
if git -C "$SRC_DIR" rev-parse >/dev/null 2>&1; then
  git -C "$SRC_DIR" ls-files -z --cached --others --exclude-standard | (cd "$SRC_DIR" && tar --null -T - -cf -) | tar -xf - -C "$BUILD_HOME/src"
else
  tar -C "$SRC_DIR" --exclude=node_modules --exclude=.git --exclude='.env' --exclude='*.db' -cf - . | tar -xf - -C "$BUILD_HOME/src"
fi
chown -R agentbox-build:agentbox-build "$BUILD_HOME"
BUILD_ENV=(HOME="$BUILD_HOME" PATH="$PREFIX/node/bin:/usr/bin:/bin" COREPACK_HOME="$BUILD_HOME/.corepack"
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1 npm_config_cache="$BUILD_HOME/.npm")
for v in https_proxy HTTPS_PROXY no_proxy NO_PROXY NODE_EXTRA_CA_CERTS; do
  [[ -z "${!v:-}" ]] || BUILD_ENV+=("$v=${!v}")
done
runuser -u agentbox-build -- env -i "${BUILD_ENV[@]}" bash -euo pipefail -c '
  cd "$HOME/src"
  corepack pnpm install --frozen-lockfile --reporter=silent
  corepack pnpm --filter @agentbox/web build >/dev/null
  corepack pnpm --filter @agentbox/server build >/dev/null
  corepack pnpm --filter @agentbox/server deploy --prod --legacy --reporter=silent "$HOME/out/server"
  corepack pnpm --filter @agentbox/termd build >/dev/null
  corepack pnpm --filter @agentbox/termd deploy --prod --legacy --reporter=silent "$HOME/out/termd"
  cp -r apps/web/dist "$HOME/out/web"
  mkdir -p "$HOME/out/deploy" && cp deploy/install.sh "$HOME/out/deploy/"
'
install -d -m 0755 "$PREFIX/releases"
mv "$BUILD_HOME/out" "$RELEASE"
chown -R root:root "$RELEASE" && chmod -R go-w "$RELEASE"  # the app can't modify its own code
ok "release $(basename "$RELEASE")"

# ── 5. Configuration ──────────────────────────────────────────────────────
step "Writing configuration"
install -d -m 0755 "$ETC"
if [[ ! -s "$ETC/secrets.env" ]]; then
  # Generated once and never printed. Only root can read it; systemd passes it
  # to the service at start. Back this file up together with the database.
  (umask 077 && "$PREFIX/node/bin/node" -e '
    const c = require("node:crypto");
    process.stdout.write(`AGENTBOX_ENCRYPTION_KEY=${c.randomBytes(32).toString("base64")}\n` +
      `AGENTBOX_SESSION_SECRET=${c.randomBytes(48).toString("base64url")}\n`);' >"$ETC/secrets.env")
  ok "generated new secrets in $ETC/secrets.env (root only)"
else
  ok "kept existing secrets"
fi
chmod 0600 "$ETC/secrets.env"
{
  echo "# Written by deploy/install.sh; re-running the installer rewrites this file."
  echo "NODE_ENV=production"
  echo "AGENTBOX_ORIGIN=https://$DOMAIN"
  echo "AGENTBOX_DATA_DIR=/var/lib/agentbox"
  if [[ "$PROXY" == caddy ]]; then echo "AGENTBOX_LISTEN=unix:$SOCKET"
  else echo "AGENTBOX_LISTEN=$LISTEN"; echo "AGENTBOX_TRUSTED_PROXIES=$TRUSTED"; fi
  echo "AGENTBOX_WEB_DIST=$PREFIX/current/web"
  echo "AGENTBOX_TERMD_SOCKET=$TERM_SOCKET"
  echo "LOG_LEVEL=info"
} >"$ETC/agentbox.env"
chmod 0644 "$ETC/agentbox.env"
{
  echo "DOMAIN=$DOMAIN"; echo "PROXY=$PROXY"; echo "EMAIL=$EMAIL"
  echo "LISTEN=$LISTEN"; echo "TRUSTED=$TRUSTED"; echo "TRAEFIK_DIR=$TRAEFIK_DIR"
  echo "TRAEFIK_RESOLVER=$TRAEFIK_RESOLVER"; echo "FIREWALL=$FIREWALL"; echo "TLS_INTERNAL=$TLS_INTERNAL"
  echo "SRC_DIR=$SRC_DIR"; echo "TERM_USER=$TERM_USER"
} >"$ETC/install.conf"
ok "$ETC/agentbox.env, $ETC/install.conf"

# ── 6. systemd service ────────────────────────────────────────────────────
step "Installing the agentbox-web service"
# Root: installs a systemd unit that runs as the unprivileged agentbox user
# inside a tight sandbox (read-only system, no new privileges, no capabilities).
cat >/etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=agentbox web gateway
# Behind Traefik in Docker, the listen address only exists once Docker is up,
# so keep retrying instead of giving up after a few fast failures.
After=network-online.target docker.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=agentbox
Group=agentbox-sock
# Only to reach the terminal service's socket.
SupplementaryGroups=agentbox-term
EnvironmentFile=$ETC/agentbox.env
EnvironmentFile=$ETC/secrets.env
ExecStart=$PREFIX/node/bin/node $PREFIX/current/server/dist/main.mjs
Restart=on-failure
RestartSec=3
RuntimeDirectory=agentbox
RuntimeDirectoryMode=0750
StateDirectory=agentbox
StateDirectoryMode=0700
UMask=0077
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
SystemCallFilter=@system-service

[Install]
WantedBy=multi-user.target
EOF
# The terminal service runs as the terminal user. It is less sandboxed than
# agentbox-web on purpose: the terminals are a normal shell where you install
# and run CLIs, and the vault needs FUSE (fusermount3 is setuid, so
# NoNewPrivileges stays off). It holds no agentbox secrets and can't read them.
# KillMode=process: restarting or updating it keeps sessions and the unlocked vault.
cat >/etc/systemd/system/$TERM_SERVICE.service <<UNIT
[Unit]
Description=agentbox terminals (tmux sessions and the encrypted vault)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$TERM_USER
Group=agentbox-term
Environment=HOME=$TERM_HOME USER=$TERM_USER LOGNAME=$TERM_USER SHELL=/bin/bash LANG=C.UTF-8
Environment=AGENTBOX_TERMD_SOCKET=$TERM_SOCKET
Environment=AGENTBOX_TERMD_HOME=$TERM_HOME
Environment=AGENTBOX_TERMD_VAULT=$VAULT_DIR/cipher
# agentbox's own Node.js, so npm install -g works in the terminals out of the box.
Environment=AGENTBOX_TERMD_PATH_EXTRA=$PREFIX/node/bin
ExecStart=$PREFIX/node/bin/node $PREFIX/current/termd/dist/main.mjs
WorkingDirectory=/
Restart=on-failure
RestartSec=3
KillMode=process
RuntimeDirectory=agentbox-termd
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
UMask=0077
# No Protect*/Private* options here: they give the service its own mount
# namespace or device list, and then the vault mount would be invisible
# outside it, or /dev/fuse and new terminals (/dev/ptmx) would be blocked.
LockPersonality=yes
RestrictRealtime=yes

[Install]
WantedBy=multi-user.target
UNIT
ln -sfn "$RELEASE" "$PREFIX/current.tmp" && mv -Tf "$PREFIX/current.tmp" "$PREFIX/current"
systemctl daemon-reload
systemctl enable --quiet "$TERM_SERVICE" "$SERVICE"
systemctl restart "$TERM_SERVICE"
for _ in $(seq 1 20); do [[ -S "$TERM_SOCKET" ]] && break; sleep 0.5; done
[[ -S "$TERM_SOCKET" ]] || { journalctl -u "$TERM_SERVICE" -n 30 --no-pager >&2 || true; die "agentbox-termd didn't start (log above)."; }
ok "agentbox-termd is running (terminals as $TERM_USER)"
systemctl restart "$SERVICE"

health() {
  if [[ "$PROXY" == caddy ]]; then curl -fsS --max-time 2 --unix-socket "$SOCKET" http://localhost/healthz
  else curl -fsS --max-time 2 "http://$LISTEN/healthz"; fi
}
for _ in $(seq 1 30); do health >/dev/null 2>&1 && break; sleep 1; done
health >/dev/null 2>&1 || { journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true; die "agentbox-web didn't become healthy (log above)."; }
ok "agentbox-web is running and healthy"

# Keep the three newest releases for rollback.
ls -1dt "$PREFIX"/releases/*/ 2>/dev/null | tail -n +4 | while read -r old; do
  [[ "$(readlink -f "$old")" == "$(readlink -f "$PREFIX/current")" ]] || rm -rf "$old"
done

# ── 7. Admin command ──────────────────────────────────────────────────────
step "Installing the 'agentbox' admin command"
cat >/usr/local/sbin/agentbox <<'EOF'
#!/usr/bin/env bash
# Root-only admin command. Drops to the agentbox user to touch the database.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run it with sudo: sudo agentbox $*" >&2; exit 1; }
case "${1:-help}" in
  status) exec systemctl status agentbox-web agentbox-termd --no-pager ;;
  logs) exec journalctl -u agentbox-web -u agentbox-termd -n "${2:-200}" --no-pager ;;
  # Restarting keeps terminal sessions and the unlocked vault running.
  restart) exec systemctl restart agentbox-termd agentbox-web ;;
  update)
    src="$(awk -F= '$1=="SRC_DIR"{print $2}' /etc/agentbox/install.conf)"
    git -C "$src" pull --ff-only
    exec "$src/deploy/install.sh" --yes ;;
  help | -h | --help)
    cat <<'USAGE'
Usage: sudo agentbox <command>
  setup-link [--reset]  one-time link for first setup (--reset wipes all sign-in methods)
  audit-verify          check the audit log's hash chain
  status | logs | restart
  update                pull the latest code and reinstall (keeps data and secrets)
USAGE
    exit 0 ;;
esac
env_args=()
for f in /etc/agentbox/agentbox.env /etc/agentbox/secrets.env; do
  while IFS= read -r line; do
    [[ "$line" =~ ^[A-Z_]+= ]] && env_args+=("$line")
  done <"$f"
done
cd /
exec runuser -u agentbox -- env -i PATH=/usr/bin:/bin "${env_args[@]}" \
  /opt/agentbox/node/bin/node /opt/agentbox/current/server/dist/cli.mjs "$@"
EOF
chmod 0755 /usr/local/sbin/agentbox
ok "sudo agentbox help"

# ── 8. Reverse proxy ──────────────────────────────────────────────────────
step "Configuring the reverse proxy ($PROXY)"
# Switching modes: remove the route this installer wrote for the old proxy.
if [[ -n "$SAVED_PROXY" && "$SAVED_PROXY" != "$PROXY" ]]; then
  if [[ "$SAVED_PROXY" == traefik ]]; then rm -f "$TRAEFIK_DIR/agentbox.yml"; fi
  if [[ "$SAVED_PROXY" == caddy && -f /etc/caddy/sites/agentbox.caddy ]]; then
    rm -f /etc/caddy/sites/agentbox.caddy && systemctl reload caddy || true
  fi
  ok "cleared the $SAVED_PROXY route from the previous install"
fi
case "$PROXY" in
  caddy)
    install -d -m 0755 /etc/caddy/sites
    if ! grep -q '^import /etc/caddy/sites/\*.caddy' /etc/caddy/Caddyfile 2>/dev/null; then
      cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-agentbox.$(date +%s)" 2>/dev/null || true
      # The package ships a placeholder page on :80; replace only that exact file.
      meaningful="$(grep -vE '^\s*(#|$)' /etc/caddy/Caddyfile 2>/dev/null | tr -d ' \t' | tr '\n' '|' || true)"
      if [[ -z "$meaningful" || "$meaningful" == ':80{|root*/usr/share/caddy|file_server|}|' ]]; then
        {
          echo "# Caddy configuration. Sites live in /etc/caddy/sites/."
          [[ -z "$EMAIL" ]] || printf '{\n\temail %s\n}\n' "$EMAIL"
          echo "import /etc/caddy/sites/*.caddy"
        } >/etc/caddy/Caddyfile
      else
        printf '\nimport /etc/caddy/sites/*.caddy\n' >>/etc/caddy/Caddyfile
      fi
    fi
    cat >/etc/caddy/sites/agentbox.caddy <<EOF
# agentbox (written by deploy/install.sh)
$DOMAIN {
$([[ "$TLS_INTERNAL" == 1 ]] && echo "	tls internal")
	# The key gateway (/gw/) streams AI answers; compressing would hold chunks back.
	@pages not path /gw/*
	encode @pages zstd gzip
	reverse_proxy unix/$SOCKET
	header -Server
}
EOF
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || {
      caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || true
      die "Caddy rejected the configuration (above)."
    }
    systemctl enable --quiet caddy
    if [[ "${CADDY_RESTART:-0}" == 1 ]] || ! systemctl is-active --quiet caddy; then systemctl restart caddy; else systemctl reload caddy; fi
    ok "Caddy serves https://$DOMAIN and gets its certificate automatically"
    ;;
  traefik)
    cat >"$TRAEFIK_DIR/agentbox.yml" <<EOF
# agentbox (written by deploy/install.sh). Traefik reloads this file automatically.
http:
  routers:
    agentbox:
      rule: Host(\`$DOMAIN\`)
      entryPoints: [$TRAEFIK_ENTRY_HTTPS]
      service: agentbox
      tls:
        certResolver: $TRAEFIK_RESOLVER
    agentbox-http:
      rule: Host(\`$DOMAIN\`)
      entryPoints: [$TRAEFIK_ENTRY_HTTP]
      middlewares: [agentbox-https]
      service: agentbox
  middlewares:
    agentbox-https:
      redirectScheme:
        scheme: https
        permanent: true
  services:
    agentbox:
      loadBalancer:
        passHostHeader: true
        servers:
          - url: http://$LISTEN
EOF
    chmod 0644 "$TRAEFIK_DIR/agentbox.yml"
    ok "wrote $TRAEFIK_DIR/agentbox.yml (Traefik routes https://$DOMAIN to $LISTEN)"
    if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
      # Containers reach the host through INPUT, which ufw filters: allow only
      # the proxy's subnet to agentbox's port.
      ufw allow proto tcp from "$TRUSTED" to "${LISTEN%%:*}" port "${LISTEN##*:}" comment agentbox >/dev/null
      ok "ufw: allowed $TRUSTED → ${LISTEN} (agentbox only)"
    fi
    ;;
  external)
    ok "Point your reverse proxy at http://$LISTEN for https://$DOMAIN. nginx example:"
    cat <<EOF

    server {
      listen 443 ssl; http2 on; server_name $DOMAIN;
      # ssl_certificate ...; ssl_certificate_key ...;
      location / {
        proxy_pass http://$LISTEN;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 1h;
        # Key gateway: stream AI answers as they arrive, allow large prompts.
        proxy_buffering off;
        client_max_body_size 32m;
      }
    }
EOF
    ;;
esac

# ── 9. Firewall and SSH protection (plain VPS) ───────────────────────────
if [[ "$PROXY" == caddy && "$FIREWALL" == 1 ]]; then
  step "Firewall and brute-force protection"
  # Root: opens only SSH, HTTP and HTTPS, then turns the firewall on.
  for p in $SSH_PORTS; do ufw allow "$p/tcp" comment 'ssh' >/dev/null; done
  ufw allow 80/tcp comment 'agentbox http' >/dev/null
  ufw allow 443/tcp comment 'agentbox https' >/dev/null
  ufw allow 443/udp comment 'agentbox http3' >/dev/null
  if ! ufw status | grep -q '^Status: active'; then
    ufw default deny incoming >/dev/null && ufw default allow outgoing >/dev/null
    ufw --force enable >/dev/null
  fi
  ok "ufw active: SSH ($SSH_PORTS), 80, 443"
  cat >/etc/fail2ban/jail.d/agentbox-sshd.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
  systemctl enable --quiet fail2ban && systemctl restart fail2ban
  ok "fail2ban guards SSH"
  if command -v docker >/dev/null; then warn "Docker is installed: ports it publishes bypass ufw. Use your provider's firewall too."; fi
fi

# SSH hygiene is reported, not changed: changing it remotely can lock you out.
if sshd -T 2>/dev/null | grep -qi '^passwordauthentication yes'; then warn "SSH allows passwords. Use keys only (PasswordAuthentication no)."; fi
if sshd -T 2>/dev/null | grep -qi '^permitrootlogin yes'; then warn "SSH allows root login. Consider PermitRootLogin prohibit-password."; fi

# ── Done ──────────────────────────────────────────────────────────────────
step "Done"
cat <<EOF
  agentbox is installed: https://$DOMAIN
  Next, in your own SSH session (not through an AI agent), run:

      sudo agentbox setup-link

  and open the link on the phone or computer where you want your passkey.
  Back up $ETC/secrets.env and /var/lib/agentbox together. The terminal vault
  ($VAULT_DIR) is stored encrypted; back it up too to keep your CLI logins.
EOF
