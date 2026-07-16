export const RESPONSE_PREVIEW_MAX_BYTES = 1_048_576 as const;
export const RESPONSE_TEXT_STAGING_MAX_BYTES = 5_242_880 as const;
export const RESPONSE_JSON_MAX_NODES = 5_000 as const;
export const RESPONSE_JSON_MAX_DEPTH = 64 as const;
export const RESPONSE_IMAGE_MAX_PIXELS = 16_000_000 as const;
export const RESPONSE_PROGRESS_MAX_HZ = 10 as const;

export const RESPONSE_LIMITS = Object.freeze({
  previewBytes: RESPONSE_PREVIEW_MAX_BYTES,
  textStagingBytes: RESPONSE_TEXT_STAGING_MAX_BYTES,
  jsonNodes: RESPONSE_JSON_MAX_NODES,
  jsonDepth: RESPONSE_JSON_MAX_DEPTH,
  imagePixels: RESPONSE_IMAGE_MAX_PIXELS,
  ipcProgressHz: RESPONSE_PROGRESS_MAX_HZ,
});
