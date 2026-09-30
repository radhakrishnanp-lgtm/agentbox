# Use your AI CLIs on any computer (key gateway)

Keep your AI keys on agentbox only, and still type `claude`, `codex`, `grok`, `kimi` or `gemini` directly on a GPU server or laptop.

```
 GPU server / laptop                          agentbox (your VPS)                    AI provider
 ─────────────────────                        ─────────────────────                  ───────────
 claude  ──► wrapper adds ──► HTTPS ──────►   checks the pass, IP lock,  ──► HTTPS ──► api.anthropic.com
             the machine's                     limits and expiry;                      api.openai.com
             agentbox pass                     swaps in the REAL key;                  api.x.ai …
                                               streams the answer back
 holds: a pass you can stop any time          holds: your real keys (encrypted)
```

## Set it up

1. **Add a key.** Open agentbox → **Machines** → **AI keys → Add**. Pick the provider, paste the key and save. agentbox stores it encrypted and never shows it again, not even to you; you'll only see its last 4 characters.
2. **Add a machine.** Go to **Machines → Add**:
   - give it a name;
   - tick the keys it may use;
   - optionally lock it to the machine's public IP (recommended for servers);
   - pick how long the pass works (30 days by default) and its limits.

   You'll see a one-line command and the machine's **pass**. The pass is shown once.

3. **On that computer**, in its own terminal (no root needed), run the command and paste the pass when it asks:

   ```sh
   curl -fsSL https://agent.example.com/machine.sh | sh
   ```

4. Open a new terminal and use the CLIs as usual. If a CLI isn't installed yet, install it the normal way; it uses agentbox automatically.

On that computer, `agentbox-machine status` shows what's set up. After you change something in agentbox, run `agentbox-machine refresh` to pick it up. `agentbox-machine uninstall` removes everything the setup added.

## What the setup changes on the computer

- `~/.config/agentbox/pass`: the pass, readable only by you (0600).
- `~/.local/share/agentbox/bin/`: small wrapper scripts named after each CLI, plus `agentbox-machine`.
- `~/.local/share/agentbox/codex`, `grok` and `gemini`: those CLIs keep their settings and history here instead of in `~/.codex`, `~/.grok` and `~/.gemini`. This is on purpose: a login already stored on the computer (a ChatGPT, Grok or Google sign-in) is then never read or sent anywhere.
- One PATH line between `# >>> agentbox machine >>>` markers in `~/.profile`, `~/.bashrc` and `~/.zshrc`, for each of these files that exists.

Each wrapper finds the real CLI further down your PATH, sets the CLI's own address and key for that one run, turns off the CLI's own telemetry and update checks, and starts it. Nothing is exported into your normal shell. The exact settings per CLI are in [How each CLI is wired](#how-each-cli-is-wired).

## Stopping a machine

- **Web:** Machines → **Stop** (or **Stop all machines**). This needs no passkey, so you can do it fast from your phone.
- **SSH on the VPS:** `sudo agentbox machines stop <name>` or `sudo agentbox machines stop-all`.

The pass stops working at once, and answers that are still streaming are cut within 2 seconds. Every CLI then stops with "agentbox: this machine was stopped in agentbox." (the official `grok` says "Not signed in" instead). Stopping a machine doesn't cancel your key at the provider. If you think a real key leaked, rotate it on the provider's website too.

## What someone with root on that computer can and can't do

| They can                                                                     | They can't                                                 |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Use your AI through that machine's pass until you stop it, within its limits | See or copy your real keys                                 |
| Read what the CLIs on that computer send and receive                         | Take over your AI accounts                                 |
|                                                                              | Use the pass from another address, if you set an IP lock   |
|                                                                              | Keep access after you stop the machine or the pass expires |

Every request is logged in agentbox (which key, model, tokens and status, never the content). The first use and any new address show up in **Activity**.

**On shared computers, log each CLI out of its own provider login** (run `claude /logout`, and delete `~/.codex/auth.json`, `~/.grok/auth.json` and `~/.gemini/oauth_creds.json` if they exist). The wrappers make sure such a login isn't used or sent, but a login stored on the computer is exactly what gets stolen, so it shouldn't be there at all.

## Which keys work

| Provider                                       | CLI command | Notes                                                                                                                                                                    |
| ---------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Anthropic API key                              | `claude`    | Recommended for Claude Code.                                                                                                                                             |
| Claude Pro/Max token from `claude setup-token` | `claude`    | **Experimental.** Claude Code accepts it; relaying it has not been confirmed against Anthropic's live service, and Anthropic may limit how subscription tokens are used. |
| OpenAI API key                                 | `codex`     |                                                                                                                                                                          |
| xAI API key                                    | `grok`      | Works with both the official xAI `grok` and the open-source Grok CLI.                                                                                                    |
| SuperGrok login from your Terminals            | `grok`      | **Experimental.** Nothing to paste: see [SuperGrok on other computers](#supergrok-on-other-computers). Official xAI `grok` only.                                         |
| Moonshot API key                               | `kimi`      | Works with Kimi Code and the older kimi-cli. Needs a model name (for example `kimi-k2`) when you add the key.                                                            |
| Moonshot API key, Claude-compatible address    | `claude`    | Runs Kimi models inside Claude Code. Needs a model name.                                                                                                                 |
| Google Gemini API key                          | `gemini`    |                                                                                                                                                                          |
| OpenRouter, or any HTTPS API                   | none        | Point any compatible tool at the key's gateway address, with the machine's pass as its API key.                                                                          |

A machine can have one key per CLI. Other subscription logins (for example a ChatGPT login in Codex) don't work through the gateway yet. Use them in the browser terminal on the VPS instead.

## SuperGrok on other computers

Your SuperGrok login lives only on agentbox. Other computers borrow short-lived tokens from it:

1. In agentbox, open **Terminals**, unlock the vault, run `grok` and sign in with your SuperGrok account (once).
2. In **Machines → AI keys**, add **SuperGrok login from your Terminals**. There is nothing to paste.
3. Add a machine with that key and run its setup command on the other computer.
4. Type `grok` there as usual.

How it works: when `grok` on that computer needs a token, it asks agentbox with the machine's pass (`GET /gw/<slug>/_token`). agentbox reads the login from the vault and returns only the access token, which usually expires within an hour. The refresh token never leaves agentbox; when the token is nearly expired, agentbox lets the Grok CLI on the server refresh it the normal way.

- The vault must be unlocked, or the other computer gets "the vault on agentbox is locked".
- Stopping the machine stops new tokens at once. A token it already has keeps working until it expires.
- Unlike API keys, Grok talks to xAI directly with that token, so agentbox doesn't log each request, only when a token is handed out (**Activity** shows it at most once an hour per machine).
- Tested with the official `grok` 1.0.44 against a stand-in for xAI (sign-in, requests and getting a new token near expiry). Not yet checked against the live Grok service.

## How each CLI is wired

Each recipe was run with the real CLI (versions below) in an isolated network: the CLI reached only agentbox, the provider received the real key and never the pass, and a login stored on the computer was not used or sent.

| CLI (version tested)                            | What the wrapper sets                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code 2.1                                 | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` = pass, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1`. With a model: `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, the three `ANTHROPIC_DEFAULT_*_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL`. Removes `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`. |
| Codex 0.159                                     | `CODEX_HOME` = its own folder, and `-c` options for an `agentbox` provider (`base_url` = gateway `/v1`, `wire_api = "responses"`, key from `AGENTBOX_CODEX_KEY`), with analytics, plugins, apps and the update check off.                                                                                                                                      |
| Grok: official xAI CLI and open-source Grok CLI | `XAI_API_KEY` and `GROK_API_KEY` = pass, `GROK_XAI_API_BASE_URL` and `GROK_BASE_URL` = gateway `/v1`, `GROK_HOME` = its own folder, telemetry and auto-update off.                                                                                                                                                                                             |
| Kimi Code 2.1 and kimi-cli 1.51                 | `KIMI_MODEL_BASE_URL`, `KIMI_MODEL_API_KEY`, `KIMI_MODEL_NAME` (Kimi Code) and `KIMI_BASE_URL`, `KIMI_API_KEY` (kimi-cli), telemetry and auto-update off.                                                                                                                                                                                                      |
| Gemini CLI 0.61                                 | `GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_KEY` = pass, `GEMINI_CLI_HOME` = its own folder with API-key sign-in and usage statistics off, `GEMINI_CLI_TRUST_WORKSPACE=true` unless you set it yourself.                                                                                                                                                             |

Things to know:

- The first time you run `codex` in a folder it asks whether to trust it, as usual. Claude Code shows its normal first-run questions too.
- Codex, Grok and Gemini start with fresh settings, because they use their own folder (see above). Add your own settings there if you need them.
- Kimi Code and kimi-cli keep using your `~/.kimi-code` or `~/.kimi` folder. If you once ran `/login` in kimi-cli, log out, because that login would win over agentbox.
- When agentbox is updated, run `agentbox-machine refresh` on each computer to get the newest wrappers.

## For other tools

Any tool that lets you set an API base address and key works too:

- base address: `https://agent.example.com/gw/<key name>`, the key's gateway address shown in agentbox;
- API key: the machine's pass (`abx_…`), sent as `Authorization: Bearer`, `x-api-key` or `x-goog-api-key`.
