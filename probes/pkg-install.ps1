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
Write-Host "pkg-install $Scenario — $([Environment]::OSVersion.VersionString) $env:PROCESSOR_ARCHITECTURE; new $newVersion, old $oldVersion`n"

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
    Check ($log -match 'from outside PantheonProbe') 'it set PATH from outside the app and said so' ''
    Check (-not (schtasks /query /fo csv 2>$null | Select-String 'Pantheon-Path-')) 'the one-off PATH task is gone'
    Check (-not (Get-ChildItem $local -Directory -Filter 'pantheon-probe-*' -ErrorAction SilentlyContinue)) 'no probe folder left in AppData'
    Check (-not (Get-ChildItem $priv -Directory -Filter 'pantheon-probe-*' -ErrorAction SilentlyContinue)) 'none left in the private copy either'
    $h = Test-HostComes (Join-Path $curRoot 'bin\pantheon.cmd')
    Check ($h -notlike 'NOT UP*') "the background host comes up, started by Task Scheduler: $h" $h
  }
  'tany' {
    Check (Install-Inside 'old') "the $oldVersion installer ran inside the package (as on the machine of 5 Oct)"
    Check ((-not (Test-Path (Join-Path $oldRoot 'runtime\node\node.exe'))) -and (Test-Path (Join-Path $priv 'Pantheon\runtime\node\node.exe'))) "$oldVersion is there only inside the app"
    Check (Install-Inside 'new') 'the new installer ran inside the package'
    $log = Get-Content -Raw "$W\inner-new.txt"
    Check ($log -match 'exists only inside PantheonProbe') 'it says the old install was only inside the app' ''
    Check (Test-Path (Join-Path $curRoot 'runtime\node\node.exe')) "node.exe is in $curRoot for real"
    $v = & $cliVersion (Join-Path $curRoot 'bin\pantheon.cmd')
    Check ($v -eq $newVersion) "the launcher runs from outside: $v"
    $p = & $userPath
    Check ((($p -split ';') | Select-Object -First 1) -ieq (Join-Path $curRoot 'bin')) 'PATH starts with ~\.pantheon\bin' "$p"
    Check (-not (($p -split ';') | Where-Object { $_ -ieq (Join-Path $oldRoot 'bin') })) 'and the app-only AppData bin is off it' "$p"
    $h = Test-HostComes (Join-Path $curRoot 'bin\pantheon.cmd')
    Check ($h -notlike 'NOT UP*') "the background host comes up: $h" $h
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
Write-Host "`n$(if ($fails) { "$fails FAILED" } else { 'nothing failed' }), $($results.Count - $fails) ok — $Scenario, $env:PROCESSOR_ARCHITECTURE"
exit $fails
