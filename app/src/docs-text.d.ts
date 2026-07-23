// The `#docs/*.md` alias is ambiently typed as an Astro component (for the
// rendered /docs pages). These exact-path overrides take precedence over that
// wildcard so `with { type: "text" }` imports of the same files type as
// plain strings, matching what Bun actually loads at runtime.
declare module "#docs/api.md" {
  const content: string;
  // biome-ignore lint/style/noDefaultExport: matches the runtime module shape
  export default content;
}
declare module "#docs/extensions.md" {
  const content: string;
  // biome-ignore lint/style/noDefaultExport: matches the runtime module shape
  export default content;
}
