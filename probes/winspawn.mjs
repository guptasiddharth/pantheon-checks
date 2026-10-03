// The uninstall cleanup as Pantheon would run it: a PowerShell this process waits for,
// which Start-Process-es a hidden PowerShell (-EncodedCommand) that waits for this
// process to exit and then does the work. Run from a parent that exits at once,
// through cmd.exe as pantheon.cmd does, with a path holding an apostrophe.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "ws-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const target = join(dir, "O'Brien's runtime"); mkdirSync(join(target, "node"), { recursive: true }); writeFileSync(join(target, "node", "x.txt"), "x");
const keep = join(dir, "keep"); mkdirSync(keep); writeFileSync(join(keep, "k.txt"), "k");
const parent = join(dir, "parent.mjs");
writeFileSync(parent, `import { spawnSync } from "node:child_process";
const ps = (process.env.SystemRoot || "C:\\\\Windows") + "\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe";
const paths = [${JSON.stringify(target)}];
const inner = "& { Wait-Process -Id " + process.pid + " -Timeout 60 -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500; Remove-Item -LiteralPath " + paths.map((x) => "'" + x.replace(/'/g, "''") + "'").join(",") + " -Recurse -Force } *> (Join-Path $env:TEMP 'pantheon-uninstall.log')";
const enc = Buffer.from(inner, "utf16le").toString("base64");
const outer = "Start-Process -FilePath '" + ps + "' -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','" + enc + "'";
const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", outer], { windowsHide: true, encoding: "utf8", timeout: 30000 });
console.log("outer exit", r.status, (r.stderr || "").slice(0, 300));
`);
const t0 = Date.now();
const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `""${process.execPath}" "${parent}""`], { encoding: "utf8", windowsVerbatimArguments: true });
console.log("parent:", r.status, (r.stdout + r.stderr).trim().slice(0, 300), `${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (let i = 0; i < 40 && existsSync(target); i++) await wait(500);
console.log(`cleanup: target ${existsSync(target) ? "STILL THERE" : "REMOVED"} after ${((Date.now() - t0) / 1000).toFixed(1)}s; keep ${existsSync(join(keep, "k.txt")) ? "kept" : "LOST"}`);
