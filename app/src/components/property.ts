export type PropertyType = "text" | "select" | "multi-select" | "date" | "user";

export interface Property {
  id: string;
  name: string;
  type: PropertyType;
  value?: string | string[];
}

export interface SpaceProperty {
  name: string;
  type: string | null;
  values: string[];
}
