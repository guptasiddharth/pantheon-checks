#!/usr/bin/env node
/**
 * Pantheon's desktop pieces (0.33), as a person meets them on a real machine:
 *
 *   Windows  the per-user Task Scheduler task and the hidden background host it
 *            starts (worker, notifier, tray), what keeps them running, an alert
 *            for a teammate's decision going through the tray, pantheon:// links,
 *            the board, `stop all` and `uninstall`;
 *   Linux    alerts over D-Bus with buttons (a session bus and a stand-in
 *            notification server started here), Done answering the decision on
 *            the relay, `doctor`'s alerts line, the systemd --user unit, the board;
 *   macOS    the board, and the launchd agents of the notifier and menu bar
 *            compared with the previous release's.
 *
 * Nothing here is Pantheon's source. It drives the `pantheon` command the
 * published package installs (npm, or on Windows the one-line installer served
 * by the relay below) and looks at what it leaves on the machine: processes,
 * files, the registry, Task Scheduler, launchd, systemd.
 *
 * A relay runs on this machine (from the same package); the person under test
 * ("member") uses this runner's real home, because services, Task Scheduler and
 * the registry are per user and Pantheon refuses to touch them from a borrowed
 * home. Their teammate ("peer") lives in a throwaway home. A hosted runner is
 * thrown away afterwards; everything is still taken down at the end.
 *
 * Every check prints ok, FAIL (with what was seen) or NOT RUN (with why it could
 * not run here). Nothing is skipped silently.
 *
 *   node desktop.mjs            exits 0 when nothing FAILed
 *
 * env: PANTHEON_VERSION       the version expected (npm installed it)
 *      PANTHEON_PREV_VERSION  macOS: the release whose launchd agents are compared with
 *      DESKTOP_ARTIFACTS      where logs are copied (uploaded by the workflow)
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { request } from "node:http";
import { networkInterfaces, platform, tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";

const OS = platform();
const WIN = OS === "win32", MAC = OS === "darwin", LINUX = OS === "linux";
const want = process.env.PANTHEON_VERSION ?? "";
const prev = process.env.PANTHEON_PREV_VERSION ?? "";
const ART = process.env.DESKTOP_ARTIFACTS || mkdtempSync(join(tmpdir(), "pd-artifacts-"));
mkdirSync(ART, { recursive: true });

/* ------------------------------------------------------------------ reporting */

const results = [];
const NOT_RUN = (why) => ({ notRun: why });
const indent = (s) => String(s).split("\n").join("\n           ");
/** Run one check. `blocked`: a reason it cannot run (an earlier step failed) — printed as NOT RUN. */
async function step(name, fn, blocked = null) {
  if (blocked) {
    results.push({ state: "NOT RUN", name, detail: blocked });
    console.log(`  NOT RUN  ${name}\n           ${indent(blocked)}`);
    return null;
  }
  const t0 = Date.now();
  try {
    const r = await fn();
    const secs = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
    if (r && typeof r === "object" && "notRun" in r) {
      results.push({ state: "NOT RUN", name, detail: r.notRun });
      console.log(`  NOT RUN  ${name}\n           ${indent(r.notRun)}`);
      return null;
    }
    const detail = r ?? "";
    results.push({ state: "ok", name, detail });
    console.log(`  ok       ${name}   ${detail ? `${detail}  ` : ""}(${secs})`);
    return true;
  } catch (e) {
    results.push({ state: "FAIL", name, detail: e.message });
    console.log(`  FAIL     ${name}\n           ${indent(e.message)}`);
    return false;
  }
}

/* ------------------------------------------------------------------ helpers */

const strip = (s) => String(s ?? "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Ask `fn` until it returns something truthy, or the time is up (then null). */
async function waitFor(fn, ms, every = 500) {
  const until = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() >= until) return null;
    await sleep(every);
  }
}
const freePort = () => new Promise((done) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => done(port)); }); });
const readText = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
const tail = (s, n = 40) => String(s).trimEnd().split("\n").slice(-n).join("\n");
const fileSize = (f) => { try { return statSync(f).size; } catch { return -1; } };
/** What was appended to a file after byte `from`. */
const since = (f, from) => { const t = readText(f); return from > 0 && t.length >= from ? t.slice(from) : t; };

/** A Windows command-line word for cmd.exe: quoted when it holds anything cmd reads. Our words never hold a double quote or %. */
const winArg = (a) => (a === "" || /[\s&|<>^(),;=!]/.test(a) ? `"${a}"` : a);

/** Run a program to its end. A .cmd on Windows goes through cmd.exe, quoted the way a person types it. */
function run(file, args, o = {}) {
  const opts = { encoding: "utf8", env: o.env ?? process.env, cwd: o.cwd, timeout: o.timeout ?? 120_000, input: o.input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
  const r = WIN && /\.(cmd|bat)$/i.test(file)
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", `"${[file, ...args].map(winArg).join(" ")}"`], { ...opts, windowsVerbatimArguments: true })
    : spawnSync(file, args, opts);
  return { code: r.status, out: strip(`${r.stdout ?? ""}${r.stderr ?? ""}`), stdout: strip(r.stdout ?? ""), error: r.error };
}
/** The same, without blocking this process (so watchers keep running meanwhile). */
function runAsync(file, args, o = {}) {
  return new Promise((done) => {
    const opts = { env: o.env ?? process.env, cwd: o.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] };
    const c = WIN && /\.(cmd|bat)$/i.test(file)
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"${[file, ...args].map(winArg).join(" ")}"`], { ...opts, windowsVerbatimArguments: true })
      : spawn(file, args, opts);
    let out = "";
    c.stdout.on("data", (b) => { out += b; });
    c.stderr.on("data", (b) => { out += b; });
    const t = setTimeout(() => { try { c.kill(); } catch { /* gone */ } }, o.timeout ?? 120_000);
    c.on("error", (e) => { clearTimeout(t); done({ code: null, out: strip(out), error: e }); });
    c.on("close", (code) => { clearTimeout(t); done({ code, out: strip(out) }); });
  });
}
/** Windows PowerShell running a script file (the harness's own scripts; -File needs the policy lifted for them). */
function ps(script, o = {}) {
  const f = join(scratch, `ps-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  writeFileSync(f, `$ErrorActionPreference = 'Continue'\r\n${script}`);
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", f], { encoding: "utf8", env: o.env ?? process.env, timeout: o.timeout ?? 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  try { rmSync(f, { force: true }); } catch { /* left in the scratch folder */ }
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), stdout: (r.stdout ?? "").trim() };
}
/** schtasks prints its XML in UTF-16 when piped on some builds, and in the console code page on others. */
function decodeOut(buf) {
  if (!buf || !buf.length) return "";
  const zeros = buf.filter((b, i) => i < 400 && b === 0).length;
  return zeros > 50 ? buf.toString("utf16le").replace(/^\uFEFF/, "") : buf.toString("utf8");
}
/** A plain HTTP request to 127.0.0.1, with full control over Host and Origin (fetch would set them itself). */
function http(port, path, o = {}) {
  return new Promise((done) => {
    const req = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: o.headers ?? {}, timeout: o.timeout ?? 15_000 }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } done({ status: res.statusCode, text, json }); });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", (e) => done({ status: 0, text: "", json: null, error: e.code ?? e.message }));
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}
/** Does anything accept a TCP connection at host:port? */
const reachable = (host, port) => new Promise((done) => {
  const s = connect({ host, port, timeout: 3000 });
  s.on("connect", () => { s.destroy(); done("connected"); });
  s.on("timeout", () => { s.destroy(); done("timeout"); });
  s.on("error", (e) => done(e.code ?? "error"));
});

/* ------------------------------------------------------------------ cleanup */

const cleanups = [];
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const f of cleanups.reverse()) { try { f(); } catch { /* best effort */ } }
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });
const killTree = (child) => {
  if (!child?.pid) return;
  try { if (WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }); else child.kill("SIGKILL"); } catch { /* gone */ }
};

const scratch = mkdtempSync(join(tmpdir(), "pd-"));

/* ------------------------------------------------------------------ the package, the relay, two people */

console.log(`pantheon desktop — ${OS} ${process.arch}, node ${process.version}${want ? `, expecting ${want}` : ""}\n`);

/** The pantheon npm installed (the relay's, the peer's, and the member's off Windows). */
const npmPantheon = WIN
  ? (spawnSync("where", ["pantheon.cmd"], { encoding: "utf8" }).stdout ?? "").split(/\r?\n/).find((l) => l.trim())?.trim() ?? "pantheon.cmd"
  : "pantheon";
const scrub = (env) => {
  for (const k of Object.keys(env)) if (/^PANTHEON_/.test(k) && !["PANTHEON_VERSION", "PANTHEON_PREV_VERSION"].includes(k)) delete env[k];
  delete env.PANTHEON_VERSION; delete env.PANTHEON_PREV_VERSION;
  return env;
};

function tempPerson(name) {
  const root = mkdtempSync(join(tmpdir(), `pd-${name}-`));
  const home = join(root, "home"); mkdirSync(home, { recursive: true });
  const env = scrub({ ...process.env, HOME: home, USERPROFILE: home, PANTHEON_HOME: join(root, "pantheon") });
  if (WIN) Object.assign(env, { APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") });
  const p = { name, root, home, env, cwd: root, bin: npmPantheon, ph: env.PANTHEON_HOME };
  p.run = (args, o = {}) => run(p.bin, args, { env: p.env, cwd: o.cwd ?? p.cwd, ...o });
  p.runAsync = (args, o = {}) => runAsync(p.bin, args, { env: p.env, cwd: o.cwd ?? p.cwd, ...o });
  return p;
}

// The member: this runner's real user, real home, real ~/.pantheon.
const realHome = userInfo().homedir;
const member = (() => {
  const env = scrub({ ...process.env, HOME: realHome });
  if (WIN) env.USERPROFILE = realHome;
  const cwd = join(realHome, "pantheon-desktop-check");
  mkdirSync(cwd, { recursive: true });
  const p = { name: "member", home: realHome, env, cwd, bin: npmPantheon, ph: join(realHome, ".pantheon") };
  p.run = (args, o = {}) => run(p.bin, args, { env: o.env ?? p.env, cwd: o.cwd ?? p.cwd, ...o });
  p.runAsync = (args, o = {}) => runAsync(p.bin, args, { env: o.env ?? p.env, cwd: o.cwd ?? p.cwd, ...o });
  return p;
})();
const peer = tempPerson("peer");
const relayHome = tempPerson("relay");

const port = await freePort();
const httpBase = `http://127.0.0.1:${port}`, relayUrl = `ws://127.0.0.1:${port}`;
let relayLog = "";
const relayArgs = ["relay", "--port", String(port), "--data", join(relayHome.root, "data")];
const relay = WIN
  ? spawn("cmd.exe", ["/d", "/s", "/c", `"${[npmPantheon, ...relayArgs].map(winArg).join(" ")}"`], { windowsVerbatimArguments: true, env: { ...relayHome.env, PANTHEON_REQUIRE_ACCOUNTS: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  : spawn("pantheon", relayArgs, { env: { ...relayHome.env, PANTHEON_REQUIRE_ACCOUNTS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
relay.stdout.on("data", (b) => { relayLog += b; });
relay.stderr.on("data", (b) => { relayLog += b; });
cleanups.push(() => { killTree(relay); writeFileSync(join(ART, "relay.log"), relayLog); });

const codeFor = async (email) => {
  const re = new RegExp(`code for ${email.replace(/[.+]/g, "\\$&")}: (\\d{6})`);
  const m = await waitFor(() => re.exec(relayLog), 30_000, 250);
  if (!m) throw new Error(`no code for ${email} in the relay log: ${relayLog.slice(-300)}`);
  return m[1];
};
const quiet = ["--no-worker", "--no-hook", "--no-notifications", "--no-menubar"];

await step(`the package npm installed is ${want || "the one asked for"}`, () => {
  const r = run(npmPantheon, ["--version"], { env: relayHome.env });
  const v = /\d+\.\d+\.\d+(-[\w.]+)?/.exec(r.out)?.[0];
  if (r.code !== 0 || !v) throw new Error(`exit ${r.code}: ${r.out.slice(0, 300)}`);
  if (want && !["latest", "next"].includes(want) && v !== want) throw new Error(`installed ${v}, expected ${want}`);
  return v;
});

const relayUp = await step("a relay from that package runs on this machine", async () => {
  const ok = await waitFor(async () => (await (await fetch(`${httpBase}/health`)).json()).ok, 30_000);
  if (!ok) throw new Error(relayLog.slice(-400) || "no answer in 30s");
  return `port ${port}`;
});

// Windows: the member installs the way a Windows person does — the one line from the relay.
let managed = null;
if (WIN) {
  const localAppData = process.env.LOCALAPPDATA ?? join(realHome, "AppData", "Local");
  const launcher = join(localAppData, "Pantheon", "bin", "pantheon.cmd");
  await step("the one line from the relay installs Pantheon for this Windows user (its own Node, a launcher)", async () => {
    let r0;
    for (let i = 0; i < 40; i++) { r0 = await fetch(`${httpBase}/install.ps1`).catch(() => null); if (r0?.status === 200) break; await sleep(3000); }
    if (r0?.status !== 200) throw new Error(`the relay does not serve install.ps1 (${r0?.status ?? "no answer"}) — the member uses npm's pantheon instead`);
    // No -ExecutionPolicy: irm | iex never consults it (0.33 dropped the flag from the printed line).
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", `irm ${httpBase}/install.ps1 | iex`], { encoding: "utf8", env: { ...member.env, PANTHEON_ARGS: "--version" }, timeout: 600_000, windowsHide: true });
    const out = strip(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    writeFileSync(join(ART, "install.ps1.out.txt"), out);
    if (r.status !== 0 || !existsSync(launcher)) throw new Error(`exit ${r.status}; launcher ${existsSync(launcher) ? "present" : "missing"} — the member uses npm's pantheon instead\n${tail(out, 15)}`);
    member.bin = launcher;
    managed = { launcher, runtime: join(localAppData, "Pantheon", "runtime") };
    const v = /\d+\.\d+\.\d+(-[\w.]+)?/.exec(out.split("\n").slice(-3).join(" "))?.[0];
    return `${launcher}${v ? ` (${v})` : ""}`;
  }, relayUp ? null : "no relay");
}

let memberId = "", invite = "";
const setUp = await step("the member signs up, verifies by email code, and starts a team (flags, no prompts)", async () => {
  const s = member.run(["signup", "--email", "member@example.com", "--username", "member", "--relay", relayUrl]);
  if (s.code !== 0) throw new Error(`signup: ${s.out.slice(-400)}`);
  const v = member.run(["verify", await codeFor("member@example.com")]);
  if (v.code !== 0) throw new Error(`verify: ${v.out.slice(-400)}`);
  const r = member.run(["start", "--relay", relayUrl, "--space", "desk", "--yes", "--name", "Member", "--title", "Engineer", "--decides", "none", ...quiet], { timeout: 180_000 });
  writeFileSync(join(ART, "member-start.txt"), r.out);
  invite = /pantheon join (pantheons?:\/\/\S+|https?:\/\/\S+)/.exec(r.out)?.[1]?.replace(/['"]$/, "") ?? "";
  if (r.code !== 0 || !invite) throw new Error(`start exit ${r.code}: ${r.out.slice(-600)}`);
  memberId = JSON.parse(readText(join(member.ph, "config.json")) || "{}").member ?? "";
  if (!memberId) throw new Error(`no member id in ${join(member.ph, "config.json")}`);
  return `member id ${memberId}, team desk`;
}, relayUp ? null : "no relay");

const peerUp = await step("a teammate (another home on this machine) signs up and joins with the invite", async () => {
  const s = peer.run(["signup", "--email", "peer@example.com", "--username", "peer", "--relay", relayUrl]);
  if (s.code !== 0) throw new Error(`signup: ${s.out.slice(-400)}`);
  const v = peer.run(["verify", await codeFor("peer@example.com")]);
  if (v.code !== 0) throw new Error(`verify: ${v.out.slice(-400)}`);
  const j = peer.run(["join", invite, "--name", "Peer", "--title", "Engineer", "--decides", "none", ...quiet], { timeout: 180_000 });
  if (j.code !== 0) throw new Error(`join exit ${j.code}: ${j.out.slice(-500)}`);
  return "";
}, setUp ? null : "the member has no team");

const noTeam = setUp && peerUp ? null : "the member or the teammate could not be set up (FAIL above)";

/**
 * The teammate asks the member for a decision only they can make: HUMAN_REQUIRED
 * to the member (an ESCALATE would land on the sender's own human). The relay
 * makes it a HUMAN obligation owned by human:<member> — what the notifier alerts on.
 */
async function askForDecision(words, domain) {
  const r = await peer.runAsync(["say", "HUMAN_REQUIRED", ...words.split(" "), "--to", memberId, "--domains", domain], { timeout: 120_000 });
  const id = /sent HUMAN_REQUIRED id=(\S+)/.exec(r.out)?.[1];
  if (r.code !== 0 || !id) throw new Error(`the teammate's HUMAN_REQUIRED was not sent (exit ${r.code}): ${r.out.slice(-400)}`);
  return id;
}
/** The member's ANSWER to that act, as the teammate reads the ledger. */
function answerOnRelay(actId) {
  const h = peer.run(["history", "--json", "--last", "60"]);
  let acts = [];
  try { acts = JSON.parse(h.stdout); } catch { return null; }
  return acts.find((a) => a.act === "ANSWER" && a.from === memberId && a.ref === actId) ?? null;
}
/** The member's own board data (what the menu bar, tray and board draw). */
function memberItems() {
  const r = member.run(["tray-status"], { timeout: 60_000 });
  try { return JSON.parse(r.stdout.trim().split("\n").at(-1)).items ?? []; } catch { return null; }
}

/* ------------------------------------------------------------------ the board (every OS) */

async function boardChecks(label, decisionAct, blocked) {
  const st = {};
  const pre = blocked ?? null;
  // A board left running by a check that failed half-way is stopped at exit.
  if (!pre) cleanups.push(() => { if (existsSync(join(member.ph, "board.json"))) run(member.bin, ["board", "--stop"], { env: member.env, cwd: member.cwd, timeout: 30_000 }); });
  await step(`${label}: pantheon board --url prints a single-use link on 127.0.0.1`, () => {
    const r = member.run(["board", "--url"], { timeout: 90_000 });
    const m = /http:\/\/127\.0\.0\.1:(\d+)\/#open=([0-9a-f]{64})/.exec(r.out);
    if (r.code !== 0 || !m) throw new Error(`exit ${r.code}: ${r.out.slice(-400)}`);
    st.port = Number(m[1]); st.nonce = m[2];
    return `port ${st.port}`;
  }, pre);
  const need = pre ?? (st.port ? null : "the board printed no address");
  await step(`${label}: the board refuses its API without a credential (401), a wrong one (401) and a foreign Host (403)`, async () => {
    const page = await http(st.port, "/");
    const none = await http(st.port, "/api/board");
    const wrong = await http(st.port, "/api/board", { headers: { Authorization: `Bearer ${"0".repeat(64)}` } });
    const host = await http(st.port, "/api/board", { headers: { Host: `pantheon.example:${st.port}` } });
    const got = `/ ${page.status}, no credential ${none.status}, wrong bearer ${wrong.status}, foreign Host ${host.status}`;
    if (page.status !== 200 || !/<html/i.test(page.text) || none.status !== 401 || wrong.status !== 401 || host.status !== 403) throw new Error(got);
    return got;
  }, need);
  await step(`${label}: the board listens on 127.0.0.1 only`, async () => {
    const ip = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (!ip) return NOT_RUN("this runner has no non-loopback IPv4 address to try");
    const r = await reachable(ip, st.port);
    if (r === "connected") throw new Error(`${ip}:${st.port} accepted a connection`);
    return `${ip}:${st.port} → ${r}`;
  }, need);
  await step(`${label}: its link trades once for a session that reads the board${decisionAct ? ", the teammate's decision under Needs you now" : ""}`, async () => {
    const origin = `http://127.0.0.1:${st.port}`;
    const post = (bearer) => http(st.port, "/api/session", { method: "POST", headers: { Authorization: `Bearer ${bearer}`, Origin: origin, "Content-Type": "application/json" }, body: "{}" });
    const s = await post(st.nonce);
    if (s.status !== 200 || !/^[0-9a-f]{64}$/.test(s.json?.session ?? "")) throw new Error(`the link did not trade for a session: ${s.status} ${s.text.slice(0, 200)}`);
    const again = await post(st.nonce);
    if (again.status !== 401) throw new Error(`the link worked twice (${again.status})`);
    const b = await http(st.port, "/api/board", { headers: { Authorization: `Bearer ${s.json.session}` }, timeout: 60_000 });
    if (b.status !== 200 || !b.json?.ok) throw new Error(`/api/board with the session: ${b.status} ${b.text.slice(0, 300)}`);
    const items = b.json.status?.items ?? [];
    const now = items.filter((i) => i.lane === "now");
    if (decisionAct && !now.some((i) => i.ref === decisionAct)) throw new Error(`the decision ${decisionAct} is not under Needs you now: ${JSON.stringify(items.map((i) => ({ lane: i.lane, kind: i.kind, ref: i.ref, title: i.title }))).slice(0, 500)}`);
    return `${items.length} item(s), ${now.length} under Needs you now; the link is refused the second time`;
  }, need);
  await step(`${label}: board.json holds the board's token, readable by this user only`, async () => {
    const f = join(member.ph, "board.json");
    const j = JSON.parse(readText(f) || "null");
    if (!j?.token || j.port !== st.port) throw new Error(`${f}: ${readText(f).slice(0, 200) || "missing"}`);
    const mode = statSync(f).mode & 0o777;
    if (!WIN && (mode & 0o077)) throw new Error(`${f} is mode ${mode.toString(8)}`);
    const b = await http(st.port, "/api/board", { headers: { Authorization: `Bearer ${j.token}` }, timeout: 60_000 });
    if (b.status !== 200) throw new Error(`the token itself was refused: ${b.status}`);
    return WIN ? "token answers" : `mode ${mode.toString(8)}, token answers`;
  }, need);
  await step(`${label}: pantheon board --watch draws the lanes in a terminal`, () => {
    const r = member.run(["board", "--watch"], { timeout: 90_000 });
    const m = /Needs you now \((\d+)\)/.exec(r.out);
    if (r.code !== 0 || !/Pantheon board/.test(r.out) || !m) throw new Error(`exit ${r.code}:\n${tail(r.out, 15)}`);
    if (decisionAct && Number(m[1]) < 1) throw new Error(`Needs you now (${m[1]}) while the teammate's decision is open:\n${tail(r.out, 15)}`);
    return `"Needs you now (${m[1]})", "${["Handling", "Waiting", "Older"].filter((l) => r.out.includes(l)).join('", "')}"`;
  }, pre);
  return st;
}
async function boardStop(label, st, blocked) {
  await step(`${label}: pantheon board --stop stops it`, async () => {
    const r = member.run(["board", "--stop"], { timeout: 60_000 });
    if (r.code !== 0) throw new Error(r.out.slice(-300));
    const gone = await waitFor(async () => (await http(st.port, "/api/ping", { timeout: 2000 })).status === 0, 15_000);
    if (!gone) throw new Error(`port ${st.port} still answers 15 s later`);
    return `port ${st.port} closed`;
  }, blocked ?? (st.port ? null : "no board was running"));
}

/* ================================================================== Windows */

if (WIN) await windows();
async function windows() {
  const H = join(member.ph, "host"), LOGS = join(member.ph, "logs");
  const sid = /"[^"]*"\s*,\s*"(S-1-[0-9-]+)"/.exec(spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).stdout ?? "")?.[1] ?? "";
  const task = sid ? `Pantheon-${sid}` : "";
  const me = userInfo().username;
  cleanups.push(() => windowsTeardown(task));

  // Whether this job runs at an interactive desktop at all (a toast and a tray need one).
  const sess = ps("$s = (Get-Process -Id $PID).SessionId; Write-Output ('session=' + $s); qwinsta 2>&1 | Out-String");
  const ourSession = Number(/session=(\d+)/.exec(sess.out)?.[1] ?? -1);
  const desktop = ourSession > 0;
  console.log(`\n  windows: user ${me}, SID ${sid || "?"}, this job runs in session ${ourSession}${desktop ? "" : " (no interactive desktop)"}`);
  console.log(`  ${tail(sess.out.replace(/^session=\d+\s*/, ""), 8).split("\n").join("\n  ")}\n`);
  writeFileSync(join(ART, "sessions.txt"), sess.out);

  /** Every process that is part of the member's background Pantheon, by what it runs. */
  const kindOf = (p) => {
    const cmd = p.cmd ?? "", name = p.name ?? "";
    if (/pantheon-tray\.ps1/i.test(cmd)) return "tray";
    if (/^pantheon-host/i.test(name)) return "launcher";
    if (/^powershell/i.test(name) && /launch\.txt/i.test(cmd)) return "launcher";
    if (!/^node/i.test(name)) return null;
    if (/cli\.js"?\s+host(\s|$)/i.test(cmd)) return "host";
    if (/cli\.js"?\s+worker(\s|$)/i.test(cmd)) return "worker";
    if (/cli\.js"?\s+notifier(\s|$)/i.test(cmd)) return "notifier";
    if (/cli\.js"?\s+board\s+--serve/i.test(cmd)) return "board";
    return null;
  };
  const procs = () => {
    const r = ps(`$p = @(Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -match 'pantheon') -or ($_.Name -like 'pantheon-host*') } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; session = [int]$_.SessionId; cmd = [string]$_.CommandLine } })
ConvertTo-Json -InputObject $p -Compress -Depth 3`);
    let list = [];
    try { list = JSON.parse(r.stdout || "[]"); } catch { list = []; }
    if (!Array.isArray(list)) list = [list];
    return list.map((p) => ({ ...p, kind: kindOf(p) })).filter((p) => p.kind);
  };
  const byKind = (list) => Object.fromEntries(["launcher", "host", "worker", "notifier", "tray", "board"].map((k) => [k, list.filter((p) => p.kind === k)]));
  const showProcs = (list) => list.map((p) => `${p.kind} pid ${p.pid} (${p.name}, session ${p.session})`).join("; ") || "none";
  const state = () => { try { return JSON.parse(readText(join(H, "state.json"))); } catch { return null; } };
  const hostUp = (list) => { const s = state(); return !!s && Date.now() - s.beat < 30_000 && list.some((p) => p.kind === "host" && p.pid === s.pid); };
  const queryXml = () => { const r = spawnSync("schtasks", ["/Query", "/TN", task, "/XML"], { windowsHide: true }); return r.status === 0 ? decodeOut(r.stdout) : null; };
  const taskInfo = () => strip(spawnSync("schtasks", ["/Query", "/TN", task, "/V", "/FO", "LIST"], { encoding: "utf8", windowsHide: true }).stdout ?? "");
  const logOf = (k) => join(LOGS, `${k}.log`);
  const xmlUn = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

  const installed = await step("pantheon service install worker, then notifier: registered for this user and started", () => {
    const w = member.run(["service", "install", "worker"], { timeout: 300_000 });
    const n = member.run(["service", "install", "notifier"], { timeout: 300_000 });
    writeFileSync(join(ART, "service-install.txt"), `${w.out}\n----\n${n.out}`);
    if (w.code !== 0 || n.code !== 0) throw new Error(`worker exit ${w.code}, notifier exit ${n.code}\n${tail(w.out, 10)}\n${tail(n.out, 10)}`);
    if (!queryXml()) throw new Error(`no ${task} task after install\n${tail(w.out, 12)}`);
    const said = /registered the (\S+) task/.exec(w.out)?.[1];
    return `task ${said ?? task}${/through PowerShell/.test(w.out) ? " (PowerShell launcher: no csc.exe build)" : ""}`;
  }, noTeam ?? (task ? null : "whoami gave no SID"));
  const noTask = installed ? null : "the services did not install (FAIL above)";

  let launchCmd = "", launchArgs = "";
  await step(`the ${task || "Pantheon-<SID>"} task: a logon trigger for this user, interactive, least privilege, a hidden launcher`, () => {
    const xml = queryXml();
    if (!xml) throw new Error(`schtasks /Query /TN ${task} /XML failed`);
    writeFileSync(join(ART, "task.xml"), xml);
    const trig = /<LogonTrigger>([\s\S]*?)<\/LogonTrigger>/.exec(xml)?.[1];
    const princ = /<Principal[^>]*>([\s\S]*?)<\/Principal>/.exec(xml)?.[1] ?? "";
    const isMe = (u) => !!u && (u.toLowerCase() === sid.toLowerCase() || u.toLowerCase() === me.toLowerCase() || u.toLowerCase().endsWith(`\\${me.toLowerCase()}`));
    const trigUser = /<UserId>([^<]*)<\/UserId>/.exec(trig ?? "")?.[1];
    const princUser = /<UserId>([^<]*)<\/UserId>/.exec(princ)?.[1];
    const bad = [];
    if (!trig) bad.push("no LogonTrigger");
    else if (!isMe(trigUser)) bad.push(`the logon trigger is for ${trigUser ?? "every user"}`);
    if (!isMe(princUser)) bad.push(`it runs as ${princUser}`);
    if (!/<LogonType>InteractiveToken<\/LogonType>/.test(princ)) bad.push(`logon type ${/<LogonType>([^<]*)/.exec(princ)?.[1] ?? "?"}`);
    if (!/<RunLevel>LeastPrivilege<\/RunLevel>/.test(princ)) bad.push(`run level ${/<RunLevel>([^<]*)/.exec(princ)?.[1] ?? "?"}`);
    launchCmd = xmlUn(/<Command>([^<]*)<\/Command>/.exec(xml)?.[1] ?? "");
    launchArgs = xmlUn(/<Arguments>([^<]*)<\/Arguments>/.exec(xml)?.[1] ?? "");
    const how = /pantheon-host[^\\]*\.exe$/i.test(launchCmd) ? "pantheon-host.exe (csc-built)" : /powershell\.exe$/i.test(launchCmd) ? "PowerShell fallback" : `unexpected: ${launchCmd}`;
    if (/^unexpected/.test(how)) bad.push(`its action runs ${launchCmd}`);
    const legacy = spawnSync("schtasks", ["/Query", "/TN", "Pantheon"], { windowsHide: true }).status === 0;
    if (legacy) bad.push('a plain "Pantheon" task is registered too');
    if (bad.length) throw new Error(bad.join("; "));
    return `trigger + principal ${princUser}, InteractiveToken, LeastPrivilege; launcher ${how}`;
  }, noTask);

  await step("the install started the host (state.json heartbeat, a live host process)", async () => {
    const ok = await waitFor(() => hostUp(procs()), 90_000, 1500);
    if (!ok) throw new Error(`no live host 90 s after install. state.json: ${readText(join(H, "state.json")).slice(0, 300) || "none"}\nhost.log: ${tail(readText(logOf("host")), 10)}\n${tail(taskInfo(), 12)}`);
    return `host pid ${state()?.pid}`;
  }, noTask);

  await step("schtasks /End ends the task's launcher, and the host with it", async () => {
    const r = spawnSync("schtasks", ["/End", "/TN", task], { encoding: "utf8", windowsHide: true });
    const down = await waitFor(() => { const l = procs(); return !hostUp(l) && !l.some((p) => ["launcher", "host"].includes(p.kind)) ? l : null; }, 45_000, 1500);
    if (!down) throw new Error(`still running 45 s after /End (exit ${r.status}: ${strip(r.stdout + r.stderr).trim()}): ${showProcs(procs())}`);
    return `left running: ${showProcs(down)}`;
  }, noTask);

  // The task, run as Task Scheduler runs it at logon.
  let fallback = false;
  const t0 = Date.now();
  const allUp = await step("schtasks /Run starts it: within 90 s the host, worker, notifier and tray run", async () => {
    const r = spawnSync("schtasks", ["/Run", "/TN", task], { encoding: "utf8", windowsHide: true });
    const want4 = desktop ? ["worker", "notifier", "tray"] : ["worker", "notifier"];
    // Each child must be the NEW host's (its parent), not one an ended host left behind.
    const up = await waitFor(() => {
      const l = procs(), k = byKind(l);
      if (!hostUp(l)) return null;
      const hostPid = state().pid;
      return want4.every((x) => k[x].some((p) => p.ppid === hostPid)) ? k : null;
    }, 90_000, 1500);
    if (!up) {
      const info = taskInfo();
      throw new Error(`schtasks /Run exit ${r.status} (${strip(r.stdout + r.stderr).trim()}); after 90 s: ${showProcs(procs())}\n${tail(info, 14)}\nhost.log: ${tail(readText(logOf("host")), 8)}`);
    }
    return `${((Date.now() - t0) / 1000).toFixed(0)} s: ${showProcs(Object.values(up).flat())}${desktop ? "" : " (no desktop here: the tray is checked below)"}`;
  }, noTask);
  if (allUp === false && launchCmd && !hostUp(procs())) {
    // Task Scheduler would not run it here (a runner without this user's
    // interactive logon). The rest still says something about the host if it
    // is started the way the task would start it: its own action, hidden.
    fallback = true;
    const r = ps(`Start-Process -FilePath $env:PD_CMD -ArgumentList $env:PD_ARGS -WindowStyle Hidden`, { env: { ...member.env, PD_CMD: launchCmd, PD_ARGS: launchArgs } });
    const up = await waitFor(() => hostUp(procs()), 60_000, 1500);
    console.log(`  (the checks below run on a host started from the task's own action, not by Task Scheduler: ${up ? "it is up" : `it did not start either: ${r.out.slice(0, 200)}`})`);
  }
  const via = fallback ? " [host started from the task's action, not by Task Scheduler]" : "";
  const noHost = noTask ?? (hostUp(procs()) ? null : "the host is not running (FAIL above)");

  await step(`the tray runs${via}`, async () => {
    const up = await waitFor(() => byKind(procs()).tray[0], 60_000, 1500);
    if (up) return `pid ${up.pid}`;
    const why = tail(readText(logOf("tray")), 8);
    const st = state()?.children?.tray;
    if (!desktop) return NOT_RUN(`this job has no interactive desktop (session ${ourSession}), and a tray icon needs one. The host reports the tray ${JSON.stringify(st ?? null)}; tray.log:\n${why}`);
    throw new Error(`no tray process 60 s after the host started; host reports ${JSON.stringify(st ?? null)}\ntray.log:\n${why}`);
  }, noHost);

  await step(`none of them shows a window (MainWindowHandle 0, no visible top-level window, conhost included)${via}`, () => {
    const l = procs().filter((p) => p.kind !== "board");
    const pids = l.map((p) => p.pid);
    if (!pids.length) throw new Error("no Pantheon processes to look at");
    const r = ps(`
$pids = @(${pids.join(",")})
$con = @(Get-CimInstance Win32_Process | Where-Object { $pids -contains [int]$_.ParentProcessId -and $_.Name -eq 'conhost.exe' } | ForEach-Object { [int]$_.ProcessId })
$all = $pids + $con
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class PdWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static List<string> Visible(int[] pids) {
    var set = new HashSet<uint>(); foreach (var p in pids) set.Add((uint)p);
    var o = new List<string>();
    EnumWindows(delegate (IntPtr h, IntPtr l) { uint p; GetWindowThreadProcessId(h, out p); if (set.Contains(p) && IsWindowVisible(h)) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); o.Add(p + ": " + sb.ToString()); } return true; }, IntPtr.Zero);
    return o;
  }
}
"@
$main = @(Get-Process -Id $all -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; handle = $_.MainWindowHandle.ToInt64(); title = $_.MainWindowTitle } })
$vis = [PdWin]::Visible([int[]]$all)
ConvertTo-Json -InputObject @{ main = $main; visible = @($vis); conhost = $con } -Compress -Depth 4`);
    let j;
    try { j = JSON.parse(r.stdout); } catch { throw new Error(`could not look: ${r.out.slice(0, 400)}`); }
    const main = Array.isArray(j.main) ? j.main : j.main ? [j.main] : [];
    const withWin = main.filter((m) => m.handle !== 0);
    const visible = Array.isArray(j.visible) ? j.visible : [];
    if (withWin.length || visible.length) throw new Error(`windows: ${JSON.stringify(withWin)} visible: ${JSON.stringify(visible)} (processes: ${showProcs(l)})`);
    return `${pids.length} processes${(j.conhost ?? []).length ? ` + ${[].concat(j.conhost).length} conhost` : ""}, session ${l[0]?.session}: no window`;
  }, noHost);

  await step(`each writes its log: host.log, worker.log, notifier.log, tray.log${via}`, async () => {
    const kinds = desktop || byKind(procs()).tray.length ? ["host", "worker", "notifier", "tray"] : ["host", "worker", "notifier"];
    const ok = await waitFor(() => kinds.every((k) => fileSize(logOf(k)) > 0), 30_000);
    const sizes = kinds.map((k) => `${k} ${fileSize(logOf(k))} B`).join(", ");
    if (!ok) throw new Error(sizes);
    return sizes;
  }, noHost);

  await step(`pantheon ps names the host, worker, notifier and tray running${via}`, () => {
    const r = member.run(["ps"], { timeout: 60_000 });
    writeFileSync(join(ART, "ps.txt"), r.out);
    const need = ["host", "worker", "notifier", ...(byKind(procs()).tray.length ? ["tray"] : [])];
    const missing = need.filter((k) => !new RegExp(`^\\s*${k}\\s+running`, "m").test(r.out));
    if (missing.length) throw new Error(`not shown running: ${missing.join(", ")}\n${tail(r.out, 20)}`);
    return need.join(", ");
  }, noHost);

  await step(`pantheon doctor: its task and host rows ok, no FAIL among the background rows${via}`, () => {
    const r = member.run(["doctor"], { timeout: 120_000 });
    writeFileSync(join(ART, "doctor.txt"), r.out);
    const rows = r.out.split("\n").filter((l) => /^\s*(ok|warn|FAIL)\s+(task|host|worker|alerts|tray)\b/.test(l)).map((l) => l.trim().replace(/\s+/g, " "));
    const otherFails = r.out.split("\n").filter((l) => /\bFAIL\b/.test(l) && !rows.includes(l.trim().replace(/\s+/g, " ")));
    if (rows.some((l) => /^FAIL/.test(l))) throw new Error(rows.join("\n"));
    if (!rows.some((l) => /^ok task/.test(l)) || !rows.some((l) => /^ok host/.test(l))) throw new Error(`task/host rows: ${rows.join(" | ") || "none"}\n${tail(r.out, 25)}`);
    return `${rows.join(" | ").slice(0, 400)}${otherFails.length ? `; elsewhere: ${otherFails.map((l) => l.trim()).join(" | ").slice(0, 200)}` : ""}`;
  }, noHost);

  await step(`a worker killed from outside is started again by the host within 15 s${via}`, async () => {
    const w = byKind(procs()).worker[0];
    if (!w) throw new Error("no worker running");
    const t = Date.now();
    spawnSync("taskkill", ["/PID", String(w.pid), "/F"], { windowsHide: true });
    const back = await waitFor(() => byKind(procs()).worker.find((p) => p.pid !== w.pid), 20_000, 1000);
    const secs = ((Date.now() - t) / 1000).toFixed(1);
    if (!back) throw new Error(`no new worker 20 s after killing pid ${w.pid}; host reports ${JSON.stringify(state()?.children?.worker ?? null)}`);
    if (Date.now() - t > 15_000) throw new Error(`back, but after ${secs} s`);
    return `pid ${w.pid} → ${back.pid} in ${secs} s`;
  }, noHost);

  await step(`pantheon stop worker: it stops and stays down`, async () => {
    const r = member.run(["stop", "worker"], { timeout: 60_000 });
    if (r.code !== 0) throw new Error(r.out.slice(-300));
    const down = await waitFor(() => !byKind(procs()).worker.length, 20_000, 1000);
    if (!down) throw new Error(`a worker is still running 20 s later: ${showProcs(byKind(procs()).worker)}`);
    for (let i = 0; i < 4; i++) { await sleep(4000); if (byKind(procs()).worker.length) throw new Error(`the worker came back by itself: ${showProcs(byKind(procs()).worker)}`); }
    if (!existsSync(join(H, "worker.disabled"))) throw new Error("no host\\worker.disabled marker");
    return "down for 16 s, worker.disabled written";
  }, noHost);

  await step(`pantheon service start worker brings it back`, async () => {
    const r = member.run(["service", "start", "worker"], { timeout: 60_000 });
    if (r.code !== 0) throw new Error(r.out.slice(-300));
    const back = await waitFor(() => byKind(procs()).worker[0], 30_000, 1000);
    if (!back) throw new Error(`no worker 30 s later: ${r.out.slice(-200)}`);
    if (existsSync(join(H, "worker.disabled"))) throw new Error("worker.disabled is still there");
    return `pid ${back.pid}`;
  }, noHost);

  await step(`pantheon tray starts the tray icon again (a new tray process, the old one gone)`, async () => {
    const old = byKind(procs()).tray[0];
    if (!old) return NOT_RUN(desktop ? "no tray was running to restart (FAIL above)" : `no tray here (no interactive desktop, session ${ourSession})`);
    const r = member.run(["tray"], { timeout: 60_000 });
    if (r.code !== 0) throw new Error(r.out.slice(-300));
    const fresh = await waitFor(() => { const t = byKind(procs()).tray; return t.length && !t.some((p) => p.pid === old.pid) ? t[0] : null; }, 40_000, 1500);
    if (!fresh) throw new Error(`trays now: ${showProcs(byKind(procs()).tray)} (was ${old.pid}); ${r.out.slice(-200)}`);
    return `pid ${old.pid} → ${fresh.pid}`;
  }, noHost);

  /* ---- an alert: the teammate's decision, through the notifier and the tray ---- */

  const notices = join(H, "notices");
  const seen = new Map();
  const watcher = setInterval(() => {
    let names = [];
    try { names = readdirSync(notices); } catch { return; }
    for (const n of names) {
      if (!n.endsWith(".json") || seen.has(n)) continue;
      let json = null;
      try { json = JSON.parse(readFileSync(join(notices, n), "utf8")); } catch { /* the tray took it meanwhile */ }
      seen.set(n, { at: Date.now(), json });
    }
  }, 20);
  const alertsLog = join(LOGS, "alerts.log"), notifierLog = logOf("notifier"), uriLog = join(LOGS, "uri.log");
  const aFrom = fileSize(alertsLog), nFrom = fileSize(notifierLog);
  let actId = "", oblig = "";
  const asked = await step("the teammate's HUMAN_REQUIRED reaches the member's notifier, which raises an alert", async () => {
    actId = await askForDecision("Pick the release banner colour blue or green", "release-banner");
    const hit = await waitFor(() => /> notified for (o_\w+)/.exec(since(notifierLog, nFrom)) || /! could not show a desktop notification for (o_\w+)/.exec(since(notifierLog, nFrom)), 120_000, 250);
    if (!hit) throw new Error(`nothing in notifier.log 120 s after ${actId}:\n${tail(since(notifierLog, nFrom), 10)}\nalerts.log:\n${tail(since(alertsLog, aFrom), 6)}`);
    oblig = hit[1];
    if (/could not show/.test(hit[0])) throw new Error(`the notifier could not show it: ${hit[0]}\nalerts.log:\n${tail(since(alertsLog, aFrom), 8)}`);
    return `act ${actId} → decision ${oblig}`;
  }, noHost ?? noTeam);
  const noAlert = asked ? null : "no alert was raised (FAIL above)";

  await step("the alert goes through ~/.pantheon/host/notices to the tray", async () => {
    const line = await waitFor(() => new RegExp(`(handed to the tray|shown|handed to a balloon|not shown)[^\\n]*decision ${oblig}[^\\n]*`).exec(since(alertsLog, aFrom))?.[0], 30_000, 250);
    const files = [...seen.keys()];
    if (/handed to the tray/.test(line ?? "")) {
      const gone = await waitFor(() => files.every((n) => !existsSync(join(notices, n))), 15_000, 250);
      return `alerts.log: "${line.trim().slice(25, 160)}"; queue file ${files.length ? `${files.join(", ")} seen, ${gone ? "taken by the tray" : "STILL THERE"}` : "taken before it could be seen (under 20 ms)"}`;
    }
    const what = line ? `alerts.log: ${line.trim()}` : `alerts.log says nothing about ${oblig}: ${tail(since(alertsLog, aFrom), 6)}`;
    if (!byKind(procs()).tray.length && !desktop) return NOT_RUN(`no tray to hand it to (no interactive desktop) — the notifier showed it itself. ${what}`);
    throw new Error(`not handed to the tray (tray ${byKind(procs()).tray.length ? "running" : "not running"}). ${what}`);
  }, noAlert);

  await step("the alert is shown: a toast, or a balloon from the tray icon", async () => {
    const re = new RegExp(`(tray: shown|tray: balloon for|tray: not shown|tray: dropped|\\bshown:|handed to a balloon:|not shown:)[^\\n]*decision ${oblig}[^\\n]*`);
    const line = await waitFor(() => re.exec(since(alertsLog, aFrom))?.[0], 45_000, 250);
    if (!line) throw new Error(`alerts.log has no outcome for ${oblig} after 45 s:\n${tail(since(alertsLog, aFrom), 8)}\ntray.log:\n${tail(readText(logOf("tray")), 6)}`);
    if (/tray: shown|tray: balloon for|\bshown:|handed to a balloon/.test(line) && !/not shown/.test(line)) return line.trim().slice(25, 220);
    if (!desktop) return NOT_RUN(`no interactive desktop here (session ${ourSession}), so nothing can be on screen. What happened: ${line.trim()}`);
    throw new Error(line.trim());
  }, noAlert);
  clearInterval(watcher);

  /** Run a pantheon:// link exactly as Windows runs the registered handler: CreateProcess on the registered command, %1 replaced. */
  const viaHandler = (uri) => ps(`
$c = (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Classes\\pantheon\\shell\\open\\command' -ErrorAction Stop).'(default)'
Write-Output ('registered: ' + $c)
$c = $c.Replace('%1', $env:PD_URI)
if ($c.StartsWith('"')) { $i = $c.IndexOf('"', 1); $file = $c.Substring(1, $i - 1); $rest = $c.Substring($i + 1).Trim() } else { $i = $c.IndexOf(' '); $file = $c.Substring(0, $i); $rest = $c.Substring($i + 1).Trim() }
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $file; $psi.Arguments = $rest; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
$p = [System.Diagnostics.Process]::Start($psi)
$o = $p.StandardOutput.ReadToEnd(); $e = $p.StandardError.ReadToEnd()
[void]$p.WaitForExit(120000)
Write-Output ('exit ' + $p.ExitCode)
Write-Output $o
Write-Output $e`, { env: { ...member.env, PD_URI: uri }, timeout: 180_000 });

  let uFrom = fileSize(uriLog);
  const boardOpened = await step("pantheon://board, run as Windows runs the registered handler, opens the board (uri.log)", async () => {
    const r = viaHandler("pantheon://board");
    if (!/registered: /.test(r.out)) throw new Error(`no handler under HKCU\\Software\\Classes\\pantheon: ${r.out.slice(0, 300)}`);
    const line = await waitFor(() => /board: [^\n]*/.exec(since(uriLog, uFrom))?.[0], 30_000, 250);
    if (!line || !/board: opened/.test(line)) throw new Error(`uri.log: ${line ?? (tail(since(uriLog, uFrom), 5) || "(nothing)")}\n${r.out.slice(0, 600)}`);
    return `${/registered: (.*)/.exec(r.out)?.[1]?.slice(0, 120)}… → uri.log "${line.trim()}"`;
  }, noTask ?? noTeam);

  await step("Windows itself opens pantheon://board (protocol activation through the shell)", async () => {
    uFrom = fileSize(uriLog);
    const r = ps("Start-Process 'pantheon://board'; Write-Output 'started'");
    if (!/started/.test(r.out)) throw new Error(r.out.slice(0, 400));
    const line = await waitFor(() => /board: [^\n]*/.exec(since(uriLog, uFrom))?.[0], 45_000, 250);
    if (!line && desktop) throw new Error(`uri.log has nothing 45 s after Start-Process pantheon://board: ${r.out.slice(0, 200)}`);
    if (!line) return NOT_RUN(`no interactive desktop here: the shell did not run the handler (${r.out.slice(0, 120)})`);
    if (!/board: opened/.test(line)) throw new Error(`uri.log: ${line}`);
    return `uri.log "${line.trim()}"`;
  }, boardOpened ? null : "the registered handler did not open the board (FAIL above)");

  const st = await boardChecks("Windows", actId || null, noTeam);

  await step("Done on the alert (its pantheon://done link, run as Windows runs it) answers the decision on the relay", async () => {
    const q = [...seen.values()].find((s) => s.json?.about === `decision ${oblig}`)?.json;
    if (!q) return NOT_RUN(seen.size ? "the queued alert was taken by the tray before its links could be read" : "no queued alert was seen (the tray took it within 20 ms, or it was shown without the tray), so this check has no Done link to click");
    const done = (q.toast?.buttons ?? []).find((b) => b.content === "Done")?.uri;
    if (!done) throw new Error(`the alert has no Done button: ${JSON.stringify(q.toast?.buttons ?? [])}`);
    const from = fileSize(uriLog);
    const r = viaHandler(done);
    const res = await waitFor(() => /explain --queued exited (\d+)/.exec(since(uriLog, from)), 60_000, 500);
    if (!res || res[1] !== "0") throw new Error(`uri.log: ${tail(since(uriLog, from), 4)}\n${r.out.slice(0, 500)}`);
    const ans = await waitFor(() => answerOnRelay(actId), 30_000, 2000);
    if (!ans) throw new Error(`no ANSWER to ${actId} from ${memberId} on the relay`);
    return `buttons ${(q.toast.buttons ?? []).map((b) => b.content).join("/")}; ANSWER ${ans.id}: "${String(ans.body).slice(0, 60)}"`;
  }, noAlert);

  await boardStop("Windows", st, noTeam);

  // The logs and the host's state, kept before uninstall removes them (no keys, no tokens).
  keepMemberFiles();

  await step("pantheon stop all: the host, worker, notifier, tray and launcher all stop", async () => {
    const r = member.run(["stop", "all"], { timeout: 120_000 });
    if (r.code !== 0) throw new Error(r.out.slice(-400));
    const down = await waitFor(() => { const l = procs().filter((p) => p.kind !== "board"); return !l.length && !hostUp(l); }, 45_000, 1500);
    if (!down) throw new Error(`still running 45 s later: ${showProcs(procs())}\n${tail(r.out, 10)}`);
    return tail(r.out, 4).split("\n").map((l) => l.trim()).join(" | ").slice(0, 200);
  }, noTask);

  await step("pantheon uninstall --yes: no task, no processes, no ~/.pantheon, no pantheon: handler", async () => {
    const r = member.run(["uninstall", "--yes"], { timeout: 300_000 });
    writeFileSync(join(ART, "uninstall.txt"), r.out);
    if (r.code !== 0) throw new Error(`exit ${r.code}: ${tail(r.out, 15)}`);
    const left = [];
    const noTaskNow = await waitFor(() => !queryXml(), 30_000, 1000);
    if (!noTaskNow) left.push(`the ${task} task`);
    const noProcs = await waitFor(() => !procs().length, 30_000, 1500);
    if (!noProcs) left.push(`processes: ${showProcs(procs())}`);
    const homeGone = await waitFor(() => !existsSync(member.ph), 60_000, 1000);
    if (!homeGone) left.push(`${member.ph}: ${readdirSync(member.ph).join(", ")}`);
    if (spawnSync("reg", ["query", "HKCU\\Software\\Classes\\pantheon"], { windowsHide: true }).status === 0) left.push("HKCU\\Software\\Classes\\pantheon");
    const aumid = spawnSync("reg", ["query", "HKCU\\Software\\Classes\\AppUserModelId\\JoinPantheon.Pantheon"], { windowsHide: true }).status === 0;
    if (managed && !(await waitFor(() => !existsSync(managed.runtime), 60_000, 1000))) left.push(managed.runtime);
    if (left.length) throw new Error(`still there: ${left.join("; ")}\n${tail(r.out, 12)}`);
    return `removed${managed ? " (the managed runtime too)" : ""}${aumid ? "; the AppUserModelId key is still there" : ""}`;
  }, noTask);
}

/** Whatever the checks left running or registered, taken down (best effort, at exit). */
function windowsTeardown(task) {
  if (!task) return;
  if (spawnSync("schtasks", ["/Query", "/TN", task], { windowsHide: true }).status !== 0) return;
  try { run(member.bin, ["stop", "all"], { env: member.env, timeout: 60_000 }); } catch { /* */ }
  spawnSync("schtasks", ["/End", "/TN", task], { windowsHide: true });
  spawnSync("schtasks", ["/Delete", "/TN", task, "/F"], { windowsHide: true });
}

/* ================================================================== Linux */

if (LINUX) await linux();
async function linux() {
  const dir = mkdtempSync(join(tmpdir(), "pd-bus-"));
  const busPath = join(dir, "bus"), busAddr = `unix:path=${busPath}`;
  const notifyLog = join(dir, "notify.jsonl"), ctl = join(dir, "invoke.json");
  const records = () => readText(notifyLog).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  cleanups.push(() => { try { cpSync(notifyLog, join(ART, "notify.jsonl")); } catch { /* none */ } });

  // A stand-in for GNOME Shell / dunst: org.freedesktop.Notifications with
  // actions, which records every call and emits ActionInvoked on request.
  const server = `
import sys, os, json
import dbus, dbus.service, dbus.mainloop.glib
from gi.repository import GLib
dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
LOG, CTL = sys.argv[1], sys.argv[2]
IFACE = "org.freedesktop.Notifications"
def rec(o):
    with open(LOG, "a") as f:
        f.write(json.dumps(o) + "\\n")
bus = dbus.SessionBus()
name = dbus.service.BusName(IFACE, bus, do_not_queue=True)
class Server(dbus.service.Object):
    last = 0
    @dbus.service.method(IFACE, in_signature="", out_signature="as")
    def GetCapabilities(self):
        return ["actions", "body", "body-markup", "persistence"]
    @dbus.service.method(IFACE, in_signature="", out_signature="ssss")
    def GetServerInformation(self):
        return ("pantheon-checks", "pantheon-checks", "1.0", "1.2")
    @dbus.service.method(IFACE, in_signature="susssasa{sv}i", out_signature="u", sender_keyword="sender")
    def Notify(self, app, replaces, icon, summary, body, actions, hints, timeout, sender=None):
        if int(replaces):
            nid = int(replaces)
        else:
            Server.last += 1
            nid = Server.last
        rec({"t": "notify", "id": nid, "app": str(app), "summary": str(summary), "body": str(body),
             "actions": [str(a) for a in actions], "hints": {str(k): str(v) for k, v in hints.items()},
             "timeout": int(timeout), "sender": str(sender)})
        return dbus.UInt32(nid)
    @dbus.service.method(IFACE, in_signature="u", out_signature="")
    def CloseNotification(self, nid):
        rec({"t": "close", "id": int(nid)})
        self.NotificationClosed(nid, dbus.UInt32(3))
    @dbus.service.signal(IFACE, signature="uu")
    def NotificationClosed(self, nid, reason):
        pass
    @dbus.service.signal(IFACE, signature="us")
    def ActionInvoked(self, nid, key):
        pass
srv = Server(bus, "/org/freedesktop/Notifications")
def poll():
    try:
        if os.path.exists(CTL):
            with open(CTL) as f:
                c = json.load(f)
            os.remove(CTL)
            srv.ActionInvoked(dbus.UInt32(c["id"]), c["action"])
            rec({"t": "invoked", "id": c["id"], "action": c["action"]})
    except Exception as e:
        rec({"t": "error", "error": str(e)})
    return True
GLib.timeout_add(100, poll)
rec({"t": "ready", "owner": bus.get_unique_name()})
GLib.MainLoop().run()
`;
  const serverFile = join(dir, "notifications.py");
  writeFileSync(serverFile, server);
  const invoke = (id, action) => { writeFileSync(`${ctl}.tmp`, JSON.stringify({ id, action })); renameSync(`${ctl}.tmp`, ctl); };

  let busUp = false;
  const haveBus = await step("a session bus (dbus-daemon) and a notification server with actions (a stand-in written here) run", async () => {
    const missing = [];
    if (spawnSync("sh", ["-c", "command -v dbus-daemon"]).status !== 0) missing.push("dbus-daemon");
    if (spawnSync("python3", ["-c", "import dbus, dbus.service, dbus.mainloop.glib; from gi.repository import GLib"]).status !== 0) missing.push("python3-dbus / python3-gi");
    if (missing.length) return NOT_RUN(`${missing.join(" and ")} not installed on this runner (the workflow installs them with apt)`);
    const daemon = spawn("dbus-daemon", ["--session", "--nofork", `--address=${busAddr}`, "--print-address=1"], { stdio: ["ignore", "pipe", "pipe"] });
    let dOut = ""; daemon.stdout.on("data", (b) => { dOut += b; }); daemon.stderr.on("data", (b) => { dOut += b; });
    cleanups.push(() => killTree(daemon));
    if (!(await waitFor(() => existsSync(busPath) && dOut.includes("unix:"), 15_000, 200))) throw new Error(`dbus-daemon did not start: ${dOut.slice(0, 300)}`);
    const py = spawn("python3", [serverFile, notifyLog, ctl], { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: busAddr }, stdio: ["ignore", "pipe", "pipe"] });
    let pOut = ""; py.stdout.on("data", (b) => { pOut += b; }); py.stderr.on("data", (b) => { pOut += b; });
    cleanups.push(() => { killTree(py); writeFileSync(join(ART, "notifications-server.txt"), pOut); });
    const ready = await waitFor(() => records().find((r) => r.t === "ready"), 15_000, 200);
    if (!ready) throw new Error(`the notification server did not start: ${pOut.slice(-400)}`);
    busUp = true;
    return `${busAddr}, server ${ready.owner}`;
  });
  const noBus = haveBus ? null : haveBus === null ? "no session bus or notification server here (NOT RUN above)" : "the session bus did not start (FAIL above)";

  // The member's notifier, as its systemd unit runs it, against this bus.
  let nOut = "", notifier = null;
  const nEnv = { ...member.env, DBUS_SESSION_BUS_ADDRESS: busAddr, BROWSER: "true" };
  delete nEnv.DISPLAY; delete nEnv.WAYLAND_DISPLAY;
  const notifierUp = await step("pantheon notifier runs against the local relay, on this session bus", async () => {
    notifier = spawn(member.bin, ["notifier"], { env: nEnv, cwd: member.cwd, stdio: ["ignore", "pipe", "pipe"] });
    notifier.stdout.on("data", (b) => { nOut += b; }); notifier.stderr.on("data", (b) => { nOut += b; });
    cleanups.push(() => { killTree(notifier); writeFileSync(join(ART, "notifier.txt"), strip(nOut)); });
    if (!(await waitFor(() => /notifier online as/.test(nOut), 45_000, 250))) throw new Error(`not online 45 s later:\n${tail(strip(nOut), 10)}`);
    return strip(/notifier online as \S+/.exec(nOut)?.[0] ?? "");
  }, noTeam ?? noBus);
  const noNotifier = noTeam ?? noBus ?? (notifierUp ? null : "the notifier did not start (FAIL above)");

  let actId = "", note = null;
  const alerted = await step("the teammate's HUMAN_REQUIRED arrives as a notification with Done and Open board buttons", async () => {
    actId = await askForDecision("Pick the release banner colour blue or green", "release-banner");
    note = await waitFor(() => records().find((r) => r.t === "notify" && r.actions.includes("done")) ?? null, 90_000, 250);
    if (!note) throw new Error(`no Notify with a Done action 90 s after ${actId}. Calls: ${JSON.stringify(records().filter((r) => r.t === "notify")).slice(0, 400)}\nnotifier:\n${tail(strip(nOut), 10)}`);
    const pairs = [];
    for (let i = 0; i + 1 < note.actions.length; i += 2) pairs.push(`${note.actions[i]}=${note.actions[i + 1]}`);
    if (!pairs.includes("done=Done") || !pairs.includes("board=Open board")) throw new Error(`actions: ${pairs.join(", ")}`);
    const said = strip(/alerts: D-Bus notifications[^\n]*/.exec(nOut)?.[0] ?? "");
    return `#${note.id} "${note.summary}" [${pairs.join(", ")}]${said ? `; notifier: ${said}` : ""}`;
  }, noNotifier);
  const noNote = alerted ? null : "no notification arrived (FAIL above)";

  await step("Open board on the notification starts the board", async () => {
    const before = readText(join(member.ph, "board.json"));
    invoke(note.id, "board");
    const up = await waitFor(async () => {
      const t = readText(join(member.ph, "board.json"));
      if (!t || t === before) return null;
      const j = JSON.parse(t);
      return (await http(j.port, "/api/ping")).json?.board ? j : null;
    }, 45_000, 500);
    if (!up) throw new Error(`no board 45 s after the button:\n${tail(strip(nOut), 8)}`);
    return `board on port ${up.port} (pid ${up.pid})`;
  }, noNote);

  const st = await boardChecks("Linux", actId || null, noTeam);

  await step("Done on the notification answers the decision on the relay, and the notification closes", async () => {
    invoke(note.id, "done");
    const done = await waitFor(() => /alerts: Done (→|was not sent)[^\n]*/.exec(strip(nOut))?.[0], 60_000, 250);
    if (!done || /not sent/.test(done)) throw new Error(`notifier: ${done ?? tail(strip(nOut), 8)}`);
    const ans = await waitFor(() => answerOnRelay(actId), 30_000, 2000);
    if (!ans) throw new Error(`no ANSWER to ${actId} from ${memberId} on the relay; notifier said "${done}"`);
    const closed = await waitFor(() => records().find((r) => r.t === "close" && r.id === note.id), 15_000, 250);
    const items = await waitFor(() => { const i = memberItems(); return i && !i.some((x) => x.ref === actId) ? i : null; }, 30_000, 2000);
    if (!items) throw new Error(`the decision is still on the member's board: ${JSON.stringify(memberItems()).slice(0, 300)}`);
    return `notifier: "${done.trim()}"; ANSWER ${ans.id}; ${closed ? "CloseNotification sent" : "no CloseNotification"}; gone from the board`;
  }, noNote);

  await step("pantheon board --watch: nothing under Needs you now once it is done", () => {
    const r = member.run(["board", "--watch"], { timeout: 90_000 });
    const m = /Needs you now \((\d+)\)/.exec(r.out);
    if (!m) throw new Error(tail(r.out, 12));
    if (m[1] !== "0") throw new Error(`Needs you now (${m[1]}):\n${tail(r.out, 12)}`);
    return "Needs you now (0)";
  }, noNote);

  await boardStop("Linux", st, noTeam);

  await step("pantheon doctor's alerts line: D-Bus notifications with actions, from this desktop's server", () => {
    const r = member.run(["doctor"], { env: { ...member.env, DBUS_SESSION_BUS_ADDRESS: busAddr }, timeout: 120_000 });
    writeFileSync(join(ART, "doctor.txt"), r.out);
    const line = /^\s*(ok|warn|FAIL)\s+alerts\s+(.*)$/m.exec(r.out);
    if (!line) throw new Error(`no alerts row:\n${tail(r.out, 25)}`);
    if (!/D-Bus notifications with actions/.test(line[2])) throw new Error(line[0].trim());
    return `${line[1]} alerts ${line[2].trim().slice(0, 160)}`;
  }, noTeam ?? (busUp ? null : noBus));

  if (notifier) { killTree(notifier); await sleep(500); }

  /* ---- the systemd --user unit ---- */
  const uid = process.getuid(), runtime = `/run/user/${uid}`;
  const sdEnv = { ...member.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
  const unit = join(realHome, ".config", "systemd", "user", "pantheon-notifier.service");
  const sd = await step("systemd --user answers for this runner's user (lingering on, as a desktop login would have it)", async () => {
    const already = spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8", env: sdEnv });
    if (!existsSync(join(runtime, "systemd", "private"))) {
      const l = spawnSync("sudo", ["-n", "loginctl", "enable-linger", userInfo().username], { encoding: "utf8" });
      if (l.status !== 0) return NOT_RUN(`no systemd --user instance, and lingering could not be switched on: ${strip(l.stderr).trim().slice(0, 200)}`);
      if (!(await waitFor(() => existsSync(join(runtime, "systemd", "private")), 30_000, 500))) return NOT_RUN(`lingering is on but no user manager appeared at ${runtime} in 30 s`);
    }
    const r = spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8", env: sdEnv });
    const s = strip(r.stdout).trim();
    if (!s || /Failed to connect/i.test(strip(r.stderr))) return NOT_RUN(`systemctl --user: ${strip(r.stderr).trim().slice(0, 200)}`);
    cleanups.push(() => { if (existsSync(unit)) run(member.bin, ["service", "uninstall", "notifier"], { env: sdEnv, cwd: member.cwd, timeout: 60_000 }); });
    return `user manager ${s}${already.status === 0 ? "" : " (lingering switched on here)"}`;
  }, noTeam);
  const noSd = noTeam ?? (sd ? null : sd === null ? "no systemd --user here (NOT RUN above)" : "systemd --user is not reachable (FAIL above)");

  await step("pantheon service install notifier writes pantheon-notifier.service, and systemd runs it", async () => {
    const r = member.run(["service", "install", "notifier"], { env: sdEnv, timeout: 120_000 });
    writeFileSync(join(ART, "service-install.txt"), r.out);
    if (r.code !== 0) throw new Error(tail(r.out, 12));
    const text = readText(unit);
    writeFileSync(join(ART, "pantheon-notifier.service"), text);
    const bad = [];
    if (!/^ExecStart=.*\bnotifier\b/m.test(text)) bad.push("ExecStart does not run the notifier");
    if (!/^Restart=always$/m.test(text)) bad.push("no Restart=always");
    const target = /^WantedBy=(\S+)/m.exec(text)?.[1];
    if (!["graphical-session.target", "default.target"].includes(target)) bad.push(`WantedBy=${target}`);
    if (target === "graphical-session.target" && !/^After=graphical-session\.target/m.test(text)) bad.push("WantedBy graphical-session.target but not After= it");
    if (/^Environment=.*\b(DISPLAY|WAYLAND_DISPLAY)=/m.test(text)) bad.push("the unit carries a display");
    if (bad.length) throw new Error(`${bad.join("; ")}\n${text}`);
    const active = await waitFor(() => strip(spawnSync("systemctl", ["--user", "is-active", "pantheon-notifier.service"], { encoding: "utf8", env: sdEnv }).stdout).trim() === "active", 30_000, 1000);
    if (!active) throw new Error(`not active 30 s later:\n${strip(spawnSync("systemctl", ["--user", "status", "pantheon-notifier.service", "--no-pager"], { encoding: "utf8", env: sdEnv }).stdout).slice(0, 800)}`);
    return `WantedBy=${target}, Restart=always, active`;
  }, noSd);

  await step("pantheon doctor: alerts installed and running, shown as D-Bus notifications with actions", () => {
    if (!busUp) return NOT_RUN("no session bus with a notification server here (see above)");
    const r = member.run(["doctor"], { env: { ...sdEnv, DBUS_SESSION_BUS_ADDRESS: busAddr }, timeout: 120_000 });
    const line = /^\s*(ok|warn|FAIL)\s+alerts\s+(.*)$/m.exec(r.out);
    if (!line || line[1] !== "ok" || !/D-Bus notifications with actions/.test(line[2])) throw new Error(line?.[0]?.trim() ?? tail(r.out, 20));
    return line[0].trim().replace(/\s+/g, " ").slice(0, 160);
  }, noSd);

  await step("pantheon service uninstall notifier removes the unit and stops it", async () => {
    const r = member.run(["service", "uninstall", "notifier"], { env: sdEnv, timeout: 120_000 });
    if (r.code !== 0) throw new Error(tail(r.out, 10));
    if (existsSync(unit)) throw new Error(`${unit} is still there`);
    const st2 = strip(spawnSync("systemctl", ["--user", "is-active", "pantheon-notifier.service"], { encoding: "utf8", env: sdEnv }).stdout).trim();
    if (st2 === "active") throw new Error("still active");
    return `unit removed, ${st2 || "inactive"}`;
  }, noSd);
}

/* ================================================================== macOS */

if (MAC) await mac();
async function mac() {
  let actId = "";
  await step("the teammate's HUMAN_REQUIRED reaches the relay (so the board has something to show)", async () => {
    actId = await askForDecision("Pick the release banner colour blue or green", "release-banner");
    const on = await waitFor(() => (memberItems() ?? []).some((i) => i.ref === actId), 30_000, 2000);
    if (!on) throw new Error(`not in the member's tray-status: ${JSON.stringify(memberItems()).slice(0, 300)}`);
    return actId;
  }, noTeam);
  const st = await boardChecks("macOS", actId || null, noTeam);
  await boardStop("macOS", st, noTeam);

  // The launchd agents: what 0.33 writes for the notifier and menu bar has the
  // shape the previous release wrote (the darwin branch is meant to be unchanged).
  const uid = process.getuid();
  const gui = spawnSync("launchctl", ["print", `gui/${uid}`], { encoding: "utf8" });
  const guiOk = gui.status === 0;
  let prevBin = "";
  if (prev) {
    await step(`the previous release (${prev}) installed beside it, to compare with`, () => {
      const dir = join(scratch, "prev");
      const r = run("npm", ["i", "--prefix", dir, `@join-pantheon/cli@${prev}`, "--no-audit", "--no-fund", "--loglevel=error"], { timeout: 600_000 });
      const bin = join(dir, "node_modules", ".bin", "pantheon");
      if (r.code !== 0 || !existsSync(bin)) throw new Error(tail(r.out, 10));
      prevBin = bin;
      return run(bin, ["--version"], { env: member.env }).out.trim().split("\n").pop();
    }, noTeam);
  }
  const plistOf = (kind) => join(realHome, "Library", "LaunchAgents", `dev.pantheon.${kind}.plist`);
  /** Install one kind with this pantheon, read what launchd was given and what it says, then uninstall it. */
  const installRead = (bin, kind) => {
    const i = run(bin, ["service", "install", kind], { env: member.env, cwd: member.cwd, timeout: 600_000 });
    const plist = plistOf(kind);
    const json = spawnSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" });
    let j = null; try { j = JSON.parse(json.stdout); } catch { /* none */ }
    const pr = spawnSync("launchctl", ["print", `gui/${uid}/dev.pantheon.${kind}`], { encoding: "utf8" });
    const u = run(bin, ["service", "uninstall", kind], { env: member.env, cwd: member.cwd, timeout: 120_000 });
    return { install: i, plist: j, raw: readText(plist), print: pr.status === 0 ? strip(pr.stdout) : null, printErr: strip(pr.stderr), uninstall: u, gone: !existsSync(plist) };
  };
  const home = (s) => String(s ?? "").split(realHome).join("~");
  const shape = (j) => j && ({
    keys: Object.keys(j).sort().join(","),
    Label: j.Label, RunAtLoad: j.RunAtLoad, KeepAlive: JSON.stringify(j.KeepAlive), ThrottleInterval: j.ThrottleInterval,
    args: (j.ProgramArguments ?? []).map((a, n) => (n === 0 ? basename(a) : /[\\/]/.test(a) ? `…/${basename(a)}` : a)).join(" "),
    WorkingDirectory: home(j.WorkingDirectory), StandardOutPath: home(j.StandardOutPath), StandardErrorPath: home(j.StandardErrorPath),
    env: Object.keys(j.EnvironmentVariables ?? {}).sort().join(","),
  });
  const printShape = (p) => p && ({ state: /^\s*state = (\S+)/m.exec(p)?.[1], args: (/arguments = \{([\s\S]*?)\}/.exec(p)?.[1] ?? "").trim().split(/\s*\n\s*/).map((a, n) => (n === 0 ? basename(a) : /[\\/]/.test(a) ? `…/${basename(a)}` : a)).join(" ") });
  for (const kind of ["notifier", "menubar"]) {
    let cur = null;
    await step(`the ${kind}'s launchd agent (dev.pantheon.${kind}): ${prevBin ? `the same shape as ${prev}'s` : "the expected shape"}`, () => {
      const p = prevBin ? installRead(prevBin, kind) : null;
      cur = installRead(member.bin, kind);
      writeFileSync(join(ART, `dev.pantheon.${kind}.plist`), cur.raw);
      if (!cur.plist) throw new Error(`no plist written: ${tail(cur.install.out, 10)}`);
      if (!cur.gone) throw new Error(`service uninstall ${kind} left ${plistOf(kind)}: ${tail(cur.uninstall.out, 6)}`);
      const a = shape(cur.plist);
      if (p) {
        if (!p.plist) throw new Error(`${prev} wrote no plist to compare with: ${tail(p.install.out, 8)}`);
        const b = shape(p.plist);
        const diff = Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => `${k}: ${prev} ${JSON.stringify(b[k])} → now ${JSON.stringify(a[k])}`);
        if (diff.length) throw new Error(diff.join("\n"));
        return `${a.args}; RunAtLoad ${a.RunAtLoad}, KeepAlive ${a.KeepAlive}, ThrottleInterval ${a.ThrottleInterval} — as ${prev}`;
      }
      const bad = [];
      if (a.Label !== `dev.pantheon.${kind}`) bad.push(`Label ${a.Label}`);
      if (a.RunAtLoad !== true || a.KeepAlive !== "true") bad.push(`RunAtLoad ${a.RunAtLoad}, KeepAlive ${a.KeepAlive}`);
      if (!a.args.endsWith(` ${kind}`) && !a.args.includes(` ${kind} `)) bad.push(`ProgramArguments ${a.args}`);
      if (!/(^|,)PATH(,|$)/.test(a.env)) bad.push("no PATH in EnvironmentVariables");
      if (bad.length) throw new Error(bad.join("; "));
      return `${a.args}; RunAtLoad, KeepAlive, ThrottleInterval ${a.ThrottleInterval}`;
    }, noTeam);
    await step(`launchctl print shows the ${kind} agent loaded${prevBin ? `, as ${prev}'s was` : ""}`, () => {
      if (!guiOk) return NOT_RUN(`this runner has no gui/${uid} launchd domain to load agents into: ${strip(gui.stderr).trim().slice(0, 200)}`);
      if (!cur) throw new Error("the agent was not installed (FAIL above)");
      if (!cur.print) return NOT_RUN(`launchd did not take the agent here: ${cur.printErr.trim().slice(0, 200)}; install said: ${tail(cur.install.out, 4)}`);
      const s = printShape(cur.print);
      return `state ${s.state}; arguments ${s.args}`;
    }, noTeam);
  }
}

/* ------------------------------------------------------------------ the end */

/** ~/.pantheon/logs and ~/.pantheon/host (state.json, task.xml, launch.txt), copied for the workflow to upload. */
function keepMemberFiles() {
  for (const [from, to] of [["logs", "member-logs"], ["host", "member-host"]]) {
    try { if (existsSync(join(member.ph, from))) cpSync(join(member.ph, from), join(ART, to), { recursive: true, force: true, filter: (s) => !/[\\/]notices([\\/]|$)/.test(s) }); } catch { /* partial is fine */ }
  }
}

const failed = results.filter((r) => r.state === "FAIL");
const notRun = results.filter((r) => r.state === "NOT RUN");
keepMemberFiles();
if (failed.length) {
  console.log("\n---- logs, because something failed ----");
  console.log(`relay (last 40 lines):\n${tail(relayLog, 40)}\n`);
  const logs = existsSync(join(member.ph, "logs")) ? join(member.ph, "logs") : join(ART, "member-logs");
  try {
    for (const f of readdirSync(logs)) if (f.endsWith(".log")) console.log(`${f} (last 25 lines):\n${tail(readText(join(logs, f)), 25)}\n`);
  } catch { console.log(`(no member logs at ${logs})`); }
  const stf = join(member.ph, "host", "state.json");
  if (existsSync(stf)) console.log(`host/state.json: ${readText(stf)}`);
}
console.log(`\n${failed.length ? `${failed.length} FAILED` : "nothing failed"}, ${results.length - failed.length - notRun.length} ok, ${notRun.length} NOT RUN — ${OS} ${process.arch}${want ? `, ${want}` : ""}`);
if (notRun.length) for (const r of notRun) console.log(`  NOT RUN  ${r.name}: ${String(r.detail).split("\n")[0].slice(0, 200)}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const icon = { ok: "✅", FAIL: "❌", "NOT RUN": "⏭️ NOT RUN" };
  const rows = results.map((r) => `| ${icon[r.state]} | ${r.name} | ${String(r.detail).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 300)} |`).join("\n");
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### desktop · ${OS} ${process.arch}${want ? ` · ${want}` : ""}\n\n| | check | evidence |\n|---|---|---|\n${rows}\n\n`, { flag: "a" });
}
cleanup();
process.exit(failed.length ? 1 : 0);
