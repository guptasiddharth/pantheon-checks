// Runs winpkg.ps1 in Windows PowerShell 5.1 (see that file).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const ps1 = fileURLToPath(new URL("./winpkg.ps1", import.meta.url));
const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { stdio: "inherit", timeout: 600_000 });
process.exit(r.status ?? 1);
