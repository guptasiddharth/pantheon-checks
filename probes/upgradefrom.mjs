// A member who joined with an older release installed by npm (UL joined with
// 0.31.0 on Windows, Ubuntu and macOS) moves to the latest: what `pantheon
// upgrade` does on its own, then what `service install` and `policy grant` add.
// The relay is the latest release, as the hosted one is. Real user, real home.
//   PANTHEON_FROM   the release the member has (npm -g, installed by the workflow)
//   RELAY_BIN       a pantheon of the latest release, for the relay and the teammate
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { platform, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const WIN = platform() === "win32", LINUX = platform() === "linux";
const FROM = process.env.PANTHEON_FROM, RELAY_BIN = process.env.RELAY_BIN;
const ART = process.env.ARTIFACTS || mkdtempSync(join(tmpdir(), "uf-art-"));
mkdirSync(ART, { recursive: true });
const strip = (s) => String(s ?? "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const winArg = (a) => (a === "" || /[\s&|<>^(),;=!]/.test(a) ? `"${a}"` : a);
function run(file, args, o = {}) {
  const opts = { encoding: "utf8", env: o.env ?? process.env, cwd: o.cwd, timeout: o.timeout ?? 180_000, windowsHide: true, maxBuffer: 64 << 20 };
  const r = WIN && /\.(cmd|bat)$/i.test(file)
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", `"${[file, ...args].map(winArg).join(" ")}"`], { ...opts, windowsVerbatimArguments: true })
    : spawnSync(file, args, opts);
  return { code: r.status, out: strip(`${r.stdout ?? ""}${r.stderr ?? ""}`) };
}
const results = [];
async function step(name, fn) {
  try { const d = (await fn()) ?? ""; results.push(["ok", name]); console.log(`  ok    ${name}${d ? `\n        ${String(d).split("\n").join("\n        ")}` : ""}`); return true; }
  catch (e) { results.push(["FAIL", name]); console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n").join("\n        ")}`); return false; }
}
const note = (label, text) => { console.log(`  --    ${label}\n        ${strip(text).trim().split("\n").slice(0, 60).join("\n        ")}`); };

const which = (n) => (spawnSync(WIN ? "where" : "which", [n], { encoding: "utf8" }).stdout ?? "").split(/\r?\n/).find((l) => l.trim())?.trim();
const memberBin = WIN ? which("pantheon.cmd") : "pantheon";
const scrub = (env) => { for (const k of Object.keys(env)) if (/^PANTHEON_/.test(k)) delete env[k]; return env; };

// The relay and the teammate: the latest release, in their own homes.
const tmpPerson = (name) => {
  const root = mkdtempSync(join(tmpdir(), `uf-${name}-`)), home = join(root, "home"); mkdirSync(home, { recursive: true });
  const env = scrub({ ...process.env, HOME: home, USERPROFILE: home, PANTHEON_HOME: join(root, "pantheon") });
  if (WIN) Object.assign(env, { APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") });
  return { root, env, run: (a, o = {}) => run(RELAY_BIN, a, { env, cwd: root, ...o }) };
};
const relayP = tmpPerson("relay"), peer = tmpPerson("peer");
const port = await new Promise((d) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => d(p)); }); });
const relayUrl = `ws://127.0.0.1:${port}`;
let relayLog = "";
const rargs = ["relay", "--port", String(port), "--data", join(relayP.root, "data")];
const relay = WIN
  ? spawn("cmd.exe", ["/d", "/s", "/c", `"${[RELAY_BIN, ...rargs].map(winArg).join(" ")}"`], { windowsVerbatimArguments: true, env: { ...relayP.env, PANTHEON_REQUIRE_ACCOUNTS: "1" }, windowsHide: true })
  : spawn(RELAY_BIN, rargs, { env: { ...relayP.env, PANTHEON_REQUIRE_ACCOUNTS: "1" } });
relay.stdout.on("data", (b) => { relayLog += b; }); relay.stderr.on("data", (b) => { relayLog += b; });
process.on("exit", () => { try { WIN ? spawnSync("taskkill", ["/pid", String(relay.pid), "/t", "/f"]) : relay.kill("SIGKILL"); } catch {} writeFileSync(join(ART, "relay.log"), relayLog); });
const codeFor = async (email) => { for (let i = 0; i < 120; i++) { const m = new RegExp(`code for ${email.replace(/[.+]/g, "\\$&")}: (\\d{6})`).exec(relayLog); if (m) return m[1]; await sleep(250); } throw new Error(`no code for ${email}`); };
for (let i = 0; i < 120; i++) { try { if ((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).ok) break; } catch {} await sleep(250); }

console.log(`upgrade from ${FROM} — ${platform()} ${process.arch}; relay ${run(RELAY_BIN, ["--version"], { env: relayP.env }).out.trim().split("\n").at(-1)}\n`);

// The member: real user, real home, in a git repo (as UL joined from their repo).
const home = userInfo().homedir;
const menv = scrub({ ...process.env, HOME: home }); if (WIN) menv.USERPROFILE = home;
const repo = join(home, "ul-repo"); mkdirSync(repo, { recursive: true });
run("git", ["init", "-q", "-b", "main"], { cwd: repo });
run("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
run("git", ["remote", "add", "origin", "https://github.com/example/ul-repo.git"], { cwd: repo });
const m = (a, o = {}) => run(o.bin ?? memberBin, a, { env: menv, cwd: repo, ...o });

let invite = "";
await step("teammate (latest) signs up and starts the team", async () => {
  peer.run(["signup", "--email", "peer@example.com", "--username", "peer", "--relay", relayUrl]);
  const v = peer.run(["verify", await codeFor("peer@example.com")]); if (v.code !== 0) throw new Error(v.out.slice(-300));
  const r = peer.run(["start", "--relay", relayUrl, "--space", "ul", "--yes", "--name", "Peer", "--title", "Founder", "--decides", "none", "--no-worker", "--no-hook", "--no-notifications", "--no-menubar"]);
  invite = /pantheon join (\S+)/.exec(r.out)?.[1]?.replace(/['"]$/, "") ?? ""; if (!invite) throw new Error(r.out.slice(-500));
});
await step(`member on ${FROM} (npm -g) signs up and joins with defaults, from the repo`, async () => {
  const ver = m(["--version"]).out; if (!ver.includes(FROM)) throw new Error(`member runs ${ver}`);
  const s = m(["signup", "--email", "member@example.com", "--username", "member", "--relay", relayUrl]); writeFileSync(join(ART, "signup.txt"), s.out);
  const v = m(["verify", await codeFor("member@example.com")]); if (v.code !== 0) throw new Error(v.out.slice(-300));
  const j = m(["join", invite, "--yes", "--name", "Member", "--title", "QA", "--decides", "engineering,deployment"], { timeout: 300_000 });
  writeFileSync(join(ART, "join.txt"), j.out); if (j.code !== 0) throw new Error(j.out.slice(-800));
  return j.out.split("\n").filter((l) => /worker|alerts|notif|menu|tray|host/i.test(l)).slice(0, 12).join("\n");
});
note(`ps on ${FROM}`, m(["ps"]).out);
note(`policy on ${FROM}`, m(["policy"]).out);

let upOut = "";
await step(`pantheon upgrade (the ${FROM} command) moves the member to the latest`, async () => {
  const r = m(["upgrade"], { timeout: 600_000 }); upOut = r.out; writeFileSync(join(ART, "upgrade.txt"), r.out);
  const v = run(WIN ? which("pantheon.cmd") : "pantheon", ["--version"], { env: menv, cwd: repo }).out.trim().split("\n").at(-1);
  if (r.code !== 0 || v.includes(FROM)) throw new Error(`exit ${r.code}, now ${v}\n${r.out.slice(-1200)}`);
  return `now ${v}\n${r.out.trim().split("\n").slice(-12).join("\n")}`;
});
const bin2 = WIN ? which("pantheon.cmd") : "pantheon";
note("ps right after upgrade", m(["ps"], { bin: bin2 }).out);
note("policy right after upgrade", m(["policy"], { bin: bin2 }).out);
note("doctor right after upgrade (alerts/worker/version lines)", m(["doctor"], { bin: bin2, timeout: 240_000 }).out.split("\n").filter((l) => /alerts|worker|menu|host|tray|version|machine|FAIL|warn/i.test(l)).join("\n"));

await step("pantheon service install notifier", () => { const r = m(["service", "install", "notifier"], { bin: bin2 }); if (r.code !== 0) throw new Error(r.out.slice(-600)); return r.out.trim().split("\n").slice(-4).join("\n"); });
await step("pantheon service install worker --allow-bash (in the repo)", () => { const r = m(["service", "install", "worker", "--allow-bash"], { bin: bin2 }); if (r.code !== 0) throw new Error(r.out.slice(-600)); return r.out.trim().split("\n").slice(-4).join("\n"); });
await step("pantheon policy grant self-upgrade", () => { const r = m(["policy", "grant", "self-upgrade"], { bin: bin2 }); if (r.code !== 0) throw new Error(r.out.slice(-400)); const p = m(["policy"], { bin: bin2 }).out; if (!/self-upgrade\s+granted/.test(p)) throw new Error(p); return p.split("\n").find((l) => /self-upgrade/.test(l)); });
await sleep(15_000);
note("ps after the three commands", m(["ps"], { bin: bin2 }).out);
const doc = m(["doctor"], { bin: bin2, timeout: 240_000 }).out; writeFileSync(join(ART, "doctor.txt"), doc);
note("doctor after (alerts/worker/version lines)", doc.split("\n").filter((l) => /alerts|worker|menu|host|tray|version|machine|FAIL|warn|blocking|no blockers/i.test(l)).join("\n"));
await step("worker is running after", () => { const p = m(["ps"], { bin: bin2 }).out; if (!/worker\s+running/.test(p)) throw new Error(p); });
await step("alerts (notifier) are running after", () => { const p = m(["ps"], { bin: bin2 }).out; if (!/notifier\s+running/.test(p)) throw new Error(p); });

const fails = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${fails ? `${fails} FAILED` : "nothing failed"}, ${results.length - fails} ok — ${platform()} ${process.arch}, from ${FROM}`);
process.exitCode = fails ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 500);
