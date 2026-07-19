// Aggressive repro: induce the memory-pressure hang headlessly.
// - reconnect storm: many clients repeatedly YjsJoin (each re-encodes the ~40MB
//   doc state server-side)
// - draw/erase churn: clients add and delete strokes (Yjs tombstone growth in
//   the live room doc, which a fresh load never shows)
// Run against the profiled dev server; watch server trace log + RSS.
import * as Y from "yjs";

const HOST = process.env.HOST ?? "127.0.0.1:8080";
const SPACE = process.env.SPACE ?? "8624ada5-822e-479a-8202-f7a656e9d8ee";
const DOC = process.env.DOC ?? "doc_5bdef611-6543-4de0-b6c2-531400849e07";
const RECONNECTORS = Number.parseInt(process.env.RECONNECTORS ?? "12", 10);
const DRAWERS = Number.parseInt(process.env.DRAWERS ?? "2", 10);
const SECONDS = Number.parseInt(process.env.SECONDS ?? "75", 10);

const T = { Error: 3, YjsJoin: 4, YjsUpdate: 5, PresenceJoin: 6, PresenceUpdate: 7 };
const enc = new TextEncoder();
const t0 = Date.now();
const log = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
function frameJson(type, p) { const j = enc.encode(JSON.stringify(p)); const f = new Uint8Array(1 + j.length); f[0] = type; f.set(j, 1); return f; }
function frameYjsJoin(id) { return frameJson(T.YjsJoin, { documentId: id }); }
function frameYjsUpdate(id, update) {
  const idb = enc.encode(id); const f = new Uint8Array(1 + 4 + idb.length + update.length);
  f[0] = T.YjsUpdate; new DataView(f.buffer).setUint32(1, idb.length, false); f.set(idb, 5); f.set(update, 5 + idb.length); return f;
}
const url = `ws://${HOST}/events/${SPACE}`;
let joins = 0;
let stopped = false;

// Reconnect storm: connect, join, hold briefly, close, repeat.
function reconnector(i) {
  if (stopped) return;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { try { ws.send(frameYjsJoin(DOC)); joins++; } catch {} };
  ws.onmessage = () => {};
  ws.onerror = () => {};
  const closeAfter = 500 + Math.floor((i % 5) * 120);
  setTimeout(() => { try { ws.close(); } catch {} ; setTimeout(() => reconnector(i), 100); }, closeAfter);
}

// Draw/erase churn: keep a synced doc, add strokes and delete old ones.
class Drawer {
  constructor(i) {
    this.i = i; this.n = 0; this.ids = []; this.synced = false;
    this.doc = new Y.Doc();
    this.doc.on("update", (u, origin) => { if (origin !== "remote" && this.ws?.readyState === 1) this.ws.send(frameYjsUpdate(DOC, u)); });
    this.connect();
  }
  connect() {
    this.ws = new WebSocket(url); this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => { this.ws.send(frameYjsJoin(DOC)); };
    this.ws.onmessage = (e) => {
      const u = new Uint8Array(e.data);
      if (u[0] === T.YjsUpdate) {
        const p = u.subarray(1); const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
        const idLen = dv.getUint32(0, false);
        try { Y.applyUpdate(this.doc, p.subarray(4 + idLen), "remote"); this.synced = true; } catch {}
      }
    };
    this.ws.onerror = () => {};
    this.ws.onclose = () => { if (!stopped) setTimeout(() => this.connect(), 300); };
  }
  tick() {
    if (!this.synced || this.ws.readyState !== 1) return;
    const strokes = this.doc.getMap("canvas.strokes");
    const id = `stress-${this.i}-${this.n++}`;
    const pts = Array.from({ length: 60 }, (_, k) => ({ x: k, y: k, width: 2 }));
    this.doc.transact(() => {
      const m = new Y.Map(); m.set("points", pts); m.set("style", { color: "#abcdef" }); m.set("updatedAt", Date.now());
      strokes.set(id, m);
    });
    this.ids.push(id);
    // Erase an older stroke to create tombstones.
    if (this.ids.length > 5) {
      const old = this.ids.shift();
      this.doc.transact(() => { strokes.delete(old); });
    }
  }
}

log(`cfg reconnectors=${RECONNECTORS} drawers=${DRAWERS} seconds=${SECONDS}`);
for (let i = 0; i < RECONNECTORS; i++) setTimeout(() => reconnector(i), i * 60);
const drawers = Array.from({ length: DRAWERS }, (_, i) => new Drawer(i));
const drawTimer = setInterval(() => { for (const d of drawers) d.tick(); }, 250);
const statTimer = setInterval(() => log(`joins=${joins} strokesDrawn=${drawers.reduce((a, d) => a + d.n, 0)}`), 5000);

setTimeout(() => {
  stopped = true; clearInterval(drawTimer); clearInterval(statTimer);
  log(`DONE joins=${joins} strokesDrawn=${drawers.reduce((a, d) => a + d.n, 0)}`);
  for (const d of drawers) { try { d.ws.close(); } catch {} }
  setTimeout(() => process.exit(0), 500);
}, SECONDS * 1000);
