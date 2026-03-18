/* global require */
const { app, core, imaging, action } = require("photoshop");
const { storage } = require("uxp");

// ── UI refs ───────────────────────────────────────────────────────────────────
const providerEl   = document.getElementById("apiProvider");
const infoBarEl    = document.getElementById("infoBar");
const apiKeyLabelEl= document.getElementById("apiKeyLabel");
const apiKeyEl     = document.getElementById("apiKey");
const apiKeyHintEl = document.getElementById("apiKeyHint");
const promptEl     = document.getElementById("prompt");
const editModeEl   = document.getElementById("editMode");
const editModeRow  = document.getElementById("editModeRow");
const btn          = document.getElementById("inpaintBtn");
const statusEl     = document.getElementById("status");

// ── Provider configs ──────────────────────────────────────────────────────────
const PROVIDERS = {
  imagen3: {
    keyLabel:       "Vertex AI / AI Studio API Key",
    keyPlaceholder: "AIza...",
    keyHint:        "console.cloud.google.com → Vertex AI → Enable Imagen",
    maxPx:          1536,
    needsMask:      true,
    btnLabel:       "Inpaint Selection",
    info: [
      "<b>Imagen 3 — Inpainting</b>",
      "Max input: 1536 × 1536 px &nbsp;·&nbsp; Output: ~1024 px (AI-generated region blended back)",
      "Cost: $0.02 / image edit &nbsp;·&nbsp; Upscale to 17 MP via Imagen 4 upscale ($0.003)",
      "Note: at 2 K+ input Google applies its own blending — output quality varies",
    ],
  },
  fluxFill: {
    keyLabel:       "fal.ai API Key",
    keyPlaceholder: "fal_...",
    keyHint:        "fal.ai/dashboard → API Keys",
    maxPx:          2048,
    needsMask:      true,
    btnLabel:       "Inpaint Selection",
    info: [
      "<b>FLUX.1 Fill Pro — Mask-based Inpainting</b>",
      "Max input: 2048 × 2048 px &nbsp;·&nbsp; Cost: $0.05 / megapixel",
      "Best-in-class inpainting quality &nbsp;·&nbsp; Result fetched from fal CDN",
    ],
  },
  fluxKontext: {
    keyLabel:       "fal.ai API Key",
    keyPlaceholder: "fal_...",
    keyHint:        "fal.ai/dashboard → API Keys &nbsp;·&nbsp; No selection needed — edits full image",
    maxPx:          2048,
    needsMask:      false,
    btnLabel:       "Edit Full Image",
    info: [
      "<b>FLUX.1 Kontext Pro — Full Image Editing</b>",
      "Max input: 2048 × 2048 px &nbsp;·&nbsp; Cost: $0.04 / image",
      "No mask needed — rewrites the whole image from a text instruction",
      "Ideal for style shifts, retouching, scene restructuring",
    ],
  },
};

// ── Prefs helpers ─────────────────────────────────────────────────────────────
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

// ── Update UI for selected provider ──────────────────────────────────────────
function applyProvider(cfg) {
  apiKeyLabelEl.textContent = cfg.keyLabel;
  apiKeyEl.placeholder      = cfg.keyPlaceholder;
  apiKeyHintEl.innerHTML    = cfg.keyHint;
  infoBarEl.innerHTML       = cfg.info.join("<br>");
  editModeRow.style.display = cfg.needsMask ? "" : "none";
  btn.textContent           = cfg.btnLabel;
}

// ── Initialise ────────────────────────────────────────────────────────────────
(async () => {
  const prefs    = await loadPrefs();
  const provider = prefs.provider || "imagen3";
  providerEl.value = provider;
  apiKeyEl.value   = prefs.keys?.[provider] || "";
  applyProvider(PROVIDERS[provider]);
})();

// ── Provider change ───────────────────────────────────────────────────────────
providerEl.addEventListener("change", async () => {
  const provider = providerEl.value;
  const prefs    = await loadPrefs();
  apiKeyEl.value = prefs.keys?.[provider] || "";
  applyProvider(PROVIDERS[provider]);
  prefs.provider = provider;
  await savePrefs(prefs);
});

// ── Persist API key per provider ──────────────────────────────────────────────
apiKeyEl.addEventListener("change", async () => {
  const prefs    = await loadPrefs();
  prefs.keys     = prefs.keys || {};
  prefs.keys[providerEl.value] = apiKeyEl.value;
  await savePrefs(prefs);
});

// ── Status helper ─────────────────────────────────────────────────────────────
function setStatus(msg, type = "") {
  statusEl.textContent = msg;
  statusEl.className   = type;
}

// ── Main handler ──────────────────────────────────────────────────────────────
btn.addEventListener("click", async () => {
  const provider = providerEl.value;
  const cfg      = PROVIDERS[provider];
  const apiKey   = apiKeyEl.value.trim();
  const prompt   = promptEl.value.trim();
  const editMode = editModeEl.value;

  if (!apiKey) return setStatus("Enter your API key.", "error");
  if (!prompt) return setStatus("Enter a prompt.", "error");

  const doc = app.activeDocument;
  if (!doc) return setStatus("No document open.", "error");

  btn.disabled = true;

  try {
    setStatus("Reading canvas...", "working");
    const { imageBase64, width, height, scaledW, scaledH } = await getDocumentPixels(doc, cfg.maxPx);

    let resultBase64;

    if (!cfg.needsMask) {
      // Full image edit — no mask required
      setStatus("Sending to FLUX Kontext...", "working");
      resultBase64 = await callFluxKontext(apiKey, prompt, imageBase64);
    } else {
      setStatus("Reading selection mask...", "working");
      const maskBase64 = await getSelectionMask(doc, width, height, scaledW, scaledH);

      if (!maskBase64 && editMode !== "outpainting") {
        btn.disabled = false;
        return setStatus("Make a selection first.", "error");
      }

      setStatus(`Sending to ${cfg.btnLabel.split(" ")[0]}...`, "working");
      resultBase64 = await callAPI(provider, apiKey, prompt, imageBase64, maskBase64, editMode);
    }

    setStatus("Placing result...", "working");
    await placeResultAsLayer(doc, resultBase64, width, height);

    setStatus("Done.", "ok");
  } catch (err) {
    setStatus(err.message, "error");
    console.error("[Lier]", err);
  }

  btn.disabled = false;
});

// ── Get full document pixels (downsampled if needed) ──────────────────────────
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

// ── Export current selection as a grayscale mask PNG (base64) ─────────────────
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
        [{
          _obj: "delete",
          _target: [{ _ref: "channel", _index: channelIndex }],
        }],
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

// ── Place base64 PNG result as a new layer at original canvas size ─────────────
async function placeResultAsLayer(doc, base64png, origWidth, origHeight) {
  const folder = await storage.localFileSystem.getTemporaryFolder();
  const file   = await folder.createFile("lier_result.png", { overwrite: true });
  await file.write(base64ToUint8Array(base64png), { format: storage.formats.binary });
  const nativePath = await file.nativePath;

  await core.executeAsModal(async () => {
    await action.batchPlay(
      [{
        _obj: "placeEvent",
        null:       { _path: nativePath, _kind: "local" },
        width:      { _unit: "pixelsUnit", _value: origWidth },
        height:     { _unit: "pixelsUnit", _value: origHeight },
        horizontal: { _unit: "pixelsUnit", _value: origWidth  / 2 },
        vertical:   { _unit: "pixelsUnit", _value: origHeight / 2 },
        _options:   { dialogOptions: "dontDisplay" },
      }],
      { synchronousExecution: false }
    );

    await action.batchPlay(
      [{ _obj: "rasterizeLayer", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }],
      { synchronousExecution: false }
    );
  }, { commandName: "Place inpaint result" });
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
