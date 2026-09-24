import { sanitizeSvgMarkup } from "./html.ts";

const MAX_IMAGE_BYTES = 300 * 1024;
const IMAGE_TYPES = ["image/svg+xml", "image/png", "image/jpeg"];

function blobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read image file"));
    reader.readAsDataURL(blob);
  });
}

export async function imageFileAsDataUrl(file: File): Promise<string> {
  if (!IMAGE_TYPES.includes(file.type)) {
    throw new Error("Only SVG, PNG, and JPG files are supported");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error("Image file must be smaller than 300 KB");
  }

  if (file.type !== "image/svg+xml") return await blobAsDataUrl(file);

  const svg = sanitizeSvgMarkup(await file.text());
  if (!svg) throw new Error("That file is not an SVG image");
  return await blobAsDataUrl(new Blob([svg], { type: "image/svg+xml" }));
}
