/* global require */
const { app, core, imaging, action } = require("photoshop");
const { storage } = require("uxp");

// ── UI refs ───────────────────────────────────────────────────────────────────
const providerEl      = document.getElementById("apiProvider");
const infoBarEl       = document.getElementById("infoBar");
const apiKeyLabelEl   = document.getElementById("apiKeyLabel");
const apiKeyEl        = document.getElementById("apiKey");
const apiKeyHintEl    = document.getElementById("apiKeyHint");
const promptRowEl     = document.getElementById("promptRow");
const promptEl        = document.getElementById("prompt");
const editModeRowEl   = document.getElementById("editModeRow");
const editModeEl      = document.getElementById("editMode");
const scaleFactorRowEl= document.getElementById("scaleFactorRow");
const scaleFactorEl   = document.getElementById("scaleFactor");
const actionBtn       = document.getElementById("actionBtn");
const statusEl        = document.getElementById("status");

// ── Provider configs ──────────────────────────────────────────────────────────
// operation: "edit" | "upscale" | "denoise"
// maxInputPx: cap applied when reading pixels from Photoshop before sending
//   - edit:   downsample to fit model's generation size
//   - upscale/denoise: send at native resolution, cap only if canvas is huge
// nativeResultSize: true = place result at its own pixel dimensions (upscale)
//                   false = stretch result back to canvas size (edit/denoise)
const PROVIDERS = {
  // ── Edit / Inpaint ──────────────────────────────────────────────────────────
  imagen3: {
    operation: "edit",
    keyLabel:  "Google AI Studio / Vertex AI Key",
    keyPlaceholder: "AIza...",
    keyHint:   "console.cloud.google.com → Vertex AI → Imagen",
    maxInputPx: 1536,
    needsMask:  true,
    btnLabel:  "Inpaint Selection",
    nativeResultSize: false,
    info: [
      "<b>Imagen 3 — Mask Inpainting</b>",
      "Max input: 1536 × 1536 px &nbsp;·&nbsp; AI generates at ~1 K, blended back to canvas",
      "Cost: $0.02 / image edit",
    ],
  },
  fluxFill: {
    operation: "edit",
    keyLabel:  "fal.ai API Key",
    keyPlaceholder: "fal_...",
    keyHint:   "fal.ai/dashboard → API Keys",
    maxInputPx: 2048,
    needsMask:  true,
    btnLabel:  "Inpaint Selection",
    nativeResultSize: false,
    info: [
      "<b>FLUX.1 Fill Pro — Mask Inpainting</b>",
      "Max input: 2048 × 2048 px &nbsp;·&nbsp; Cost: $0.05 / megapixel",
      "Best-in-class inpainting quality",
    ],
  },
  fluxKontext: {
    operation: "edit",
    keyLabel:  "fal.ai API Key",
    keyPlaceholder: "fal_...",
    keyHint:   "fal.ai/dashboard → API Keys &nbsp;·&nbsp; No selection needed",
    maxInputPx: 2048,
    needsMask:  false,
    btnLabel:  "Edit Full Image",
    nativeResultSize: false,
    info: [
      "<b>FLUX.1 Kontext Pro — Full Image Edit</b>",
      "Max input: 2048 × 2048 px &nbsp;·&nbsp; Cost: $0.04 / image",
      "No mask needed — rewrites whole image from a text instruction",
    ],
  },

  // ── Upscale ─────────────────────────────────────────────────────────────────
  clarityUpscaler: {
    operation: "upscale",
    keyLabel:  "fal.ai API Key",
    keyPlaceholder: "fal_...",
    keyHint:   "fal.ai/dashboard → API Keys",
    maxInputPx: 2048,  // send at native res, cap at 2 K input
    needsMask:  false,
    btnLabel:  "Upscale Document",
    nativeResultSize: true,
    info: [
      "<b>Clarity Upscaler — 2× or 4×</b>",
      "Max input: 2048 × 2048 px &nbsp;·&nbsp; 2× output: up to 4096 × 4096 px",
      "Tuned for CGI / arch: high resemblance, low hallucination &nbsp;·&nbsp; $0.05 / MP",
      "Result layer will be larger than canvas — use Image › Canvas Size to expand",
    ],
  },
  auraSR: {
    operation: "upscale",
    keyLabel:  "fal.ai API Key",
    keyPlaceholder: "fal_...",
    keyHint:   "fal.ai/dashboard → API Keys",
    maxInputPx: 1024,  // AuraSR works best with ≤1 K input for 4× to 4 K
    needsMask:  false,
    btnLabel:  "Upscale 4× (AuraSR)",
    nativeResultSize: true,
    info: [
      "<b>AuraSR — 4× Upscale</b>",
      "Recommended input: ≤ 1024 × 1024 px (canvas downsampled if larger)",
      "Output: up to 4096 × 4096 px &nbsp;·&nbsp; Fast, sharp on clean renders",
      "Result layer will be larger than canvas — use Image › Canvas Size to expand",
    ],
  },

  // ── Denoise ─────────────────────────────────────────────────────────────────
  nafnetDenoise: {
    operation: "denoise",
    keyLabel:  "fal.ai API Key",
    keyPlaceholder: "fal_...",
    keyHint:   "fal.ai/dashboard → API Keys",
    maxInputPx: 2048,  // send at native up to 2 K; larger canvases downsampled
    needsMask:  false,
    btnLabel:  "Denoise Document",
    nativeResultSize: false,
    info: [
      "<b>NAFNet — AI Noise / Grain Removal</b>",
      "Recommended input: ≤ 2048 × 2048 px (downsampled if larger, then scaled back)",
      "Good for render noise, compression artefacts, grain",
    ],
  },
};

// ── Prefs ─────────────────────────────────────────────────────────────────────
async function loadPrefs() {
  try {
    const folder = await storage.localFileSystem.getDataFolder();
    const file   = await folder.getEntry("lier-prefs.json").catch(() => null);
    if (file) return JSON.parse(await file.read({ format: storage.formats.utf8 }));
  } catch (_) {}
  return {};
}

async function savePrefs(data) {
  try {
    const folder = await storage.localFileSystem.getDataFolder();
    const file   = await folder.createFile("lier-prefs.json", { overwrite: true });
    await file.write(JSON.stringify(data), { format: storage.formats.utf8 });
  } catch (_) {}
}

// ── Apply provider config to UI ───────────────────────────────────────────────
function applyProvider(cfg) {
  apiKeyLabelEl.textContent    = cfg.keyLabel;
  apiKeyEl.placeholder         = cfg.keyPlaceholder;
  apiKeyHintEl.innerHTML       = cfg.keyHint;
  infoBarEl.innerHTML          = cfg.info.join("<br>");
  actionBtn.textContent        = cfg.btnLabel;

  const isEdit   = cfg.operation === "edit";
  const isUpscale= cfg.operation === "upscale";

  promptRowEl.style.display      = isEdit    ? "" : "none";
  editModeRowEl.style.display    = (isEdit && cfg.needsMask) ? "" : "none";
  scaleFactorRowEl.style.display = isUpscale ? "" : "none";

  // AuraSR is always 4×
  if (providerEl.value === "auraSR") {
    scaleFactorEl.value   = "4";
    scaleFactorEl.disabled = true;
  } else {
    scaleFactorEl.disabled = false;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const prefs    = await loadPrefs();
  const provider = prefs.provider || "imagen3";
  providerEl.value = provider;
  apiKeyEl.value   = prefs.keys?.[provider] || "";
  applyProvider(PROVIDERS[provider]);
})();

providerEl.addEventListener("change", async () => {
  const provider = providerEl.value;
  const prefs    = await loadPrefs();
  apiKeyEl.value = prefs.keys?.[provider] || "";
  applyProvider(PROVIDERS[provider]);
  prefs.provider = provider;
  await savePrefs(prefs);
});

apiKeyEl.addEventListener("change", async () => {
  const prefs        = await loadPrefs();
  prefs.keys         = prefs.keys || {};
  prefs.keys[providerEl.value] = apiKeyEl.value;
  await savePrefs(prefs);
});

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(msg, type = "") {
  statusEl.textContent = msg;
  statusEl.className   = type;
}

// ── Main handler ──────────────────────────────────────────────────────────────
actionBtn.addEventListener("click", async () => {
  const provider = providerEl.value;
  const cfg      = PROVIDERS[provider];
  const apiKey   = apiKeyEl.value.trim();
  const prompt   = promptEl.value.trim();
  const editMode = editModeEl.value;
  const scale    = parseInt(scaleFactorEl.value, 10);

  if (!apiKey) return setStatus("Enter your API key.", "error");
  if (cfg.operation === "edit" && !prompt) return setStatus("Enter a prompt.", "error");

  const doc = app.activeDocument;
  if (!doc) return setStatus("No document open.", "error");

  actionBtn.disabled = true;

  try {
    setStatus("Reading canvas...", "working");
    const { imageBase64, width, height, scaledW, scaledH } =
      await getDocumentPixels(doc, cfg.maxInputPx);

    let resultBase64;

    if (cfg.operation === "upscale") {
      setStatus(`Upscaling via ${provider}...`, "working");
      resultBase64 = await callAPI(provider, apiKey, null, imageBase64, null, null, { scale });

    } else if (cfg.operation === "denoise") {
      setStatus("Denoising...", "working");
      resultBase64 = await callAPI(provider, apiKey, null, imageBase64, null, null, {});

    } else {
      // edit / inpaint
      if (!cfg.needsMask) {
        setStatus("Sending to AI...", "working");
        resultBase64 = await callAPI(provider, apiKey, prompt, imageBase64, null, editMode, {});
      } else {
        setStatus("Reading selection mask...", "working");
        const maskBase64 = await getSelectionMask(doc, width, height, scaledW, scaledH);
        if (!maskBase64 && editMode !== "outpainting") {
          actionBtn.disabled = false;
          return setStatus("Make a selection first.", "error");
        }
        setStatus("Sending to AI...", "working");
        resultBase64 = await callAPI(provider, apiKey, prompt, imageBase64, maskBase64, editMode, {});
      }
    }

    setStatus("Placing result...", "working");
    if (cfg.nativeResultSize) {
      // Upscale: place at image's own pixel size (larger than canvas)
      await placeResultAsLayer(doc, resultBase64, null, null);
    } else {
      // Edit/denoise: stretch result back to original canvas dimensions
      await placeResultAsLayer(doc, resultBase64, width, height);
    }

    const extra = cfg.nativeResultSize
      ? " Result layer is larger than canvas — use Image › Canvas Size to expand."
      : "";
    setStatus("Done." + extra, "ok");

  } catch (err) {
    setStatus(err.message, "error");
    console.error("[Lier]", err);
  }

  actionBtn.disabled = false;
});

// ── Get document pixels, downsampled to maxPx if needed ───────────────────────
async function getDocumentPixels(doc, maxPx) {
  const width  = doc.width;
  const height = doc.height;
  const scale  = Math.min(1, maxPx / Math.max(width, height));
  const scaledW = Math.round(width  * scale);
  const scaledH = Math.round(height * scale);

  const pixelObj = await imaging.getPixels({
    documentID:    doc.id,
    sourceBounds:  { left: 0, top: 0, right: width, bottom: height },
    targetSize:    { width: scaledW, height: scaledH },
    colorSpace:    "RGB",
    componentSize: 8,
  });

  const imageData = await pixelObj.imageData.getData();
  const base64    = await pixelsToBase64(imageData, scaledW, scaledH);
  pixelObj.imageData.dispose();

  return { imageBase64: base64, width, height, scaledW, scaledH };
}

// ── Get selection mask ────────────────────────────────────────────────────────
async function getSelectionMask(doc, width, height, scaledW, scaledH) {
  const hasSelection = await core.executeAsModal(async () => {
    const result = await action.batchPlay(
      [{
        _obj: "get",
        _target: [
          { _property: "selection" },
          { _ref: "document", _enum: "ordinal", _value: "targetEnum" },
        ],
      }],
      { synchronousExecution: false }
    );
    const sel = result[0]?.selection;
    if (!sel || sel._enum === "allEnum" || sel._class === "null") return false;
    return true;
  }, { commandName: "Check selection" });

  if (!hasSelection) return null;

  let channelIndex = null;

  await core.executeAsModal(async () => {
    await action.batchPlay(
      [{
        _obj: "set",
        _target: [{ _ref: "channel", _property: "selection" }],
        to: {
          _obj: "saveSelection",
          destination: { _ref: "channel", _class: "channel" },
          operation: { _enum: "selectionModificationTypeClass", _value: "newSelection" },
        },
      }],
      { synchronousExecution: false }
    );

    const docInfo = await action.batchPlay(
      [{
        _obj: "get",
        _target: [
          { _property: "numberOfChannels" },
          { _ref: "document", _enum: "ordinal", _value: "targetEnum" },
        ],
      }],
      { synchronousExecution: false }
    );
    channelIndex = docInfo[0].numberOfChannels;
  }, { commandName: "Save selection to channel" });

  if (channelIndex === null) return null;

  let maskBase64 = null;
  try {
    const maskPixels = await imaging.getPixels({
      documentID:    doc.id,
      sourceBounds:  { left: 0, top: 0, right: width, bottom: height },
      targetSize:    { width: scaledW, height: scaledH },
      colorSpace:    "Grayscale",
      componentSize: 8,
      channelIndex,
    });
    const maskData = await maskPixels.imageData.getData();
    maskBase64     = await grayscalePixelsToBase64(maskData, scaledW, scaledH);
    maskPixels.imageData.dispose();
  } finally {
    await core.executeAsModal(async () => {
      await action.batchPlay(
        [{ _obj: "delete", _target: [{ _ref: "channel", _index: channelIndex }] }],
        { synchronousExecution: false }
      );
    }, { commandName: "Delete temp channel" });
  }

  return maskBase64;
}

// ── Canvas helpers ────────────────────────────────────────────────────────────
async function pixelsToBase64(pixelData, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width  = width;
  canvas.height = height;
  const ctx  = canvas.getContext("2d");
  const imgd = new ImageData(new Uint8ClampedArray(pixelData), width, height);
  ctx.putImageData(imgd, 0, 0);
  return canvas.toDataURL("image/png").split(",")[1];
}

async function grayscalePixelsToBase64(pixelData, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width  = width;
  canvas.height = height;
  const ctx  = canvas.getContext("2d");
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixelData.length; i++) {
    const v = pixelData[i];
    rgba[i * 4]     = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  const imgd = new ImageData(rgba, width, height);
  ctx.putImageData(imgd, 0, 0);
  return canvas.toDataURL("image/png").split(",")[1];
}

// ── Place result as a new layer ───────────────────────────────────────────────
// Pass origWidth/origHeight to force canvas dimensions; pass null/null to place
// at the image's native pixel size (e.g. after upscaling).
async function placeResultAsLayer(doc, base64png, origWidth, origHeight) {
  const folder = await storage.localFileSystem.getTemporaryFolder();
  const file   = await folder.createFile("lier_result.png", { overwrite: true });
  await file.write(base64ToUint8Array(base64png), { format: storage.formats.binary });
  const nativePath = await file.nativePath;

  await core.executeAsModal(async () => {
    const placeParams = {
      _obj:     "placeEvent",
      null:     { _path: nativePath, _kind: "local" },
      _options: { dialogOptions: "dontDisplay" },
    };

    if (origWidth && origHeight) {
      placeParams.width      = { _unit: "pixelsUnit", _value: origWidth };
      placeParams.height     = { _unit: "pixelsUnit", _value: origHeight };
      placeParams.horizontal = { _unit: "pixelsUnit", _value: origWidth  / 2 };
      placeParams.vertical   = { _unit: "pixelsUnit", _value: origHeight / 2 };
    }

    await action.batchPlay([placeParams], { synchronousExecution: false });

    await action.batchPlay(
      [{ _obj: "rasterizeLayer", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }],
      { synchronousExecution: false }
    );
  }, { commandName: "Place result" });
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
