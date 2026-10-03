// Can a process start a hidden PowerShell that outlives it, and does that PowerShell run?
// Each variant: a parent node starts PowerShell with these flags, then exits at once;
// the PowerShell waits for the parent, then writes a marker file. Run through
// cmd.exe /c, as `pantheon.cmd uninstall` is.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "ws-"));
const ps = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const variants = {
  hidden_detached: { args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden"], opts: { detached: true, windowsHide: true } },
  nohidden_detached: { args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"], opts: { detached: true, windowsHide: true } },
  nohidden_attached: { args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"], opts: { detached: false, windowsHide: true } },
};
for (const [name, v] of Object.entries(variants)) {
  const marker = join(dir, `${name}.txt`), log = join(dir, `${name}.log`);
  const parent = join(dir, `${name}.mjs`);
  writeFileSync(parent, `import { spawn } from "node:child_process";
const c = spawn(${JSON.stringify(ps)}, [...${JSON.stringify(v.args)}, "-Command", "& { Wait-Process -Id " + process.pid + " -Timeout 60 -ErrorAction SilentlyContinue; Set-Content -LiteralPath '${marker}' 'ran' } *> '${log}'"], { ...${JSON.stringify(v.opts)}, stdio: "ignore" });
c.on("error", (e) => console.error("spawn error", e.message));
c.unref();
`);
  const t0 = Date.now();
  // /s /c "<whole line>": cmd strips the outer pair, so the line keeps its own quotes.
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `""${process.execPath}" "${parent}""`], { stdio: "inherit", windowsVerbatimArguments: true });
  if (r.status !== 0) console.log(`${name}: the parent itself exited ${r.status}`);
  let ok = false;
  for (let i = 0; i < 40 && !(ok = existsSync(marker)); i++) await new Promise((r) => setTimeout(r, 500));
  console.log(`${name}: ${ok ? "RAN" : "never ran"} after ${((Date.now() - t0) / 1000).toFixed(1)}s; log: ${existsSync(log) ? JSON.stringify(readFileSync(log, "utf8").slice(0, 200)) : "none"}`);
}
