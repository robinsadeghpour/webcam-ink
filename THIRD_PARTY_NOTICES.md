# Third-party notices

The code in this repository is MIT licensed (see `LICENSE`). The built site
also ships the two things below, which are not part of this repository's
source and keep their own licences. They are fetched at install and build
time by `tools/copy-assets.mjs`.

## @mediapipe/tasks-vision

- What: the MediaPipe Tasks vision runtime (JavaScript and WebAssembly) that
  runs the hand tracker in the browser.
- Source: https://www.npmjs.com/package/@mediapipe/tasks-vision,
  https://github.com/google-ai-edge/mediapipe
- Licence: Apache License, Version 2.0
- Copyright: The MediaPipe Authors

## MediaPipe Hand Landmarker model

- What: `hand_landmarker.task` (float16, version 1), the palm detector and
  hand landmark models used for tracking.
- Source: https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
- Documentation: https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
- Licence: Apache License, Version 2.0, as stated on the model card
  ("Hand Tracking (Lite/Full) with Fairness", October 2021), which is linked
  from the documentation page above.

The full text of the Apache License, Version 2.0 is at
https://www.apache.org/licenses/LICENSE-2.0.

## Development tools

Vite (MIT) and TypeScript (Apache License, Version 2.0) are used to build
the site and are not shipped with it.
