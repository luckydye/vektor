interface Props {
  date: string;
  greeting: string;
  name?: string;
}

export function SpaceHomeHeadline(props: Props) {
  return (
    <header class="pt-4xs md:pt-s">
      <p class="mb-3 font-semibold text-green-800 text-size-small uppercase tracking-[0.12em] dark:text-green-300">
        {props.date}
      </p>
      <h1 class="max-w-[22ch] font-normal font-serif text-neutral-900 text-size-hero leading-hero tracking-[-0.035em] dark:text-neutral-900">
        {props.greeting}
        {props.name ? `, ${props.name}` : ""}.
      </h1>
    </header>
  );
}
