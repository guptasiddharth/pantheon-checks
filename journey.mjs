#!/usr/bin/env node
/**
 * Pantheon, as a new person meets it — run against the published npm package on
 * a real machine (Windows, macOS, Linux). Nothing here is Pantheon's source: it
 * drives the `pantheon` command that `npm i -g @join-pantheon/cli` installed.
 *
 * Everything happens in throwaway homes against a relay started on this machine,
 * so it touches no real account, team or hosted service.
 *
 *   node journey.mjs            exits 0 when every step passed
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

const WIN = platform() === "win32";
const results = [];
const step = async (name, fn) => {
  try { const detail = (await fn()) ?? ""; results.push({ ok: true, name, detail }); console.log(`  ok    ${name}${detail ? `   ${detail}` : ""}`); }
  catch (e) { results.push({ ok: false, name, detail: e.message }); console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n").join("\n        ")}`); }
};
const strip = (s) => String(s ?? "").replace(/\u001b\[[0-9;]*m/g, "");

/** A separate person: their own home, their own Pantheon home. */
function person(name) {
  const root = mkdtempSync(join(tmpdir(), `pj-${name}-`));
  const home = join(root, "home"); mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, PANTHEON_HOME: join(root, "pantheon"), APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") };
  for (const k of ["PANTHEON_RELAY", "PANTHEON_SPACE", "PANTHEON_TOKEN", "PANTHEON_MEMBER", "PANTHEON_AGENT", "PANTHEON_PUBKEY", "PANTHEON_PRIVKEY"]) delete env[k];
  const run = (args, opts = {}) => {
    // `pantheon` on Windows is pantheon.cmd: a person types it in a shell, so run it through one.
    const r = spawnSync(WIN ? "pantheon.cmd" : "pantheon", args, { encoding: "utf8", env, cwd: opts.cwd ?? root, timeout: opts.timeout ?? 120_000, shell: WIN, input: opts.input });
    return { code: r.status, out: strip(`${r.stdout ?? ""}${r.stderr ?? ""}`), error: r.error };
  };
  return { name, root, home, env, run };
}

const freePort = () => new Promise((done) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => done(port)); }); });

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
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "journey", version: "0" } } }) + "\n");
  });
}

const want = process.env.PANTHEON_VERSION ?? "";
console.log(`pantheon journey — ${platform()} ${process.arch}, node ${process.version}${want ? `, expecting ${want}` : ""}\n`);

const founder = person("founder"), joiner = person("joiner");
const port = await freePort();
const relayUrl = `ws://127.0.0.1:${port}`;
let relayLog = "";
const relay = spawn(WIN ? "pantheon.cmd" : "pantheon", ["relay", "--port", String(port), "--data", join(founder.root, "relay")],
  { env: { ...founder.env, PANTHEON_REQUIRE_ACCOUNTS: "1" }, stdio: ["ignore", "pipe", "pipe"], shell: WIN });
relay.stdout.on("data", (b) => { relayLog += b; });
relay.stderr.on("data", (b) => { relayLog += b; });
const stopRelay = () => { try { if (WIN) spawnSync("taskkill", ["/pid", String(relay.pid), "/t", "/f"]); else relay.kill("SIGKILL"); } catch { /* gone */ } };
process.on("exit", stopRelay);

const codeFor = async (email) => {
  for (let i = 0; i < 60; i++) {
    const m = new RegExp(`code for ${email.replace(/[.+]/g, "\\$&")}: (\\d{6})`).exec(relayLog);
    if (m) return m[1];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no code for ${email} in the relay log: ${relayLog.slice(-300)}`);
};
const quiet = ["--no-worker", "--no-hook", "--no-notifications", "--no-menubar"];
let invite = "";

await step("pantheon --version", () => {
  const r = founder.run(["--version"]);
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.out.slice(0, 300)}${r.error ? ` ${r.error.message}` : ""}`);
  const v = /\d+\.\d+\.\d+(-[\w.]+)?/.exec(r.out)?.[0];
  if (want && want !== "latest" && want !== "next" && v !== want) throw new Error(`installed ${v}, expected ${want}`);
  return v;
});

await step("a relay starts on this machine and answers", async () => {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).ok) return `port ${port}`; } catch { /* not yet */ }
  }
  throw new Error(relayLog.slice(-400) || "no answer in 30s");
});

await step("the founder signs up and verifies by email code", async () => {
  const s = founder.run(["signup", "--email", "founder@example.com", "--username", "founder", "--relay", relayUrl]);
  if (s.code !== 0) throw new Error(s.out.slice(-400));
  const v = founder.run(["verify", await codeFor("founder@example.com")]);
  if (v.code !== 0 || !/verified/.test(v.out)) throw new Error(v.out.slice(-400));
  return "";
});

await step("the founder starts a team and gets an invite", () => {
  const r = founder.run(["start", "--relay", relayUrl, "--space", "acme", "--yes", "--name", "Founder", "--title", "Founder", "--decides", "none", ...quiet]);
  invite = /pantheon join (pantheons?:\/\/\S+)/.exec(r.out)?.[1] ?? "";
  if (r.code !== 0 || !invite) throw new Error(`exit ${r.code}: ${r.out.slice(-500)}`);
  return "";
});

await step("a new person signs up, verifies, and joins with the invite", async () => {
  const s = joiner.run(["signup", "--email", "joiner@example.com", "--username", "joiner", "--relay", relayUrl]);
  if (s.code !== 0) throw new Error(s.out.slice(-400));
  const v = joiner.run(["verify", await codeFor("joiner@example.com")]);
  if (v.code !== 0) throw new Error(v.out.slice(-400));
  const j = joiner.run(["join", invite, "--name", "Joiner", "--title", "Engineer", "--decides", "none", ...quiet]);
  if (j.code !== 0) throw new Error(`exit ${j.code}: ${j.out.slice(-500)}`);
  const cfg = JSON.parse(readFileSync(join(joiner.env.PANTHEON_HOME, "config.json"), "utf8"));
  if (!Object.values(cfg.spaces ?? {}).some((sp) => sp.name === "acme")) throw new Error("joined, but no membership in acme was saved");
  return "";
});

await step("a message crosses: the joiner says hello, the founder reads it", async () => {
  const say = joiner.run(["say", "NOTE", "hello from the journey"]);
  if (say.code !== 0) throw new Error(say.out.slice(-300));
  await new Promise((r) => setTimeout(r, 500));
  const h = founder.run(["history"]);
  if (!/hello from the journey/.test(h.out)) throw new Error(h.out.slice(-400));
  return "";
});

// Claude Code, when the workflow installed it: wiring, hooks and the committed-repo case use the real CLI.
const hasClaude = spawnSync(WIN ? "claude.cmd" : "claude", ["--version"], { encoding: "utf8", shell: WIN }).status === 0;

await step("every agent entry Pantheon wrote can be started the way a host starts it", async () => {
  const r = joiner.run(["install", "--user"]);
  const entries = [];
  const read = (label, file, pick) => { if (existsSync(file)) { try { const e = pick(JSON.parse(readFileSync(file, "utf8"))); if (e?.command) entries.push({ label, ...e }); } catch { /* none */ } } };
  read("claude code", join(joiner.home, ".claude.json"), (d) => d.mcpServers?.pantheon);
  read("cursor", join(joiner.home, ".cursor", "mcp.json"), (d) => d.mcpServers?.pantheon);
  if (!entries.length) return hasClaude ? (() => { throw new Error(`Claude Code is installed but no entry was written: ${r.out.slice(-300)}`); })() : "no agent on this machine to wire";
  const out = [];
  for (const e of entries) {
    const a = await handshake(e.command, e.args ?? [], joiner.env, joiner.root);
    if (!a.ok) throw new Error(`${e.label}: ${e.command} ${(e.args ?? []).join(" ")}\n${a.why}`);
    out.push(`${e.label}: ${a.tools} tools`);
  }
  return out.join(", ");
});

await step("a repo whose committed .mcp.json says `pantheon mcp` still gets Pantheon here", async () => {
  const repo = join(joiner.root, "team-repo");
  mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync("git", a, { cwd: repo, env: joiner.env, stdio: "pipe" });
  git("init", "-q"); git("remote", "add", "origin", "https://github.com/example/team-repo.git");
  writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { pantheon: { command: "pantheon", args: ["mcp"] } } }, null, 2));
  git("add", "."); git("-c", "user.email=j@example.com", "-c", "user.name=J", "commit", "-qm", "team config");
  const u = joiner.run(["use", "acme", "--here", "--yes"], { cwd: repo });
  if (u.code !== 0) throw new Error(u.out.slice(-400));
  if (!WIN) {
    const a = await handshake("pantheon", ["mcp"], joiner.env, repo);
    if (!a.ok) throw new Error(`the committed entry does not start here: ${a.why}`);
    return `committed entry starts (${a.tools} tools)`;
  }
  // Windows: a host cannot spawn pantheon.cmd without a shell, so Claude Code needs
  // its per-folder override, which outranks the committed file.
  if (!hasClaude) return "no Claude Code installed: nothing to check";
  const cj = JSON.parse(readFileSync(join(joiner.home, ".claude.json"), "utf8"));
  const proj = Object.entries(cj.projects ?? {}).find(([p]) => p.replace(/\\/g, "/").toLowerCase() === repo.replace(/\\/g, "/").toLowerCase())?.[1];
  const e = proj?.mcpServers?.pantheon;
  if (!e?.command) throw new Error(`no per-folder override for ${repo}: Claude Code would try the committed \`pantheon mcp\`, which Windows cannot start. use printed:\n${u.out.slice(-300)}`);
  const a = await handshake(e.command, e.args ?? [], joiner.env, repo);
  if (!a.ok) throw new Error(`the override does not start: ${a.why}`);
  return `override starts (${a.tools} tools)`;
});

await step("the wake-up hook is a command that actually runs", () => {
  if (!hasClaude) return "no Claude Code installed: nothing to hook";
  const r = joiner.run(["hook", "install", "--user"]);
  const f = join(joiner.home, ".claude", "settings.json");
  if (!existsSync(f)) throw new Error(`no ${f}: ${r.out.slice(-300)}`);
  const cmd = JSON.parse(readFileSync(f, "utf8")).hooks?.Stop?.[0]?.hooks?.[0]?.command;
  if (!cmd) throw new Error(`no Stop hook written: ${r.out.slice(-300)}`);
  // Hosts run hook commands through a shell; "end" is the harmless report of an editor going idle.
  const line = cmd.replace(/\s+\S+$/, " end");
  const run = spawnSync(line, { shell: true, encoding: "utf8", env: joiner.env, cwd: joiner.root, input: "{}", timeout: 60_000 });
  if (run.error || run.status !== 0) throw new Error(`\`${line}\` exited ${run.status}: ${strip(run.stderr).slice(-300)} ${run.error?.message ?? ""}`);
  return cmd.length > 70 ? `${cmd.slice(0, 67)}…` : cmd;
});

await step("pantheon doctor runs and reports", () => {
  const r = joiner.run(["doctor"]);
  if (!/machine/.test(r.out)) throw new Error(`exit ${r.code}: ${r.out.slice(-400)}`);
  const fails = r.out.split("\n").filter((l) => /\bFAIL\b|✗/.test(l));
  return fails.length ? `${fails.length} FAIL line(s): ${fails.slice(0, 2).join(" | ").slice(0, 160)}` : "no FAIL lines";
});

stopRelay();
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `${failed.length} of ${results.length} steps FAILED` : `all ${results.length} steps passed`} on ${platform()}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) => `| ${r.ok ? "✅" : "❌"} | ${r.name} | ${String(r.detail).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 200)} |`).join("\n");
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${platform()} · node ${process.version}\n\n| | step | detail |\n|---|---|---|\n${rows}\n\n`, { flag: "a" });
}
process.exit(failed.length ? 1 : 0);
