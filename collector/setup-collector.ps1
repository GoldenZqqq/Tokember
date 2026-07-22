#requires -version 5.1
<#
  Tokember native collector setup for Windows.
  Installs an adaptive one-minute trigger or a fixed 30-minute rollback task.
  Auto-detects node, creates a protected environment file and task runner.

  Usage:
    pwsh -ExecutionPolicy Bypass -File collector\setup-collector.ps1 `
      [-Action install|upgrade|uninstall|doctor|collect|dry-run] `
      [-ScheduleMode adaptive|fixed] [-Purge]

  Cross-platform entry: node collector/install.mjs <action>
#>
[CmdletBinding()]
param(
    [ValidateSet('install', 'upgrade', 'uninstall', 'doctor', 'collect', 'dry-run')]
    [string]$Action = 'install',
    [ValidateSet('adaptive', 'fixed')]
    [string]$ScheduleMode = 'adaptive',
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'

$scheduleIntervalMinutes = if ($ScheduleMode -eq 'adaptive') { 1 } else { 30 }
$collectorLogMaxBytes = 10 * 1024 * 1024
$taskName = 'tokember-collector'
$legacyTaskName = 'ai-burn-collector'

function Set-EnvSetting {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Value
    )
    $lines = if (Test-Path $Path) { @(Get-Content -LiteralPath $Path -Encoding UTF8) } else { @() }
    $pattern = '^' + [regex]::Escape($Name) + '='
    $updated = [System.Collections.Generic.List[string]]::new()
    $replaced = $false
    foreach ($line in $lines) {
        if ($line -match $pattern) {
            if (-not $replaced) { $updated.Add("$Name=$Value"); $replaced = $true }
        } else {
            $updated.Add($line)
        }
    }
    if (-not $replaced) { $updated.Add("$Name=$Value") }
    [System.IO.File]::WriteAllLines($Path, $updated, [System.Text.UTF8Encoding]::new($false))
}

# Resolve project root (parent of collector/)
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$CollectorDir = Join-Path $ProjectRoot 'collector'
$TSX = Join-Path $ProjectRoot 'node_modules\tsx\dist\cli.mjs'
$CollectorSrc = Join-Path $CollectorDir 'src\index.ts'
$CollectorDist = Join-Path $CollectorDir 'dist\index.js'
$envPath = Join-Path $CollectorDir 'collector.env'
$cmdPath = Join-Path $CollectorDir 'run-collector.cmd'
$vbsPath = Join-Path $CollectorDir 'run-collector.vbs'
$logPath = Join-Path $CollectorDir 'collector.log'

function Find-TokemberNode {
    $nodeCandidates = @()
    $pathNode = (Get-Command node -ErrorAction SilentlyContinue).Source
    if ($pathNode) { $nodeCandidates += $pathNode }
    $miseInstalls = Join-Path $env:LOCALAPPDATA 'mise\installs\node'
    if (Test-Path $miseInstalls) {
        $nodeCandidates += Get-ChildItem $miseInstalls -Filter node.exe -Recurse -File |
            Sort-Object { [version]$_.Directory.Name } -Descending |
            Select-Object -ExpandProperty FullName
    }
    return $nodeCandidates | Select-Object -Unique | Where-Object {
        $versionText = & $_ --version 2>$null
        $versionText -match '^v(?<major>\d+)\.' -and [int]$Matches.major -ge 22
    } | Select-Object -First 1
}

function Show-NativeSources {
    $nativeSources = @(
        @{ Name = 'Claude Code'; Path = (Join-Path $env:USERPROFILE '.claude\projects') },
        @{ Name = 'Codex'; Path = (Join-Path $env:USERPROFILE '.codex\sessions') },
        @{ Name = 'Gemini'; Path = (Join-Path $env:USERPROFILE '.gemini\tmp') },
        @{ Name = 'Grok Build'; Path = (Join-Path $env:USERPROFILE '.grok\sessions') },
        @{ Name = 'Antigravity'; Path = (Join-Path $env:USERPROFILE '.gemini\antigravity') },
        @{ Name = 'OpenClaw'; Path = (Join-Path $env:USERPROFILE '.openclaw') },
        @{ Name = 'Pi Agent'; Path = (Join-Path $env:USERPROFILE '.pi\agent\sessions') }
    )
    foreach ($source in $nativeSources) {
        $status = if (Test-Path $source.Path) { 'found' } else { 'not installed' }
        Write-Host "  $($source.Name): $status" -ForegroundColor DarkGray
    }
}

function Invoke-Doctor {
    Write-Host '=== Tokember collector doctor ===' -ForegroundColor Cyan
    Write-Host "OS: Windows $([System.Environment]::OSVersion.VersionString)"
    Write-Host "Project: $ProjectRoot"
    $node = Find-TokemberNode
    if ($node) {
        Write-Host "Node: $node ($(& $node --version))"
    } else {
        Write-Host 'Node: MISSING (need 22+)' -ForegroundColor Yellow
    }
    if (Test-Path $CollectorDist) {
        Write-Host "Runtime: dist ($CollectorDist)"
    } elseif (Test-Path $TSX) {
        Write-Host 'Runtime: tsx + src'
    } else {
        Write-Host 'Runtime: MISSING (npm install or npm run build -w collector)' -ForegroundColor Yellow
    }
    if (Test-Path $envPath) {
        Write-Host "Config: $envPath"
        $envText = Get-Content -LiteralPath $envPath -Raw -ErrorAction SilentlyContinue
        if ($envText -match 'TOKEMBER_SERVER=(.+)' -and $Matches[1] -notmatch 'tokember\.example') {
            Write-Host '  TOKEMBER_SERVER: set'
        } else {
            Write-Host '  TOKEMBER_SERVER: missing or still example' -ForegroundColor Yellow
        }
        if ($envText -match 'TOKEMBER_DEVICE_TOKEN=.+' -or $envText -match 'TOKEMBER_API_KEY=.+') {
            Write-Host '  credential: set'
        } else {
            Write-Host '  credential: MISSING' -ForegroundColor Yellow
        }
    } else {
        Write-Host "Config: MISSING ($envPath)" -ForegroundColor Yellow
    }
    Write-Host 'Sources:'
    Show-NativeSources
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) { $task = Get-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue }
    if ($task) {
        Write-Host "Scheduler: task '$($task.TaskName)' state=$($task.State)"
    } else {
        Write-Host 'Scheduler: not installed'
    }
    Write-Host 'State dir preference: ~/.tokember (legacy ~/.ai-burn reused if present alone)'
}

function Invoke-Uninstall {
    if ($Action -eq 'dry-run') {
        Write-Host "DRY-RUN uninstall Purge=$Purge"
        return
    }
    foreach ($name in @($taskName, $legacyTaskName)) {
        $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($existing) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Host "Removed scheduled task: $name" -ForegroundColor Yellow
        }
    }
    foreach ($path in @($cmdPath, $vbsPath)) {
        if (Test-Path $path) {
            Remove-Item -LiteralPath $path -Force
            Write-Host "Removed: $path"
        }
    }
    if ($Purge) {
        foreach ($path in @($envPath, $logPath)) {
            if (Test-Path $path) {
                Remove-Item -LiteralPath $path -Force
                Write-Host "Purged: $path"
            }
        }
        Write-Host 'Collector state under ~/.tokember was kept.'
    } else {
        Write-Host "Kept $envPath and state directories (pass -Purge to remove env/log)."
    }
}

function Invoke-Install {
    if ($Action -eq 'dry-run') {
        Write-Host "DRY-RUN install schedule=$ScheduleMode interval=${scheduleIntervalMinutes}m"
        Write-Host "  would write $envPath $cmdPath $vbsPath and register task $taskName"
        return
    }

    # 1. Find a Node.js version that supports node:sqlite (22+)
    $node = Find-TokemberNode
    if (-not $node) { throw "Node.js 22+ not found. Install Node 22 or newer first." }
    Write-Host "node: $node ($(& $node --version))" -ForegroundColor Cyan

    # 2. Prefer packaged dist; otherwise ensure tsx is available
    $useDist = Test-Path $CollectorDist
    if (-not $useDist) {
        if (-not (Test-Path $TSX)) {
            Write-Host "Installing dependencies..." -ForegroundColor Yellow
            Push-Location $ProjectRoot
            npm install
            Pop-Location
        }
        if (-not (Test-Path $TSX)) { throw "tsx not found at $TSX — run 'npm install' or 'npm run build -w collector'" }
        Write-Host "Runtime: tsx + src" -ForegroundColor Cyan
    } else {
        Write-Host "Runtime: dist" -ForegroundColor Cyan
    }

    # 3. Report native sources. Missing tools are normal; heartbeat still succeeds.
    Write-Host 'Sources:' -ForegroundColor DarkGray
    Show-NativeSources

    # 4. Create/preserve machine-specific config, then restrict its ACL.
    if (-not (Test-Path $envPath)) {
        $serverValue = if ($env:TOKEMBER_SERVER) { $env:TOKEMBER_SERVER } elseif ($env:AI_BURN_SERVER) { $env:AI_BURN_SERVER } else { 'https://tokember.example' }
        $tokenValue = if ($env:TOKEMBER_DEVICE_TOKEN) { $env:TOKEMBER_DEVICE_TOKEN } elseif ($env:TOKEMBER_API_KEY) { $env:TOKEMBER_API_KEY } elseif ($env:AI_BURN_API_KEY) { $env:AI_BURN_API_KEY } elseif ($env:API_KEY) { $env:API_KEY } else { '' }
        $initialConfig = @(
            "TOKEMBER_SERVER=$serverValue",
            "TOKEMBER_DEVICE_TOKEN=$tokenValue",
            'TOKEMBER_CLAUDE_CODEX_SOURCE=native',
            'TOKEMBER_ATTRIBUTION_ENABLED=false'
        )
        [System.IO.File]::WriteAllLines($envPath, $initialConfig, [System.Text.UTF8Encoding]::new($false))
        Write-Host "Created protected config: $envPath" -ForegroundColor Green
        if ($serverValue -eq 'https://tokember.example') {
            Write-Host 'WARNING: replace TOKEMBER_SERVER in collector.env with your server URL.' -ForegroundColor Yellow
        }
        if (-not $tokenValue) {
            Write-Host 'WARNING: set TOKEMBER_DEVICE_TOKEN in collector.env before production sync.' -ForegroundColor Yellow
        }
    } else {
        Write-Host "Preserving existing config: $envPath" -ForegroundColor Cyan
    }
    Set-EnvSetting -Path $envPath -Name 'TOKEMBER_SCHEDULE_MODE' -Value $ScheduleMode
    Set-EnvSetting -Path $envPath -Name 'TOKEMBER_SCHEDULE_INTERVAL_MINUTES' -Value ([string]$scheduleIntervalMinutes)
    Write-Host "Schedule mode: $ScheduleMode ($scheduleIntervalMinutes minute trigger)" -ForegroundColor Cyan

    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $aclRules = @(
        "*$($currentSid):(F)",
        '*S-1-5-18:(F)',
        '*S-1-5-32-544:(F)'
    )
    # Set-Acl may try to persist an existing SACL and require SeSecurityPrivilege
    # on repeated runs. icacls updates only the DACL, so setup remains idempotent
    # for non-admin users while preserving audit rules owned by Windows.
    & icacls.exe $envPath '/inheritance:r' '/grant:r' $aclRules | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to secure $envPath (icacls exit $LASTEXITCODE)." }

    # 5. Generate run-collector.cmd (machine-specific, gitignored)
    $logRotation = @"
set "LOG_MAX_BYTES=$collectorLogMaxBytes"
if exist "%LOG%" for %%I in ("%LOG%") do if %%~zI GEQ %LOG_MAX_BYTES% (
    move /Y "%LOG%" "%LOG%.1" >nul
    if errorlevel 1 exit /b 1
)
"@
    if ($useDist) {
        $cmd = @"
@echo off
set "NODE_BIN=$node"
set "COLLECTOR=$CollectorDist"
set "ENV_FILE=$envPath"
set "LOG=$logPath"
$logRotation
for /f "usebackq eol=# delims=" %%L in ("%ENV_FILE%") do set "%%L"
echo [%DATE% %TIME%] --- start --- >> "%LOG%"
"%NODE_BIN%" "%COLLECTOR%" %* >> "%LOG%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"
echo [%DATE% %TIME%] --- exit %EXIT_CODE% --- >> "%LOG%"
exit /b %EXIT_CODE%
"@
    } else {
        $cmd = @"
@echo off
set "NODE_BIN=$node"
set "TSX_ENTRY=$TSX"
set "COLLECTOR=$CollectorSrc"
set "ENV_FILE=$envPath"
set "LOG=$logPath"
$logRotation
for /f "usebackq eol=# delims=" %%L in ("%ENV_FILE%") do set "%%L"
echo [%DATE% %TIME%] --- start --- >> "%LOG%"
"%NODE_BIN%" "%TSX_ENTRY%" "%COLLECTOR%" %* >> "%LOG%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"
echo [%DATE% %TIME%] --- exit %EXIT_CODE% --- >> "%LOG%"
exit /b %EXIT_CODE%
"@
    }
    [System.IO.File]::WriteAllText($cmdPath, $cmd, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Generated: $cmdPath" -ForegroundColor Green

    # 5b. Generate a VBScript launcher that runs the .cmd with a hidden window.
    # wscript.exe itself shows no window, and Run(..., 0, ...) hides the console the
    # .cmd would otherwise flash on screen. bWaitOnReturn=True + WScript.Quit keeps
    # the real exit code so LastTaskResult and RestartCount still work.
    $vbs = @"
' Tokember collector launcher — runs run-collector.cmd with no visible window.
Dim shell, q, arguments
q = Chr(34)
arguments = ""
If WScript.Arguments.Count > 0 Then arguments = " " & WScript.Arguments(0)
Set shell = CreateObject("WScript.Shell")
WScript.Quit shell.Run(q & "$cmdPath" & q & arguments, 0, True)
"@
    [System.IO.File]::WriteAllText($vbsPath, $vbs, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Generated: $vbsPath" -ForegroundColor Green

    # 6. Register scheduled task for the interactive user so native per-user logs
    # are available. Adaptive mode probes every minute; fixed rollback runs every 30 minutes.
    # Missed runs are caught by StartWhenAvailable after sleep, shutdown, or network
    # downtime. The action runs the VBScript launcher via wscript.exe so no console flashes.
    $taskAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbsPath`"" -WorkingDirectory $CollectorDir
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
    # Use the fully qualified identity so Task Scheduler can resolve it to a SID.
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $repeatingTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes $scheduleIntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    $description = "Sync local AI usage to Tokember ($ScheduleMode, every $scheduleIntervalMinutes minute(s))"
    $registerTask = {
        param([string]$Name)
        Register-ScheduledTask -TaskName $Name -Trigger @($logonTrigger, $repeatingTrigger) -Action $taskAction -Settings $settings -Principal $principal -Description $description -Force | Out-Null
    }
    # Register the canonical task first. If the old task is protected, roll back the
    # canonical registration before reusing the old name, so two schedulers never run.
    & $registerTask 'tokember-collector'
    $taskName = 'tokember-collector'
    $legacyTask = Get-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue
    if ($legacyTask) {
        try {
            Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false
            Write-Host "Removed legacy task: $legacyTaskName" -ForegroundColor Yellow
        } catch {
            $legacyAction = $legacyTask.Actions | Select-Object -First 1
            $expectedArgument = "`"$vbsPath`""
            $usesGeneratedRunner = $legacyAction.Execute -eq 'wscript.exe' -and
                $legacyAction.Arguments -eq $expectedArgument
            if (-not $usesGeneratedRunner) {
                Unregister-ScheduledTask -TaskName 'tokember-collector' -Confirm:$false
                throw "Cannot remove legacy task '$legacyTaskName', and it does not use $vbsPath. Re-run setup as Administrator."
            }
            Unregister-ScheduledTask -TaskName 'tokember-collector' -Confirm:$false
            $taskName = $legacyTaskName
            & $registerTask $taskName
            Write-Host "Keeping protected legacy task name; it now uses the native Tokember runner." -ForegroundColor Yellow
        }
    }

    # 7. Force one hidden run so installation verification never waits for eligibility.
    Write-Host "`nRunning forced collector smoke..." -ForegroundColor Cyan
    $smoke = Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbsPath`" --force" -Wait -PassThru -WindowStyle Hidden
    if ($smoke.ExitCode -eq 0) {
        Write-Host "OK: forced smoke succeeded (exit 0). Check log: $logPath" -ForegroundColor Green
    } else {
        Write-Host "Forced smoke result: 0x$($smoke.ExitCode.ToString('X')) — check log at $logPath" -ForegroundColor Yellow
    }
    Write-Host "`nDone. Task '$taskName' uses $ScheduleMode mode and runs at logon and every $scheduleIntervalMinutes minute(s)." -ForegroundColor Green
    Write-Host "Device name (auto from hostname): $env:COMPUTERNAME"
}

function Invoke-Collect {
    if ($Action -eq 'dry-run') {
        Write-Host 'DRY-RUN collect --force'
        return
    }
    if (-not (Test-Path $vbsPath)) {
        Invoke-Install
    }
    $smoke = Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbsPath`" --force" -Wait -PassThru -WindowStyle Hidden
    exit $smoke.ExitCode
}

switch ($Action) {
    'doctor' { Invoke-Doctor }
    'uninstall' { Invoke-Uninstall }
    'collect' { Invoke-Collect }
    'dry-run' { Invoke-Install }
    default { Invoke-Install }
}
