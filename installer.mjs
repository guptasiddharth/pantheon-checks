#!/usr/bin/env node
/**
 * The one-line installer, as a new person with NO Node meets it — on a real
 * machine (Windows, macOS, Linux). Nothing here is Pantheon's source: a founder
 * installs the published package with npm (as the workflow does) and starts a
 * relay on this machine; that relay serves /install.sh and /install.ps1, and a
 * second person, whose PATH has no node, npm or pantheon at all, installs from it.
 *
 *   node installer.mjs          exits 0 when every step passed
 *
 * Everything happens in throwaway homes against the local relay, so it touches
 * no real account, team or hosted service. On Windows the installer writes the
 * runner's own user PATH and %LOCALAPPDATA% (it asks Windows for that folder),
 * which a CI runner throws away.
 */
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { platform, tmpdir } from "node:os";

const WIN = platform() === "win32";
const results = [];
const step = async (name, fn) => {
  try { const detail = (await fn()) ?? ""; results.push({ ok: true, name }); console.log(`  ok    ${name}${detail ? `   ${detail}` : ""}`); }
  catch (e) { results.push({ ok: false, name }); console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n").join("\n        ")}`); }
};
const strip = (s) => String(s ?? "").replace(/\u001b\[[0-9;]*m/g, "");
const want = process.env.PANTHEON_VERSION ?? "";
const freePort = () => new Promise((done) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => done(port)); }); });

/** PATH without any folder that holds node, npm or pantheon: a machine that never had Node. */
function nodelessPath() {
  const names = WIN ? ["node.exe", "npm.cmd", "pantheon.cmd"] : ["node", "npm", "pantheon"];
  return (process.env.PATH ?? "").split(delimiter).filter((d) => d && !names.some((n) => existsSync(join(d, n)))).join(delimiter);
}

// ---- the founder: npm install (the workflow did it), a relay, a team, an invite

const froot = mkdtempSync(join(tmpdir(), "pi-founder-"));
const fhome = join(froot, "home"); mkdirSync(fhome, { recursive: true });
const fenv = { ...process.env, HOME: fhome, USERPROFILE: fhome, PANTHEON_HOME: join(froot, "pantheon") };
const founder = (args) => {
  const r = spawnSync(WIN ? "pantheon.cmd" : "pantheon", args, { encoding: "utf8", env: fenv, cwd: froot, timeout: 120_000, shell: WIN });
  return { code: r.status, out: strip(`${r.stdout ?? ""}${r.stderr ?? ""}`) };
};
const port = await freePort();
const http = `http://127.0.0.1:${port}`, relayUrl = `ws://127.0.0.1:${port}`;
let relayLog = "";
const relay = spawn(WIN ? "pantheon.cmd" : "pantheon", ["relay", "--port", String(port), "--data", join(froot, "relay")],
  { env: { ...fenv, PANTHEON_REQUIRE_ACCOUNTS: "1" }, stdio: ["ignore", "pipe", "pipe"], shell: WIN });
relay.stdout.on("data", (b) => { relayLog += b; });
relay.stderr.on("data", (b) => { relayLog += b; });
process.on("exit", () => { try { if (WIN) spawnSync("taskkill", ["/pid", String(relay.pid), "/t", "/f"]); else relay.kill("SIGKILL"); } catch { /* gone */ } });
const codeFor = async (email) => {
  for (let i = 0; i < 80; i++) {
    const m = new RegExp(`code for ${email.replace(/[.+]/g, "\\$&")}: (\\d{6})`).exec(relayLog);
    if (m) return m[1];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no code for ${email} in the relay log: ${relayLog.slice(-300)}`);
};
const quiet = ["--no-worker", "--no-hook", "--no-notifications", "--no-menubar"];

console.log(`pantheon installer — ${platform()} ${process.arch}${want ? `, expecting ${want}` : ""}\n`);

let invite = "";
await step("the founder's relay serves the installers, with its version filled in", async () => {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await (await fetch(`${http}/health`)).json()).ok) break; } catch { /* not yet */ }
  }
  const out = [];
  for (const f of ["install.sh", "install.ps1"]) {
    let r;
    // The relay serves an installer only once npm has its version (it checks the registry): a minute at most.
    for (let i = 0; i < 40; i++) { r = await fetch(`${http}/${f}`); if (r.status === 200) break; await new Promise((x) => setTimeout(x, 3000)); }
    const body = await r.text();
    if (r.status !== 200) throw new Error(`${f}: ${r.status} ${body.slice(0, 200)}`);
    if (body.includes("__PANTHEON_VERSION__")) throw new Error(`${f}: the version placeholder was not filled in`);
    if (want && !["latest", "next"].includes(want) && !body.includes(want)) throw new Error(`${f}: does not name ${want}`);
    out.push(`${f} ${body.length}b`);
  }
  return out.join(", ");
});
await step("the founder signs up, starts a team, and gets an invite", async () => {
  const s = founder(["signup", "--email", "founder@example.com", "--username", "founder", "--relay", relayUrl]);
  if (s.code !== 0) throw new Error(s.out.slice(-400));
  const v = founder(["verify", await codeFor("founder@example.com")]);
  if (v.code !== 0) throw new Error(v.out.slice(-400));
  const r = founder(["start", "--relay", relayUrl, "--space", "acme", "--yes", "--name", "Founder", "--title", "Founder", "--decides", "none", ...quiet]);
  invite = /pantheon join (pantheons?:\/\/\S+|https?:\/\/\S+)/.exec(r.out)?.[1]?.replace(/['"]$/, "") ?? "";
  if (r.code !== 0 || !invite) throw new Error(`exit ${r.code}: ${r.out.slice(-500)}`);
  return "";
});

// ---- the joiner: no Node anywhere, installs with the one line

const jroot = mkdtempSync(join(tmpdir(), "pi-joiner-"));
const jhome = join(jroot, "home"); mkdirSync(jhome, { recursive: true });
const jenv = { ...process.env, HOME: jhome, USERPROFILE: jhome, PANTHEON_HOME: join(jroot, "pantheon"), PATH: nodelessPath() };
if (WIN) jenv.Path = jenv.PATH;
for (const k of ["PANTHEON_RELAY", "PANTHEON_SPACE", "PANTHEON_TOKEN", "PANTHEON_MEMBER", "PANTHEON_AGENT", "PANTHEON_PUBKEY", "PANTHEON_PRIVKEY", "npm_config_prefix", "NPM_CONFIG_PREFIX"]) delete jenv[k];
const localAppData = WIN ? spawnSync("powershell", ["-NoProfile", "-Command", "[Environment]::GetFolderPath('LocalApplicationData')"], { encoding: "utf8" }).stdout.trim() : "";
// Windows: ~\.pantheon since 0.33.1 (every program sees it, Task Scheduler included,
// even when the installer runs inside an app package); %LOCALAPPDATA%\Pantheon before.
const winLauncher = (home) => [join(home, ".pantheon", "bin", "pantheon.cmd"), join(localAppData, "Pantheon", "bin", "pantheon.cmd")].find((p) => existsSync(p)) ?? join(home, ".pantheon", "bin", "pantheon.cmd");
let launcher = WIN ? winLauncher(jhome) : join(jhome, ".pantheon", "bin", "pantheon");
/** After an install: where the installer actually put the launcher. */
const findLauncher = () => { if (WIN) launcher = winLauncher(jhome); return launcher; };

/** The one line, exactly as a person pastes it, with these arguments for pantheon. */
function installLine(args, shell = WIN ? "powershell" : "sh") {
  const argLine = args.map((a) => (/[\s'"#&]/.test(a) ? `'${a}'` : a)).join(" ");
  if (shell === "sh") return { cmd: "sh", args: ["-c", `curl -fsSL ${http}/install.sh | sh -s -- ${argLine}`] };
  // The line `pantheon invite` prints for Windows, pasted into Command Prompt, or into PowerShell (it must work in both).
  const winLine = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${args.length ? `Set-Item Env:PANTHEON_ARGS '${args.join(" ")}'; ` : ""}irm ${http}/install.ps1 | iex"`;
  if (shell === "cmd") return { cmd: "cmd.exe", args: ["/d", "/s", "/c", winLine] };
  if (shell === "ps-paste") return { cmd: "powershell", args: ["-NoProfile", "-Command", winLine] };
  if (shell === "pwsh") return { cmd: "pwsh", args: ["-NoProfile", "-Command", `$env:PANTHEON_ARGS="${argLine.replace(/"/g, '`"')}"; irm ${http}/install.ps1 | iex`] };
  return { cmd: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `$env:PANTHEON_ARGS="${argLine.replace(/"/g, '`"')}"; irm ${http}/install.ps1 | iex`] };
}
function install(args, shell) {
  const l = installLine(args, shell);
  const r = spawnSync(l.cmd, l.args, { encoding: "utf8", env: jenv, cwd: jroot, timeout: 600_000, windowsVerbatimArguments: shell === "cmd" });
  return { code: r.status, out: strip(`${r.stdout ?? ""}${r.stderr ?? ""}`), error: r.error };
}
/** pantheon, the way the joiner now runs it: the launcher the installer wrote. */
function joiner(args, cwd = jroot) {
  const r = spawnSync(launcher, args, { encoding: "utf8", env: jenv, cwd, timeout: 120_000, shell: WIN });
  return { code: r.status, out: strip(`${r.stdout ?? ""}${r.stderr ?? ""}`) };
}
const hashProfiles = () => {
  if (WIN) return spawnSync("powershell", ["-NoProfile", "-Command", "[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)"], { encoding: "utf8" }).stdout.trim();
  const h = createHash("sha256");
  for (const f of [".profile", ".bashrc", ".bash_profile", ".zshrc", ".zprofile"]) { try { h.update(f + readFileSync(join(jhome, f))); } catch { /* none */ } }
  return h.digest("hex");
};

await step("this person has no node, npm or pantheon on PATH", () => {
  for (const n of ["node", "npm", "pantheon"]) {
    const r = spawnSync(WIN ? "where" : "sh", WIN ? [n] : ["-c", `command -v ${n}`], { encoding: "utf8", env: jenv });
    if (r.status === 0 && r.stdout.trim()) throw new Error(`${n} is still on PATH: ${r.stdout.trim()}`);
  }
  return "";
});

await step("the one line installs Pantheon and signs them up (no Node beforehand)", async () => {
  const r = install(["signup", "--email", "joiner@example.com", "--username", "joiner", "--relay", relayUrl]);
  if (r.code !== 0) throw new Error(`exit ${r.code}${r.error ? ` (${r.error.message})` : ""}:\n${r.out.slice(-1200)}`);
  if (!existsSync(findLauncher())) throw new Error(`no launcher at ${launcher}:\n${r.out.slice(-600)}`);
  const v = joiner(["verify", await codeFor("joiner@example.com")]);
  if (v.code !== 0) throw new Error(v.out.slice(-400));
  return /Downloading Node/.test(r.out) ? "Node downloaded and checked" : "";
});

await step("the pantheon it installed is the relay's version, on Pantheon's own Node", () => {
  const r = joiner(["--version"]);
  const v = /\d+\.\d+\.\d+(-[\w.]+)?/.exec(r.out)?.[0];
  if (r.code !== 0 || !v) throw new Error(r.out.slice(-300));
  if (want && !["latest", "next"].includes(want) && v !== want) throw new Error(`installed ${v}, expected ${want}`);
  return v;
});

await step("a NEW terminal finds that pantheon first", () => {
  const r = WIN
    ? spawnSync("powershell", ["-NoProfile", "-Command", "$env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine'); (Get-Command pantheon -ErrorAction Stop).Source"], { encoding: "utf8", env: jenv })
    : spawnSync(process.env.SHELL?.endsWith("zsh") ? "zsh" : "bash", ["-lic", "command -v pantheon"], { encoding: "utf8", env: { ...jenv, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  const found = (r.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
  if (found.toLowerCase() !== launcher.toLowerCase()) throw new Error(`a new shell runs "${found}", not ${launcher}\n${strip(r.stderr).slice(-300)}`);
  return found;
});

await step("joining with the invite, through the same one line", () => {
  const r = install(["join", invite, "--name", "Joiner", "--title", "Engineer", "--decides", "none", ...quiet]);
  if (r.code !== 0) throw new Error(`exit ${r.code}:\n${r.out.slice(-800)}`);
  if (!/already installed/i.test(r.out)) throw new Error(`the second run did not say it was already installed:\n${r.out.slice(0, 500)}`);
  const cfg = JSON.parse(readFileSync(join(jenv.PANTHEON_HOME, "config.json"), "utf8"));
  if (!Object.values(cfg.spaces ?? {}).some((sp) => sp.name === "acme")) throw new Error("no membership in acme was saved");
  return "";
});

await step("a message crosses: the joiner says hello, the founder reads it", async () => {
  const say = joiner(["say", "NOTE", "hello from the installer"]);
  if (say.code !== 0) throw new Error(say.out.slice(-300));
  await new Promise((r) => setTimeout(r, 500));
  const h = founder(["history"]);
  if (!/hello from the installer/.test(h.out)) throw new Error(h.out.slice(-400));
  return "";
});

await step("the MCP entry it writes starts the way an agent starts it", async () => {
  const repo = join(jroot, "repo"); mkdirSync(repo, { recursive: true });
  // A runner has no coding agent; Cursor's config folder is what Pantheon takes as "Cursor
  // is here", so its user entry is written and can be started the way Cursor starts it.
  mkdirSync(join(jhome, ".cursor"), { recursive: true });
  const u = joiner(["install", "--user"]);
  const files = [join(jhome, ".cursor", "mcp.json"), join(jhome, ".claude.json")];
  const r = joiner(["install"], repo);
  if (r.code !== 0 && u.code !== 0) throw new Error(`${r.out.slice(-300)}\n${u.out.slice(-300)}`);
  for (const f of [join(repo, ".mcp.json"), ...files]) {
    if (!existsSync(f)) continue;
    const e = JSON.parse(readFileSync(f, "utf8")).mcpServers?.pantheon ?? Object.values(JSON.parse(readFileSync(f, "utf8")).projects ?? {}).map((p) => p.mcpServers?.pantheon).find(Boolean);
    if (!e?.command) continue;
    if (e.command === "pantheon" || e.command === "pantheon.cmd") continue;   // the portable committed form: checked by journey.mjs
    const a = await handshake(e.command, e.args ?? [], jenv, repo);
    if (!a.ok) throw new Error(`${f}: ${e.command} ${(e.args ?? []).join(" ")}\n${a.why}`);
    return `${e.command} — ${a.tools} tools`;
  }
  throw new Error("no MCP entry naming this machine's pantheon was written");
});

await step("pantheon doctor reports the managed runtime and no FAIL", () => {
  const r = joiner(["doctor"]);
  if (/\bFAIL\b/.test(r.out)) throw new Error(r.out.split("\n").filter((l) => /FAIL/.test(l)).join("\n"));
  if (!/Pantheon's own Node/.test(r.out)) throw new Error(`doctor did not mention the managed runtime:\n${r.out.slice(-600)}`);
  return "";
});

await step("running the one line again changes nothing", () => {
  const before = hashProfiles();
  const r = install([]);
  if (r.code !== 0) throw new Error(r.out.slice(-500));
  if (/Downloading/.test(r.out)) throw new Error(`downloaded again:\n${r.out.slice(0, 400)}`);
  if (hashProfiles() !== before) throw new Error("the PATH setup changed on a second run");
  return "";
});

if (WIN) {
  await step("the Windows line from the invite works pasted into Command Prompt", () => {
    const r = install(["--version"], "cmd");
    if (r.code !== 0) throw new Error(r.out.slice(-600));
    if (!/already installed/i.test(r.out) || !/\d+\.\d+\.\d+/.test(r.out.split("\n").slice(-3).join(" "))) throw new Error(r.out.slice(-500));
    return "";
  });
  await step("the same line works pasted into PowerShell", () => {
    const r = install(["--version"], "ps-paste");
    if (r.code !== 0) throw new Error(r.out.slice(-600));
    if (!/already installed/i.test(r.out) || !/\d+\.\d+\.\d+/.test(r.out.split("\n").slice(-3).join(" "))) throw new Error(r.out.slice(-500));
    return "";
  });
}

await step("pantheon uninstall removes what the installer added, and nothing else", async () => {
  const help = joiner(["help"]);
  if (!/\buninstall\b/.test(help.out)) return "not in this version: skipped";
  // A person closes their agent windows first; here, any pantheon still running from the
  // runtime (an MCP server an earlier step started) is stopped and named.
  let closed = "";
  if (WIN) {
    const ps = spawnSync("powershell", ["-NoProfile", "-Command", `Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith('${join(dirname(dirname(findLauncher())), "runtime")}', 'OrdinalIgnoreCase') } | ForEach-Object { "$($_.Id) $($_.Path)"; Stop-Process -Id $_.Id -Force }`], { encoding: "utf8" });
    closed = (ps.stdout ?? "").trim();
  }
  const runtime = WIN ? join(dirname(dirname(findLauncher())), "runtime") : join(jhome, ".pantheon", "runtime");
  const r = joiner(["uninstall", "--yes"]);
  if (r.code !== 0) throw new Error(r.out.slice(-500));
  // Since 0.33.1 the identity stays (a reinstall is back in its teams): said, and only it is left of Pantheon's home.
  if (/kept, so installing Pantheon again puts you back/.test(r.out)) {
    const ph = jenv.PANTHEON_HOME;
    const leftThere = existsSync(ph) ? readdirSync(ph).filter((n) => !/^(config\.json(\.bak|\.lock)?|keys\.json|profile\.json|worker-policy\.json|spend\.json|continued\.json|cursors\.json|nonces\.json|worker-cursor\.json|personas|\.pantheon-home)$/.test(n)) : [];
    if (!existsSync(join(ph, "config.json"))) throw new Error(`uninstall said it kept the identity, but ${ph}\\config.json is gone`);
    if (leftThere.length && !(WIN && leftThere.every((n) => ["runtime", "bin"].includes(n)))) throw new Error(`besides the identity, ${ph} still has: ${leftThere.join(", ")}`);
  }
  // Windows: the runtime is locked while uninstall runs from it, and goes a few seconds after it exits.
  for (let i = 0; i < (WIN ? 60 : 1) && existsSync(runtime); i++) await new Promise((res) => setTimeout(res, 500));
  if (existsSync(runtime)) {
    const holding = WIN ? spawnSync("powershell", ["-NoProfile", "-Command", `Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith('${runtime}', 'OrdinalIgnoreCase') } | ForEach-Object { "$($_.Id) $($_.Path)" }`], { encoding: "utf8" }).stdout : "";
    let log = ""; try { log = readFileSync(join(process.env.TEMP ?? "", "pantheon-uninstall.log"), "utf8"); } catch { log = "(no pantheon-uninstall.log: the cleanup never ran)"; }
    throw new Error(`${runtime} is still there${holding ? `; still running from it: ${holding.trim()}` : ""}\ncleanup log: ${log.slice(-600) || "(empty)"}\n${r.out.slice(-300)}`);
  }
  if (closed) return `closed first (an agent window would be): ${closed.split(/\r?\n/).length} process(es)`;
  if (!WIN) for (const f of [".profile", ".bashrc", ".zshrc"]) { try { if (readFileSync(join(jhome, f), "utf8").includes(">>> pantheon >>>")) throw new Error(`${f} still has the PATH block`); } catch (e) { if (e.code !== "ENOENT") throw e; } }
  return "";
});

/* ---- upgrades: the transition every one-line install makes, then the new release's own path ---- */
// PANTHEON_PREV_VERSION: a release installed with the one line first (0.32.1). Its
// own upgrade code is what every machine on it will run when a release ships.
const prev = process.env.PANTHEON_PREV_VERSION ?? "";
if (prev && want && !["latest", "next"].includes(want)) {
  const uroot = mkdtempSync(join(tmpdir(), "pi-upgrader-"));
  const uhome = join(uroot, "home"); mkdirSync(uhome, { recursive: true });
  const uenv = { ...process.env, HOME: uhome, USERPROFILE: uhome, PANTHEON_HOME: join(uroot, "pantheon"), PATH: nodelessPath() };
  if (WIN) uenv.Path = uenv.PATH;
  const rt = WIN ? join(localAppData, "Pantheon", "runtime") : join(uhome, ".pantheon", "runtime");
  const node = WIN ? join(rt, "node", "node.exe") : join(rt, "node", "bin", "node");
  const pkg = WIN ? join(rt, "node", "node_modules", "@join-pantheon", "cli") : join(rt, "node", "lib", "node_modules", "@join-pantheon", "cli");
  const versionOf = () => { const r = spawnSync(node, ["--use-system-ca", join(pkg, "bin", "pantheon.js"), "--version"], { encoding: "utf8", env: uenv }); return /\d+\.\d+\.\d+(-[\w.]+)?/.exec(strip(r.stdout))?.[0] ?? `(no answer: ${strip(r.stderr).slice(0, 200)})`; };
  /** an MCP server running from the install, as an open agent window keeps one */
  const holdMcp = () => spawn(node, ["--use-system-ca", join(pkg, "dist", "cli.js"), "mcp"], { env: uenv, stdio: ["pipe", "ignore", "ignore"] });
  /** exactly what a worker runs to self-upgrade: that release's own upgrade(), toward the relay's version */
  const workerUpgrade = (to) => spawnSync(node, ["--use-system-ca", "-e",
    `import(${JSON.stringify(pathToFileURL(join(pkg, "dist", "upgrade.js")).href)}).then((m) => { const r = m.upgrade(undefined, { version: ${JSON.stringify(to)} }); console.log("RESULT " + JSON.stringify({ ok: r.ok, from: r.from, to: r.to, steps: r.steps })); })`],
    { encoding: "utf8", env: uenv, timeout: 600_000 });

  // Released code before 0.32.2 asks npm for a plain version only, so it cannot
  // be pointed at a release candidate: that leg needs the final V published as
  // `next` (RELEASING.md step 3). Said loudly, never skipped silently.
  const prevCanReach = !want.includes("-");
  if (!prevCanReach) console.log(`NOT RUN: ${prev} -> ${want}. ${prev} cannot upgrade to a release candidate; run this workflow again with the final version (published as next).`);
  if (prevCanReach) await step(`the one line installs the previous release (${prev})`, async () => {
    const r0 = await fetch(`${http}/${WIN ? "install.ps1" : "install.sh"}`);
    let script = await r0.text();
    script = WIN ? script.replace(/\$PantheonVersion = '[^']+'/, `$PantheonVersion = '${prev}'`) : script.replace(/^PANTHEON_VERSION="[^"]+"/m, `PANTHEON_VERSION="${prev}"`);
    const f = join(uroot, WIN ? "install-prev.ps1" : "install-prev.sh"); writeFileSync(f, script);
    const r = WIN
      ? spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f], { encoding: "utf8", env: uenv, timeout: 600_000 })
      : spawnSync("sh", [f], { encoding: "utf8", env: uenv, timeout: 600_000 });
    if (r.status !== 0) throw new Error(strip(`${r.stdout}${r.stderr}`).slice(-800));
    const v = versionOf(); if (v !== prev) throw new Error(`installed ${v}, expected ${prev}`);
    return v;
  });

  if (prevCanReach) await step(`${prev} self-upgrades to ${want} the way its worker does, with an agent's MCP server running`, async () => {
    const mcp = holdMcp(); await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = workerUpgrade(want);
      const res = /RESULT (.*)/.exec(r.stdout ?? "")?.[1];
      if (!res) throw new Error(`no result: ${strip(`${r.stdout}${r.stderr}`).slice(-600)}`);
      const j = JSON.parse(res);
      if (!j.ok) throw new Error(`upgrade failed: ${JSON.stringify(j.steps).slice(0, 600)}`);
    } finally { mcp.kill(); }
    const v = versionOf(); if (v !== want) throw new Error(`after the upgrade it answers ${v}, expected ${want}`);
    const a = await handshake(node, ["--use-system-ca", join(pkg, "dist", "cli.js"), "mcp"], uenv, uroot);
    if (!a.ok) throw new Error(`the upgraded MCP server does not start: ${a.why}`);
    return `${prev} -> ${v}, MCP ${a.tools} tools`;
  });

  if (!prevCanReach) await step(`the one line installs ${want}`, async () => {
    const f = join(uroot, WIN ? "install.ps1" : "install.sh"); writeFileSync(f, await (await fetch(`${http}/${WIN ? "install.ps1" : "install.sh"}`)).text());
    const r = WIN
      ? spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f], { encoding: "utf8", env: uenv, timeout: 600_000 })
      : spawnSync("sh", [f], { encoding: "utf8", env: uenv, timeout: 600_000 });
    if (r.status !== 0) throw new Error(strip(`${r.stdout}${r.stderr}`).slice(-800));
    return versionOf();
  });
  await step(`${want}'s own upgrade swaps safely while an MCP server runs: checked, swapped, the previous kept`, async () => {
    const mcp = holdMcp(); await new Promise((r) => setTimeout(r, 2000));
    let j;
    try {
      const r = workerUpgrade(want);
      const res = /RESULT (.*)/.exec(r.stdout ?? "")?.[1];
      if (!res) throw new Error(`no result: ${strip(`${r.stdout}${r.stderr}`).slice(-600)}`);
      j = JSON.parse(res);
      if (!j.ok) throw new Error(`upgrade failed: ${JSON.stringify(j.steps).slice(0, 600)}`);
    } finally { mcp.kill(); }
    if (!existsSync(join(rt, "cli.prev"))) throw new Error(`no ${join(rt, "cli.prev")}: the upgrade did not go through the swap (${JSON.stringify(j.steps).slice(0, 300)})`);
    if (readdirSync(rt).some((n) => n.startsWith(".upgrade-"))) throw new Error("a staging folder was left behind");
    const v = versionOf(); if (v !== want) throw new Error(`after the swap it answers ${v}`);
    const a = await handshake(node, ["--use-system-ca", join(pkg, "dist", "cli.js"), "mcp"], uenv, uroot);
    if (!a.ok) throw new Error(`the MCP server does not start after the swap: ${a.why}`);
    return `swapped, previous kept, MCP ${a.tools} tools`;
  });

  await step("an upgrade cut off between its two renames: the pantheon command puts the CLI back and runs", async () => {
    const ulauncher = WIN ? winLauncher(uhome) : join(uhome, ".pantheon", "bin", "pantheon");
    const prevDir = join(rt, "cli.prev");
    rmSync(prevDir, { recursive: true, force: true });
    renameSync(pkg, prevDir);
    const r = WIN
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", `""${ulauncher}" --version"`], { encoding: "utf8", env: uenv, windowsVerbatimArguments: true })
      : spawnSync(ulauncher, ["--version"], { encoding: "utf8", env: uenv });
    const said = strip(`${r.stdout}${r.stderr}`);
    if (!existsSync(join(pkg, "bin", "pantheon.js"))) throw new Error(`the CLI was not put back (launcher said: ${said.slice(0, 300)})`);
    if (!said.includes(want)) throw new Error(`the launcher did not run ${want} after putting it back: ${said.slice(0, 300)}`);
    return "put back, and it ran";
  });
}

/** Start an MCP server exactly as an agent host does — no shell — and finish initialize + tools/list. */
function handshake(command, args, env, cwd) {
  return new Promise((done) => {
    let child;
    try { child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], shell: false }); }
    catch (e) { done({ ok: false, why: `could not be started: ${e.message}` }); return; }
    let buf = "", err = "";
    const timer = setTimeout(() => { child.kill(); done({ ok: false, why: `no answer in 30s. stderr: ${err.slice(-300)}` }); }, 30_000);
    child.on("error", (e) => { clearTimeout(timer); done({ ok: false, why: `${e.code ?? ""} ${e.message}` }); });
    child.stderr.on("data", (b) => { err += b; });
    child.stdout.on("data", (b) => {
      buf += b;
      for (const line of buf.split("\n").slice(0, -1)) {
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
        }
        if (m.id === 2) { clearTimeout(timer); child.kill(); done({ ok: true, tools: m.result?.tools?.length ?? 0 }); }
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "installer", version: "0" } } }) + "\n");
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `${failed.length} of ${results.length} steps FAILED` : `all ${results.length} steps passed`} on ${platform()} ${process.arch}`);
process.exit(failed.length ? 1 : 0);
