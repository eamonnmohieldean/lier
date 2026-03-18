/* global require */
const { app, core, imaging, action } = require("photoshop");
const { storage } = require("uxp");

// ── UI refs ──────────────────────────────────────────────────────────────────
const btn       = document.getElementById("inpaintBtn");
const statusEl  = document.getElementById("status");
const apiKeyEl  = document.getElementById("apiKey");
const promptEl  = document.getElementById("prompt");
const modeEl    = document.getElementById("editMode");

// ── Persist API key across sessions ─────────────────────────────────────────
(async () => {
  try {
    const prefs = await storage.localFileSystem.getDataFolder();
    const file  = await prefs.getEntry("lier-prefs.json").catch(() => null);
    if (file) {
      const text = await file.read({ format: storage.formats.utf8 });
      const data = JSON.parse(text);
      if (data.apiKey) apiKeyEl.value = data.apiKey;
    }
  } catch (_) {}
})();

apiKeyEl.addEventListener("change", async () => {
  try {
    const prefs = await storage.localFileSystem.getDataFolder();
    const file  = await prefs.createFile("lier-prefs.json", { overwrite: true });
    await file.write(JSON.stringify({ apiKey: apiKeyEl.value }), { format: storage.formats.utf8 });
  } catch (_) {}
});

// ── Status helper ────────────────────────────────────────────────────────────
function setStatus(msg, type = "") {
  statusEl.textContent = msg;
  statusEl.className   = type; // "error" | "ok" | "working" | ""
}

// ── Main handler ─────────────────────────────────────────────────────────────
btn.addEventListener("click", async () => {
  const apiKey   = apiKeyEl.value.trim();
  const prompt   = promptEl.value.trim();
  const editMode = modeEl.value;

  if (!apiKey) return setStatus("Enter your API key.", "error");
  if (!prompt) return setStatus("Enter a prompt.", "error");

  const doc = app.activeDocument;
  if (!doc) return setStatus("No document open.", "error");

  btn.disabled = true;

  try {
    setStatus("Reading canvas...", "working");
    const { imageBase64, width, height } = await getDocumentPixels(doc);

    setStatus("Reading selection mask...", "working");
    const maskBase64 = await getSelectionMask(doc, width, height, scaledW, scaledH);

    if (!maskBase64 && editMode !== "outpainting") {
      btn.disabled = false;
      return setStatus("Make a selection first.", "error");
    }

    setStatus("Sending to Imagen 3...", "working");
    const resultBase64 = await callImagen3(apiKey, prompt, imageBase64, maskBase64, editMode);

    setStatus("Placing result...", "working");
    await placeResultAsLayer(doc, resultBase64, width, height);

    setStatus("Done.", "ok");
  } catch (err) {
    setStatus(err.message, "error");
    console.error("[Lier]", err);
  }

  btn.disabled = false;
});

// ── Downsampling ──────────────────────────────────────────────────────────────
const MAX_PX = 1536; // Imagen 3 max dimension

function computeScale(width, height) {
  return Math.min(1, MAX_PX / Math.max(width, height));
}

// ── Get full document pixels as base64 PNG ───────────────────────────────────
async function getDocumentPixels(doc) {
  const width  = doc.width;
  const height = doc.height;
  const scale  = computeScale(width, height);
  const scaledW = Math.round(width  * scale);
  const scaledH = Math.round(height * scale);

  const pixelObj = await imaging.getPixels({
    documentID:   doc.id,
    sourceBounds: { left: 0, top: 0, right: width, bottom: height },
    targetSize:   { width: scaledW, height: scaledH },
    colorSpace:   "RGB",
    componentSize: 8,
  });

  const imageData = await pixelObj.imageData.getData();
  const base64    = await pixelsToBase64(imageData, scaledW, scaledH);
  pixelObj.imageData.dispose();

  return { imageBase64: base64, width, height, scaledW, scaledH };
}

// ── Export current selection as a grayscale mask PNG (base64) ─────────────────
// White pixels = area to inpaint. Black pixels = keep.
async function getSelectionMask(doc, width, height, scaledW, scaledH) {
  // Check if there is an active selection
  const hasSelection = await core.executeAsModal(async () => {
    const result = await action.batchPlay(
      [
        {
          _obj: "get",
          _target: [
            { _property: "selection" },
            { _ref: "document", _enum: "ordinal", _value: "targetEnum" },
          ],
        },
      ],
      { synchronousExecution: false }
    );
    // If selection is "allEnum" there is no selection (whole canvas selected or none)
    const sel = result[0]?.selection;
    if (!sel || sel._enum === "allEnum" || sel._class === "null") return false;
    return true;
  }, { commandName: "Check selection" });

  if (!hasSelection) return null;

  // Steps:
  // 1. Save selection to a new channel
  // 2. Get pixel data from that channel
  // 3. Delete the channel
  // 4. Return as base64 grayscale PNG

  let channelIndex = null;

  await core.executeAsModal(async () => {
    // Save selection to a new alpha channel
    const saveResult = await action.batchPlay(
      [
        {
          _obj: "set",
          _target: [{ _ref: "channel", _property: "selection" }],
          to: {
            _obj: "saveSelection",
            destination: { _ref: "channel", _class: "channel" }, // new channel
            operation: { _enum: "selectionModificationTypeClass", _value: "newSelection" },
          },
        },
      ],
      { synchronousExecution: false }
    );
    void saveResult;

    // Get the index of the newly created channel (it's the last one)
    const docInfo = await action.batchPlay(
      [
        {
          _obj: "get",
          _target: [
            { _property: "numberOfChannels" },
            { _ref: "document", _enum: "ordinal", _value: "targetEnum" },
          ],
        },
      ],
      { synchronousExecution: false }
    );
    channelIndex = docInfo[0].numberOfChannels; // 1-based index of new channel
  }, { commandName: "Save selection to channel" });

  if (channelIndex === null) return null;

  // Read the channel pixels
  let maskBase64 = null;
  try {
    const maskPixels = await imaging.getPixels({
      documentID:    doc.id,
      sourceBounds:  { left: 0, top: 0, right: width, bottom: height },
      targetSize:    { width: scaledW, height: scaledH },
      colorSpace:    "Grayscale",
      componentSize: 8,
      channelIndex:  channelIndex,
    });

    const maskData = await maskPixels.imageData.getData();
    maskBase64     = await grayscalePixelsToBase64(maskData, scaledW, scaledH);
    maskPixels.imageData.dispose();
  } finally {
    // Always clean up the temp channel
    await core.executeAsModal(async () => {
      await action.batchPlay(
        [
          {
            _obj: "delete",
            _target: [{ _ref: "channel", _index: channelIndex }],
          },
        ],
        { synchronousExecution: false }
      );
    }, { commandName: "Delete temp channel" });
  }

  return maskBase64;
}

// ── Canvas helpers ────────────────────────────────────────────────────────────

// RGBA pixel array → base64 PNG
async function pixelsToBase64(pixelData, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width  = width;
  canvas.height = height;
  const ctx  = canvas.getContext("2d");
  const imgd = new ImageData(new Uint8ClampedArray(pixelData), width, height);
  ctx.putImageData(imgd, 0, 0);
  const dataURL = canvas.toDataURL("image/png");
  return dataURL.split(",")[1];
}

// Grayscale pixel array → base64 PNG (converted to RGBA for canvas)
async function grayscalePixelsToBase64(pixelData, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width  = width;
  canvas.height = height;
  const ctx  = canvas.getContext("2d");
  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let i = 0; i < pixelData.length; i++) {
    const v    = pixelData[i];
    const base = i * 4;
    rgba[base]     = v;
    rgba[base + 1] = v;
    rgba[base + 2] = v;
    rgba[base + 3] = 255;
  }

  const imgd = new ImageData(rgba, width, height);
  ctx.putImageData(imgd, 0, 0);
  const dataURL = canvas.toDataURL("image/png");
  return dataURL.split(",")[1];
}

// ── Place base64 PNG result as a new layer ────────────────────────────────────
async function placeResultAsLayer(doc, base64png, origWidth, origHeight) {
  const folder = await storage.localFileSystem.getTemporaryFolder();
  const file   = await folder.createFile("lier_result.png", { overwrite: true });

  const bytes = base64ToUint8Array(base64png);
  await file.write(bytes, { format: storage.formats.binary });

  const nativePath = await file.nativePath;

  await core.executeAsModal(async () => {
    // Place with explicit pixel dimensions so it always fills the canvas,
    // even when the source image was downsampled before sending to the API.
    await action.batchPlay(
      [
        {
          _obj: "placeEvent",
          null: { _path: nativePath, _kind: "local" },
          width:      { _unit: "pixelsUnit", _value: origWidth },
          height:     { _unit: "pixelsUnit", _value: origHeight },
          horizontal: { _unit: "pixelsUnit", _value: origWidth  / 2 },
          vertical:   { _unit: "pixelsUnit", _value: origHeight / 2 },
          _options:   { dialogOptions: "dontDisplay" },
        },
      ],
      { synchronousExecution: false }
    );

    // Rasterise the placed smart object to a regular pixel layer
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
