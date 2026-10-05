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
function Probe($label) {
  Write-Output ('---- ' + $label)
  foreach ($id in 'JoinPantheon.Pantheon', '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe', 'Microsoft.Windows.Explorer') {
    $n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id)
    $p = $n.Setting
    Write-Output ($id + ': .Setting -> [' + [string]$p + '] null=' + ($null -eq $p))
    try { $g = $n.get_Setting(); Write-Output ('   get_Setting() -> [' + [string]$g + '] int ' + [int]$g + ' ' + $g.GetType().FullName) } catch { Write-Output ('   get_Setting() THREW ' + $_.Exception.GetType().FullName + ': ' + $_.Exception.Message + ' HResult 0x' + $_.Exception.HResult.ToString('X8')) }
    try {
      $doc = [Windows.Data.Xml.Dom.XmlDocument]::new()
      $doc.LoadXml('<toast><visual><binding template="ToastGeneric"><text>probe</text><text>' + $label + '</text></binding></visual><actions><action content="Done" activationType="protocol" arguments="pantheon://probe"/></actions></toast>')
      $t = [Windows.UI.Notifications.ToastNotification]::new($doc); $t.Tag = 'pdprobe'; $t.Group = 'pdcheck'
      $n.Show($t); Start-Sleep -Milliseconds 800
      $h = @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($id))
      $mine = @($h | Where-Object { $_.Tag -eq 'pdprobe' })
      Write-Output ('   Show() ok; history ' + $h.Count + ', ours ' + $mine.Count + $(if ($mine.Count) { ' xml ' + $mine[0].Content.GetXml().Length + ' chars' } else { '' }))
      try { [Windows.UI.Notifications.ToastNotificationManager]::History.Remove('pdprobe', 'pdcheck', $id) } catch { }
    } catch { Write-Output ('   Show() THREW ' + $_.Exception.Message + ' 0x' + $_.Exception.HResult.ToString('X8')) }
  }
}
Probe 'as found'
New-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications' -Name ToastEnabled -Value 1 -PropertyType DWord -Force | Out-Null
Probe 'ToastEnabled=1'
`);
const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", f], { encoding: "utf8", timeout: 120000 });
console.log(r.status, `${r.stdout}${r.stderr}`);
