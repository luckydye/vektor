import { run } from "./src/process.ts";

const linux = process.argv.includes("--linux");
const output = linux ? "dist/vektor-host-linux-x64" : "dist/vektor-host";
await run(
  [
    process.execPath,
    "build",
    "--compile",
    ...(linux ? ["--target=bun-linux-x64"] : []),
    "src/cli.ts",
    "--outfile",
    output,
  ],
  { stream: true },
);
if (!linux && process.platform === "darwin") {
  // Match the app build: re-sign Bun's compiled Mach-O before macOS launches it.
  await run(["codesign", "--sign", "-", "--force", output], { stream: true });
}
