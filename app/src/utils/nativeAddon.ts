interface NativeAddonExportOptions {
  addonName: string;
  exportName: string;
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

export function getNativeAddonExport<T>(
  nativeModule: unknown,
  options: NativeAddonExportOptions,
): T {
  const nativeExport = readProperty(nativeModule, options.exportName);
  const requiredFunction = readProperty(nativeExport, options.requiredFunction);

  if (typeof requiredFunction !== "function") {
    const message =
      `Native ${options.addonName} addon export does not expose ` +
      `${options.requiredFunction}()`;
    throw new TypeError(
      message,
      {
        cause: {
          platform: process.platform,
          architecture: process.arch,
          bunVersion: process.versions.bun,
          napiVersion: process.versions.napi,
          compiled: options.moduleUrl.startsWith("file:///$bunfs/"),
          moduleUrl: options.moduleUrl,
          exportName: options.exportName,
          requiredFunction: options.requiredFunction,
          moduleType: valueType(nativeModule),
          moduleProperties: ownPropertyNames(nativeModule),
          moduleRequiredFunctionType: valueType(
            readProperty(nativeModule, options.requiredFunction),
          ),
          nativeExportType: valueType(nativeExport),
          nativeExportProperties: ownPropertyNames(nativeExport),
          nativeExportRequiredFunctionType: valueType(requiredFunction),
        },
      },
    );
  }

  return nativeExport as T;
}
