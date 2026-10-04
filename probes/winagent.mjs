// How a coding agent on Windows (Claude Code runs commands in Git Bash) gets
// through the one-line install, and which way of calling pantheon then works in
// the same shell, before any new terminal. Install only: no account, no team.
import { spawnSync } from "node:child_process";
const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
const run = (label, script) => {
  const r = spawnSync(bash, ["-c", script], { encoding: "utf8", timeout: 600_000 });
  const out = `${r.stdout}${r.stderr}`.trim().split("\n").slice(-6).join("\n    ");
  console.log(`--- ${label}: exit ${r.status}\n    ${out}`);
  return r.status;
};
run("the Windows one-liner, typed in Git Bash", `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://relay.joinpantheon.network/install.ps1 | iex"`);
run("plain pantheon, same shell", `pantheon --version`);
run("full path with $LOCALAPPDATA and forward slashes", `"$LOCALAPPDATA/Pantheon/bin/pantheon.cmd" --version`);
run("full path, %LOCALAPPDATA% as the doc writes it", `"%LOCALAPPDATA%\\Pantheon\\bin\\pantheon.cmd" --version`);
run("cmd //c with %LOCALAPPDATA%", `cmd //c "%LOCALAPPDATA%\\Pantheon\\bin\\pantheon.cmd" --version`);
run("~/AppData path", `~/AppData/Local/Pantheon/bin/pantheon.cmd --version`);
run("a new login bash (new terminal)", `bash -lc "pantheon --version"`);
