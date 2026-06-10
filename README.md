<!--
Generated from kit-meta.json by scripts/demo-kit-standard.mjs.
Update kit-meta.json or capability.yml, then rerun the generator instead of hand-editing generated README sections.
-->

# Realtime Voice

Kit with a browser voice conversation loop, speech recognition, local chat, and speech output.

![Realtime Voice screenshot](screenshot.png)

## What It Does

- Streams microphone audio from the browser to a CapaKit workload.
- Transcribes speech with a local Whisper model.
- Generates assistant replies through a bundled local llama.cpp dependency.
- Speaks replies with a local Kokoro TTS model.

## Tags

- web-ui
- websocket
- voice
- audio
- speech-to-text
- text-to-speech
- llama.cpp
- transformers.js
- whisper
- kokoro
- local-ai
- react
- vite
- typescript
- bun

## Kit Info

```text
Kit: realtime-voice
License: Apache-2.0

Exposes
- Public path: /voice
  Protocols:
    - Protocol: http
      Path: /http

Requires
Secrets:
No secrets declared.

Host mounts:
- models [read_write]
  Usage: Local model cache for llama.cpp, Whisper ASR, and Kokoro TTS

Options:
- asr_model [string, default=Xenova/whisper-tiny.en]: Transformers.js Whisper model used for server-side speech recognition.
- chat_model [string, default=ggml-org/gemma-3-270m-it-GGUF:Q8_0]: Local GGUF/Hugging Face model spec used for assistant replies.
- gpu [enum, default=metal, values=none|metal]: Local GPU acceleration mode for bundled llama.cpp.
- llama_context_size [number, default=8192]: Context size passed through to the bundled llama.cpp dependency.
- tts_model [string, default=onnx-community/Kokoro-82M-v1.0-ONNX]: Kokoro ONNX model used for server-side neural speech synthesis.
- tts_voice [string, default=af_bella]: Kokoro voice id used for server-side neural speech synthesis.

External services
No external services declared.

Kit dependencies
- llama: Git repo https://github.com/capakit/llama-cpp-local-kit (default bundled Kit)
  Options passed:
  - context_size <- option llama_context_size (default: 8192)
  - default_model <- option chat_model (default: ggml-org/gemma-3-270m-it-GGUF:Q8_0)
  - gpu <- option gpu (default: metal)
  - hydrate_models <- option chat_model (default: ggml-org/gemma-3-270m-it-GGUF:Q8_0)
  Mounts passed:
  - models <- models (Local model cache for llama.cpp, Whisper ASR, and Kokoro TTS)

Use as dependency
Add this to another Kit's capability.yml:
dependencies:
  realtime-voice:
    source:
      path: /Users/roman/Code/capakit/demo-kits/realtime-voice-demo-kit

Commands
- Run:
  capakit run https://github.com/capakit/realtime-voice-demo-kit \
    --mount models=~/.capakit/models
- Test:
  capakit test --kit /Users/roman/Code/capakit/demo-kits/realtime-voice-demo-kit
```

## Run

```sh
capakit run https://github.com/capakit/realtime-voice-demo-kit \
--mount models=~/.capakit/models
```

## Test

```sh
capakit test .
```

## About CapaKit

CapaKit is a free runtime and CLI toolkit for building AI app Kits. When your agent builds, tests, or runs a Kit, it happens in isolation, not on your host.

https://capakit.com
