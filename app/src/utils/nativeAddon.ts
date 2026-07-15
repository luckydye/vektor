interface NativeAddonOptions {
  addonName: string;
  requiredFunction: string;
  moduleUrl: string;
}

function valueType(value: unknown): string {
  return value === null ? "null" : typeof value;
}

function ownPropertyNames(value: unknown): string[] {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return [];
  }

  try {
    return Object.getOwnPropertyNames(value).sort();
  } catch {
    return ["<unavailable>"];
  }
}

function readProperty(value: unknown, property: string): unknown {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return undefined;
  }

  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

export function getNativeAddon<T>(
  nativeModule: unknown,
  options: NativeAddonOptions,
): T {
  const requiredFunction = readProperty(nativeModule, options.requiredFunction);

  if (typeof requiredFunction !== "function") {
    throw new TypeError(
      `Native ${options.addonName} addon does not expose ${options.requiredFunction}()`,
      {
        cause: {
          platform: process.platform,
          architecture: process.arch,
          bunVersion: process.versions.bun,
          napiVersion: process.versions.napi,
          compiled: options.moduleUrl.startsWith("file:///$bunfs/"),
          moduleUrl: options.moduleUrl,
          requiredFunction: options.requiredFunction,
          moduleType: valueType(nativeModule),
          moduleProperties: ownPropertyNames(nativeModule),
          moduleRequiredFunctionType: valueType(requiredFunction),
        },
      },
    );
  }

  return nativeModule as T;
}
