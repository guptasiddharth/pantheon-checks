// The Windows install as a careful agent runs it: download install.ps1 to a file,
// read it, run the file with arguments. From Git Bash (Claude Code) and from
// PowerShell (Codex, Cursor). `start --space` stops at sign-in: no account, no team.
import { spawnSync } from "node:child_process";
const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
const show = (label, r) => console.log(`--- ${label}: exit ${r.status}\n    ${`${r.stdout}${r.stderr}`.trim().split("\n").slice(-5).join("\n    ")}`);
show("Git Bash: curl -o, then powershell -File with args", spawnSync(bash, ["-c",
  `cd /tmp && curl -fsSL https://relay.joinpantheon.network/install.ps1 -o pantheon-install.ps1 && powershell -NoProfile -ExecutionPolicy Bypass -File pantheon-install.ps1 start --space Probe`], { encoding: "utf8", timeout: 600_000 }));
show("PowerShell: irm -OutFile, then -File with args (second run)", spawnSync("powershell", ["-NoProfile", "-Command",
  `cd $env:TEMP; irm https://relay.joinpantheon.network/install.ps1 -OutFile pantheon-install.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File .\\pantheon-install.ps1 start --space Probe; exit $LASTEXITCODE`], { encoding: "utf8", timeout: 600_000 }));
