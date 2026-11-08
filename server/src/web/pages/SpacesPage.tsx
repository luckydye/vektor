import type { ComponentProps } from "solid-js";
import { SpacesApp } from "#components/SpacesApp.tsx";

export type SpacesPageProps = ComponentProps<typeof SpacesApp>;

export function SpacesPage(props: SpacesPageProps) {
  return <SpacesApp {...props} />;
}
