// Runs winpkg.ps1 in Windows PowerShell 5.1 (see that file).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const ps1 = fileURLToPath(new URL("./winpkg.ps1", import.meta.url));
// PowerShell 7's module path (the runner's step shell) breaks 5.1's PKI and Appx modules.
const env = { ...process.env }; delete env.PSModulePath;
const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { stdio: "inherit", timeout: 600_000, env });
process.exit(r.status ?? 1);
