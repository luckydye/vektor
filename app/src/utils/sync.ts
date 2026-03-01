import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Doc } from "yjs";
import { config } from "../config.ts";

const appConfig = config();

export function createYProvider(roomName: string, ydoc: Doc) {
  const provider = new HocuspocusProvider({
    url: `ws${!import.meta.env.DEV ? "s" : ""}://${appConfig.COLLABORATION_HOST}/collaboration`,
    name: roomName,
    document: ydoc,
  });
  provider.on("error", (err: unknown) => {
    console.error("[HocuspocusProvider Error]:", err);
  });

  console.debug(ydoc);

  return provider;
}
