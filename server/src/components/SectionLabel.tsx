/** Names a group of nav rows; the collapsed sidebar has no room for it. */
export function SectionLabel(props: { text: string }) {
  return (
    <span class="@max-xs:hidden block px-3xs pt-4xs pb-4xs font-medium text-neutral-500 text-size-extra-small uppercase tracking-wide">
      {props.text}
    </span>
  );
}
