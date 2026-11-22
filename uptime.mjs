// Is the hosted relay up, as a person's machine sees it? Run every few minutes by
// .github/workflows/uptime.yml, from GitHub's machines, so it watches while every
// laptop is asleep.
//
// Two checks, each tried up to 3 times about 40 s apart (one blip is not an outage):
//   1. GET /health?strict=1: HTTP 200 and "ok": true. ok is false when the relay's
//      disk refuses writes or the volume is nearly full; strict makes that a 503.
//   2. A WebSocket opens and the relay sends its "challenge" within 10 s: the path
//      every client's handshake takes, which /health alone does not exercise.
//
// Prints one line, and writes "up" or "down: <why>" to $GITHUB_OUTPUT as `state` and to
// $STATE_FILE when set.
// Sends nothing but these two requests, with User-Agent pantheon-check so they are
// never counted as installs.
import { appendFileSync, writeFileSync } from "node:fs";

const RELAY = process.env.RELAY_URL || "https://relay.joinpantheon.network";
const UA = "pantheon-check uptime";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    const r = await fetch(`${RELAY}/health?strict=1`, { headers: { "user-agent": UA }, signal: ctl.signal });
    const body = await r.text();
    let j = null;
    try { j = JSON.parse(body); } catch { /* not JSON */ }
    if (r.status !== 200 || j?.ok !== true) {
      const why = j?.storage ? `storage: ${j.storage.error}` : j?.disk?.low ? "the relay's disk is nearly full" : body.slice(0, 120);
      return `/health answered ${r.status}: ${why}`;
    }
    return null;
  } catch (e) {
    return `/health did not answer: ${e.name === "AbortError" ? "no reply in 10 s" : e.message}`;
  } finally { clearTimeout(t); }
}

function handshake() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (why) => { if (done) return; done = true; clearTimeout(t); try { ws.close(); } catch {} resolve(why); };
    const ws = new WebSocket(RELAY.replace(/^http/, "ws"), { headers: { "user-agent": UA } });
    const t = setTimeout(() => finish("the WebSocket opened no handshake in 10 s"), 10_000);
    ws.addEventListener("message", (ev) => {
      try { if (JSON.parse(String(ev.data))?.t === "challenge") return finish(null); } catch { /* not JSON */ }
      finish(`the relay's first message was not a challenge: ${String(ev.data).slice(0, 80)}`);
    });
    ws.addEventListener("error", () => finish("the WebSocket could not connect"));
    ws.addEventListener("close", () => finish("the WebSocket closed before the handshake"));
  });
}

let why = "not checked";
for (let i = 0; i < 3; i++) {
  if (i) await sleep(40_000);
  why = (await health()) ?? (await handshake());
  if (!why) break;
  console.log(`attempt ${i + 1}: ${why}`);
}
const state = why ? `down: ${why}` : "up";
console.log(`${RELAY}: ${state}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `state=${state.replace(/\n/g, " ")}\n`);
if (process.env.STATE_FILE) writeFileSync(process.env.STATE_FILE, state.replace(/\n/g, " "));
