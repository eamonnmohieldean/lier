/**
 * Lier — multi-provider API client
 * Supports: Imagen 3 (Google), FLUX.1 Fill Pro (fal.ai), FLUX.1 Kontext Pro (fal.ai)
 */

// ── Dispatcher ────────────────────────────────────────────────────────────────

async function callAPI(provider, apiKey, prompt, imageBase64, maskBase64, editMode) {
  switch (provider) {
    case "imagen3":     return callImagen3(apiKey, prompt, imageBase64, maskBase64, editMode);
    case "fluxFill":    return callFluxFill(apiKey, prompt, imageBase64, maskBase64);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

// ── Imagen 3 (Google Vertex AI / AI Studio) ───────────────────────────────────
// Docs: https://cloud.google.com/vertex-ai/generative-ai/docs/image/edit-insert-objects

const IMAGEN_MODEL = "imagen-3.0-capability-001";

async function callImagen3(apiKey, prompt, imageBase64, maskBase64, editMode) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGEN_MODEL}:predict?key=${apiKey}`;

  const instance = {
    prompt,
    image: { bytesBase64Encoded: imageBase64 },
  };
  if (maskBase64) {
    instance.mask = { image: { bytesBase64Encoded: maskBase64 } };
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [instance],
      parameters: { sampleCount: 1, editMode },
    }),
  });

  if (!resp.ok) {
    let msg = `Imagen 3 error ${resp.status}`;
    try { const e = await resp.json(); msg = e.error?.message || msg; } catch (_) {}
    throw new Error(msg);
  }

  const json = await resp.json();
  if (!json.predictions?.[0]) throw new Error("No prediction returned from Imagen 3.");
  return json.predictions[0].bytesBase64Encoded;
}

// ── FLUX.1 Fill Pro (fal.ai) — mask-based inpainting ─────────────────────────
// Docs: https://fal.ai/models/fal-ai/flux-pro/v1/fill

async function callFluxFill(apiKey, prompt, imageBase64, maskBase64) {
  const resp = await fetch("https://fal.run/fal-ai/flux-pro/v1/fill", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Key ${apiKey}`,
    },
    body: JSON.stringify({
      image_url: `data:image/png;base64,${imageBase64}`,
      mask_url:  `data:image/png;base64,${maskBase64}`,
      prompt,
      num_images:    1,
      output_format: "png",
      sync_mode:     true,
    }),
  });

  if (!resp.ok) {
    let msg = `FLUX Fill error ${resp.status}`;
    try { const e = await resp.json(); msg = e.detail || e.message || msg; } catch (_) {}
    throw new Error(msg);
  }

  const json = await resp.json();
  if (!json.images?.[0]?.url) throw new Error("No image returned from FLUX.1 Fill.");

  // fal.ai returns a CDN URL — fetch and convert to base64
  const imgResp = await fetch(json.images[0].url);
  if (!imgResp.ok) throw new Error(`Failed to fetch result image (${imgResp.status})`);
  return blobToBase64(await imgResp.blob());
}

// ── FLUX.1 Kontext Pro (fal.ai) — full image instruction editing ──────────────
// Docs: https://fal.ai/models/fal-ai/flux-pro/kontext

async function callFluxKontext(apiKey, prompt, imageBase64) {
  const resp = await fetch("https://fal.run/fal-ai/flux-pro/kontext", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Key ${apiKey}`,
    },
    body: JSON.stringify({
      image_url:     `data:image/png;base64,${imageBase64}`,
      prompt,
      num_images:    1,
      output_format: "png",
      sync_mode:     true,
    }),
  });

  if (!resp.ok) {
    let msg = `FLUX Kontext error ${resp.status}`;
    try { const e = await resp.json(); msg = e.detail || e.message || msg; } catch (_) {}
    throw new Error(msg);
  }

  const json = await resp.json();
  if (!json.images?.[0]?.url) throw new Error("No image returned from FLUX.1 Kontext.");

  const imgResp = await fetch(json.images[0].url);
  if (!imgResp.ok) throw new Error(`Failed to fetch result image (${imgResp.status})`);
  return blobToBase64(await imgResp.blob());
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror  = reject;
    reader.readAsDataURL(blob);
  });
}
