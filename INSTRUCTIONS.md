# Lier — Photoshop Inpainting Plugin (Gemini / Imagen 3)

A UXP plugin for Adobe Photoshop that sends the current canvas selection to
Google's Imagen 3 API for AI inpainting, and pastes the result back as a new layer.

---

## Overview

| Concern | Choice |
|---|---|
| Plugin system | Adobe UXP (modern, JS/HTML) |
| Inpainting API | Imagen 3 via Google AI Studio |
| Auth | API key (stored locally in plugin prefs) |
| Non-destructive | Result always placed on a new layer |

---

## Prerequisites

- **Adobe Photoshop** 24.0+ (UXP support)
- **Adobe UXP Developer Tools** — download from Creative Cloud
- **Google AI Studio API key** — https://aistudio.google.com/app/apikey
- **Node.js** 18+ (for build tooling)

---

## Project Structure

```
lier/
  manifest.json          # UXP plugin manifest
  index.html             # Plugin panel UI
  index.js               # Main plugin logic
  api.js                 # Imagen 3 API client
  package.json
  INSTRUCTIONS.md        # This file
```

---

## Step 1 — Scaffold the UXP Plugin

### `manifest.json`
```json
{
  "id": "com.yourname.lier",
  "name": "Lier",
  "version": "1.0.0",
  "manifestVersion": 6,
  "host": [
    { "app": "PS", "minVersion": "24.0" }
  ],
  "entrypoints": [
    {
      "type": "panel",
      "id": "lier-panel",
      "label": "Lier — AI Inpaint",
      "minimumSize": { "width": 300, "height": 400 },
      "main": "index.html"
    }
  ],
  "requiredPermissions": {
    "network": {
      "domains": ["https://generativelanguage.googleapis.com"]
    }
  }
}
```

### `index.html`
```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: sans-serif; padding: 12px; background: #2b2b2b; color: #eee; }
    textarea { width: 100%; height: 80px; background: #1e1e1e; color: #eee; border: 1px solid #555; padding: 6px; box-sizing: border-box; }
    button { width: 100%; padding: 10px; margin-top: 8px; background: #0078d4; color: white; border: none; cursor: pointer; font-size: 14px; }
    input[type=text] { width: 100%; background: #1e1e1e; color: #eee; border: 1px solid #555; padding: 6px; box-sizing: border-box; }
    label { display: block; margin-top: 10px; font-size: 12px; color: #aaa; }
    #status { margin-top: 10px; font-size: 12px; min-height: 20px; }
    .error { color: #f55; }
    .ok { color: #5f5; }
  </style>
</head>
<body>
  <label>API Key</label>
  <input type="text" id="apiKey" placeholder="AIza..." />

  <label>Prompt</label>
  <textarea id="prompt" placeholder="Replace with a mossy stone wall..."></textarea>

  <button id="inpaintBtn">Inpaint Selection</button>
  <div id="status"></div>

  <script src="index.js"></script>
</body>
</html>
```

---

## Step 2 — Plugin Logic (`index.js`)

```js
const { app, core, imaging } = require("photoshop");
const { storage } = require("uxp");

const btn = document.getElementById("inpaintBtn");
const statusEl = document.getElementById("status");
const apiKeyEl = document.getElementById("apiKey");
const promptEl = document.getElementById("prompt");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? "error" : "ok";
}

btn.addEventListener("click", async () => {
  const apiKey = apiKeyEl.value.trim();
  const prompt = promptEl.value.trim();

  if (!apiKey) return setStatus("Enter your API key.", true);
  if (!prompt) return setStatus("Enter a prompt.", true);

  const doc = app.activeDocument;
  if (!doc) return setStatus("No document open.", true);

  try {
    setStatus("Reading selection...");

    // 1. Get full document as base64 PNG
    const imageData = await getDocumentPixels(doc);
    // 2. Get selection mask as base64 PNG
    const maskData = await getSelectionMask(doc);

    if (!maskData) return setStatus("Make a selection first.", true);

    setStatus("Sending to Imagen 3...");
    const result = await callImagen3(apiKey, prompt, imageData, maskData);

    setStatus("Placing result...");
    await placeResultAsLayer(doc, result);

    setStatus("Done.");
  } catch (err) {
    setStatus(err.message, true);
    console.error(err);
  }
});

async function getDocumentPixels(doc) {
  // Flatten to pixel data, encode as base64
  const pixels = await imaging.getPixels({
    documentID: doc.id,
    sourceBounds: { left: 0, top: 0, right: doc.width, bottom: doc.height },
    targetSize: { width: doc.width, height: doc.height },
    colorSpace: "RGB",
    componentSize: 8,
  });
  return pixelsToBase64(pixels.imageData, doc.width, doc.height);
}

async function getSelectionMask(doc) {
  // Export selection as grayscale mask
  // White = inpaint here, Black = keep
  const selBounds = await core.executeAsModal(async () => {
    const desc = await require("photoshop").action.batchPlay([
      { _obj: "get", _target: [{ _property: "selection" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }] }
    ], {});
    return desc[0].selection;
  }, { commandName: "Get Selection" });

  if (!selBounds) return null;

  // Create a temporary channel from selection and export
  // (simplified — in practice use batchPlay to export selection as mask PNG)
  // See full implementation notes below
  return await exportSelectionAsMask(doc, selBounds);
}

async function pixelsToBase64(imageData, width, height) {
  // Convert UXP ImageData to base64 PNG using canvas
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const data = new ImageData(new Uint8ClampedArray(imageData), width, height);
  ctx.putImageData(data, 0, 0);
  const dataURL = canvas.toDataURL("image/png");
  return dataURL.split(",")[1]; // strip "data:image/png;base64,"
}
```

---

## Step 3 — Imagen 3 API Client (`api.js`)

```js
async function callImagen3(apiKey, prompt, imageBase64, maskBase64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-capability-001:predict?key=${apiKey}`;

  const body = {
    instances: [
      {
        prompt: prompt,
        image: { bytesBase64Encoded: imageBase64 },
        mask: {
          image: { bytesBase64Encoded: maskBase64 }
        }
      }
    ],
    parameters: {
      sampleCount: 1,
      editMode: "inpainting-insert"
    }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error?.message || `API error ${resp.status}`);
  }

  const json = await resp.json();
  return json.predictions[0].bytesBase64Encoded;
}
```

---

## Step 4 — Place Result as Layer

```js
async function placeResultAsLayer(doc, base64png) {
  // Write base64 to a temp file, then place into document
  const folder = await storage.localFileSystem.getTemporaryFolder();
  const file = await folder.createFile("lier_result.png", { overwrite: true });
  const bytes = base64ToUint8Array(base64png);
  await file.write(bytes, { format: storage.formats.binary });

  await core.executeAsModal(async () => {
    await require("photoshop").action.batchPlay([
      {
        _obj: "placeEvent",
        null: { _path: await file.nativePath, _kind: "local" },
        _options: { dialogOptions: "dontDisplay" }
      }
    ], {});
  }, { commandName: "Place Inpaint Result" });
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
```

---

## Step 5 — Load in Photoshop (Dev Mode)

1. Open **Adobe UXP Developer Tools**
2. Click **Add Plugin** → select the `lier/` folder (the one containing `manifest.json`)
3. Click **Load** → the Lier panel appears in Photoshop under Plugins menu
4. Open a document, make a selection, enter your API key + prompt, click **Inpaint Selection**

---

## Known Complexities

### Selection → Mask export
The cleanest approach is to use `batchPlay` to:
1. Save the current selection to a channel
2. Export that channel as a grayscale PNG
3. Delete the temp channel

This is verbose but well-documented in Adobe's UXP batchPlay reference.

### Image resizing
Imagen 3 has max input dimensions (~1536px). For large canvases, downsample before sending and upsample the result before placing. Use the canvas API or a JS image resizing lib.

### API access
Imagen 3 inpainting (`imagen-3.0-capability-001`) requires **allowlisting** on some Google AI Studio accounts. If you hit a 403, you may need to use **Vertex AI** instead (requires a GCP project). The request format is nearly identical.

---

## Vertex AI Alternative (if AI Studio is blocked)

Replace the URL in `api.js`:
```
https://us-central1-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/us-central1/publishers/google/models/imagen-3.0-capability-001:predict
```
Auth via OAuth2 bearer token instead of API key.

---

## Next Steps

- [ ] Implement full selection-to-mask export via batchPlay
- [ ] Add image downsampling for large canvases
- [ ] Persist API key in UXP plugin storage (not just the text field)
- [ ] Add outpainting mode (expand canvas + fill)
- [ ] Package for distribution via Creative Cloud marketplace
