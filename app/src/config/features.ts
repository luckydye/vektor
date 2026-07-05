import { config } from "#config";

const appConfig = config();

// Parse boolean from environment variable
function _getEnvBoolean(key: string, defaultValue: boolean = false): boolean {
  const value = appConfig[key as unknown as keyof typeof appConfig];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  return value === "true" || value === "1" || value === "yes";
}
