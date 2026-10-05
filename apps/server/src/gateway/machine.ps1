# agentbox machine setup for Windows
#
# Lets the AI CLIs on this computer (claude, codex, grok, kimi, gemini) use the
# AI keys kept on your agentbox, without storing those keys here. This computer
# only keeps an agentbox pass, which you can stop at any time in agentbox.
#
# In PowerShell:
#   irm @@AGENTBOX_URL@@/machine.ps1 | iex      set up (asks for the pass)
# Then, in PowerShell or the Command Prompt:
#   agentbox-machine status                    show what is set up
#   agentbox-machine refresh                   pick up changes made in agentbox
#   agentbox-machine uninstall                 remove everything this added
#
# No administrator needed. Everything lives in your own AppData folder:
#   %LOCALAPPDATA%\agentbox\pass        the pass (only you can read it)
#   %LOCALAPPDATA%\agentbox\bin\        small wrappers named claude.cmd, codex.cmd, ...
#   %LOCALAPPDATA%\agentbox\<cli>\      own settings for codex, grok and gemini
#                                       (grok-login when grok uses your SuperGrok login)
# plus that bin folder at the front of your own PATH.
#
# This file is plain ASCII on purpose: Windows PowerShell 5.1 reads files
# without a byte order mark in the local code page.

& {
  $ErrorActionPreference = 'Stop'
  Set-StrictMode -Version 2

  $AgentboxUrl = '@@AGENTBOX_URL@@'
  $Clis = @('claude', 'codex', 'grok', 'kimi', 'gemini')
  $GeminiSettings = '{"security":{"auth":{"selectedType":"gemini-api-key"}},"privacy":{"usageStatisticsEnabled":false}}'
  $State = @{ Http = $null; Wired = @() }
  $OnWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or ((Test-Path variable:IsWindows) -and $IsWindows)

  function Say([string]$Text) { Write-Host $Text }
  function Fail([string]$Text) { throw [System.InvalidOperationException]::new("agentbox: $Text") }

  if (-not $env:LOCALAPPDATA) { Fail 'LOCALAPPDATA is not set; run this as your normal Windows user.' }
  $Data = Join-Path $env:LOCALAPPDATA 'agentbox'
  $Bin = Join-Path $Data 'bin'
  $PassFile = Join-Path $Data 'pass'
  # Wrappers find their folders through %LOCALAPPDATA% at run time, so they work
  # whatever characters your user name has.
  $DataCmd = '%LOCALAPPDATA%\agentbox'

  if ($AgentboxUrl -like 'https://*') { $Proto = '=https' }
  elseif ($AgentboxUrl -match '^http://(127\.0\.0\.1|localhost):\d+$') { $Proto = '=http,https' } # local tests only
  else { Fail 'unexpected agentbox address.' }

  function Test-Pass([string]$Pass) { return $Pass -cmatch '^abx_[A-Za-z0-9_-]{43}$' }

  # One HTTP client for every call. No redirects: agentbox never sends any, and
  # following one could hand the pass to another address.
  function Get-Http {
    if (-not $State.Http) {
      if ($PSVersionTable.PSEdition -eq 'Desktop') {
        Add-Type -AssemblyName System.Net.Http
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      }
      $handler = New-Object System.Net.Http.HttpClientHandler
      $handler.AllowAutoRedirect = $false
      $handler.UseCookies = $false
      $State.Http = New-Object System.Net.Http.HttpClient($handler)
      $State.Http.Timeout = [TimeSpan]::FromSeconds(30)
    }
    return $State.Http
  }

  function Invoke-Agentbox([string]$Path, [string]$Pass) {
    $http = Get-Http
    $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, "$AgentboxUrl$Path")
    if ($Pass) { $request.Headers.TryAddWithoutValidation('Authorization', "Bearer $Pass") | Out-Null }
    $request.Headers.TryAddWithoutValidation('Accept', 'text/plain') | Out-Null
    try {
      $response = $http.SendAsync($request).GetAwaiter().GetResult()
    } catch {
      Fail "could not reach $AgentboxUrl."
    }
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return @{ Code = [int]$response.StatusCode; Body = $body }
  }

  function Get-Setup([string]$Pass) {
    $r = Invoke-Agentbox '/gw/_machine' $Pass
    if ($r.Code -ne 200) {
      $msg = 'unknown error'
      if ($r.Body -match '"message":"(agentbox: )?([^"]*)"') { $msg = $Matches[2] }
      Fail "agentbox said no (HTTP $($r.Code)): $msg"
    }
    $machine = @{ Name = ''; Expires = '' }
    $keys = @()
    foreach ($line in ($r.Body -split "`r?`n")) {
      $f = $line -split "`t"
      if ($f[0] -eq 'machine' -and $f.Count -ge 3) {
        $machine.Expires = $f[1]
        $machine.Name = $f[2]
      } elseif ($f[0] -eq 'key' -and $f.Count -ge 5) {
        $keys += , @{ Slug = $f[1]; Cli = $f[2]; Model = $f[3]; Name = $f[4] }
      }
    }
    return @{ Machine = $machine; KeyList = $keys }
  }

  function Read-Pass {
    if ($env:AGENTBOX_PASS) { return $env:AGENTBOX_PASS }
    $secure = Read-Host -AsSecureString "Paste this machine's agentbox pass (it won't be shown)"
    return (New-Object System.Net.NetworkCredential('', $secure)).Password
  }

  function Write-Ascii([string]$Path, [string[]]$Lines) {
    $tmp = "$Path.tmp"
    [IO.File]::WriteAllText($tmp, (($Lines -join "`r`n") + "`r`n"), [Text.Encoding]::ASCII)
    Move-Item -LiteralPath $tmp -Destination $Path -Force
  }

  # Only you (not other users on this computer) may read the pass.
  function Protect-File([string]$Path) {
    if (-not $OnWindows) { return }
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $Path /inheritance:r /grant:r "*${me}:F" | Out-Null
    if ($LASTEXITCODE -ne 0) { Say 'agentbox: could not limit who can read the pass file; it is still in your own AppData folder.' }
  }

  # What each wrapper sets up for its CLI. These are the same recipes as the
  # Linux and macOS setup (machine.sh): the CLI reaches only agentbox, never
  # the provider or the CLI's own telemetry, and ignores any login already
  # stored on this computer.
  #   Unset  variables that would send the CLI somewhere else
  #   Set    name = value; @PASS@ is read from the pass file at run time
  #   Args   arguments put before the user's own (no quotes: codex reads a
  #          value that isn't TOML as plain text)
  #   Homes  name = folder: the CLI keeps its state in a folder of its own
  function Get-Recipe([string]$Cli, [string]$Url, [string]$Model) {
    $r = @{ Unset = @(); Set = [ordered]@{}; Args = @(); Homes = [ordered]@{} }
    switch ($Cli) {
      'claude' {
        $r.Unset = @('ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY')
        $r.Set['ANTHROPIC_BASE_URL'] = $Url
        $r.Set['ANTHROPIC_AUTH_TOKEN'] = '@PASS@'
        $r.Set['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'
        $r.Set['CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL'] = '1'
        if ($Model) {
          foreach ($v in @('ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL')) {
            $r.Set[$v] = $Model
          }
        }
      }
      'codex' {
        # codex asks a helper for the pass instead of reading it from the
        # environment: on Windows its background server is started apart from
        # this wrapper and never sees a variable set here.
        $r.Unset = @('OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT', 'AGENTBOX_CODEX_KEY')
        $r.Homes['CODEX_HOME'] = 'codex'
        foreach ($c in @('model_provider=agentbox', 'model_providers.agentbox.name=agentbox',
            "model_providers.agentbox.base_url=$Url/v1", "model_providers.agentbox.auth.command=$Bin\agentbox-codex-token.cmd",
            'model_providers.agentbox.wire_api=responses', 'analytics.enabled=false', 'features.plugins=false',
            'features.apps=false', 'check_for_update_on_startup=false')) {
          $r.Args += @('-c', $c)
        }
        if ($Model) { $r.Args += @('-c', "model=$Model") }
      }
      'grok' {
        # Sets up both the official xAI grok and the open-source Grok CLI.
        $r.Unset = @('GROK_MODEL')
        $r.Set['XAI_API_KEY'] = '@PASS@'
        $r.Set['GROK_XAI_API_BASE_URL'] = "$Url/v1"
        $r.Set['GROK_API_KEY'] = '@PASS@'
        $r.Set['GROK_BASE_URL'] = "$Url/v1"
        $r.Set['GROK_TELEMETRY_ENABLED'] = 'false'
        $r.Set['GROK_DISABLE_AUTOUPDATER'] = '1'
        $r.Homes['GROK_HOME'] = 'grok'
        if ($Model) { $r.Set['GROK_MODEL'] = $Model }
      }
      'kimi' {
        # Sets up both Kimi Code and the older kimi-cli. Both need a model.
        if (-not $Model) { return $null }
        $r.Unset = @('MOONSHOT_API_KEY', 'KIMI_MODEL_PROVIDER_TYPE')
        $r.Set['KIMI_MODEL_BASE_URL'] = "$Url/v1"
        $r.Set['KIMI_MODEL_API_KEY'] = '@PASS@'
        $r.Set['KIMI_MODEL_NAME'] = $Model
        $r.Set['KIMI_BASE_URL'] = "$Url/v1"
        $r.Set['KIMI_API_KEY'] = '@PASS@'
        $r.Set['KIMI_DISABLE_TELEMETRY'] = '1'
        $r.Set['KIMI_CODE_NO_AUTO_UPDATE'] = '1'
      }
      'gemini' {
        $r.Unset = @('GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_VERTEX_BASE_URL', 'GOOGLE_APPLICATION_CREDENTIALS')
        $r.Set['GOOGLE_GEMINI_BASE_URL'] = $Url
        $r.Set['GEMINI_API_KEY'] = '@PASS@'
        $r.Homes['GEMINI_CLI_HOME'] = 'gemini'
        if ($Model) { $r.Set['GEMINI_MODEL'] = $Model }
      }
      default { return $null }
    }
    return $r
  }

  # The start of every wrapper: checks the pass is here and finds the real CLI
  # on PATH, skipping this bin folder (and the current folder, which cmd would
  # otherwise try first).
  function Get-WrapperHead([string]$Cli, [string]$What) {
    return @(
      '@echo off',
      "rem Written by agentbox: $What",
      'rem Remove with: agentbox-machine uninstall',
      'setlocal DisableDelayedExpansion',
      'set "agentbox_bin=%~dp0"',
      "set `"agentbox_pass=$DataCmd\pass`"",
      'if not exist "%agentbox_pass%" (',
      '  echo agentbox: no pass on this computer. Run: agentbox-machine refresh 1>&2',
      '  exit /b 1',
      ')',
      'set "agentbox_real="',
      "for %%D in (`"%PATH:;=`" `"%`") do if not defined agentbox_real call :agentbox_look `"%%~D`" $Cli",
      'if not defined agentbox_real (',
      "  echo agentbox: $Cli is not installed on this computer yet. 1>&2",
      '  exit /b 127',
      ')'
    )
  }

  function Get-WrapperTail {
    return @(
      'exit /b %ERRORLEVEL%',
      '',
      ':agentbox_look',
      'if "%~1"=="" goto :eof',
      'if /i "%~1\"=="%agentbox_bin%" goto :eof',
      'if /i "%~1"=="%agentbox_bin%" goto :eof',
      'for %%E in (.com .exe .bat .cmd) do if not defined agentbox_real if exist "%~1\%~2%%E" set "agentbox_real=%~1\%~2%%E"',
      'goto :eof'
    )
  }

  function Write-Wrapper([string]$Cli, [string]$Url, [string]$Model) {
    $r = Get-Recipe $Cli $Url $Model
    if (-not $r) { return }
    if ($Cli -eq 'codex') { Write-CodexToken }
    $lines = Get-WrapperHead $Cli "runs the real $Cli with this machine's agentbox pass."
    foreach ($name in $r.Unset) { $lines += "set `"$name=`"" }
    foreach ($name in $r.Homes.Keys) {
      $dir = "$DataCmd\$($r.Homes[$name])"
      $lines += "if not exist `"$dir`" mkdir `"$dir`""
      $lines += "set `"$name=$dir`""
    }
    if ($Cli -eq 'gemini') {
      # Gemini only uses a custom address with API-key sign-in, set in its settings.
      $settings = Join-Path $Data 'gemini\.gemini\settings.json'
      New-Item -ItemType Directory -Force -Path (Split-Path $settings) | Out-Null
      if (-not (Test-Path -LiteralPath $settings)) { [IO.File]::WriteAllText($settings, "$GeminiSettings`n") }
      $lines += 'if not defined GEMINI_CLI_TRUST_WORKSPACE set "GEMINI_CLI_TRUST_WORKSPACE=true"'
    }
    foreach ($name in $r.Set.Keys) {
      if ($r.Set[$name] -eq '@PASS@') { $lines += "for /f `"usebackq delims=`" %%P in (`"%agentbox_pass%`") do set `"$name=%%P`"" }
      else { $lines += "set `"$name=$($r.Set[$name])`"" }
    }
    # A .cmd CLI (npm installs those) takes over from here and never returns, which is fine.
    $argv = $r.Args | ForEach-Object { if ($_ -match ' ') { "`"$_`"" } else { $_ } }
    $lines += ('"%agentbox_real%" ' + ((@($argv) + '%*') -join ' '))
    $lines += Get-WrapperTail
    Write-Ascii (Join-Path $Bin "$Cli.cmd") $lines
    $State.Wired += $Cli
  }

  # Prints this machine's pass. codex runs it (model_providers.agentbox.auth.command)
  # whenever it needs the key, including from its own background server.
  function Write-CodexToken {
    Write-Ascii (Join-Path $Bin 'agentbox-codex-token.cmd') @(
      '@echo off',
      "rem Written by agentbox: gives codex this machine's agentbox pass.",
      'setlocal DisableDelayedExpansion',
      "set `"agentbox_pass=$DataCmd\pass`"",
      'if not exist "%agentbox_pass%" (',
      '  echo agentbox: no pass on this computer. Run: agentbox-machine refresh 1>&2',
      '  exit /b 1',
      ')',
      'for /f "usebackq delims=" %%P in ("%agentbox_pass%") do echo %%P',
      'exit /b 0'
    )
  }

  # A "SuperGrok login" key: grok signs in with this machine's pass (the helper
  # below is its auth_provider_command) and sends every request to agentbox,
  # which adds the SuperGrok login from its vault. No xAI token comes to this
  # computer, so stopping the machine in agentbox cuts grok off at once.
  function Write-GrokLogin([string]$Url, [string]$Model) {
    # Older setups stored a real xAI token here; it would keep working after Stop.
    Remove-Item -LiteralPath (Join-Path $Data 'grok-login\auth.json') -Force -ErrorAction SilentlyContinue
    # grok runs this through cmd /C, finding it on the PATH the wrapper sets.
    Write-Ascii (Join-Path $Bin 'agentbox-grok-token.cmd') @(
      '@echo off',
      "rem Written by agentbox: signs grok in with this machine's agentbox pass (no xAI token here).",
      'setlocal DisableDelayedExpansion',
      "set `"agentbox_pass=$DataCmd\pass`"",
      'if not exist "%agentbox_pass%" (',
      '  echo agentbox: no pass on this computer. Run: agentbox-machine refresh 1>&2',
      '  exit /b 1',
      ')',
      'set "agentbox_key="',
      'for /f "usebackq delims=" %%P in ("%agentbox_pass%") do set "agentbox_key=%%P"',
      'set "agentbox_body=%TEMP%\agentbox-grok-%RANDOM%%RANDOM%"',
      'set "agentbox_code=000"',
      # The pass goes to curl on stdin, not on its command line.
      "echo header = `"Authorization: Bearer %agentbox_key%`"| curl.exe -sS --proto $Proto -K - -o `"%agentbox_body%.json`" -w `"%%{http_code}`" `"$Url/_session`" >`"%agentbox_body%.code`"",
      'if exist "%agentbox_body%.code" for /f "usebackq" %%C in ("%agentbox_body%.code") do set "agentbox_code=%%C"',
      'if "%agentbox_code%"=="200" (',
      '  type "%agentbox_body%.json"',
      '  del /q "%agentbox_body%.json" "%agentbox_body%.code" 2>nul',
      '  exit /b 0',
      ')',
      'echo agentbox: could not sign grok in, HTTP %agentbox_code%: 1>&2',
      'if exist "%agentbox_body%.json" type "%agentbox_body%.json" 1>&2',
      'del /q "%agentbox_body%.json" "%agentbox_body%.code" 2>nul',
      'exit /b 1'
    )
    $lines = Get-WrapperHead 'grok' 'runs the real grok, signed in with your agentbox Grok login.'
    # Anything that would sign grok in some other way, or send it elsewhere.
    foreach ($name in @('XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY', 'GROK_XAI_API_BASE_URL', 'GROK_BASE_URL',
        'GROK_CLI_CHAT_PROXY_BASE_URL', 'GROK_AUTH', 'GROK_AUTH_PATH', 'GROK_OIDC_ISSUER', 'GROK_OIDC_CLIENT_ID',
        'GROK_DEPLOYMENT_KEY', 'GROK_MODEL')) {
      $lines += "set `"$name=`""
    }
    $lines += @(
      "if not exist `"$DataCmd\grok-login`" mkdir `"$DataCmd\grok-login`"",
      "set `"GROK_HOME=$DataCmd\grok-login`"",
      # Every request goes to agentbox, which adds the SuperGrok login and can cut it off.
      "set `"GROK_CLI_CHAT_PROXY_BASE_URL=$Url/v1`"",
      'set "PATH=%agentbox_bin%;%PATH%"',
      'set "GROK_AUTH_PROVIDER_COMMAND=agentbox-grok-token"',
      'set "GROK_AUTH_PROVIDER_LABEL=agentbox"',
      'set "GROK_TELEMETRY_ENABLED=false"',
      'set "GROK_DISABLE_AUTOUPDATER=1"'
    )
    if ($Model) { $lines += "set `"GROK_MODEL=$Model`"" }
    # The first time, sign grok in through the helper (grok -p doesn't do it by itself).
    $lines += @(
      'if exist "%GROK_HOME%\auth.json" goto agentbox_run',
      'call "%agentbox_real%" login <nul >nul',
      'if errorlevel 1 exit /b 1',
      ':agentbox_run',
      '"%agentbox_real%" %*'
    )
    $lines += Get-WrapperTail
    Write-Ascii (Join-Path $Bin 'grok.cmd') $lines
    if ($State.Wired -notcontains 'grok') { $State.Wired += 'grok' }
  }

  # Your own PATH lives in the registry. It is read and written raw, so entries
  # like %USERPROFILE%\... keep working.
  function Set-UserPath([bool]$Add) {
    $env:Path = (@($env:Path -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $Bin) })) -join ';'
    if ($Add) { $env:Path = "$Bin;$env:Path" }
    if (-not $OnWindows) { return }
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
      $old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $parts = @($old -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $Bin) })
      if ($Add) { $parts = @($Bin) + $parts }
      $new = $parts -join ';'
      if ($new -ne $old) {
        if ($new) { $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
        else { $key.DeleteValue('Path', $false) }
      }
    } finally {
      $key.Close()
    }
    # Tells Windows (and new terminals) that the environment changed.
    [Environment]::SetEnvironmentVariable('AGENTBOX_PATH_CHANGED', $null, 'User')
  }

  # The real CLI the wrapper would run: the first one on PATH outside agentbox.
  function Find-RealCli([string]$Cli) {
    foreach ($dir in ($env:Path -split ';')) {
      if (-not $dir -or $dir.TrimEnd('\') -eq $Bin) { continue }
      foreach ($ext in @('.com', '.exe', '.bat', '.cmd')) {
        $p = "$($dir.TrimEnd('\'))\$Cli$ext"
        try { if (Test-Path -LiteralPath $p -PathType Leaf) { return $p } } catch { }
      }
    }
    return $null
  }

  function Install-Setup($Setup) {
    New-Item -ItemType Directory -Force -Path $Bin | Out-Null
    $State.Wired = @()
    foreach ($cli in $Clis) { Remove-Item -LiteralPath (Join-Path $Bin "$cli.cmd") -Force -ErrorAction SilentlyContinue }
    foreach ($helper in @('agentbox-grok-token.cmd', 'agentbox-codex-token.cmd')) { Remove-Item -LiteralPath (Join-Path $Bin $helper) -Force -ErrorAction SilentlyContinue }
    foreach ($k in $Setup.KeyList) {
      if ($k.Slug -cnotmatch '^[a-z][a-z0-9-]{1,30}$') { continue }
      if (($Clis + 'grok-login') -notcontains $k.Cli) { continue }
      $model = $k.Model
      if ($model -eq '-') { $model = '' }
      if ($model -and ($model -cnotmatch '^[A-Za-z0-9._:/-]{1,100}$')) { continue }
      $url = "$AgentboxUrl/gw/$($k.Slug)"
      if ($k.Cli -eq 'grok-login') { Write-GrokLogin $url $model }
      else { Write-Wrapper $k.Cli $url $model }
    }
    # Keep a copy of this tool for status, refresh and uninstall.
    try {
      $r = Invoke-Agentbox '/machine.ps1' ''
      if ($r.Code -ne 200) { throw 'download failed' }
      [IO.File]::WriteAllText((Join-Path $Bin 'agentbox-machine.ps1'), $r.Body, [Text.Encoding]::ASCII)
      Write-Ascii (Join-Path $Bin 'agentbox-machine.cmd') @(
        '@echo off',
        'rem Written by agentbox: status, refresh and uninstall for this machine.',
        'setlocal',
        'set "AGENTBOX_CLI=1"',
        # "& exit /b" on the same line: after uninstall this file is gone, and cmd
        # would otherwise try to read its next line.
        'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0agentbox-machine.ps1" %* & exit /b'
      )
    } catch {
      Say 'agentbox: could not save agentbox-machine; setup still worked.'
    }
  }

  function Show-Report($Setup) {
    Say ''
    Say "This computer is set up as `"$($Setup.Machine.Name)`" (pass valid until: $($Setup.Machine.Expires))."
    if ($State.Wired.Count -eq 0) {
      Say 'No AI tools are allowed for this machine yet. Allow some in agentbox > Machines, then run: agentbox-machine refresh'
    } else {
      Say "These commands now use your agentbox keys: $($State.Wired -join ' ')"
      $systemPath = @()
      if ($OnWindows) { $systemPath = @(([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';') | ForEach-Object { $_.TrimEnd('\') }) }
      foreach ($cli in $State.Wired) {
        $real = Find-RealCli $cli
        if (-not $real) {
          Say "  ${cli}: install the $cli CLI as usual; it will use agentbox automatically"
        } elseif ($systemPath -contains (Split-Path $real).TrimEnd('\')) {
          Say "  ${cli}: installed for all users ($real), which Windows finds before agentbox."
          Say "        Type $cli.cmd instead of $cli, or install $cli just for your user."
        } else {
          Say "  ${cli}: ready"
        }
      }
    }
    Say ''
    Say 'Open a new terminal and use them as normal (this window already works).'
    Say ''
    Say 'Anyone with administrator rights on this computer could use your AI through this pass'
    Say 'until you stop the machine in agentbox. They cannot see or copy your real keys.'
  }

  function Install-Pass([string]$Pass) {
    New-Item -ItemType Directory -Force -Path $Data | Out-Null
    $tmp = "$PassFile.tmp"
    [IO.File]::WriteAllText($tmp, "$Pass`r`n", [Text.Encoding]::ASCII)
    Protect-File $tmp
    Move-Item -LiteralPath $tmp -Destination $PassFile -Force
  }

  function Read-SavedPass {
    if (-not (Test-Path -LiteralPath $PassFile)) { Fail 'this computer has no pass yet. Run the setup command from agentbox first.' }
    return ([IO.File]::ReadAllText($PassFile)).Trim()
  }

  function Invoke-Main([string]$Command) {
    switch ($Command) {
      'install' {
        $pass = (Read-Pass).Trim()
        if (-not (Test-Pass $pass)) { Fail "that doesn't look like an agentbox pass (it starts with abx_)." }
        $setup = Get-Setup $pass
        Install-Pass $pass
        Remove-Item Env:\AGENTBOX_PASS -ErrorAction SilentlyContinue
        Install-Setup $setup
        Set-UserPath $true
        Show-Report $setup
      }
      'refresh' {
        $pass = Read-SavedPass
        # Run the newest setup from agentbox, so wrappers pick up its fixes too.
        if (-not $env:AGENTBOX_FRESH) {
          $r = $null
          try { $r = Invoke-Agentbox '/machine.ps1' '' } catch { $r = $null }
          if ($r -and $r.Code -eq 200) {
            $env:AGENTBOX_FRESH = '1'
            try { & ([scriptblock]::Create($r.Body)) 'refresh' } finally { Remove-Item Env:\AGENTBOX_FRESH -ErrorAction SilentlyContinue }
            return
          }
        }
        $setup = Get-Setup $pass
        Install-Setup $setup
        Set-UserPath $true
        Show-Report $setup
      }
      'status' {
        $setup = Get-Setup (Read-SavedPass)
        Say "Machine: $($setup.Machine.Name) (pass valid until: $($setup.Machine.Expires))"
        foreach ($k in $setup.KeyList) {
          $model = ''
          if ($k.Model -ne '-') { $model = ", model $($k.Model)" }
          Say "  $($k.Cli) -> $AgentboxUrl/gw/$($k.Slug) ($($k.Name)$model)"
        }
      }
      'uninstall' {
        Set-UserPath $false
        Remove-Item -LiteralPath $Data -Recurse -Force -ErrorAction SilentlyContinue
        Say 'Removed agentbox from this computer. Also stop the machine in agentbox > Machines.'
      }
      default {
        Say 'Usage: agentbox-machine [install | status | refresh | uninstall]'
        return 2
      }
    }
    return 0
  }

  $command = 'install'
  if ($args.Count -gt 0) { $command = [string]$args[0] }
  $code = 0
  try {
    $code = Invoke-Main $command
  } catch [System.InvalidOperationException] {
    Write-Host $_.Exception.Message -ForegroundColor Red
    $code = 1
  }
  # From agentbox-machine.cmd: end with the exit code. From "irm | iex": keep
  # the window open and just set $LASTEXITCODE.
  if ($env:AGENTBOX_CLI -eq '1') { exit $code }
  $global:LASTEXITCODE = $code
} @args
