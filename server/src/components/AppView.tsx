interface Props {
  html?: string;
}

export function AppView(props: Props) {
  return (
    <iframe
      title="Document preview"
      srcdoc={props.html ?? ""}
      sandbox="allow-scripts allow-forms allow-modals allow-popups"
      class="block w-full border-none"
      style={{ height: "calc(100vh - 60px)" }}
    />
  );
}
