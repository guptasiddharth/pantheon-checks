# Pantheon's Windows installer run from inside an app package (the Claude
# desktop app's situation), then checked from outside it, the way Task
# Scheduler and a Start-menu PowerShell see the machine.
#
#   -Scenario fresh     the new installer, inside the package, on a clean machine
#   -Scenario control   the 0.33.0 installer, inside: the failure being fixed must show
#   -Scenario tany      0.33.0 installed inside (an AppData install only the app sees),
#                       then the new installer inside: it must move out and work
#   -Scenario legacy    0.33.0 installed normally (outside), then the new installer
#                       inside: it must update that install where it is
#
# The new build comes from this repo's release test-0.33.1-1 (env PANTHEON_TEST_RELEASE).
param([string]$Scenario = 'fresh')
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib-msix.ps1')
$W = 'C:\pkgi'
Remove-Item -Recurse -Force $W -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $W | Out-Null
$results = New-Object System.Collections.ArrayList
function Check([bool]$Ok, [string]$Name, [string]$Detail = '') {
  [void]$results.Add(@($Ok, $Name))
  if ($Ok) { Write-Host "  ok    $Name$(if ($Detail) { "   $Detail" })" } else { Write-Host "  FAIL  $Name`n        $($Detail -replace "`n", "`n        ")" }
}
function Show([string]$Label, [string]$File) { Write-Host "  --    $Label"; if (Test-Path $File) { Get-Content $File | Select-Object -Last 40 | ForEach-Object { Write-Host "        $_" } } }

$rel = if ($env:PANTHEON_TEST_RELEASE) { $env:PANTHEON_TEST_RELEASE } else { 'https://github.com/guptasiddharth/pantheon-checks/releases/download/test-0.33.1-1' }
$newVersion = '0.33.1-test.1'
Invoke-WebRequest "$rel/join-pantheon-cli-$newVersion.tgz" -OutFile "$W\pantheon.tgz" -UseBasicParsing
Invoke-WebRequest "$rel/install-new.ps1" -OutFile "$W\install-new.ps1" -UseBasicParsing
Invoke-WebRequest 'https://relay.joinpantheon.network/install.ps1' -OutFile "$W\install-old.ps1" -UseBasicParsing
$oldVersion = ([regex]::Match((Get-Content -Raw "$W\install-old.ps1"), "PantheonVersion = '([^']+)'")).Groups[1].Value
Write-Host "pkg-install $Scenario - $([Environment]::OSVersion.VersionString) $env:PROCESSOR_ARCHITECTURE; new $newVersion, old $oldVersion`n"

$pfn = New-ProbePackage $W
Write-Host "  package: $pfn`n"
# What runs inside: one of the installers, as `irm | iex` would, output kept.
Set-Content "$W\inner.ps1" @'
param([string]$Which)
$out = "C:\pkgi\inner-$Which.txt"
if ($Which -eq 'new') { $env:PANTHEON_INSTALL_SPEC = 'C:\pkgi\pantheon.tgz' } else { Remove-Item Env:PANTHEON_INSTALL_SPEC -ErrorAction SilentlyContinue }
Remove-Item Env:PANTHEON_ARGS -ErrorAction SilentlyContinue
& { Get-Content -Raw "C:\pkgi\install-$Which.ps1" | iex } *> "C:\pkgi\inner-$Which.log"
Get-Content "C:\pkgi\inner-$Which.log" | Set-Content $out
Add-Content $out 'done'
'@

# Inside, the facts the new installer decides by: its own helpers, lifted from its syntax tree.
Set-Content "$W\diag.ps1" @'
$out = 'C:\pkgi\inner-diag.txt'
$ast = [System.Management.Automation.Language.Parser]::ParseFile('C:\pkgi\install-new.ps1', [ref]$null, [ref]$null)
foreach ($n in 'Get-PantheonAppPackage', 'Select-PantheonRoot') { $f = $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true) | Select-Object -First 1; . ([scriptblock]::Create($f.Extent.Text)) }
$local = [Environment]::GetFolderPath('LocalApplicationData'); $prof = [Environment]::GetFolderPath('UserProfile')
$pkg = Get-PantheonAppPackage $local
$r = Select-PantheonRoot $prof $local $pkg
$lines = @(
  "LocalApplicationData=$local", "UserProfile=$prof", "package=$pkg",
  "current node: $(Test-Path ([IO.Path]::Combine($prof, '.pantheon', 'runtime', 'node', 'node.exe')))",
  "legacy node: $(Test-Path ([IO.Path]::Combine($local, 'Pantheon', 'runtime', 'node', 'node.exe')))",
  "legacy launcher: $(Test-Path ([IO.Path]::Combine($local, 'Pantheon', 'bin', 'pantheon.cmd')))",
  "private node: $(Test-Path ([IO.Path]::Combine($local, 'Packages', $pkg, 'LocalCache', 'Local', 'Pantheon', 'runtime', 'node', 'node.exe')))",
  "select: root=$($r.root) oldPrivate=$($r.oldPrivate)",
  'done')
$lines | Set-Content $out
'@

$prof = $env:USERPROFILE; $local = $env:LOCALAPPDATA
$curRoot = Join-Path $prof '.pantheon'; $oldRoot = Join-Path $local 'Pantheon'
$priv = Join-Path $local "Packages\$pfn\LocalCache\Local"
$userPath = { [string](Get-ItemProperty HKCU:\Environment -Name Path -ErrorAction SilentlyContinue).Path }
$cliVersion = { param($launcher) if (-not (Test-Path $launcher)) { return '(no launcher)' }; ((& cmd.exe /d /c "`"$launcher`" --version" 2>&1) | Select-Object -Last 1) -replace '^.*?(\d+\.\d+\.\d+\S*).*$', '$1' }
$pathBefore = & $userPath

function Install-Inside([string]$Which) {
  $ok = Invoke-InPackage $pfn "$W\inner.ps1" $Which "$W\inner-$Which.txt"
  Show "the $Which installer, inside the package" "$W\inner-$Which.txt"
  return $ok
}

# A member to run services for: a relay on this machine (from the new CLI), and a team on it.
function New-Member([string]$Launcher) {
  $node = Join-Path $curRoot 'runtime\node\node.exe'; $cli = Join-Path $curRoot 'runtime\node\node_modules\@join-pantheon\cli\dist\cli.js'
  if (-not (Test-Path $node)) { $node = Join-Path $oldRoot 'runtime\node\node.exe'; $cli = Join-Path $oldRoot 'runtime\node\node_modules\@join-pantheon\cli\dist\cli.js' }
  Start-Process -FilePath $node -ArgumentList @('--use-system-ca', $cli, 'relay', '--port', '8799', '--data', 'C:\pkgi\relay') -WindowStyle Hidden -RedirectStandardOutput 'C:\pkgi\relay.out' -RedirectStandardError 'C:\pkgi\relay.err' | Out-Null
  for ($i = 0; $i -lt 60; $i++) { try { if ((Invoke-WebRequest 'http://127.0.0.1:8799/health' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { break } } catch { }; Start-Sleep 1 }
  $o = (& cmd.exe /d /c "`"$Launcher`" start --relay ws://127.0.0.1:8799 --space pk --yes --name Pk --title QA --decides none --no-worker --no-hook --no-notifications --no-menubar" 2>&1) -join "`n"
  Write-Host "  --    pantheon start (a team on a relay on this machine)`n        $(($o -split "`n" | Select-Object -Last 6) -join "`n        ")"
  return (Test-Path (Join-Path $curRoot 'config.json'))
}

# The host, started the way logon starts it, from outside: does it come up?
function Test-HostComes([string]$Launcher) {
  $o = (& cmd.exe /d /c "`"$Launcher`" service install notifier" 2>&1) -join "`n"
  Write-Host "  --    pantheon service install notifier`n        $($o -replace "`n", "`n        ")"
  $state = Join-Path $curRoot 'host\state.json'
  for ($i = 0; $i -lt 60; $i++) {
    if (Test-Path $state) { try { $s = Get-Content -Raw $state | ConvertFrom-Json; if (([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$s.beat) -lt 30000) { return "pid $($s.pid), $($s.version)" } } catch { } }
    Start-Sleep 1
  }
  $le = Join-Path $curRoot 'host\launch-error.txt'
  return $(if (Test-Path $le) { 'NOT UP: ' + (Get-Content -Raw $le) } else { 'NOT UP' })
}

switch ($Scenario) {
  'control' {
    Check (Install-Inside 'old') "the $oldVersion installer ran inside the package"
    $realNode = Test-Path (Join-Path $oldRoot 'runtime\node\node.exe')
    $privNode = Test-Path (Join-Path $priv 'Pantheon\runtime\node\node.exe')
    Check ((-not $realNode) -and $privNode) "the failure being fixed shows: $oldVersion's node.exe exists only in the package's private copy" "real: $realNode, private: $privNode"
  }
  'fresh' {
    Check (Install-Inside 'new') 'the new installer ran inside the package'
    $log = Get-Content -Raw "$W\inner-new.txt"
    Check ($log -match 'Pantheon 0\.33\.1-test\.1 is installed') 'it says it installed' ''
    Check (Test-Path (Join-Path $curRoot 'runtime\node\node.exe')) "node.exe is in $curRoot for real (seen from outside)"
    Check (-not (Test-Path (Join-Path $priv 'Pantheon'))) 'nothing of Pantheon went to the package''s private copy'
    Check (-not (Test-Path $oldRoot)) "no $oldRoot was made"
    $v = & $cliVersion (Join-Path $curRoot 'bin\pantheon.cmd')
    Check ($v -eq $newVersion) "the launcher runs from outside the package: $v"
    $p = & $userPath
    Check ((($p -split ';') | Select-Object -First 1) -ieq (Join-Path $curRoot 'bin')) 'the user PATH, read from outside, starts with ~\.pantheon\bin' "$p"
    Check ($log -match 'from outside\s+PantheonProbe') 'it set PATH from outside the app and said so' ''
    Check (-not (schtasks /query /fo csv 2>$null | Select-String 'Pantheon-Path-')) 'the one-off PATH task is gone'
    Check (-not (Get-ChildItem $local -Directory -Filter 'pantheon-probe-*' -ErrorAction SilentlyContinue)) 'no probe folder left in AppData'
    Check (-not (Get-ChildItem $priv -Directory -Filter 'pantheon-probe-*' -ErrorAction SilentlyContinue)) 'none left in the private copy either'
    Check (New-Member (Join-Path $curRoot 'bin\pantheon.cmd')) 'a member is set up (a team on a relay on this machine)'
    $h = Test-HostComes (Join-Path $curRoot 'bin\pantheon.cmd')
    Check ($h -notlike 'NOT UP*') "the background host comes up, started by Task Scheduler: $h" $h
    $L = Join-Path $curRoot 'bin\pantheon.cmd'
    $g = (& cmd.exe /d /c "`"$L`" upgrade 0.33.0" 2>&1) -join ' '
    Check ($g -match 'predates Pantheon in your profile folder') 'pantheon upgrade 0.33.0 is refused here (it could not find itself again)' $g
    $lv = (& cmd.exe /d /c "`"$L`" leave pk --yes" 2>&1) -join ' '
    Check ((& $cliVersion $L) -eq $newVersion) 'after pantheon leave <team>, the pantheon command still runs' $lv
    $u = (& cmd.exe /d /c "`"$L`" uninstall --yes" 2>&1) -join "`n"
    Write-Host "  --    pantheon uninstall --yes`n        $(($u -split "`n" | Select-Object -Last 12) -join "`n        ")"
    $gone = $false; for ($i = 0; $i -lt 60 -and -not $gone; $i++) { $gone = -not (Test-Path (Join-Path $curRoot 'runtime')); if (-not $gone) { Start-Sleep 1 } }
    Check $gone "the runtime in $curRoot is gone a few seconds after uninstall exits"
    Check (Test-Path (Join-Path $curRoot 'config.json')) 'the identity is kept (config.json), so a reinstall is back in its teams'
    Check (-not (schtasks /query /fo csv 2>$null | Select-String 'Pantheon-S-')) 'the logon task is gone'
    $p2 = & $userPath
    Check (-not (($p2 -split ';') | Where-Object { $_ -ieq (Join-Path $curRoot 'bin') })) 'its PATH entry is gone' "$p2"
    # Reinstall inside the app: back as the same member, agents rewired, no start/join.
    Check (Install-Inside 'new') 'the new installer ran again inside the package'
    $re = Get-Content -Raw "$W\inner-new.txt"
    Check ($re -match 'still signed in as') 'it says you are still signed in, nothing to rejoin' ''
    Check ($re -match 'Your coding agents now use this install') 'it pointed the coding agents at the install' ''
  }
  'outside' {
    # Not inside an app: AppData, exactly as 0.33.0 put it (AppData\Local never roams).
    $o = (& powershell.exe -NoProfile -Command "`$env:PANTHEON_INSTALL_SPEC='$W\pantheon.tgz'; Get-Content -Raw '$W\install-new.ps1' | iex" 2>&1) -join "`n"
    Write-Host "  --    the new installer, outside any package`n        $(($o -split "`n" | Select-Object -Last 8) -join "`n        ")"
    Check (Test-Path (Join-Path $oldRoot 'runtime\node\node.exe')) "it installed into $oldRoot"
    Check (-not (Test-Path (Join-Path $curRoot 'runtime'))) 'not into the profile folder'
    Check ($o -notmatch 'from outside') 'no PATH task outside a package' ''
    $v = & $cliVersion (Join-Path $oldRoot 'bin\pantheon.cmd')
    Check ($v -eq $newVersion) "its launcher runs: $v"
  }
  'tany' {
    Check (Install-Inside 'old') "the $oldVersion installer ran inside the package (as on the machine of 5 Oct)"
    Check ((-not (Test-Path (Join-Path $oldRoot 'runtime\node\node.exe'))) -and (Test-Path (Join-Path $priv 'Pantheon\runtime\node\node.exe'))) "$oldVersion's Node is there only inside the app"
    Check (Invoke-InPackage $pfn "$W\diag.ps1" '' "$W\inner-diag.txt" 60) 'inside, the facts the installer decides by'
    Show 'those facts' "$W\inner-diag.txt"
    # That machine also had its identity and its alerts set up. The identity: a team made
    # with the new CLI from a scratch folder (its config is what a real machine keeps).
    # The alerts: the definition pantheon service install leaves, as Node writes it.
    npm i --prefix "$W\scratchcli" "$W\pantheon.tgz" --no-audit --no-fund --loglevel=error | Out-Null
    $sc = "$W\scratchcli\node_modules\@join-pantheon\cli\dist\cli.js"
    Start-Process -FilePath node -ArgumentList @($sc, 'relay', '--port', '8799', '--data', "$W\relay") -WindowStyle Hidden -RedirectStandardOutput "$W\relay.out" -RedirectStandardError "$W\relay.err" | Out-Null
    for ($i = 0; $i -lt 60; $i++) { try { if ((Invoke-WebRequest 'http://127.0.0.1:8799/health' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { break } } catch { }; Start-Sleep 1 }
    $o = (& node $sc start --relay ws://127.0.0.1:8799 --space pk --yes --name Pk --title QA --decides none --no-worker --no-hook --no-notifications --no-menubar 2>&1) -join "`n"
    Check (Test-Path (Join-Path $curRoot 'config.json')) 'the identity is set up' (($o -split "`n" | Select-Object -Last 4) -join ' | ')
    New-Item -ItemType Directory -Force (Join-Path $curRoot 'host') | Out-Null
    [IO.File]::WriteAllText((Join-Path $curRoot 'host\notifier.json'), (@{ kind = 'notifier'; cwd = $prof; args = @() } | ConvertTo-Json -Compress))
    Check (Install-Inside 'new') 'the new installer ran inside the package'
    $log = Get-Content -Raw "$W\inner-new.txt"
    Check ($log -match 'exists only inside\s+PantheonProbe') 'it says the old install was only inside the app' ''
    Check ($log -match "Pantheon's background notifier runs on this install") 'it started the background notifier that was set up, on the new install' ''
    Check ($log -match 'Your coding agents now use this install') 'it pointed the coding agents at the new install (they named the app-only one)' ''
    Check ($log -match 'still signed in as') 'it says you are still signed in, nothing to rejoin' ''
    $state = Join-Path $curRoot 'host\state.json'
    $up = $false; for ($i = 0; $i -lt 30 -and -not $up; $i++) { if (Test-Path $state) { try { $up = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double](Get-Content -Raw $state | ConvertFrom-Json).beat) -lt 30000 } catch { } }; if (-not $up) { Start-Sleep 1 } }
    Check $up 'the background host is up (Task Scheduler, outside the app) without anyone running service install again' ''
    $launchTxt = Join-Path $curRoot 'host\launch.txt'
    Check ((Test-Path $launchTxt) -and ((Get-Content $launchTxt | Select-Object -First 1) -ieq (Join-Path $curRoot 'runtime\node\node.exe'))) 'the task starts the Node in the profile folder' ((Get-Content $launchTxt -ErrorAction SilentlyContinue) -join ' | ')
    Check (Test-Path (Join-Path $curRoot 'runtime\node\node.exe')) "node.exe is in $curRoot for real"
    $v = & $cliVersion (Join-Path $curRoot 'bin\pantheon.cmd')
    Check ($v -eq $newVersion) "the launcher runs from outside: $v"
    $p = & $userPath
    Check ((($p -split ';') | Select-Object -First 1) -ieq (Join-Path $curRoot 'bin')) 'PATH starts with ~\.pantheon\bin' "$p"
    Check (-not (($p -split ';') | Where-Object { $_ -ieq (Join-Path $oldRoot 'bin') })) 'and the app-only AppData bin is off it' "$p"
  }
  'legacy' {
    $o = (& powershell.exe -NoProfile -Command "Get-Content -Raw '$W\install-old.ps1' | iex" 2>&1) -join "`n"
    Check (Test-Path (Join-Path $oldRoot 'runtime\node\node.exe')) "$oldVersion installed normally into $oldRoot" ($o.Substring([Math]::Max(0, $o.Length - 400)))
    Check (Install-Inside 'new') 'the new installer ran inside the package'
    $log = Get-Content -Raw "$W\inner-new.txt"
    $pkgJson = Join-Path $oldRoot 'runtime\node\node_modules\@join-pantheon\cli\package.json'
    $got = if (Test-Path $pkgJson) { (Get-Content -Raw $pkgJson | ConvertFrom-Json).version } else { '(none)' }
    Check ($got -eq $newVersion) "the working AppData install was updated where it is, for real: $got"
    Check (-not (Test-Path (Join-Path $curRoot 'runtime'))) 'nothing was installed in the profile folder beside it'
    $v = & $cliVersion (Join-Path $oldRoot 'bin\pantheon.cmd')
    Check ($v -eq $newVersion) "its launcher runs the new version from outside: $v"
  }
}

$fails = @($results | Where-Object { -not $_[0] }).Count
# A script that broke before its checks ran must not pass.
if ($results.Count -lt 2) { Write-Host "only $($results.Count) checks ran - the script itself failed"; exit 99 }
Write-Host "`n$(if ($fails) { "$fails FAILED" } else { 'nothing failed' }), $($results.Count - $fails) ok - $Scenario, $env:PROCESSOR_ARCHITECTURE"
exit $fails
