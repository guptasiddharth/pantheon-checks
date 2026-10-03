// The Windows launcher's repair lines (0.32.2), run by real cmd.exe: an upgrade cut off
// between its two renames leaves runtime\cli.prev and no CLI; pantheon.cmd must move it
// back and run it. Folder names with spaces, &, parentheses, % and non-ASCII letters.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const cmdText = "@echo off\r\n" +
  "rem The pantheon command, written by the Pantheon installer. It runs Pantheon's own\r\n" +
  "rem Node by absolute path, so it never depends on which node comes first on PATH.\r\n" +
  "rem An upgrade cut off mid-swap leaves the previous version beside the runtime: put it back.\r\n" +
  'if not exist "%~dp0..\\runtime\\node\\node_modules\\@join-pantheon\\cli\\" if exist "%~dp0..\\runtime\\cli.prev\\bin\\pantheon.js" move "%~dp0..\\runtime\\cli.prev" "%~dp0..\\runtime\\node\\node_modules\\@join-pantheon\\cli" >nul 2>&1\r\n' +
  '"%~dp0..\\runtime\\node\\node.exe" --use-system-ca "%~dp0..\\runtime\\node\\node_modules\\@join-pantheon\\cli\\bin\\pantheon.js" %*\r\n';
const base = mkdtempSync(join(tmpdir(), "cr-"));
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
for (const name of ["plain", "with space", "A&B (x)", "100% done", "Ünï ŝ"]) {
  const root = join(base, name, "Pantheon");
  const bin = join(root, "bin"), rt = join(root, "runtime"), nodeDir = join(rt, "node");
  const pkg = join(nodeDir, "node_modules", "@join-pantheon", "cli"), prev = join(rt, "cli.prev");
  mkdirSync(bin, { recursive: true }); mkdirSync(join(nodeDir, "node_modules", "@join-pantheon"), { recursive: true });
  copyFileSync(process.execPath, join(nodeDir, "node.exe"));
  const writeCli = (dir, label) => { mkdirSync(join(dir, "bin"), { recursive: true }); writeFileSync(join(dir, "bin", "pantheon.js"), `console.log(${JSON.stringify(label)} + " " + process.argv.slice(2).join(" ")); process.exit(0);`); };
  const launcher = join(bin, "pantheon.cmd"); writeFileSync(launcher, cmdText, "ascii");
  const run = () => { const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `"${launcher}" --version x`], { encoding: "utf8", windowsVerbatimArguments: true }); return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() }; };

  writeCli(prev, "previous");
  let r = run();
  check(`[${name}] cut-off swap: put back and run`, r.code === 0 && r.out === "previous --version x" && existsSync(join(pkg, "bin", "pantheon.js")) && !existsSync(prev), `code ${r.code}: ${r.out}`);
  r = run();
  check(`[${name}] and from then on it is simply there`, r.code === 0 && r.out === "previous --version x", `code ${r.code}: ${r.out}`);
  writeCli(prev, "older");
  r = run();
  check(`[${name}] a CLI in place is never replaced by cli.prev`, r.code === 0 && r.out === "previous --version x" && existsSync(prev), `code ${r.code}: ${r.out}`);
  rmSync(prev, { recursive: true, force: true }); rmSync(pkg, { recursive: true, force: true });
  r = run();
  check(`[${name}] neither there: fails plainly, no cmd syntax error`, r.code !== 0 && /Cannot find module/.test(r.out) && !/syntax|was unexpected/i.test(r.out), `code ${r.code}: ${r.out.split("\n")[0]}`);
}
rmSync(base, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
