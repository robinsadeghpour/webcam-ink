// Puts the MediaPipe runtime and the hand model into public/mediapipe so the
// built site is fully self-hosted. Runs before `dev` and `build`.
//
// The model is not in the repository (it is 7.8 MB of binary), so it is
// downloaded once from the pinned URL below and checked against a known
// hash. If the download fails or the file is not the expected one, this
// script fails, and so does the build: a site without its model must not ship.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmFrom = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const out = join(root, 'public/mediapipe');

const MODEL = {
  url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  bytes: 7819105,
  sha256: 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1',
};

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const isTheModel = (data) => data.length === MODEL.bytes && sha256(data) === MODEL.sha256;

await mkdir(join(out, 'wasm'), { recursive: true });

for (const name of [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
]) {
  await copyFile(join(wasmFrom, name), join(out, 'wasm', name));
}

const modelPath = join(out, 'hand_landmarker.task');
const existing = await readFile(modelPath).catch(() => null);
if (!existing || !isTheModel(existing)) {
  if (existing) await rm(modelPath);
  let data;
  try {
    const res = await fetch(MODEL.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error(`Could not download the hand model from\n  ${MODEL.url}\n  ${err.message}`);
    process.exit(1);
  }
  if (!isTheModel(data)) {
    console.error(
      `The downloaded hand model is not the expected file.\n` +
        `  expected ${MODEL.bytes} bytes, sha256 ${MODEL.sha256}\n` +
        `  got      ${data.length} bytes, sha256 ${sha256(data)}`,
    );
    process.exit(1);
  }
  await writeFile(modelPath, data);
  console.log('fetched and verified hand_landmarker.task');
}
