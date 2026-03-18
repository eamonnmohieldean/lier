/**
 * Lier — multi-provider API client
 *
 * Providers:
 *   Edit/Inpaint : imagen3, fluxFill, fluxKontext
 *   Upscale      : clarityUpscaler, auraSR
 *   Denoise      : nafnetDenoise
 */

// ── Dispatcher ────────────────────────────────────────────────────────────────

async function callAPI(provider, apiKey, prompt, imageBase64, maskBase64, editMode, opts) {
  switch (provider) {
    case "imagen3":         return callImagen3(apiKey, prompt, imageBase64, maskBase64, editMode);
    case "fluxFill":        return callFluxFill(apiKey, prompt, imageBase64, maskBase64);
    case "fluxKontext":     return callFluxKontext(apiKey, prompt, imageBase64);
    case "clarityUpscaler": return callClarityUpscaler(apiKey, imageBase64, opts.scale);
    case "auraSR":          return callAuraSR(apiKey, imageBase64);
    case "nafnetDenoise":   return callNAFNetDenoise(apiKey, imageBase64);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

// ── Imagen 3 — Mask Inpainting (Google) ───────────────────────────────────────
async function callImagen3(apiKey, prompt, imageBase64, maskBase64, editMode) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-capability-001:predict?key=${apiKey}`;

  const instance = { prompt, image: { bytesBase64Encoded: imageBase64 } };
  if (maskBase64) instance.mask = { image: { bytesBase64Encoded: maskBase64 } };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances:  [instance],
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

// ── FLUX.1 Fill Pro — Mask Inpainting (fal.ai) ────────────────────────────────
async function callFluxFill(apiKey, prompt, imageBase64, maskBase64) {
  const resp = await fetch("https://fal.run/fal-ai/flux-pro/v1/fill", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Key ${apiKey}` },
    body: JSON.stringify({
      image_url:     `data:image/png;base64,${imageBase64}`,
      mask_url:      `data:image/png;base64,${maskBase64}`,
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
  return fetchUrlToBase64(json.images[0].url);
}

// ── FLUX.1 Kontext Pro — Full Image Edit (fal.ai) ─────────────────────────────
async function callFluxKontext(apiKey, prompt, imageBase64) {
  const resp = await fetch("https://fal.run/fal-ai/flux-pro/kontext", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Key ${apiKey}` },
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
  return fetchUrlToBase64(json.images[0].url);
}

// ── Clarity Upscaler (fal.ai) ─────────────────────────────────────────────────
// Defaults tuned for architectural CGI: high resemblance, minimal hallucination.
async function callClarityUpscaler(apiKey, imageBase64, scaleFactor = 2) {
  const resp = await fetch("https://fal.run/fal-ai/clarity-upscaler", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Key ${apiKey}` },
    body: JSON.stringify({
      image_url:          `data:image/png;base64,${imageBase64}`,
      scale_factor:       scaleFactor,
      creativity:         0.15,   // low — don't invent new geometry
      detail:             1.0,    // preserve fine architectural lines
      shape_preservation: 0.6,
      resemblance:        0.9,    // stay close to input
      guidance_scale:     4,
      num_inference_steps: 20,
      output_format:      "png",
      sync_mode:          true,
    }),
  });

  if (!resp.ok) {
    let msg = `Clarity Upscaler error ${resp.status}`;
    try { const e = await resp.json(); msg = e.detail || e.message || msg; } catch (_) {}
    throw new Error(msg);
  }

  const json = await resp.json();
  // Clarity returns { image: { url } }
  const url = json.image?.url;
  if (!url) throw new Error("No image returned from Clarity Upscaler.");
  return fetchUrlToBase64(url);
}

// ── AuraSR 4× Upscaler (fal.ai) ──────────────────────────────────────────────
async function callAuraSR(apiKey, imageBase64) {
  const resp = await fetch("https://fal.run/fal-ai/aura-sr", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Key ${apiKey}` },
    body: JSON.stringify({
      image_url:        `data:image/png;base64,${imageBase64}`,
      upscaling_factor: 4,
      overlapping_tiles: true,   // better quality at tile boundaries
      output_format:    "png",
      sync_mode:        true,
    }),
  });

  if (!resp.ok) {
    let msg = `AuraSR error ${resp.status}`;
    try { const e = await resp.json(); msg = e.detail || e.message || msg; } catch (_) {}
    throw new Error(msg);
  }

  const json = await resp.json();
  const url = json.image?.url;
  if (!url) throw new Error("No image returned from AuraSR.");
  return fetchUrlToBase64(url);
}

// ── NAFNet Denoise (fal.ai) ───────────────────────────────────────────────────
async function callNAFNetDenoise(apiKey, imageBase64) {
  const resp = await fetch("https://fal.run/fal-ai/nafnet/denoise", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Key ${apiKey}` },
    body: JSON.stringify({
      image_url: `data:image/png;base64,${imageBase64}`,
      sync_mode: true,
    }),
  });

  if (!resp.ok) {
    let msg = `NAFNet error ${resp.status}`;
    try { const e = await resp.json(); msg = e.detail || e.message || msg; } catch (_) {}
    throw new Error(msg);
  }

  const json = await resp.json();
  const url = json.image?.url;
  if (!url) throw new Error("No image returned from NAFNet.");
  return fetchUrlToBase64(url);
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function fetchUrlToBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch result image (${resp.status})`);
  return blobToBase64(await resp.blob());
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror  = reject;
    reader.readAsDataURL(blob);
  });
}
