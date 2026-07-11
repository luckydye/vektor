export interface EmbeddedModelLicense {
  name: string;
  source: string;
  text: string;
}

/**
 * Generate normalized dense vectors with Vektor's embedded ONNX model.
 * Initialization and inference run on N-API's worker pool.
 */
export function embed(texts: string[]): Promise<number[][]>;

/** Licenses included in the embedded native addon. */
export function embeddedModelLicenses(): EmbeddedModelLicense[];
