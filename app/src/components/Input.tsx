import { createSignal, mergeProps } from "solid-js";

interface Props {
  placeholder?: string;
  /** Two-way bound value. */
  value?: string;
  type?: string;
  disabled?: boolean;
  onInput?: (value: string) => void;
}

export function Input(props: Props) {
  const merged = mergeProps(
    { placeholder: "Placeholder", value: "", type: "text", disabled: false },
    props,
  );
  const [isFocused, setIsFocused] = createSignal(false);

  return (
    <div class="inline-flex w-full rounded-md bg-neutral-100 p-[4px]">
      <div
        class="relative flex h-[36px] w-full items-center rounded-sm border bg-background px-xs transition-colors"
        classList={{
          "border-black/15": !isFocused(),
          "border-primary-500": isFocused(),
        }}
      >
        <input
          value={merged.value}
          placeholder={merged.placeholder}
          type={merged.type}
          disabled={merged.disabled}
          onInput={(event) => merged.onInput?.(event.currentTarget.value)}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          class="w-full bg-transparent font-normal text-[14px] outline-none placeholder:opacity-30 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
    </div>
  );
}
