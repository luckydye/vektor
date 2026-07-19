// Probe the Yjs-join path: how long from YjsJoin to receiving the doc state,
// and whether the event loop is blocked meanwhile.
const HOST = process.env.HOST ?? "127.0.0.1:8080";
const SPACE = process.env.SPACE ?? "8624ada5-822e-479a-8202-f7a656e9d8ee";
const DOC = process.env.DOC ?? "doc_5bdef611-6543-4de0-b6c2-531400849e07";
const SECONDS = Number.parseInt(process.env.SECONDS ?? "40", 10);
const T = { YjsJoin: 4, YjsUpdate: 5, PresenceJoin: 6, PresenceUpdate: 7, PresenceSnapshot: 9, Error: 3 };
const enc = new TextEncoder();
const t0 = Date.now();
const log = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(2)}s] ${m}`);

function frameJson(type, p) { const j = enc.encode(JSON.stringify(p)); const f = new Uint8Array(1 + j.length); f[0] = type; f.set(j, 1); return f; }
function frameYjsJoin(id) { return frameJson(T.YjsJoin, { documentId: id }); }

let joinSentAt = 0, firstYjsAt = 0, yjsBytes = 0, yjsFrames = 0;
const ws = new WebSocket(`ws://${HOST}/events/${SPACE}`);
ws.binaryType = "arraybuffer";
ws.onopen = () => {
  log(`WS open (connect took ${Date.now() - t0}ms)`);
  ws.send(frameYjsJoin(DOC)); joinSentAt = Date.now();
  log("sent YjsJoin, waiting for doc state...");
};
ws.onmessage = (e) => {
  const u = new Uint8Array(e.data); const type = u[0];
  if (type === T.YjsUpdate) {
    yjsFrames++; yjsBytes += u.byteLength;
    if (!firstYjsAt) { firstYjsAt = Date.now(); log(`FIRST YjsUpdate after ${firstYjsAt - joinSentAt}ms, ${(u.byteLength / 1048576).toFixed(1)}MB`); }
  } else if (type === T.Error) { log(`ERROR frame: ${new TextDecoder().decode(u.subarray(1))}`); }
  else { log(`recv type=${type}`); }
};
ws.onclose = (e) => log(`WS closed code=${e.code}`);
ws.onerror = () => log("WS error");

// Liveness pinger: send a presence update every 500ms; if the server is blocked,
// we'll see no responses and know when it recovers.
setInterval(() => {
  if (ws.readyState === 1) {
    try { ws.send(frameJson(T.PresenceJoin, { room: DOC, clientId: "probe", user: { id: "p", name: "probe" }, state: { kind: "canvas", t: Date.now() } })); } catch {}
  }
}, 2000);

setTimeout(() => {
  log(`SUMMARY: firstYjs=${firstYjsAt ? firstYjsAt - joinSentAt : "NEVER"}ms yjsFrames=${yjsFrames} yjsMB=${(yjsBytes / 1048576).toFixed(1)}`);
  ws.close(); setTimeout(() => process.exit(0), 200);
}, SECONDS * 1000);
