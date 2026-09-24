import { createMemo, createSignal, For, Show } from "solid-js";
import { canonicalPropertyKey } from "#documents/properties.ts";
import {
  formatFilterTerm,
  type QuerySegment,
  type QueryTerm,
  termAtCaret,
} from "#search/query.ts";

/** A property in the space, as the filter completions read it. */
export interface QueryProperty {
  name: string;
  values: string[];
}

interface Props {
  value: string;
  segments: QuerySegment[];
  properties: QueryProperty[];
  placeholder?: string;
  onInput: (value: string) => void;
  onEnter?: () => void;
}

/* The input's own text is invisible and the painted copy sits under it, so the
 * two have to lay out identically: every metric-affecting class belongs here,
 * and the highlight spans may only add colour. */
const FIELD =
  "w-full rounded-lg border border-transparent py-3 pr-12 pl-12 text-base leading-normal";

const SEGMENT_CLASS: Record<QuerySegment["kind"], string> = {
  text: "text-neutral-900",
  key: "rounded-l bg-primary-50 font-medium text-primary-700",
  separator: "bg-primary-50 text-primary-400",
  value: "rounded-r bg-primary-50 text-primary-900",
};

/** How many completions are offered at once; the rest are typed towards. */
const MAX_COMPLETIONS = 6;

interface Completion {
  /** What the term becomes. */
  term: string;
  key: string;
  value?: string;
}

/**
 * The search box, with the `key:value` filter terms in the query tinted apart
 * from the words being searched for, and the space's own properties offered as
 * completions while one is being typed.
 *
 * A real `<input>` keeps the caret, selection and IME behaviour; the colours
 * come from a copy of the text rendered behind it and scrolled in step. Renders
 * both without a wrapper: the parent positions the field, and has to be
 * `relative` for the painted copy to land on the input.
 */
export function SearchQueryInput(props: Props) {
  let mirror: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;

  const [caret, setCaret] = createSignal(0);
  const [focused, setFocused] = createSignal(false);
  // Nothing is preselected: Enter runs the search until the reader has stepped
  // into the list, so the key that submits never changes meaning under them.
  const [highlighted, setHighlighted] = createSignal(-1);
  const [dismissed, setDismissed] = createSignal(false);

  // The caret can also be moved past the edge by the keyboard, and Safari does
  // not always report that as a scroll, so the offset is taken on every event.
  const sync = (target: HTMLInputElement) => {
    if (mirror) mirror.scrollLeft = target.scrollLeft;
    setCaret(target.selectionStart ?? target.value.length);
  };

  const term = createMemo<QueryTerm | null>(() =>
    focused() ? termAtCaret(props.value, caret()) : null,
  );

  const completions = createMemo<Completion[]>(() => {
    const current = term();
    if (dismissed() || !current) return [];
    const typed = current.typed.toLowerCase();

    // A plain word could be either half of a search, so the keys stay quiet
    // until what is typed actually names one.
    if (current.key === null) {
      if (typed.length === 0) return [];
      return props.properties
        .filter((property) => property.name.toLowerCase().startsWith(typed))
        .slice(0, MAX_COMPLETIONS)
        .map((property) => ({ term: `${property.name}:`, key: property.name }));
    }

    const property = props.properties.find(
      (candidate) =>
        canonicalPropertyKey(candidate.name) === canonicalPropertyKey(current.key ?? ""),
    );
    if (!property) return [];
    return property.values
      .filter((value) => value.toLowerCase().startsWith(typed))
      .slice(0, MAX_COMPLETIONS)
      .map((value) => ({
        term: formatFilterTerm(property.name, value),
        key: property.name,
        value,
      }));
  });

  const apply = (completion: Completion) => {
    const current = term();
    if (!current || !input) return;
    const next =
      props.value.slice(0, current.start) +
      completion.term +
      props.value.slice(current.end);
    props.onInput(next);
    setHighlighted(-1);

    // The caret lands after what was inserted, so a key completion leaves the
    // reader typing its value and a value completion leaves them at the end.
    const position = current.start + completion.term.length;
    input.value = next;
    input.setSelectionRange(position, position);
    setCaret(position);
    input.focus();
  };

  const onKeyDown = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    const list = completions();

    if (event.key === "Escape" && list.length > 0) {
      event.preventDefault();
      setDismissed(true);
      setHighlighted(-1);
      return;
    }

    if (event.key === "ArrowDown" && list.length > 0) {
      event.preventDefault();
      setHighlighted((index) => (index + 1) % list.length);
      return;
    }

    if (event.key === "ArrowUp" && list.length > 0) {
      event.preventDefault();
      setHighlighted((index) => (index <= 0 ? list.length - 1 : index - 1));
      return;
    }

    // Tab completes the first match without a trip through the list, the way a
    // shell does; Enter only completes what the reader has stepped onto.
    if (event.key === "Tab" && list.length > 0 && !event.shiftKey) {
      event.preventDefault();
      apply(list[Math.max(highlighted(), 0)]);
      return;
    }

    if (event.key === "Enter") {
      const selected = list[highlighted()];
      if (selected) {
        event.preventDefault();
        apply(selected);
        return;
      }
      props.onEnter?.();
    }
  };

  return (
    <>
      <div
        ref={mirror}
        aria-hidden="true"
        class={`${FIELD} pointer-events-none absolute inset-0 overflow-hidden whitespace-pre`}
      >
        <For each={props.segments}>
          {(segment) => <span class={SEGMENT_CLASS[segment.kind]}>{segment.text}</span>}
        </For>
      </div>

      <input
        ref={input}
        value={props.value}
        onInput={(event) => {
          props.onInput(event.currentTarget.value);
          setDismissed(false);
          setHighlighted(-1);
          sync(event.currentTarget);
        }}
        onScroll={(event) => sync(event.currentTarget)}
        onKeyUp={(event) => sync(event.currentTarget)}
        onClick={(event) => sync(event.currentTarget)}
        onFocus={(event) => {
          setFocused(true);
          sync(event.currentTarget);
        }}
        /* Late enough for a click on a completion to land first. */
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        type="text"
        placeholder={props.placeholder}
        spellcheck={false}
        autocapitalize="off"
        autocorrect="off"
        autocomplete="off"
        role="combobox"
        aria-expanded={completions().length > 0}
        aria-autocomplete="list"
        /* Transparent text over the painted copy; the selection keeps a
           background so a drag is still visible through it. */
        class={`${FIELD} relative border-neutral-100 bg-transparent text-transparent caret-neutral-900 selection:bg-primary-100 placeholder:text-neutral-400 focus:border-primary-300 focus:outline-none focus:ring-2 focus:ring-primary-100`}
        onKeyDown={onKeyDown}
      />

      <Show when={completions().length > 0}>
        {/* Left-aligned with the text rather than the field, so a completion
            sits under the term it would replace. */}
        <div class="absolute top-full left-11 z-20 mt-1 w-64 overflow-hidden rounded-lg border border-neutral-100 bg-background py-1 shadow-large">
          <For each={completions()}>
            {(completion, index) => (
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(event) => {
                  event.preventDefault();
                  apply(completion);
                }}
                onMouseEnter={() => setHighlighted(index())}
                class="flex w-full items-baseline gap-1 px-3 py-1.5 text-left text-size-small"
                classList={{
                  "bg-primary-50": highlighted() === index(),
                  "hover:bg-primary-50": highlighted() !== index(),
                }}
              >
                <span class="truncate font-medium text-primary-700">
                  {completion.key}:
                </span>
                <Show when={completion.value}>
                  <span class="truncate text-neutral-700">{completion.value}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}
