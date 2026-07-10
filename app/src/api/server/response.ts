import type { ServerResponse } from "node:http";

/** Write a Web Response produced by a Hono route to the Node response. */
export async function sendWebResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  if (res.headersSent) return;

  const setCookies = response.headers.getSetCookie?.() ?? [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    res.setHeader(key, value);
  });
  if (setCookies.length > 0) {
    res.setHeader("set-cookie", setCookies);
  }

  res.statusCode = response.status;

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  const onClose = () => reader.cancel().catch(() => {});
  res.on("close", onClose);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const ok = res.write(Buffer.from(value));
        if (!ok) {
          await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      }
    }
  } finally {
    res.off("close", onClose);
    res.end();
  }
}
