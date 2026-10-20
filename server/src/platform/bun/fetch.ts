import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import {
  type ConnectValidated,
  type SafeFetch,
  SsrfError,
  safeFetch,
} from "#utils/ssrf.ts";
import { assertOutsideTransaction } from "#utils/transactionScope.ts";

const MAX_RACED_ADDRESSES = 8;
const CONNECT_STAGGER_MS = 250;
const CONNECT_RACE_TIMEOUT_MS = 5_000;

/** Unref'd, so a race timer left over cannot hold the process open. */
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/** Resolves once `attempt` has failed, and stays pending if it succeeds. */
function whenFailed(attempt: Promise<unknown>): Promise<null> {
  return attempt.then(
    () => new Promise<null>(() => {}),
    () => null,
  );
}

/**
 * Pick which validated address to connect to, racing them as `fetch` does
 * natively. Pinning gives that race up, and a record that black-holes packets
 * rather than refusing them costs a full OS connect timeout, so trying them in
 * series would turn a working name into a failing one.
 */
async function pickAddress(addresses: string[], url: URL): Promise<string> {
  const candidates = addresses.slice(0, MAX_RACED_ADDRESSES);
  if (candidates.length === 1) return candidates[0];

  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const attempts: Promise<string>[] = [];
  let winner: string | undefined;

  for (const [index, address] of candidates.entries()) {
    attempts.push(
      (async () => {
        if (index > 0) {
          await Promise.race([
            after(index * CONNECT_STAGGER_MS, null),
            whenFailed(attempts[index - 1]),
          ]);
          // Must throw rather than return, or it could be taken for the winner.
          if (winner) throw new SsrfError(`${address} was not needed`);
        }
        const socket = await Bun.connect({
          hostname: address,
          port,
          socket: { data() {}, error() {}, close() {} },
        });
        socket.end();
        winner ??= address;
        return address;
      })(),
    );
  }

  // Falling back to the first address reports its real failure, which beats
  // anything a probe could say.
  const decided = await Promise.race([
    Promise.any(attempts).catch(() => candidates[0]),
    after(CONNECT_RACE_TIMEOUT_MS, candidates[0]),
  ]);
  winner ??= decided;
  return decided;
}

/**
 * Connect to a validated address while still addressing the request to the
 * hostname, which is what closes the DNS-rebinding window. `Host` and the TLS
 * identity checks stay on the original hostname, so pinning breaks neither
 * virtual hosting nor certificate validation.
 */
const connectPinned: ConnectValidated = async (target, init) => {
  if (target.addresses.length === 0) return await fetch(target.url, init);

  const hostname = target.url.hostname;
  const headers = new Headers(init.headers);
  headers.set("Host", target.url.host);

  const request: BunFetchRequestInit = { ...init, headers };
  if (target.url.protocol === "https:") {
    request.tls = {
      serverName: hostname,
      checkServerIdentity: (_peerName, cert) => checkServerIdentity(hostname, cert),
    };
  }

  const address = await pickAddress(target.addresses, target.url);
  const pinned = new URL(target.url.toString());
  pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return await fetch(pinned, request);
};

/** The SSRF-safe `fetch` of a Bun process, for the platform and for threads that run without one. */
export function createBunFetch(): SafeFetch {
  return (url, init, validate) => {
    assertOutsideTransaction("platform.fetch");
    return safeFetch(connectPinned, url, init, validate);
  };
}
