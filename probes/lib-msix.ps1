# A minimal full-trust MSIX package to run PowerShell inside, the way the
# Claude desktop app (an MSIX app) runs its agent's shell. Dot-source, then:
#   $pfn = New-ProbePackage 'C:\work'
#   Invoke-InPackage $pfn 'C:\work\inner.ps1' 'arg' 'C:\work\inner-arg.txt'
# Inside, a NEW folder written in %LOCALAPPDATA% / %APPDATA% goes to the
# package's private copy (probes/winpkg.ps1 showed which writes do and do not).
# Note: Invoke-CommandInDesktopPackage puts the started PowerShell inside the
# package; processes IT starts run outside it (winpkg.ps1 again), so what is
# tested inside is what that PowerShell writes itself.

function New-ProbePackage([string]$Dir) {
  Import-Module PKI -ErrorAction SilentlyContinue; Import-Module Appx -ErrorAction SilentlyContinue
  $pkg = Join-Path $Dir 'pkg'
  New-Item -ItemType Directory -Force $pkg | Out-Null
  $kits = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\makeappx.exe' -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -Last 1
  if (-not $kits) { throw 'no makeappx.exe (Windows SDK) on this runner' }
  $makeappx = $kits.FullName; $signtool = Join-Path $kits.DirectoryName 'signtool.exe'
  $csc = "$env:windir\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
  Set-Content "$Dir\probe.cs" 'class P { static void Main() { System.Threading.Thread.Sleep(1000); } }'
  & $csc /nologo /target:winexe /out:"$pkg\probe.exe" "$Dir\probe.cs" | Out-Null
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap 150, 150; $bmp.Save("$pkg\logo.png", [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
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
'@ | Set-Content -Encoding UTF8 "$pkg\AppxManifest.xml"
  & $makeappx pack /o /d $pkg /p "$Dir\probe.msix" | Out-Null
  $cert = New-SelfSignedCertificate -Type Custom -Subject 'CN=PantheonProbe' -KeyUsage DigitalSignature -CertStoreLocation Cert:\CurrentUser\My -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
  $pw = ConvertTo-SecureString -String 'probe' -Force -AsPlainText
  Export-PfxCertificate -Cert $cert -FilePath "$Dir\probe.pfx" -Password $pw | Out-Null
  Export-Certificate -Cert $cert -FilePath "$Dir\probe.cer" | Out-Null
  Import-Certificate -FilePath "$Dir\probe.cer" -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
  & $signtool sign /fd SHA256 /f "$Dir\probe.pfx" /p probe "$Dir\probe.msix" | Out-Null
  Add-AppxPackage -Path "$Dir\probe.msix"
  $p = Get-AppxPackage PantheonProbe
  if (-not $p) { throw 'the probe package did not install' }
  return $p.PackageFamilyName
}

# Run a script in PowerShell inside the package and wait for it to write 'done' as the last line of $Out.
function Invoke-InPackage([string]$Pfn, [string]$Script, [string]$Arg, [string]$Out, [int]$Seconds = 900) {
  Remove-Item -LiteralPath $Out -Force -ErrorAction SilentlyContinue
  Invoke-CommandInDesktopPackage -PackageFamilyName $Pfn -AppId App -Command "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe" -Args "-NoProfile -ExecutionPolicy Bypass -File $Script $Arg"
  for ($i = 0; $i -lt $Seconds; $i++) {
    if ((Test-Path -LiteralPath $Out) -and ((Get-Content -LiteralPath $Out -Tail 1 -ErrorAction SilentlyContinue) -eq 'done')) { return $true }
    Start-Sleep 1
  }
  return $false
}
