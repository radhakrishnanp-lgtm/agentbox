# agentbox setup guide

One page for everything: signing in your AI subscriptions once, adding another computer, using the CLIs there, and stopping or starting it. The details behind each step are in [MACHINES.md](MACHINES.md) and [TERMINALS.md](TERMINALS.md).

## How it works

```
 Other computer (laptop, GPU server, Windows PC)      agentbox (your VPS)                     AI provider
 ───────────────────────────────────────────────      ───────────────────                     ───────────
 you type  claude / codex / grok / kimi        ──►    checks the machine's pass,       ──►   Anthropic, OpenAI/ChatGPT,
 a small wrapper adds the machine's pass              its address and limits;                xAI/SuperGrok, Kimi, Google
                                                      adds your REAL key or login
 holds: only a pass you can stop any time             holds: your keys and logins (encrypted)
```

- Your real keys and subscription logins live **only on agentbox**. Logins made in agentbox's **Terminals** stay in the encrypted vault.
- Each other computer gets a **machine pass**. It can only talk to agentbox, from that computer's address, until you stop it.
- If a computer is stolen or hacked, press **Stop** in agentbox. That computer loses access at once, and your accounts are never exposed.

## 1. One-time setup on agentbox

Open https://agent.krish.in.net and sign in. Go to **Terminals** and unlock the vault with your vault password. The vault must stay unlocked for logins from the terminals to work on other computers. If you want that to survive a server restart, turn on auto-unlock.

Then add each subscription once.

| Your subscription        | In an agentbox **Shell** terminal                                                                                          | Then in **Machines → AI keys → Add**, pick                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Claude Pro/Max**       | `claude setup-token`, sign in, copy the token (starts with `sk-ant-oat`)                                                   | **Claude Pro/Max subscription token**, paste the token             |
| **SuperGrok**            | `grok`, sign in with your SuperGrok account                                                                                | **SuperGrok login from your Terminals**, nothing to paste          |
| **ChatGPT (Codex)**      | `npm install -g @openai/codex` (first time only), then `codex login --device-auth`, open the link and sign in with ChatGPT | **ChatGPT login from your Terminals (Codex)**, nothing to paste    |
| **Kimi Code (Moderato)** | nothing: in the browser open the Kimi Code console (kimi.com/code) → **API keys** → create a key                           | **Kimi Code subscription key**, paste it (model `kimi-for-coding`) |
| API keys (pay as you go) | nothing                                                                                                                    | the matching **… API key** choice, paste the key                   |

To install the CLIs themselves in the terminal, use `npm install -g` (for example `npm install -g @anthropic-ai/claude-code`). No sudo is needed.

A computer can use **one key per CLI**: one for `claude`, one for `codex`, one for `grok` and one for `kimi`.

## 2. Add another computer

1. In agentbox, go to **Machines → Add**.
   - Give it a name, for example "A6000" or "Office PC".
   - Tick the keys it may use, for example Claude, SuperGrok, ChatGPT and Kimi Code.
   - Keep **Lock to this computer** on.
   - Press create. You'll see a command and the machine's **pass**. The pass is shown only once.
2. On the other computer, open a terminal (no admin or root needed) and run the command. Paste the pass when it asks.

   **Linux or Mac:**

   ```sh
   curl -fsSL https://agent.krish.in.net/machine.sh | sh
   ```

   **Windows (PowerShell):**

   ```powershell
   irm https://agent.krish.in.net/machine.ps1 | iex
   ```

3. It ends by listing which CLIs are ready (for example "grok claude ready").
4. Install any CLI that isn't on that computer yet, the normal way:
   - `npm install -g @anthropic-ai/claude-code`
   - `npm install -g @openai/codex`
   - the Kimi Code and Grok installers from their websites

## 3. Use it

Open a **new** terminal on that computer and type the command as usual:

```sh
claude
codex
grok
kimi
```

There's nothing to sign in to there; agentbox handles it. On Windows, PowerShell and the Command Prompt both work.

**On that computer you can also run:**

| Command                      | What it does                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `agentbox-machine status`    | Shows what's set up                                                                      |
| `agentbox-machine refresh`   | Picks up changes made in agentbox (a key you added or ticked). Run it after every change |
| `agentbox-machine uninstall` | Removes everything the setup added                                                       |

## 4. Stop and start a computer

| You want to…                                   | Do this                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Cut a computer off right now                   | agentbox → **Machines** → **Stop** on that machine (works from your phone, no passkey needed)                      |
| Cut every computer off (panic)                 | **Machines → Stop all machines**                                                                                   |
| Let it work again                              | **Machines → Start** (asks for your passkey or authenticator code). The same pass works again; nothing to do there |
| Change its keys, addresses, limits or end date | **Machines → Edit**, then run `agentbox-machine refresh` on that computer                                          |
| Remove it for good                             | **Machines → Delete**, then `agentbox-machine uninstall` on that computer                                          |
| It moved to a new network and got blocked      | agentbox shows **Blocked a request from …** on the machine: press **Allow this address** if it's yours             |
| Stop it from SSH on the VPS                    | `sudo agentbox machines stop <name>` or `sudo agentbox machines stop-all`                                          |

A stopped computer gets "agentbox: this machine was stopped in agentbox." from every CLI.

## 5. Check a key is working

In **Machines → AI keys**, each key has a **Test** button. agentbox asks that provider one small question with your real key (or the login in your vault) and tells you what came back:

- "…answered. This key works." means the key, the address and the vault login are all right, and a computer with that key ticked will work.
- A red line gives the provider's own words, for example a key that was cancelled, or "The vault on agentbox is locked".

Testing never uses a machine pass, so it works even before you set up any computer.

## 6. If something goes wrong

| Message                                          | What to do                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| "the vault on agentbox is locked"                | Unlock the vault in **Terminals**                                          |
| "this machine was stopped in agentbox"           | Press **Start** on that machine, if you meant it to work                   |
| "this computer's address (…) is new"             | Press **Allow this address** on the machine in agentbox                    |
| "… run agentbox-machine refresh"                 | Run `agentbox-machine refresh` on that computer                            |
| Codex: "not signed in with ChatGPT" or "expired" | In an agentbox terminal run `codex login --device-auth` again              |
| Grok login expired                               | In an agentbox terminal run `grok` and sign in again                       |
| A CLI isn't found on that computer               | Install it there, open a new terminal, then run `agentbox-machine refresh` |

ChatGPT login for Codex and the Kimi Code key are new and marked experimental. If either fails, note the exact error message.

Use the **Test** button on the key first: it says whether the problem is the key itself or that computer.

## Keep it safe

- Never share a machine pass, your vault password or recovery codes.
- On shared computers, don't sign in to the CLIs directly there. Let agentbox do it.
- If you think a real key leaked, stop the machine **and** create a new key on the provider's website.
