/** Names a group of nav rows on mobile, where the drawer reads like a native list. */
export function SectionLabel(props: { text: string }) {
  return (
    <span class="block px-3xs pt-4xs pb-5xs font-medium text-neutral-500 text-size-extra-small uppercase tracking-wide md:hidden">
      {props.text}
    </span>
  );
}
