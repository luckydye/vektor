import { BadgeEditor } from "./BadgeEditor.tsx";
import { CategoryBadge } from "./CategoryBadge.tsx";

interface Props {
  name: string;
  color: string;
  icon: string;
  onUpdateColor?: (value: string) => void;
  onUpdateIcon?: (value: string) => void;
}

/**
 * The category's badge as the sidebar shows it. Its `icon` holds either short
 * text or an uploaded image (the same files as a space logo).
 */
export function CategoryAppearance(props: Props) {
  const isImageIcon = () => props.icon.startsWith("data:image/");

  return (
    <BadgeEditor
      preview={
        <CategoryBadge
          category={{ name: props.name || "?", color: props.color, icon: props.icon }}
          class="h-full w-full rounded-lg text-size-large ring-1 ring-(--control-border) ring-inset"
        />
      }
      image={isImageIcon() ? props.icon : ""}
      onUpdateImage={(image) => props.onUpdateIcon?.(image)}
      text={{
        value: props.icon,
        placeholder: (props.name || "?")[0].toUpperCase(),
        onUpdate: (text) => props.onUpdateIcon?.(text),
      }}
      color={props.color}
      allowTransparent
      onUpdateColor={(color) => props.onUpdateColor?.(color)}
    />
  );
}
