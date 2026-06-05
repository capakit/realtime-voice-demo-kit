import { endpointPath, hostMountMid } from "@capakit/sdk";
import type { WorkloadHttpHandlerContext } from "@capakit/sdk";
import type { WorkloadSdk } from "@capakit/sdk";
import { mountOaic } from "@capakit/sdk/oaic";
import { env, pipeline } from "@xenova/transformers";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";

type AsrRuntime = {
    modelsDir: string;
};

type TranscriptionResult = {
    text?: string;
};

type ModelState = "idle" | "loading" | "ready" | "error";

const app = new Hono();
let asrRuntime: AsrRuntime | null = null;
let transcriberPromise: Promise<(audio: Float32Array) => Promise<TranscriptionResult>> | null = null;
let modelState: ModelState = "idle";
let modelError: string | null = null;
let modelStartedAt: number | null = null;
let modelReadyAt: number | null = null;

app.get("/api/health", (c) =>
    c.json({
        ok: true,
        workload: process.env.CAPAKIT_WORKLOAD_MID ?? "web",
        title: "Local Whisper ASR",
        model: asrModelName(),
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
                id: "local-whisper-transformers",
                object: "model",
                owned_by: "capakit",
                status: modelState,
                source: asrModelName(),
                error: modelError,
                load_ms: modelStartedAt && modelReadyAt ? Math.round(modelReadyAt - modelStartedAt) : null,
            },
        ],
    }),
);

app.post("/v1/audio/transcriptions", async (c) => {
    const runtime = asrRuntime;
    if (!runtime) {
        throw new Error("ASR runtime was not initialized");
    }
    const form = await c.req.raw.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
        return c.json({ text: "" });
    }

    configureTransformersCache(runtime.modelsDir);
    const audio = wavToFloat32(new Uint8Array(await file.arrayBuffer()));
    const transcriber = await getTranscriber();
    const result = await transcriber(audio);
    return c.json({ text: result.text?.trim() ?? "" });
});

app.notFound((c) => c.json({ error: "not found" }, 404));

export function registerHttp(sdk: WorkloadSdk): void {
    const modelsMount = sdk.mounts.get(hostMountMid("models"));
    if (!modelsMount) {
        throw new Error("missing required host mount `models`");
    }
    asrRuntime = { modelsDir: modelsMount.path };
    configureTransformersCache(asrRuntime.modelsDir);
    void getTranscriber();
    const handler = async (request: Request, context: WorkloadHttpHandlerContext) =>
        app.fetch(requestForMountedApp(request, context));

    sdk.mount({
        protocol: "http",
        endpoint: endpointPath("/http"),
        handler,
    });
    mountOaic(sdk, {
        endpoint: "/oaic",
        handler,
    });
}

function requestForMountedApp(
    request: Request,
    context: WorkloadHttpHandlerContext,
): Request {
    const url = new URL(request.url);
    const endpoint = context.endpoint.toString();
    if (endpoint !== "/" && url.pathname.startsWith(endpoint)) {
        url.pathname = url.pathname.slice(endpoint.length) || "/";
    }
    return new Request(url.toString(), request);
}

function asrModelName(): string {
    return process.env.ASR_MODEL?.trim() || "Xenova/whisper-tiny.en";
}

function configureTransformersCache(modelsDir: string): void {
    const cacheDir = join(modelsDir, "transformers-cache");
    void mkdir(cacheDir, { recursive: true });
    env.cacheDir = cacheDir;
    env.allowLocalModels = false;
}

async function getTranscriber(): Promise<(audio: Float32Array) => Promise<TranscriptionResult>> {
    if (!transcriberPromise) {
        modelState = "loading";
        modelError = null;
        modelStartedAt = performance.now();
        transcriberPromise = (
            pipeline(
                "automatic-speech-recognition",
                asrModelName(),
            ) as Promise<(audio: Float32Array) => Promise<TranscriptionResult>>
        )
            .then((transcriber) => {
                modelState = "ready";
                modelReadyAt = performance.now();
                return transcriber;
            })
            .catch((error: unknown) => {
                modelState = "error";
                modelError = error instanceof Error ? error.message : "ASR model failed to load";
                transcriberPromise = null;
                throw error;
            });
    }
    return transcriberPromise;
}

function wavToFloat32(bytes: Uint8Array): Float32Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
        throw new Error("ASR input must be a WAV file");
    }

    let offset = 12;
    let channels = 1;
    let sampleRate = 16_000;
    let bitsPerSample = 16;
    let dataOffset = -1;
    let dataSize = 0;

    while (offset + 8 <= view.byteLength) {
        const chunkId = readAscii(view, offset, 4);
        const chunkSize = view.getUint32(offset + 4, true);
        const chunkData = offset + 8;
        if (chunkId === "fmt ") {
            const format = view.getUint16(chunkData, true);
            if (format !== 1) {
                throw new Error(`unsupported WAV format ${format}; expected PCM`);
            }
            channels = view.getUint16(chunkData + 2, true);
            sampleRate = view.getUint32(chunkData + 4, true);
            bitsPerSample = view.getUint16(chunkData + 14, true);
        } else if (chunkId === "data") {
            dataOffset = chunkData;
            dataSize = chunkSize;
            break;
        }
        offset = chunkData + chunkSize + (chunkSize % 2);
    }

    if (dataOffset < 0 || dataSize <= 0) {
        throw new Error("WAV file has no data chunk");
    }
    if (bitsPerSample !== 16) {
        throw new Error(`unsupported WAV bit depth ${bitsPerSample}; expected 16-bit PCM`);
    }

    const frameCount = Math.floor(dataSize / (channels * 2));
    const mono = new Float32Array(frameCount);
    for (let frame = 0; frame < frameCount; frame += 1) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel += 1) {
            const sampleOffset = dataOffset + (frame * channels + channel) * 2;
            sum += view.getInt16(sampleOffset, true) / 0x8000;
        }
        mono[frame] = sum / channels;
    }
    return sampleRate === 16_000 ? mono : resampleLinear(mono, sampleRate, 16_000);
}

function readAscii(view: DataView, offset: number, length: number): string {
    let value = "";
    for (let index = 0; index < length; index += 1) {
        value += String.fromCharCode(view.getUint8(offset + index));
    }
    return value;
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
    const outputLength = Math.max(1, Math.round(input.length * toRate / fromRate));
    const output = new Float32Array(outputLength);
    const ratio = (input.length - 1) / Math.max(1, outputLength - 1);
    for (let index = 0; index < outputLength; index += 1) {
        const position = index * ratio;
        const left = Math.floor(position);
        const right = Math.min(input.length - 1, left + 1);
        const weight = position - left;
        output[index] = input[left] * (1 - weight) + input[right] * weight;
    }
    return output;
}
