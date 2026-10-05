# What a process inside a packaged (MSIX) desktop app can write that the rest of
# Windows sees — the Claude desktop app on Windows is one, and agents it runs are
# inside its package. Builds a minimal full-trust package, runs PowerShell inside
# it (Invoke-CommandInDesktopPackage), and compares what inside wrote with what
# outside sees: AppData, the profile root, HKCU, and processes started three ways.
$ErrorActionPreference = 'Continue'
$P = 'C:\pprobe'
Remove-Item -Recurse -Force $P -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $P, "$P\pkg" | Out-Null
function Say($m) { Write-Host $m }

# ---------- a minimal full-trust package ----------
$kits = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\makeappx.exe' -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -Last 1
if (-not $kits) { Say 'NO makeappx'; exit 2 }
$makeappx = $kits.FullName; $signtool = Join-Path $kits.DirectoryName 'signtool.exe'
Say "tools: $makeappx"
$csc = "$env:windir\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
Set-Content "$P\probe.cs" 'class P { static void Main() { System.Threading.Thread.Sleep(1000); } }'
& $csc /nologo /target:winexe /out:"$P\pkg\probe.exe" "$P\probe.cs" | Out-Null
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 150, 150; $bmp.Save("$P\pkg\logo.png", [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
@'
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="PantheonProbe" Publisher="CN=PantheonProbe" Version="1.0.0.0" ProcessorArchitecture="neutral" />
  <Properties><DisplayName>PantheonProbe</DisplayName><PublisherDisplayName>PantheonProbe</PublisherDisplayName><Logo>logo.png</Logo></Properties>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" /></Dependencies>
  <Resources><Resource Language="en-us" /></Resources>
  <Applications>
    <Application Id="App" Executable="probe.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="PantheonProbe" Description="probe" BackgroundColor="transparent" Square150x150Logo="logo.png" Square44x44Logo="logo.png" />
    </Application>
  </Applications>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>
'@ | Set-Content -Encoding UTF8 "$P\pkg\AppxManifest.xml"
& $makeappx pack /o /d "$P\pkg" /p "$P\probe.msix" | Select-Object -Last 1
$cert = New-SelfSignedCertificate -Type Custom -Subject 'CN=PantheonProbe' -KeyUsage DigitalSignature -CertStoreLocation Cert:\CurrentUser\My -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
$pw = ConvertTo-SecureString -String 'probe' -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath "$P\probe.pfx" -Password $pw | Out-Null
Export-Certificate -Cert $cert -FilePath "$P\probe.cer" | Out-Null
Import-Certificate -FilePath "$P\probe.cer" -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
& $signtool sign /fd SHA256 /f "$P\probe.pfx" /p probe "$P\probe.msix" | Select-Object -Last 1
Add-AppxPackage -Path "$P\probe.msix"
$pkg = Get-AppxPackage PantheonProbe
if (-not $pkg) { Say 'PACKAGE DID NOT INSTALL'; exit 3 }
$pfn = $pkg.PackageFamilyName
Say "package installed: $pfn"

# ---------- state that exists before (written outside) ----------
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\PProbeReal" | Out-Null
Set-Content "$env:LOCALAPPDATA\PProbeReal\existing.txt" 'outside'

# ---------- the script that runs inside ----------
$pkgFn = @'
Add-Type -Namespace PP -Name K -MemberDefinition '[DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern int GetCurrentPackageFullName(ref int len, System.Text.StringBuilder name);'
function Pkg { $l = 0; $r = [PP.K]::GetCurrentPackageFullName([ref]$l, $null); if ($r -eq 15700) { return 'none' }; $sb = New-Object System.Text.StringBuilder ($l); [void][PP.K]::GetCurrentPackageFullName([ref]$l, $sb); $sb.ToString() }
'@
Set-Content "$P\child.ps1" ($pkgFn + @'
param($mode)
$o = "C:\pprobe\child-$mode.txt"
"package=$(Pkg)" | Set-Content $o
"sees-inside-new=$(Test-Path "$env:LOCALAPPDATA\PProbe\new.txt")" | Add-Content $o
"sees-real-existing=$((Get-Content "$env:LOCALAPPDATA\PProbeReal\existing.txt" -Raw).Trim())" | Add-Content $o
'@)
Set-Content "$P\inner.ps1" ($pkgFn + @'
$o = 'C:\pprobe\inner.txt'
function W($s) { Add-Content -Path $o -Value $s }
W "package=$(Pkg)"
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\PProbe", "$env:APPDATA\PProbe", "$env:USERPROFILE\.pprobe" | Out-Null
Set-Content "$env:LOCALAPPDATA\PProbe\new.txt" 'inside'
Set-Content "$env:APPDATA\PProbe\new.txt" 'inside'
Set-Content "$env:USERPROFILE\.pprobe\new.txt" 'inside'
Add-Content "$env:LOCALAPPDATA\PProbeReal\existing.txt" '+inside'
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\PProbeReal\sub" | Out-Null
Set-Content "$env:LOCALAPPDATA\PProbeReal\sub\added.txt" 'inside'
[Environment]::SetEnvironmentVariable('PPROBE', 'inside', 'User')
New-Item -Force 'HKCU:\Software\Classes\pprobe' | Out-Null; Set-ItemProperty 'HKCU:\Software\Classes\pprobe' -Name 'URL Protocol' -Value ''
New-Item -Force 'HKCU:\Software\PProbe' | Out-Null; Set-ItemProperty 'HKCU:\Software\PProbe' -Name v -Value 'inside'
W "inside-sees-own-new=$(Test-Path "$env:LOCALAPPDATA\PProbe\new.txt")"
W "inside-sees-existing=$((Get-Content "$env:LOCALAPPDATA\PProbeReal\existing.txt" -Raw).Trim() -replace "`r?`n", '|')"
# the detection Pantheon could use, in Constrained Language too: does a marker written to AppData land in a package's LocalCache?
$m = '.probe-' + [guid]::NewGuid().ToString('N')
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Pantheon" | Out-Null
Set-Content "$env:LOCALAPPDATA\Pantheon\$m" 'x'
$hit = Get-ChildItem -Force "$env:LOCALAPPDATA\Packages\*\LocalCache\Local\Pantheon\$m" -ErrorAction SilentlyContinue | Select-Object -First 1
W "detect-marker=$(if ($hit) { $hit.FullName } else { 'not found' })"
W "detect-env-LOCALAPPDATA=$env:LOCALAPPDATA"
# three ways to start a process
Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\pprobe\child.ps1', 'startprocess' -WindowStyle Hidden -Wait
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\pprobe\child.ps1 wmi' }
W "wmi-create=$($r.ReturnValue)"
schtasks /create /tn PProbeTask /tr 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\pprobe\child.ps1 task' /sc once /st 23:59 /f | Out-Null
schtasks /run /tn PProbeTask | Out-Null
W "task-created=$LASTEXITCODE"
Start-Sleep -Seconds 12
W 'done'
'@)

Say 'running PowerShell inside the package...'
Invoke-CommandInDesktopPackage -PackageFamilyName $pfn -AppId App -Command "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe" -Args '-NoProfile -ExecutionPolicy Bypass -File C:\pprobe\inner.ps1'
for ($i = 0; $i -lt 60; $i++) { if ((Test-Path "$P\inner.txt") -and (Select-String -Path "$P\inner.txt" -Pattern '^done' -Quiet)) { break }; Start-Sleep 1 }
Start-Sleep 3

Say "`n===== inside reported"
Get-Content "$P\inner.txt" -ErrorAction SilentlyContinue
foreach ($m in 'startprocess', 'wmi', 'task') { Say "`n===== child started by $m"; Get-Content "$P\child-$m.txt" -ErrorAction SilentlyContinue }

Say "`n===== outside sees"
$lc = "$env:LOCALAPPDATA\Packages\$pfn\LocalCache"
Say "LOCALAPPDATA\PProbe\new.txt             : $(Test-Path "$env:LOCALAPPDATA\PProbe\new.txt")"
Say "APPDATA\PProbe\new.txt                  : $(Test-Path "$env:APPDATA\PProbe\new.txt")"
Say "USERPROFILE\.pprobe\new.txt             : $(Test-Path "$env:USERPROFILE\.pprobe\new.txt")"
Say "existing.txt content                    : $((Get-Content "$env:LOCALAPPDATA\PProbeReal\existing.txt" -Raw).Trim() -replace "`r?`n", '|')"
Say "PProbeReal\sub\added.txt                : $(Test-Path "$env:LOCALAPPDATA\PProbeReal\sub\added.txt")"
Say "HKCU\Environment PPROBE                 : $((Get-ItemProperty HKCU:\Environment -Name PPROBE -ErrorAction SilentlyContinue).PPROBE)"
Say "HKCU\Software\Classes\pprobe            : $(Test-Path 'HKCU:\Software\Classes\pprobe')"
Say "HKCU\Software\PProbe                    : $(Test-Path 'HKCU:\Software\PProbe')"
Say "task registered (schtasks /query)       : $(schtasks /query /tn PProbeTask 2>$null | Select-String PProbeTask | ForEach-Object { 'yes' })"
Say "`n===== the package's private copies ($lc)"
Get-ChildItem -Recurse -Force $lc -ErrorAction SilentlyContinue | Where-Object { -not $_.PSIsContainer } | ForEach-Object { $_.FullName.Substring($lc.Length) }
Say "`n===== package registry hive files"
Get-ChildItem -Force "$env:LOCALAPPDATA\Packages\$pfn\SystemAppData\Helium" -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }
schtasks /delete /tn PProbeTask /f 2>$null | Out-Null
