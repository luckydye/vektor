import { watchEffect, type ComputedRef, type Ref } from "vue";
import { api } from "../api/client.ts";

export function useSync(
  spaceId: Ref<string | null> | ComputedRef<string | null>,
  callback: (keys: string[]) => void,
) {
  const internalCallback = (msg: MessageEvent) => {
    const data = JSON.parse(msg.data);
    const scopes = Array.isArray(data.scope) ? data.scope : [data.scope];
    callback(scopes);
  };

  watchEffect(() => {
    if (!spaceId.value) {
      return () => {};
    }

    if (!api.socketHost) {
      throw new Error("provide a socketHost in options");
    }

    let activeSocket: WebSocket | null = null;
    api.connectToSocket(api.socketHost, spaceId?.value).then((socket) => {
      activeSocket = socket;
      socket.addEventListener("message", internalCallback);
    });

    return () => {
      if (activeSocket) {
        activeSocket.removeEventListener("message", internalCallback);
      }
    };
  });
}
