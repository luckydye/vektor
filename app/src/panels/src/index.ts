import "./panel-manager.ts";
import type { PanelHostElement } from "./panel-manager.ts";

const host = document.querySelector("panel-host") as PanelHostElement;

// Wire log
host.on("layout-changed", ({ state }) => {
  const out = document.getElementById("state");
  if (out) out.textContent = JSON.stringify(state, null, 2);
});

// Open the declared panels at startup.
host.open("inspector", { preferredDock: "right-sidebar" });
host.open("tools", { preferredDock: "left-sidebar" });
host.open("color-picker", {
  placement: { x: 160, y: 100, width: 260, height: 200 },
});

// Demo buttons
document.getElementById("toggle-inspector")?.addEventListener("click", () => {
  const s = host.getState().panels["inspector"];
  if (!s || s.visibility !== "open")
    host.open("inspector", { preferredDock: "right-sidebar" });
  else host.hide("inspector");
});
document
  .getElementById("float-tools")
  ?.addEventListener("click", () =>
    host.float("tools", { x: 80, y: 80, width: 240, height: 320 }),
  );
document
  .getElementById("dock-tools")
  ?.addEventListener("click", () => host.dock("tools", "left-sidebar"));
document.getElementById("open-histogram")?.addEventListener("click", () =>
  host.open("histogram", {
    title: "Histogram",
    placement: { x: 300, y: 200, width: 280, height: 180 },
  }),
);
const debugBox = document.getElementById("toggle-debug") as HTMLInputElement | null;
debugBox?.addEventListener("change", () => host.setDebug(!!debugBox.checked));
