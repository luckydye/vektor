import { Show } from "solid-js";
import { BadgeEditor } from "./BadgeEditor.tsx";

interface Props {
  name: string;
  brandColor: string;
  /** The uploaded logo as a data URL, or empty. */
  logo: string;
  onUpdateBrandColor?: (value: string) => void;
  onUpdateLogo?: (value: string) => void;
}

/** The space's logo tile, as the space selector shows it. */
export function SpaceAppearance(props: Props) {
  return (
    <BadgeEditor
      preview={
        <div
          class="flex h-full w-full items-center justify-center overflow-hidden rounded-lg ring-1 ring-(--control-border) ring-inset"
          // `background-color`, not the `background` shorthand: the shorthand
          // also accepts `url()`, which turns a brand colour into a request.
          style={{ "background-color": props.brandColor }}
        >
          <Show
            when={props.logo}
            fallback={
              <span class="select-none font-bold text-size-large text-white">
                {(props.name || "?")[0].toUpperCase()}
              </span>
            }
          >
            <img src={props.logo} alt="" class="h-full w-full object-cover" />
          </Show>
        </div>
      }
      image={props.logo}
      onUpdateImage={(logo) => props.onUpdateLogo?.(logo)}
      color={props.brandColor}
      onUpdateColor={(color) => props.onUpdateBrandColor?.(color)}
    />
  );
}
