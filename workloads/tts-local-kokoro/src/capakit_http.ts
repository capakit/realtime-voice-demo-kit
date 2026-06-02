import { endpointPath, hostMountMid } from "@capakit/sdk";
import type { RunnerHttpHandlerContext } from "@capakit/sdk";
import type { RunnerSdk } from "@capakit/sdk";
import { mountOaic } from "@capakit/sdk/oaic";
import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

type TtsRuntime = {
    modelsDir: string;
};

type ModelState = "idle" | "loading" | "ready" | "error";

type KokoroModel = {
    generate(text: string, options: { voice: string }): Promise<KokoroAudio>;
};

type KokoroAudio = {
    save(path: string): Promise<void> | void;
};

const app = new Hono();
let ttsRuntime: TtsRuntime | null = null;
let ttsPromise: Promise<KokoroModel> | null = null;
let modelState: ModelState = "idle";
let modelError: string | null = null;
let modelStartedAt: number | null = null;
let modelReadyAt: number | null = null;

app.get("/api/health", (c) =>
    c.json({
        ok: true,
        workload: process.env.CAPAKIT_WORKLOAD_MID ?? "web",
        title: "Local Kokoro TTS",
        model: modelName(),
        voice: configuredVoice(),
        status: modelState,
        error: modelError,
        loadMs: modelStartedAt && modelReadyAt ? Math.round(modelReadyAt - modelStartedAt) : null,
    }),
);

app.get("/v1/models", (c) =>
    c.json({
        object: "list",
        data: [
            {
                id: "local-kokoro",
                object: "model",
                owned_by: "capakit",
                source: modelName(),
                status: modelState,
                voice: configuredVoice(),
                error: modelError,
                load_ms: modelStartedAt && modelReadyAt ? Math.round(modelReadyAt - modelStartedAt) : null,
            },
        ],
    }),
);

app.post("/v1/audio/speech", async (c) => {
    const body: { input?: string; voice?: string } = await c.req.json<{ input?: string; voice?: string }>()
        .catch(() => ({}));
    const text = body.input?.trim() || "I do not have anything to say yet.";
    const wav = await synthesizeSpeech(text, configuredVoice(body.voice));
    return new Response(arrayBufferBody(wav), {
        headers: {
            "content-type": "audio/wav",
        },
    });
});

function arrayBufferBody(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

app.notFound((c) => c.json({ error: "not found" }, 404));

export function registerHttp(sdk: RunnerSdk): void {
    const modelsMount = sdk.mounts.get(hostMountMid("models"));
    if (!modelsMount) {
        throw new Error("missing required host mount `models`");
    }
    ttsRuntime = { modelsDir: modelsMount.path };
    configureTransformersCache(ttsRuntime.modelsDir);
    void getTts();

    sdk.mount({
        protocol: "http",
        endpoint: endpointPath("/http"),
        handler: async (request, context) =>
            app.fetch(requestForMountedApp(request, context)),
    });
    mountOaic(sdk, {
        endpoint: "/oaic",
        handler: async (request, context) =>
            app.fetch(requestForMountedApp(request, context)),
    });
}

function requestForMountedApp(
    request: Request,
    context: RunnerHttpHandlerContext,
): Request {
    const url = new URL(request.url);
    const endpoint = context.endpoint.toString();
    if (endpoint !== "/" && url.pathname.startsWith(endpoint)) {
        url.pathname = url.pathname.slice(endpoint.length) || "/";
    }
    return new Request(url.toString(), request);
}

function modelName(): string {
    return process.env.TTS_MODEL?.trim() || "onnx-community/Kokoro-82M-v1.0-ONNX";
}

function configuredVoice(requested?: string): string {
    const configured = process.env.TTS_VOICE?.trim();
    if (configured) {
        return configured;
    }
    const trimmed = requested?.trim();
    if (!trimmed || openAiVoiceNames().has(trimmed)) {
        return "af_bella";
    }
    return trimmed;
}

function openAiVoiceNames(): ReadonlySet<string> {
    return new Set(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);
}

function configureTransformersCache(modelsDir: string): void {
    const cacheDir = join(modelsDir, "transformers-cache");
    void mkdir(cacheDir, { recursive: true });
    env.cacheDir = cacheDir;
    env.allowLocalModels = false;
}

async function getTts(): Promise<KokoroModel> {
    if (!ttsPromise) {
        modelState = "loading";
        modelError = null;
        modelStartedAt = performance.now();
        ttsPromise = KokoroTTS.from_pretrained(modelName(), {
            dtype: "q8",
            device: "cpu",
        })
            .then((tts) => {
                modelState = "ready";
                modelReadyAt = performance.now();
                return tts as KokoroModel;
            })
            .catch((error: unknown) => {
                modelState = "error";
                modelError = error instanceof Error ? error.message : "TTS model failed to load";
                ttsPromise = null;
                throw error;
            });
    }
    return ttsPromise;
}

async function synthesizeSpeech(text: string, voice: string): Promise<Uint8Array> {
    const tts = await getTts();
    const tempDir = await mkdtemp(join(tmpdir(), "capakit-kokoro-"));
    try {
        const wavPath = join(tempDir, "speech.wav");
        const audio = await tts.generate(text, { voice });
        await audio.save(wavPath);
        return new Uint8Array(await readFile(wavPath));
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}
