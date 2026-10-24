import { parseSSE } from "#api/provider/utils.ts";

export const generateImageTool = {
  type: "function",
  function: {
    name: "generate_image",
    description:
      "Generate an image from a text prompt with ChatGPT and upload it to the space. " +
      "Returns the upload's url; embed it in a document or show it to the user with markdown ![alt](url).",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed description of the image." },
        size: {
          type: "string",
          enum: ["1024x1024", "1536x1024", "1024x1536", "auto"],
          description: "Image dimensions (default auto).",
        },
      },
      required: ["prompt"],
    },
  },
};

/** Where the model API lives and who pays: the ChatGPT integration's provider. */
export type ImageGenerationProvider = {
  url: string;
  model: string;
  accessToken: () => Promise<string>;
};

/** Runs the Responses API's built-in `image_generation` tool and returns the PNG as base64. */
export async function generateImage(
  provider: ImageGenerationProvider,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const { prompt, size = "auto" } = args as { prompt: unknown; size?: unknown };
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error('generate_image "prompt" must be a non-empty string.');
  }
  if (typeof size !== "string") {
    throw new Error('generate_image "size" must be a string.');
  }

  const response = await fetch(provider.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await provider.accessToken()}`,
    },
    body: JSON.stringify({
      model: provider.model,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      tools: [{ type: "image_generation", size, output_format: "png" }],
      tool_choice: { type: "image_generation" },
      stream: true,
      store: false,
    }),
    signal,
    // Following a redirect would re-send the bearer token wherever it points.
    redirect: "manual",
  });
  if (!response.ok || !response.body) {
    throw new Error(`chatgpt ${response.status}: ${await response.text()}`);
  }

  let image: string | undefined;
  for await (const chunk of parseSSE(response.body)) {
    const item = chunk.item as { type?: string; result?: unknown } | undefined;
    if (
      chunk.type === "response.output_item.done" &&
      item?.type === "image_generation_call" &&
      typeof item.result === "string"
    ) {
      image = item.result;
    }
  }
  if (!image) throw new Error("ChatGPT returned no image.");
  return image;
}
