// Why does a PowerShell started by an exiting process not run? Each step, instrumented.
import { spawnSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "ws-"));
const ps = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
console.log("dir", dir, "ps exists", existsSync(ps));

// 1. The command itself, run and waited for.
const m1 = join(dir, "direct.txt");
const d = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", `Set-Content -LiteralPath '${m1}' 'ran'`], { encoding: "utf8" });
console.log("1 direct:", d.status, existsSync(m1) ? "RAN" : "never ran", (d.stderr || "").slice(0, 200));

// 2. From this (living) process, detached, not waited for.
const m2 = join(dir, "detached-live.txt");
const c2 = spawn(ps, ["-NoProfile", "-NonInteractive", "-Command", `Set-Content -LiteralPath '${m2}' 'ran'`], { detached: true, windowsHide: true, stdio: "ignore" });
c2.on("error", (e) => console.log("2 spawn error", e.message)); c2.unref();
for (let i = 0; i < 20 && !existsSync(m2); i++) await wait(500);
console.log("2 detached from a living parent:", existsSync(m2) ? "RAN" : "never ran", "pid", c2.pid);

// 3. From a parent that exits at once, started directly (no cmd.exe).
for (const [name, opts] of [["3a detached", { detached: true, windowsHide: true }], ["3b attached", { detached: false, windowsHide: true }]]) {
  const m = join(dir, `${name.replace(/\W/g, "")}.txt`), pidf = join(dir, `${name.replace(/\W/g, "")}.pid`);
  const parent = join(dir, `${name.replace(/\W/g, "")}.mjs`);
  writeFileSync(parent, `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
const c = spawn(${JSON.stringify(ps)}, ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 2; Set-Content -LiteralPath '" + ${JSON.stringify(m)} + "' 'ran'"], { ...${JSON.stringify(opts)}, stdio: "ignore" });
c.on("error", (e) => writeFileSync(${JSON.stringify(pidf)}, "error " + e.message));
writeFileSync(${JSON.stringify(pidf)}, String(c.pid)); c.unref();`);
  const r = spawnSync(process.execPath, [parent], { encoding: "utf8" });
  await wait(1000);
  const pid = existsSync(pidf) ? readFileSync(pidf, "utf8") : "(no pid file: parent did not run)";
  const alive = /^\d+$/.test(pid) ? spawnSync(ps, ["-NoProfile", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`], { encoding: "utf8" }).stdout.trim() : "-";
  for (let i = 0; i < 20 && !existsSync(m); i++) await wait(500);
  console.log(`${name}: parent exit ${r.status}${r.stderr ? " " + r.stderr.slice(0, 150) : ""}; child pid ${pid}, 1s after the parent exited: ${alive}; ${existsSync(m) ? "RAN" : "never ran"}`);
}
