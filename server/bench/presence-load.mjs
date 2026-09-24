// Headless presence/Yjs load harness for the vektor realtime server.
// Reproduces canvas presence traffic and measures frames in/out, broadcast
// latency, and stalls — without a browser.
//
// Usage: bun loadtest.mjs
// Env: HOST, SPACE, DOC, CLIENTS, RATE (updates/s per client), SECONDS, YJS(0|1)

const HOST = process.env.HOST ?? "127.0.0.1:8080";
const SPACE = process.env.SPACE ?? "8624ada5-822e-479a-8202-f7a656e9d8ee";
const DOC = process.env.DOC ?? "doc_5bdef611-6543-4de0-b6c2-531400849e07";
const CLIENTS = Number.parseInt(process.env.CLIENTS ?? "2", 10);
const RATE = Number.parseInt(process.env.RATE ?? "60", 10);
const SECONDS = Number.parseInt(process.env.SECONDS ?? "20", 10);
const YJS = process.env.YJS === "1";

const T = {
  Subscribe: 0,
  Unsubscribe: 1,
  Event: 2,
  Error: 3,
  YjsJoin: 4,
  YjsUpdate: 5,
  PresenceJoin: 6,
  PresenceUpdate: 7,
  PresenceLeave: 8,
  PresenceSnapshot: 9,
};
const NAME = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));
const enc = new TextEncoder();
const dec = new TextDecoder();

function frameJson(type, payload) {
  const json = enc.encode(JSON.stringify(payload));
  const f = new Uint8Array(1 + json.length);
  f[0] = type;
  f.set(json, 1);
  return f;
}
function frameYjsJoin(documentId) {
  return frameJson(T.YjsJoin, { documentId });
}

const agg = {
  sent: {},
  recv: {},
  recvBytes: 0,
  latSum: 0,
  latCount: 0,
  latMax: 0,
};
function bump(map, type, n = 1) {
  map[type] = (map[type] ?? 0) + n;
}

class Client {
  constructor(i) {
    this.i = i;
    this.clientId = `load-${i}-${Date.now()}`;
    this.sent = 0;
    this.recv = 0;
    this.lastRecvAt = 0;
    this.joined = false;
    this.ws = new WebSocket(`ws://${HOST}/events/${SPACE}`);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => this.onOpen();
    this.ws.onmessage = (e) => this.onMessage(e);
    this.ws.onclose = (e) => {
      this.closed = true;
      this.closeCode = e.code;
    };
    this.ws.onerror = () => {
      this.errored = true;
    };
  }
  send(frame, type) {
    try {
      this.ws.send(frame);
      this.sent++;
      bump(agg.sent, type);
    } catch {
      /* buffer full / closed */
    }
  }
  onOpen() {
    if (YJS) this.send(frameYjsJoin(DOC), T.YjsJoin);
    this.send(
      frameJson(T.PresenceJoin, {
        room: DOC,
        clientId: this.clientId,
        user: { id: `u${this.i}`, name: `Load ${this.i}`, color: "#3b82f6" },
        state: this.cursorState(0, 0),
      }),
      T.PresenceJoin,
    );
    this.joined = true;
  }
  cursorState(x, y) {
    return {
      kind: "canvas",
      t: Date.now(),
      pointer: { x, y },
      cursorColor: "#3b82f6",
      view: { x: 0, y: 0, scale: 1 },
      selectionIds: [],
      focusedNodeId: null,
      activeTool: "select",
    };
  }
  onMessage(e) {
    const u = new Uint8Array(e.data);
    const type = u[0];
    this.recv++;
    this.lastRecvAt = Date.now();
    bump(agg.recv, type);
    agg.recvBytes += u.byteLength;
    // Measure broadcast latency from remote presence updates carrying our `t`.
    if (type === T.PresenceUpdate) {
      try {
        const msg = JSON.parse(dec.decode(u.subarray(1)));
        const t = msg?.presence?.state?.t;
        if (typeof t === "number") {
          const lat = Date.now() - t;
          agg.latSum += lat;
          agg.latCount++;
          if (lat > agg.latMax) agg.latMax = lat;
        }
      } catch {
        /* ignore */
      }
    }
  }
  tick(x, y) {
    if (this.ws.readyState !== 1 || !this.joined) return;
    this.send(
      frameJson(T.PresenceUpdate, {
        room: DOC,
        clientId: this.clientId,
        state: this.cursorState(x, y),
      }),
      T.PresenceUpdate,
    );
  }
}

console.log(
  `[cfg] host=${HOST} clients=${CLIENTS} rate=${RATE}/s seconds=${SECONDS} yjs=${YJS}`,
);
const clients = Array.from({ length: CLIENTS }, (_, i) => new Client(i));

const start = Date.now();
const intervalMs = Math.max(1, Math.round(1000 / RATE));
let frame = 0;
const driver = setInterval(() => {
  frame++;
  const x = Math.sin(frame / 10) * 500;
  const y = Math.cos(frame / 10) * 500;
  for (const c of clients) c.tick(x, y);
}, intervalMs);

let lastStat = { sent: 0, recv: 0, bytes: 0, t: start };
const stat = setInterval(() => {
  const now = Date.now();
  const sent = clients.reduce((a, c) => a + c.sent, 0);
  const recv = clients.reduce((a, c) => a + c.recv, 0);
  const dt = (now - lastStat.t) / 1000;
  const sRate = Math.round((sent - lastStat.sent) / dt);
  const rRate = Math.round((recv - lastStat.recv) / dt);
  const brate = Math.round((agg.recvBytes - lastStat.bytes) / dt / 1024);
  const avgLat = agg.latCount ? Math.round(agg.latSum / agg.latCount) : 0;
  const stalled = clients.filter(
    (c) => c.joined && !c.closed && now - c.lastRecvAt > 1500 && c.lastRecvAt > 0,
  ).length;
  const closed = clients.filter((c) => c.closed).length;
  console.log(
    `[t+${((now - start) / 1000).toFixed(0)}s] send=${sRate}/s recv=${rRate}/s in=${brate}KB/s avgLat=${avgLat}ms maxLat=${agg.latMax}ms stalled=${stalled} closed=${closed}`,
  );
  lastStat = { sent, recv, bytes: agg.recvBytes, t: now };
}, 1000);

setTimeout(() => {
  clearInterval(driver);
  clearInterval(stat);
  const sent = clients.reduce((a, c) => a + c.sent, 0);
  const recv = clients.reduce((a, c) => a + c.recv, 0);
  console.log("\n=== SUMMARY ===");
  console.log(
    `total sent=${sent} recv=${recv} recvMB=${(agg.recvBytes / 1048576).toFixed(1)}`,
  );
  console.log(
    `sent by type:`,
    Object.fromEntries(Object.entries(agg.sent).map(([k, v]) => [NAME[k], v])),
  );
  console.log(
    `recv by type:`,
    Object.fromEntries(Object.entries(agg.recv).map(([k, v]) => [NAME[k], v])),
  );
  console.log(
    `latency avg=${agg.latCount ? Math.round(agg.latSum / agg.latCount) : 0}ms max=${agg.latMax}ms samples=${agg.latCount}`,
  );
  console.log(
    `amplification (recv/sent)=${(recv / Math.max(1, sent)).toFixed(2)}  [~${CLIENTS - 1}x expected for pure fan-out]`,
  );
  for (const c of clients) c.ws.close();
  setTimeout(() => process.exit(0), 300);
}, SECONDS * 1000);
