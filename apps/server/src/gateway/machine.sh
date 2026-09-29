#!/bin/sh
# agentbox machine setup
#
# Lets the AI CLIs on this computer (claude, codex, grok, kimi, gemini) use the
# AI keys kept on your agentbox, without storing those keys here. This computer
# only keeps an agentbox pass, which you can stop at any time in agentbox.
#
#   curl -fsSL @@AGENTBOX_URL@@/machine.sh | sh     set up (asks for the pass)
#   agentbox-machine status                        show what is set up
#   agentbox-machine refresh                       pick up changes made in agentbox
#   agentbox-machine uninstall                     remove everything this added
#
# No root needed. Everything lives in your home folder:
#   ~/.config/agentbox/pass            the pass (only you can read it)
#   ~/.local/share/agentbox/bin/       small wrappers named claude, codex, ...
#   ~/.local/share/agentbox/<cli>/     own settings for codex, grok and gemini
# plus one PATH line in your shell start-up files, between agentbox markers.
set -eu

AGENTBOX_URL='@@AGENTBOX_URL@@'
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/agentbox"
BIN="$DATA/bin"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/agentbox"
PASS_FILE="$CONF/pass"
MARK_BEGIN='# >>> agentbox machine >>>'
MARK_END='# <<< agentbox machine <<<'
CLIS='claude codex grok kimi gemini'
TAB=$(printf '\t')
GEMINI_SETTINGS='{"security":{"auth":{"selectedType":"gemini-api-key"}},"privacy":{"usageStatisticsEnabled":false}}'

say() { printf '%s\n' "$*"; }
die() {
  printf 'agentbox: %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || die "this needs curl, which is not installed."
case "$BIN$PASS_FILE" in
  *"'"* | *'"'* | *'\'* | *'$'* | *'`'*) die "your home folder path has a quote or \$ in it; that is not supported." ;;
esac
case "$AGENTBOX_URL" in
  https://*) PROTO='=https' ;;
  http://127.0.0.1:* | http://localhost:*) PROTO='=http,https' ;; # local tests only
  *) die "unexpected agentbox address." ;;
esac

valid_pass() {
  printf '%s' "$1" | grep -Eq '^abx_[A-Za-z0-9_-]{43}$'
}

# Calls agentbox with the pass. The pass goes through stdin, so other users
# on this computer can't see it in the process list.
fetch_setup() {
  body=$(mktemp)
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$1" |
    curl -sS --proto "$PROTO" -K - -H 'Accept: text/plain' -o "$body" -w '%{http_code}' \
      "$AGENTBOX_URL/gw/_machine") || {
    rm -f "$body"
    die "could not reach $AGENTBOX_URL."
  }
  if [ "$code" != 200 ]; then
    msg=$(sed -n 's/.*"message":"\([^"]*\)".*/\1/p' "$body" | head -n 1)
    rm -f "$body"
    die "agentbox said no (HTTP $code): ${msg:-unknown error}"
  fi
  SETUP=$(cat "$body")
  rm -f "$body"
}

ask_pass() {
  if [ -n "${AGENTBOX_PASS:-}" ]; then
    pass=$AGENTBOX_PASS
    return
  fi
  [ -r /dev/tty ] || die "no terminal to ask for the pass. Run it with AGENTBOX_PASS set instead."
  printf "Paste this machine's agentbox pass (it won't be shown): " >/dev/tty
  stty -echo </dev/tty 2>/dev/null || true
  IFS= read -r pass </dev/tty || pass=''
  stty echo </dev/tty 2>/dev/null || true
  printf '\n' >/dev/tty
}

# What each wrapper sets up for its CLI. Every recipe was checked against the
# real CLI: it reaches only agentbox, never the provider or the CLI's own
# telemetry, and ignores any login already stored on this computer.
#   UNSET  variables that would send the CLI somewhere else
#   SET    NAME=value pairs; @PASS@ is read from the pass file at run time
#   ARGS   arguments put before the user's own
#   HOMES  NAME=folder: the CLI keeps its state in a folder of its own under
#          ~/.local/share/agentbox, so a stored provider login is never read
# Values never contain spaces: the URL, slug and model are all checked first.
wrapper_env() {
  url=$2
  model=$3
  UNSET=''
  SET=''
  ARGS=''
  HOMES=''
  case "$1" in
    claude)
      UNSET='ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY'
      SET="ANTHROPIC_BASE_URL=$url ANTHROPIC_AUTH_TOKEN=@PASS@"
      SET="$SET CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1"
      if [ -n "$model" ]; then
        for v in ANTHROPIC_MODEL ANTHROPIC_SMALL_FAST_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL \
          ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL CLAUDE_CODE_SUBAGENT_MODEL; do
          SET="$SET $v=$model"
        done
      fi
      ;;
    codex)
      UNSET='OPENAI_API_KEY OPENAI_BASE_URL CODEX_API_KEY OPENAI_ORGANIZATION OPENAI_PROJECT'
      SET='AGENTBOX_CODEX_KEY=@PASS@'
      HOMES='CODEX_HOME=codex'
      ARGS="-c model_provider=\"agentbox\" -c model_providers.agentbox.name=\"agentbox\""
      ARGS="$ARGS -c model_providers.agentbox.base_url=\"$url/v1\""
      ARGS="$ARGS -c model_providers.agentbox.env_key=\"AGENTBOX_CODEX_KEY\""
      ARGS="$ARGS -c model_providers.agentbox.wire_api=\"responses\""
      ARGS="$ARGS -c analytics.enabled=false -c features.plugins=false -c features.apps=false"
      ARGS="$ARGS -c check_for_update_on_startup=false"
      [ -z "$model" ] || ARGS="$ARGS -c model=\"$model\""
      ;;
    grok)
      # Sets up both the official xAI grok and the open-source Grok CLI.
      UNSET='GROK_MODEL'
      SET="XAI_API_KEY=@PASS@ GROK_XAI_API_BASE_URL=$url/v1 GROK_API_KEY=@PASS@ GROK_BASE_URL=$url/v1"
      SET="$SET GROK_TELEMETRY_ENABLED=false GROK_DISABLE_AUTOUPDATER=1"
      HOMES='GROK_HOME=grok'
      [ -z "$model" ] || SET="$SET GROK_MODEL=$model"
      ;;
    kimi)
      # Sets up both Kimi Code and the older kimi-cli. Both need a model.
      [ -n "$model" ] || return 1
      UNSET='MOONSHOT_API_KEY KIMI_MODEL_PROVIDER_TYPE'
      SET="KIMI_MODEL_BASE_URL=$url/v1 KIMI_MODEL_API_KEY=@PASS@ KIMI_MODEL_NAME=$model"
      SET="$SET KIMI_BASE_URL=$url/v1 KIMI_API_KEY=@PASS@"
      SET="$SET KIMI_DISABLE_TELEMETRY=1 KIMI_CODE_NO_AUTO_UPDATE=1"
      ;;
    gemini)
      UNSET='GOOGLE_API_KEY GOOGLE_GENAI_USE_VERTEXAI GOOGLE_GENAI_USE_GCA GOOGLE_CLOUD_PROJECT GOOGLE_VERTEX_BASE_URL GOOGLE_APPLICATION_CREDENTIALS'
      SET="GOOGLE_GEMINI_BASE_URL=$url GEMINI_API_KEY=@PASS@"
      HOMES='GEMINI_CLI_HOME=gemini'
      [ -z "$model" ] || SET="$SET GEMINI_MODEL=$model"
      ;;
    *) return 1 ;;
  esac
}

write_wrapper() {
  cli=$1
  wrapper_env "$cli" "$2" "$3" || return 0
  tmp="$BIN/.$cli.tmp"
  {
    say '#!/bin/sh'
    say "# Written by agentbox: runs the real $cli with this machine's agentbox pass."
    say "# Remove with: agentbox-machine uninstall"
    say "bin='$BIN'"
    say "pass_file='$PASS_FILE'"
    say '[ -r "$pass_file" ] || { echo "agentbox: no pass on this machine. Run: agentbox-machine refresh" >&2; exit 1; }'
    say 'path=$(printf "%s" "$PATH" | tr ":" "\n" | grep -vxF "$bin" | paste -s -d: -)'
    say "real=\$(PATH=\"\$path\" command -v $cli) || { echo \"agentbox: $cli is not installed on this machine yet.\" >&2; exit 127; }"
    [ -z "$UNSET" ] || say "unset $UNSET"
    for pair in $HOMES; do
      name=${pair%%=*}
      dir="$DATA/${pair#*=}"
      say "mkdir -p '$dir' && chmod 700 '$dir'"
      say "export $name='$dir'"
    done
    if [ "$cli" = gemini ]; then
      # Gemini only uses a custom address with API-key sign-in, set in its settings.
      say "mkdir -p '$DATA/gemini/.gemini'"
      say "[ -f '$DATA/gemini/.gemini/settings.json' ] || printf '%s\\n' '$GEMINI_SETTINGS' >'$DATA/gemini/.gemini/settings.json'"
      say ': "${GEMINI_CLI_TRUST_WORKSPACE:=true}"; export GEMINI_CLI_TRUST_WORKSPACE'
    fi
    for pair in $SET; do
      name=${pair%%=*}
      value=${pair#*=}
      if [ "$value" = '@PASS@' ]; then
        say "$name=\$(cat \"\$pass_file\"); export $name"
      else
        say "export $name='$value'"
      fi
    done
    if [ -n "$ARGS" ]; then
      line='exec "$real"'
      for arg in $ARGS; do line="$line '$arg'"; done
      say "$line \"\$@\""
    else
      say 'exec "$real" "$@"'
    fi
  } >"$tmp"
  chmod 700 "$tmp"
  mv -f "$tmp" "$BIN/$cli"
  WIRED="$WIRED $cli"
}

strip_block() {
  [ -f "$1" ] || return 0
  grep -qF "$MARK_BEGIN" "$1" || return 0
  tmp="$1.agentbox.tmp"
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip' "$1" >"$tmp"
  cat "$tmp" >"$1"
  rm -f "$tmp"
}

add_path() {
  files=''
  for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.zprofile"; do
    [ -f "$rc" ] && files="$files $rc"
  done
  case "${SHELL:-}" in
    */zsh) [ -f "$HOME/.zshrc" ] || files="$files $HOME/.zshrc" ;;
  esac
  [ -n "$files" ] || files="$HOME/.profile"
  for rc in $files; do
    strip_block "$rc"
    {
      say "$MARK_BEGIN"
      say "case \":\$PATH:\" in *\":$BIN:\"*) ;; *) export PATH=\"$BIN:\$PATH\" ;; esac"
      say "$MARK_END"
    } >>"$rc"
  done
}

apply_setup() {
  mkdir -p "$BIN"
  chmod 700 "$DATA" "$BIN"
  WIRED=''
  MACHINE=''
  EXPIRES=''
  for cli in $CLIS; do rm -f "$BIN/$cli"; done
  while IFS="$TAB" read -r kind a b c d; do
    case "$kind" in
      machine)
        EXPIRES=$a
        MACHINE=$b
        ;;
      key)
        slug=$a
        cli=$b
        model=$c
        printf '%s' "$slug" | grep -Eq '^[a-z][a-z0-9-]{1,30}$' || continue
        case " $CLIS " in *" $cli "*) ;; *) continue ;; esac
        [ "$model" != - ] || model=''
        if [ -n "$model" ] && ! printf '%s' "$model" | grep -Eq '^[A-Za-z0-9._:/-]{1,100}$'; then
          continue
        fi
        write_wrapper "$cli" "$AGENTBOX_URL/gw/$slug" "$model"
        ;;
    esac
  done <<EOF
$SETUP
EOF
  # Keep a copy of this tool for status, refresh and uninstall.
  curl -fsS --proto "$PROTO" -o "$BIN/.agentbox-machine.tmp" "$AGENTBOX_URL/machine.sh" &&
    chmod 700 "$BIN/.agentbox-machine.tmp" && mv -f "$BIN/.agentbox-machine.tmp" "$BIN/agentbox-machine" ||
    say "agentbox: could not save agentbox-machine; setup still worked."
}

report() {
  say ''
  say "This computer is set up as \"$MACHINE\" (pass valid until: $EXPIRES)."
  if [ -z "$WIRED" ]; then
    say 'No AI tools are allowed for this machine yet. Allow some in agentbox → Machines, then run: agentbox-machine refresh'
  else
    say "These commands now use your agentbox keys:$WIRED"
    for cli in $WIRED; do
      p=$(printf '%s' "$PATH" | tr ':' '\n' | grep -vxF "$BIN" | paste -s -d: -)
      if PATH="$p" command -v "$cli" >/dev/null 2>&1; then
        say "  $cli: ready"
      else
        say "  $cli: install the $cli CLI as usual; it will use agentbox automatically"
      fi
    done
  fi
  say ''
  say 'Open a new terminal (or run the line below) and use them as normal:'
  say "  export PATH=\"$BIN:\$PATH\""
  say ''
  say 'Anyone with root on this computer could use your AI through this pass until you stop'
  say 'the machine in agentbox. They cannot see or copy your real keys.'
}

cmd=${1:-install}
case "$cmd" in
  install)
    umask 077
    ask_pass
    valid_pass "$pass" || die "that doesn't look like an agentbox pass (it starts with abx_)."
    fetch_setup "$pass"
    mkdir -p "$CONF"
    chmod 700 "$CONF"
    printf '%s\n' "$pass" >"$PASS_FILE.tmp"
    chmod 600 "$PASS_FILE.tmp"
    mv -f "$PASS_FILE.tmp" "$PASS_FILE"
    unset pass AGENTBOX_PASS
    apply_setup
    add_path
    report
    ;;
  refresh)
    umask 077
    [ -r "$PASS_FILE" ] || die "this machine has no pass yet. Run the setup command from agentbox first."
    # Run the newest setup from agentbox, so wrappers pick up its fixes too.
    if [ -z "${AGENTBOX_FRESH:-}" ]; then
      latest=$(mktemp)
      if curl -fsS --proto "$PROTO" -o "$latest" "$AGENTBOX_URL/machine.sh"; then
        AGENTBOX_FRESH=$latest exec sh "$latest" refresh
      fi
      rm -f "$latest"
    else
      rm -f "$AGENTBOX_FRESH"
    fi
    fetch_setup "$(cat "$PASS_FILE")"
    apply_setup
    add_path
    report
    ;;
  status)
    [ -r "$PASS_FILE" ] || die "this machine is not set up."
    fetch_setup "$(cat "$PASS_FILE")"
    say "$SETUP" | while IFS="$TAB" read -r kind a b c d; do
      case "$kind" in
        machine) say "Machine: $b (pass valid until: $a)" ;;
        key)
          [ "$c" = - ] && c='' || c=", model $c"
          say "  $b → $AGENTBOX_URL/gw/$a ($d$c)"
          ;;
      esac
    done
    ;;
  uninstall)
    for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.zprofile"; do strip_block "$rc"; done
    rm -rf "$BIN" "$DATA/codex" "$DATA/grok" "$DATA/gemini" "$CONF"
    rmdir "$DATA" 2>/dev/null || true
    say 'Removed agentbox from this computer. Also stop the machine in agentbox → Machines.'
    ;;
  *)
    say 'Usage: agentbox-machine [install | status | refresh | uninstall]' >&2
    exit 2
    ;;
esac
