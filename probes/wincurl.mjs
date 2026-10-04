// curl.exe -fsSL ... -o file, in Git Bash and in Windows PowerShell 5.1 (where `curl` is an alias).
import { spawnSync } from "node:child_process";
const show = (label, r) => console.log(`--- ${label}: exit ${r.status}\n    ${`${r.stdout}${r.stderr}`.trim().split("\n").slice(-3).join("\n    ")}`);
const u = "https://relay.joinpantheon.network/install.ps1";
show("Git Bash: curl.exe", spawnSync("C:\\Program Files\\Git\\bin\\bash.exe", ["-c", `cd /tmp && curl.exe -fsSL ${u} -o a.ps1 && wc -c a.ps1`], { encoding: "utf8" }));
show("PowerShell 5.1: curl.exe", spawnSync("powershell", ["-NoProfile", "-Command", `cd $env:TEMP; curl.exe -fsSL ${u} -o b.ps1; (Get-Item b.ps1).Length`], { encoding: "utf8" }));
show("PowerShell 5.1: plain curl (the alias)", spawnSync("powershell", ["-NoProfile", "-Command", `cd $env:TEMP; curl -fsSL ${u} -o c.ps1`], { encoding: "utf8" }));
