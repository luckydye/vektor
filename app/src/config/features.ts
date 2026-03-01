import { config } from "../config.ts";

interface FeatureFlags {
  /** Enable canvas/whiteboard document type using tldraw */
  canvas: boolean;
}

const appConfig = config();

// Parse boolean from environment variable
function getEnvBoolean(key: string, defaultValue: boolean = false): boolean {
  const value = appConfig[key as unknown as keyof typeof appConfig];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  return value === "true" || value === "1" || value === "yes";
}

export const features: FeatureFlags = {
  canvas: getEnvBoolean("FEATURE_CANVAS", false),
};

// Export individual flags for convenience
export const FEATURE_CANVAS = features.canvas;
