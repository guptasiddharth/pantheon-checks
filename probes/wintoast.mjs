// What ToastNotifier.Setting reads on this runner, as Windows PowerShell 5.1 sees it
// (the property, and its getter called directly), and whether a toast shown under
// each app id lands in Windows' own history. JoinPantheon.Pantheon is registered
// here the documented way (HKCU\Software\Classes\AppUserModelId, DisplayName).
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const f = join(mkdtempSync(join(tmpdir(), "wt-")), "probe.ps1");
writeFileSync(f, String.raw`
$ErrorActionPreference = 'Continue'
New-Item -Path 'HKCU:\Software\Classes\AppUserModelId\JoinPantheon.Pantheon' -Force | Out-Null
New-ItemProperty -LiteralPath 'HKCU:\Software\Classes\AppUserModelId\JoinPantheon.Pantheon' -Name DisplayName -Value 'Pantheon' -PropertyType String -Force | Out-Null
Write-Output ('PS ' + $PSVersionTable.PSVersion + ' / ' + [Environment]::OSVersion.VersionString + ' / session ' + (Get-Process -Id $PID).SessionId)
Write-Output ('ToastEnabled = [' + (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications' -ErrorAction SilentlyContinue).ToastEnabled + ']')
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
function Read($label) {
  Write-Output ('---- ' + $label + ' (ToastEnabled [' + (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications' -ErrorAction SilentlyContinue).ToastEnabled + '])')
  foreach ($id in $ids) {
    $n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id)
    try { $g = $n.get_Setting(); Write-Output ('   ' + $id + ': ' + [string]$g) } catch { Write-Output ('   ' + $id + ': THREW ' + $_.Exception.InnerException.Message) }
  }
}
function Show($id, $tag) {
  $doc = [Windows.Data.Xml.Dom.XmlDocument]::new()
  $doc.LoadXml('<toast><visual><binding template="ToastGeneric"><text>probe</text></binding></visual></toast>')
  $t = [Windows.UI.Notifications.ToastNotification]::new($doc); $t.Tag = $tag; $t.Group = 'pdcheck'
  try { [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show($t); Start-Sleep -Milliseconds 800
    $c = @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($id) | Where-Object { $_.Tag -eq $tag }).Count
    Write-Output ('   Show under ' + $id + ': in history ' + $c) } catch { Write-Output ('   Show under ' + $id + ' THREW ' + $_.Exception.Message) }
}
$ids = 'JoinPantheon.Pantheon', '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe', 'Microsoft.Windows.Explorer'
Read '1 as found'
Show $ids[1] 'p1'
Read '2 after one toast under PowerShell'
Show $ids[0] 'p2'
Read '3 after one toast under JoinPantheon.Pantheon'
New-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications' -Name ToastEnabled -Value 1 -PropertyType DWord -Force | Out-Null
Read '4 ToastEnabled=1'
Write-Output ('PushNotifications values: ' + ((Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications' | Get-Member -MemberType NoteProperty | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $_.Name }) -join ', '))
Write-Output ('Notifications\Settings subkeys: ' + ((Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings' -ErrorAction SilentlyContinue | ForEach-Object { $_.PSChildName }) -join ', '))
`);
const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", f], { encoding: "utf8", timeout: 120000 });
console.log(r.status, `${r.stdout}${r.stderr}`);
