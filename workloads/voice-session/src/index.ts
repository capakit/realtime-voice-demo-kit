import {
    createRunnerSdk,
    endpointPath,
    workloadMid,
} from "@capakit/sdk";
import { createOaicClient } from "@capakit/sdk/oaic";
import type OpenAI from "openai";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const Bun: {
    serve(options: {
        unix?: string;
        hostname?: string;
        port?: number;
        fetch(request: Request, server: { upgrade(request: Request): boolean }): Response | undefined | Promise<Response | undefined>;
        websocket: {
            open(socket: VoiceSocket): void;
            message(socket: VoiceSocket, message: string | Uint8Array | ArrayBuffer): void;
            close?(socket: VoiceSocket): void;
        };
    }): unknown;
    file(path: string): Blob & { exists(): Promise<boolean> };
};

type VoiceSocket = {
    data?: VoiceSession;
    send(message: string | Uint8Array): void;
};

type ChatMessage = {
    role: "user" | "assistant";
    content: string;
};

type VoiceSession = {
    id: string;
    text: string;
    messages: ChatMessage[];
    processingTurn?: boolean;
    audio: AudioInputState;
};

type AudioInputState = {
    preRollChunks: Int16Array[];
    speechChunks: Int16Array[];
    streamStartedAt: number;
    speechStartedAt?: number;
    lastVoiceAt?: number;
    speechActive: boolean;
};

type ClientEvent = {
    type?: string;
    text?: string;
};

type ReadinessItem = {
    name: string;
    kind: "workload" | "model";
    status: "ready" | "loading" | "error";
    detail: string;
    model?: string;
    loadMs?: number | null;
};

const audioSampleRate = 16_000;
const silenceMs = 850;
const minSpeechMs = 280;
const maxTurnMs = 12_000;
const noSpeechResetMs = 4_000;
const preRollMs = 300;
const rmsThreshold = 0.012;

const sdk = createRunnerSdk();
const sourceDir = dirname(fileURLToPath(import.meta.url));
const clientDistDir = join(sourceDir, "..", "dist", "client");
const bind = parseBind(process.env.CAPAKIT_RUNNER_MANAGED_INGRESS_BIND);

Bun.serve({
    ...listenOptions(bind),
    async fetch(request, server) {
        const url = mountedUrl(request);
        if (url.pathname === "/test/voice-stack-e2e-smoke" || url.pathname === "/voice/test/voice-stack-e2e-smoke") {
            if (request.method !== "POST") {
                return Response.json({ error: "method not allowed" }, { status: 405 });
            }
            return Response.json(await runVoiceStackSmoke());
        }
        if (url.pathname === "/ws" || url.pathname === "/voice/ws") {
            if (server.upgrade(request)) {
                return undefined;
            }
            return new Response("websocket upgrade required", { status: 426 });
        }
        if (url.pathname === "/api/health" || url.pathname === "/voice/api/health") {
            return Response.json({
                ok: true,
                workload: process.env.CAPAKIT_WORKLOAD_MID ?? "voice-session",
                title: "Voice Session",
            });
        }
        if (url.pathname === "/api/readiness" || url.pathname === "/voice/api/readiness") {
            return Response.json(await systemReadiness());
        }
        const assetPath = clientAssetPath(url.pathname);
        if (assetPath) {
            return serveClientFile(assetPath);
        }
        return serveClientFile("index.html");
    },
    websocket: {
        open(socket) {
            socket.data = newVoiceSession();
            sendEvent(socket, {
                type: "session.ready",
                sessionId: socket.data.id,
            });
        },
        message(socket, message) {
            void handleSocketMessage(socket, message);
        },
    },
});

console.log("[realtime-voice] voice-session listening");

async function runVoiceStackSmoke() {
    const input = normalizeTranscript("Say a short friendly hello for a voice test.");
    const asrModels = await (await oaicClient("asr-local-whisper")).models.list();
    const client = await oaicClient("llama");
    const response = await client.chat.completions.create({
        model: process.env.VOICE_CHAT_MODEL ?? "voice-chat-model",
        temperature: 0.2,
        max_tokens: 80,
        messages: [
            {
                role: "system",
                content: "Reply in one short spoken sentence.",
            },
            {
                role: "user",
                content: input,
            },
        ],
    });
    const reply = response.choices[0]?.message?.content?.trim() ?? "";
    const speech = reply ? await synthesizeSpeech(reply) : new Uint8Array();
    return {
        asr_model_count: asrModels.data.length,
        input,
        reply,
        speech_bytes: speech.byteLength,
    };
}

async function handleSocketMessage(
    socket: VoiceSocket,
    message: string | Uint8Array | ArrayBuffer,
): Promise<void> {
    try {
        if (typeof message !== "string") {
            const audioBytes = message instanceof ArrayBuffer
                ? new Uint8Array(message)
                : message;
            socket.data ??= newVoiceSession();
            if (isWav(audioBytes)) {
                await processAudioTurn(socket, audioBytes);
                return;
            }
            processAudioFrame(socket, int16FrameFromBytes(audioBytes));
            return;
        }

        let event: ClientEvent;
        try {
            event = JSON.parse(message);
        } catch {
            sendEvent(socket, {
                type: "error",
                message: "invalid JSON event",
            });
            return;
        }

        if (event.type === "session.start") {
            socket.data = newVoiceSession();
            sendEvent(socket, {
                type: "session.ready",
                sessionId: socket.data.id,
            });
            return;
        }

        if (event.type === "input.text") {
            socket.data ??= newVoiceSession();
            socket.data.text = event.text ?? "";
            sendEvent(socket, {
                type: "transcript.partial",
                text: socket.data.text,
            });
            return;
        }

        if (event.type === "input.commit") {
            await processTextTurn(socket, socket.data?.text ?? "");
            return;
        }

        sendEvent(socket, {
            type: "error",
            message: `unsupported event: ${event.type ?? "unknown"}`,
        });
    } catch (error) {
        sendEvent(socket, {
            type: "error",
            message: error instanceof Error ? error.message : "voice session error",
        });
    }
}

function newVoiceSession(): VoiceSession {
    return {
        id: crypto.randomUUID(),
        text: "",
        messages: [],
        audio: newAudioInputState(),
    };
}

function newAudioInputState(): AudioInputState {
    return {
        preRollChunks: [],
        speechChunks: [],
        streamStartedAt: performance.now(),
        speechActive: false,
    };
}

function processAudioFrame(socket: VoiceSocket, frame: Int16Array): void {
    if (frame.length === 0) {
        return;
    }
    const session = socket.data ??= newVoiceSession();
    if (session.processingTurn) {
        return;
    }

    const audio = session.audio;
    const now = performance.now();
    const rms = int16RootMeanSquare(frame);

    if (!audio.speechActive) {
        audio.preRollChunks.push(frame);
        trimPreRoll(audio);
        if (rms <= rmsThreshold) {
            if (now - audio.streamStartedAt >= noSpeechResetMs) {
                audio.streamStartedAt = now;
                audio.preRollChunks = [];
            }
            return;
        }
        audio.speechActive = true;
        audio.speechStartedAt = now;
        audio.lastVoiceAt = now;
        audio.speechChunks = [...audio.preRollChunks, frame];
        audio.preRollChunks = [];
        sendEvent(socket, { type: "input.speech_start" });
        return;
    }

    audio.speechChunks.push(frame);
    if (rms > rmsThreshold) {
        audio.lastVoiceAt = now;
    }

    const speechStartedAt = audio.speechStartedAt ?? now;
    const lastVoiceAt = audio.lastVoiceAt ?? now;
    const speechLongEnough = now - speechStartedAt >= minSpeechMs;
    const silenceLongEnough = now - lastVoiceAt >= silenceMs;
    const turnTooLong = now - speechStartedAt >= maxTurnMs;
    if (speechLongEnough && (silenceLongEnough || turnTooLong)) {
        const speech = audio.speechChunks;
        session.audio = newAudioInputState();
        void processAudioTurn(socket, pcmChunksToWav(speech));
    }
}

async function processAudioTurn(socket: VoiceSocket, wavBytes: Uint8Array): Promise<void> {
    const session = socket.data ??= newVoiceSession();
    if (session.processingTurn) {
        sendEvent(socket, {
            type: "turn.busy",
            message: "Still finishing the previous turn.",
        });
        return;
    }
    session.processingTurn = true;
    try {
        sendEvent(socket, {
            type: "input.speech_end",
            bytes: wavBytes.byteLength,
        });
        const text = normalizeTranscript(await transcribeAudio(wavBytes));
        if (!text) {
            sendEvent(socket, {
                type: "input.no_speech",
                message: "No speech detected.",
            });
            return;
        }
        sendEvent(socket, {
            type: "transcript.partial",
            text,
        });
        await runCommittedTextTurn(socket, text);
    } finally {
        if (socket.data) {
            socket.data.processingTurn = false;
        }
    }
}

async function processTextTurn(socket: VoiceSocket, rawText: string): Promise<void> {
    const session = socket.data ??= newVoiceSession();
    if (session.processingTurn) {
        sendEvent(socket, {
            type: "turn.busy",
            message: "Still finishing the previous turn.",
        });
        return;
    }
    session.processingTurn = true;
    try {
        const text = normalizeTranscript(rawText);
        await runCommittedTextTurn(socket, text);
    } finally {
        if (socket.data) {
            socket.data.text = "";
            socket.data.processingTurn = false;
        }
    }
}

async function runCommittedTextTurn(socket: VoiceSocket, text: string): Promise<void> {
    if (!text) {
        sendEvent(socket, {
            type: "input.no_speech",
            message: "No speech detected.",
        });
        return;
    }
    sendEvent(socket, {
        type: "transcript.final",
        text,
    });
    const reply = await generateAssistantReply(socket, text);
    streamAssistantReply(socket, reply);
    const speech = await synthesizeSpeech(reply);
    sendEvent(socket, {
        type: "assistant.audio",
        contentType: "audio/wav",
        bytes: speech.byteLength,
    });
    socket.send(speech);
}

function int16FrameFromBytes(bytes: Uint8Array): Int16Array {
    const sampleCount = Math.floor(bytes.byteLength / 2);
    const frame = new Int16Array(sampleCount);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < sampleCount; index += 1) {
        frame[index] = view.getInt16(index * 2, true);
    }
    return frame;
}

function int16RootMeanSquare(frame: Int16Array): number {
    let sum = 0;
    for (const sample of frame) {
        const normalized = sample / 0x8000;
        sum += normalized * normalized;
    }
    return Math.sqrt(sum / frame.length);
}

function trimPreRoll(audio: AudioInputState): void {
    const maxSamples = Math.round(audioSampleRate * preRollMs / 1000);
    let sampleCount = audio.preRollChunks.reduce((total, chunk) => total + chunk.length, 0);
    while (sampleCount > maxSamples && audio.preRollChunks.length > 1) {
        const removed = audio.preRollChunks.shift();
        sampleCount -= removed?.length ?? 0;
    }
}

function pcmChunksToWav(chunks: Int16Array[]): Uint8Array {
    const pcm = flattenInt16(chunks);
    const buffer = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(buffer);
    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + pcm.length * 2, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, audioSampleRate, true);
    view.setUint32(28, audioSampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, "data");
    view.setUint32(40, pcm.length * 2, true);
    for (let index = 0; index < pcm.length; index += 1) {
        view.setInt16(44 + index * 2, pcm[index], true);
    }
    return new Uint8Array(buffer);
}

function flattenInt16(chunks: Int16Array[]): Int16Array {
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const result = new Int16Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}

function isWav(bytes: Uint8Array): boolean {
    return bytes.byteLength >= 12
        && bytes[0] === 0x52
        && bytes[1] === 0x49
        && bytes[2] === 0x46
        && bytes[3] === 0x46
        && bytes[8] === 0x57
        && bytes[9] === 0x41
        && bytes[10] === 0x56
        && bytes[11] === 0x45;
}

function writeAscii(view: DataView, offset: number, value: string): void {
    for (let index = 0; index < value.length; index += 1) {
        view.setUint8(offset + index, value.charCodeAt(index));
    }
}

async function transcribeAudio(audioBytes: Uint8Array): Promise<string> {
    const client = await oaicClient("asr-local-whisper");
    const result = await client.audio.transcriptions.create({
        file: new File([arrayBufferBody(audioBytes)], "chunk.wav", { type: "audio/wav" }),
        model: "local-whisper-cpp",
    });
    return result.text;
}

function arrayBufferBody(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

async function generateAssistantReply(socket: VoiceSocket, text: string): Promise<string> {
    socket.data ??= newVoiceSession();
    const nextMessages = chatHistoryWithUserTurn(socket.data.messages, text);

    sendEvent(socket, { type: "assistant.thinking" });
    const client = await oaicClient("llama");
    const response = await client.chat.completions.create({
        model: process.env.VOICE_CHAT_MODEL ?? "voice-chat-model",
        temperature: 0.7,
        max_tokens: 160,
        messages: [
            {
                role: "system",
                content: [
                    "You are a concise spoken conversation partner.",
                    "Answer naturally in one or two short sentences.",
                    "Avoid markdown, lists, code blocks, and long explanations.",
                ].join(" "),
            },
            ...nextMessages,
        ],
    });
    const reply = response.choices[0]?.message?.content?.trim()
        || "I heard you, but I do not have a good reply yet.";
    socket.data.messages = trimChatHistory([
        ...nextMessages,
        { role: "assistant", content: reply },
    ]);
    return reply;
}

function chatHistoryWithUserTurn(messages: ChatMessage[], text: string): ChatMessage[] {
    const history = normalizeChatHistory(messages);
    if (history.at(-1)?.role === "user") {
        history.pop();
    }
    history.push({ role: "user", content: text });
    return trimChatHistory(history);
}

function normalizeChatHistory(messages: ChatMessage[]): ChatMessage[] {
    const normalized: ChatMessage[] = [];
    let expected: ChatMessage["role"] = "user";
    for (const message of messages) {
        const content = message.content.trim();
        if (!content || message.role !== expected) {
            continue;
        }
        normalized.push({ role: message.role, content });
        expected = message.role === "user" ? "assistant" : "user";
    }
    return normalized;
}

function trimChatHistory(messages: ChatMessage[]): ChatMessage[] {
    let trimmed = normalizeChatHistory(messages);
    while (trimmed.length > 8) {
        trimmed = trimmed.slice(2);
    }
    return trimmed;
}

async function synthesizeSpeech(text: string): Promise<Uint8Array> {
    const client = await oaicClient("tts-local-kokoro");
    const response = await client.audio.speech.create({
        model: "local-kokoro",
        voice: process.env.VOICE_TTS_VOICE ?? "alloy",
        input: prepareSpeechText(text),
    });
    return new Uint8Array(await response.arrayBuffer());
}

function normalizeTranscript(text: string): string {
    const normalized = text
        .replace(/\[[^\]]*]/g, " ")
        .replace(/\([^)]*\)/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const lower = normalized.toLowerCase().replace(/[.!?,;:\s]+$/g, "");
    if (!lower || noSpeechPhrases().has(lower)) {
        return "";
    }
    return normalized;
}

function noSpeechPhrases(): ReadonlySet<string> {
    return new Set([
        "blank audio",
        "no speech",
        "silence",
        "thanks for watching",
    ]);
}

function prepareSpeechText(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/[*_#>~]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 700);
}

async function systemReadiness(): Promise<{ ok: boolean; items: ReadinessItem[] }> {
    const items = await Promise.all([
        Promise.resolve<ReadinessItem>({
            name: "voice-session",
            kind: "workload",
            status: "ready",
            detail: "Browser WebSocket workload is serving.",
        }),
        modelReadiness("llama", "LLM", "Local llama.cpp chat model"),
        modelReadiness("asr-local-whisper", "ASR", "Local Whisper speech recognition"),
        modelReadiness("tts-local-kokoro", "TTS", "Local Kokoro neural speech synthesis"),
    ]);
    return {
        ok: items.every((item) => item.status === "ready"),
        items,
    };
}

async function modelReadiness(
    workload: string,
    name: string,
    detail: string,
): Promise<ReadinessItem> {
    try {
        const client = await oaicClient(workload);
        const models = await withTimeout(client.models.list(), 2_500);
        const firstModel = models.data[0] as {
            id?: string;
            status?: string;
            source?: string;
            error?: string | null;
            load_ms?: number | null;
        } | undefined;
        const status = firstModel?.status === "loading" ? "loading" : "ready";
        return {
            name,
            kind: "model",
            status,
            detail: firstModel?.error ?? detail,
            model: firstModel?.source ?? firstModel?.id,
            loadMs: firstModel?.load_ms ?? null,
        };
    } catch (error) {
        return {
            name,
            kind: "model",
            status: "loading",
            detail: error instanceof Error ? error.message : detail,
        };
    }
}

async function oaicClient(workload: string): Promise<OpenAI> {
    return await createOaicClient(
        sdk,
        workloadMid(workload),
        endpointPath("/oaic"),
    );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`not ready after ${timeoutMs}ms`));
        }, timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timeout);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timeout);
                reject(error);
            },
        );
    });
}

function streamAssistantReply(socket: VoiceSocket, reply: string): void {
    for (const part of reply.split(" ")) {
        sendEvent(socket, {
            type: "assistant.delta",
            text: `${part} `,
        });
    }
    sendEvent(socket, {
        type: "assistant.message",
        text: reply,
    });
    sendEvent(socket, {
        type: "assistant.done",
    });
}

function sendEvent(socket: VoiceSocket, event: Record<string, unknown>): void {
    socket.send(JSON.stringify(event));
}

function mountedUrl(request: Request): URL {
    const url = new URL(request.url);
    if (url.pathname === "/http") {
        url.pathname = "/";
    } else if (url.pathname.startsWith("/http/")) {
        url.pathname = url.pathname.slice("/http".length);
    }
    return url;
}

function clientAssetPath(pathname: string): string | null {
    if (pathname === "/pcm-worklet.js" || pathname === "/voice/pcm-worklet.js") {
        return "pcm-worklet.js";
    }
    if (pathname.startsWith("/assets/")) {
        return pathname.slice(1);
    }
    if (pathname.startsWith("/voice/assets/")) {
        return pathname.slice("/voice/".length);
    }
    return null;
}

async function serveClientFile(relativePath: string): Promise<Response> {
    const filePath = safeClientFilePath(relativePath);
    if (!filePath) {
        return new Response("not found", { status: 404 });
    }
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
        return new Response("not found", { status: 404 });
    }
    return new Response(file, {
        headers: {
            "content-type": contentTypeFor(filePath),
        },
    });
}

function safeClientFilePath(relativePath: string): string | null {
    const parts = relativePath
        .split("/")
        .filter((part) => part.length > 0 && part !== "." && part !== "..");
    if (parts.length === 0) {
        return join(clientDistDir, "index.html");
    }
    return join(clientDistDir, ...parts);
}

function contentTypeFor(path: string): string {
    if (path.endsWith(".html")) return "text/html; charset=utf-8";
    if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
    if (path.endsWith(".css")) return "text/css; charset=utf-8";
    if (path.endsWith(".svg")) return "image/svg+xml";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    if (path.endsWith(".webp")) return "image/webp";
    return "application/octet-stream";
}

type Bind =
    | { kind: "unix"; path: string }
    | { kind: "tcp"; host: string; port: number };

function parseBind(value: string | undefined): Bind {
    if (value?.startsWith("unix:")) {
        return { kind: "unix", path: value.slice("unix:".length) };
    }
    if (value?.startsWith("tcp:")) {
        const rest = value.slice("tcp:".length);
        const lastColon = rest.lastIndexOf(":");
        return {
            kind: "tcp",
            host: rest.slice(0, lastColon),
            port: Number(rest.slice(lastColon + 1)),
        };
    }
    throw new Error(`unsupported bind: ${value}`);
}

function listenOptions(bind: Bind): { unix: string } | { hostname: string; port: number } {
    if (bind.kind === "unix") {
        return { unix: bind.path };
    }
    return { hostname: bind.host, port: bind.port };
}
