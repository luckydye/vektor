interface Props {
  html?: string;
}

export function AppView(props: Props) {
  return (
    <iframe
      title="Document preview"
      srcdoc={props.html ?? ""}
      sandbox="allow-scripts allow-forms allow-modals allow-popups"
      class="block h-full min-h-0 w-full flex-1 self-stretch border-none"
    />
  );
}
