/**
 * Imagen 3 inpainting via Google AI Studio
 * Docs: https://ai.google.dev/api/generate-content
 */

const IMAGEN_MODEL = "imagen-3.0-capability-001";

/**
 * @param {string} apiKey
 * @param {string} prompt
 * @param {string} imageBase64  - PNG, base64 encoded
 * @param {string|null} maskBase64   - Grayscale PNG mask (white = inpaint), base64 encoded
 * @param {string} editMode     - "inpainting-insert" | "inpainting-remove" | "outpainting"
 * @returns {Promise<string>}   - Result image as base64 PNG
 */
async function callImagen3(apiKey, prompt, imageBase64, maskBase64, editMode) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGEN_MODEL}:predict?key=${apiKey}`;

  const instance = {
    prompt,
    image: { bytesBase64Encoded: imageBase64 },
  };

  if (maskBase64) {
    instance.mask = { image: { bytesBase64Encoded: maskBase64 } };
  }

  const body = {
    instances: [instance],
    parameters: {
      sampleCount: 1,
      editMode,
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let msg = `API error ${resp.status}`;
    try {
      const err = await resp.json();
      msg = err.error?.message || msg;
    } catch (_) {}
    throw new Error(msg);
  }

  const json = await resp.json();

  if (!json.predictions || !json.predictions[0]) {
    throw new Error("No predictions returned from Imagen 3.");
  }

  return json.predictions[0].bytesBase64Encoded;
}
