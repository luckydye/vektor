import { initTelemetry, shutdownTelemetry } from "./otel.ts";

initTelemetry();

process.once("SIGINT", () => {
  void shutdownTelemetry();
});

process.once("SIGTERM", () => {
  void shutdownTelemetry();
});
