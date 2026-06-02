import { useEffect, useMemo, useRef, useState } from "react";

type Health = {
    ok: boolean;
    workload: string;
    title: string;
};

type ServerEvent = {
    type?: string;
    text?: string;
    message?: string;
    bytes?: number;
};

type ConversationState =
    | "idle"
    | "connecting"
    | "listening"
    | "transcribing"
    | "thinking"
    | "speaking";

type Metrics = {
    asrMs: number | null;
    llmMs: number | null;
    ttsMs: number | null;
    totalMs: number | null;
};

type TurnTiming = {
    audioSentAt?: number;
    commitSentAt?: number;
    assistantAt?: number;
};

type AudioWorkletMessage = {
    type?: string;
    buffer?: ArrayBuffer;
    level?: number;
};

type DebugEvent = {
    at: string;
    label: string;
    detail: string;
};

type AudioStats = {
    framesSent: number;
    lastFrameAt: number | null;
    blockedReason: string;
};

type ReadinessItem = {
    name: string;
    kind: "workload" | "model";
    status: "ready" | "loading" | "error";
    detail: string;
    model?: string;
    loadMs?: number | null;
};

type Readiness = {
    ok: boolean;
    items: ReadinessItem[];
};

const publicBasePath = "/voice";

export function App() {
    const [health, setHealth] = useState<Health | null>(null);
    const [socketStatus, setSocketStatus] = useState("idle");
    const [conversationActive, setConversationActive] = useState(false);
    const [conversationState, setConversationState] = useState<ConversationState>("idle");
    const [transcript, setTranscript] = useState("");
    const [assistantText, setAssistantText] = useState("");
    const [level, setLevel] = useState(0);
    const [metrics, setMetrics] = useState<Metrics>({
        asrMs: null,
        llmMs: null,
        ttsMs: null,
        totalMs: null,
    });
    const [turns, setTurns] = useState<Array<{ role: "you" | "assistant"; text: string }>>([]);
    const [draftText, setDraftText] = useState("Tell me one surprising fact about local AI.");
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const [lastReason, setLastReason] = useState("Idle.");
    const [lastServerEvent, setLastServerEvent] = useState("none");
    const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([]);
    const [audioContextState, setAudioContextState] = useState<AudioContextState | "none">("none");
    const [audioStats, setAudioStats] = useState<AudioStats>({
        framesSent: 0,
        lastFrameAt: null,
        blockedReason: "not started",
    });
    const [readiness, setReadiness] = useState<Readiness>({
        ok: false,
        items: [],
    });
    const socketRef = useRef<WebSocket | null>(null);
    const conversationActiveRef = useRef(false);
    const streamRef = useRef<MediaStream | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const processorRef = useRef<AudioWorkletNode | null>(null);
    const audioSendingRef = useRef(false);
    const sendingTurnRef = useRef(false);
    const assistantDraftRef = useRef("");
    const timingRef = useRef<TurnTiming>({});
    const outputAudioRef = useRef<HTMLAudioElement | null>(null);
    const mutedGainRef = useRef<GainNode | null>(null);
    const framesSentRef = useRef(0);
    const lastAudioStatsAtRef = useRef(0);

    useEffect(() => {
        void fetch(`${publicBasePath}/api/health`)
            .then((response) => response.json())
            .then((payload: Health) => setHealth(payload));
    }, []);

    useEffect(() => {
        let cancelled = false;
        async function pollReadiness(): Promise<void> {
            try {
                const response = await fetch(`${publicBasePath}/api/readiness`);
                const payload = await response.json() as Readiness;
                if (!cancelled) {
                    setReadiness(payload);
                }
            } catch {
                if (!cancelled) {
                    setReadiness({
                        ok: false,
                        items: [
                            {
                                name: "system",
                                kind: "workload",
                                status: "loading",
                                detail: "Waiting for readiness endpoint.",
                            },
                        ],
                    });
                }
            }
        }

        void pollReadiness();
        const interval = window.setInterval(() => void pollReadiness(), 3_000);
        return () => {
            cancelled = true;
            window.clearInterval(interval);
        };
    }, []);

    useEffect(() => {
        if (!audioUrl) {
            return;
        }
        outputAudioRef.current?.play().catch((error: unknown) => {
            sendingTurnRef.current = false;
            audioSendingRef.current = conversationActiveRef.current;
            note("audio playback failed", errorMessage(error));
            if (conversationActiveRef.current) {
                setConversationState("listening");
                void startListening().catch(handleListeningError);
            } else {
                setConversationState("idle");
            }
        });
    }, [audioUrl]);

    const wsUrl = useMemo(() => {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        return `${protocol}//${window.location.host}${publicBasePath}/ws`;
    }, []);

    const primaryLabel = conversationActive ? "End conversation" : "Start conversation";

    async function toggleConversation() {
        if (conversationActiveRef.current) {
            await stopConversation();
            return;
        }
        setConversationActiveValue(true);
        try {
            setTurns([]);
            setTranscript("");
            setAssistantText("");
            setMetrics({ asrMs: null, llmMs: null, ttsMs: null, totalMs: null });
            resetAudioStats();
            note("conversation starting", "Opening WebSocket and microphone.");
            setConversationState("connecting");
            await ensureSocket();
            await startListening();
        } catch (error) {
            setConversationActiveValue(false);
            await stopMic();
            setSocketStatus("error");
            const message = errorMessage(error);
            note("conversation failed", message);
            setAssistantText(message);
            setConversationState("idle");
        }
    }

    async function ensureSocket(): Promise<void> {
        const current = socketRef.current;
        if (current?.readyState === WebSocket.OPEN) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(wsUrl);
            socket.binaryType = "arraybuffer";
            socketRef.current = socket;
            setSocketStatus("connecting");
            socket.onopen = () => {
                setSocketStatus("open");
                note("websocket open", wsUrl);
                send({ type: "session.start" });
                resolve();
            };
            socket.onmessage = (event) => {
                if (typeof event.data === "string") {
                    handleServerEvent(event.data);
                    return;
                }
                const now = performance.now();
                audioSendingRef.current = false;
                note("audio response received", `${event.data.byteLength} bytes`);
                const blob = new Blob([event.data], { type: "audio/wav" });
                setAudioUrl((currentUrl) => {
                    if (currentUrl) URL.revokeObjectURL(currentUrl);
                    return URL.createObjectURL(blob);
                });
                setMetrics((currentMetrics) => ({
                    ...currentMetrics,
                    ttsMs: timingRef.current.assistantAt
                        ? Math.round(now - timingRef.current.assistantAt)
                        : currentMetrics.ttsMs,
                    totalMs: timingRef.current.audioSentAt
                        ? Math.round(now - timingRef.current.audioSentAt)
                        : currentMetrics.totalMs,
                }));
                setConversationState("speaking");
            };
            socket.onclose = (event) => {
                const detail = `${event.code}${event.reason ? ` ${event.reason}` : ""}`;
                setSocketStatus(`closed ${event.code}`);
                note("websocket closed", event.wasClean ? detail : `${detail} not clean`);
                socketRef.current = null;
                if (conversationActiveRef.current) {
                    setConversationState("idle");
                    setConversationActiveValue(false);
                }
            };
            socket.onerror = () => {
                setSocketStatus("error");
                note("websocket error", "The browser reported a socket failure.");
                setConversationActiveValue(false);
                reject(new Error("websocket failed"));
            };
        });
    }

    function setConversationActiveValue(value: boolean): void {
        conversationActiveRef.current = value;
        setConversationActive(value);
    }

    function handleServerEvent(raw: string) {
        const event = parseServerEvent(raw);
        const now = performance.now();
        setLastServerEvent(event.type ?? "unknown");
        if (event.type) {
            note(`server ${event.type}`, event.message ?? event.text ?? bytesLabel(event.bytes));
        }
        if (event.type === "input.speech_start") {
            setTranscript("");
            setAssistantText("");
            setConversationState("listening");
            return;
        }
        if (event.type === "input.speech_end") {
            audioSendingRef.current = false;
            sendingTurnRef.current = true;
            timingRef.current = { audioSentAt: now };
            setMetrics({ asrMs: null, llmMs: null, ttsMs: null, totalMs: null });
            setConversationState("transcribing");
            return;
        }
        if (event.type === "transcript.partial" && event.text) {
            setTranscript(event.text);
            setTurns((current) => appendTurn(current, { role: "you", text: event.text! }));
            setMetrics((currentMetrics) => ({
                ...currentMetrics,
                asrMs: timingRef.current.audioSentAt
                    ? Math.round(now - timingRef.current.audioSentAt)
                    : currentMetrics.asrMs,
            }));
            return;
        }
        if (event.type === "transcript.final" && event.text) {
            setTranscript(event.text);
            return;
        }
        if (event.type === "assistant.thinking") {
            assistantDraftRef.current = "";
            timingRef.current.commitSentAt = now;
            setAssistantText("");
            setConversationState("thinking");
            return;
        }
        if (event.type === "assistant.delta" && event.text) {
            assistantDraftRef.current += event.text;
            setAssistantText(assistantDraftRef.current.trim());
            return;
        }
        if (event.type === "assistant.message" && event.text) {
            assistantDraftRef.current = event.text;
            timingRef.current.assistantAt = now;
            setAssistantText(event.text);
            setTurns((current) => appendTurn(current, { role: "assistant", text: event.text! }));
            setMetrics((currentMetrics) => ({
                ...currentMetrics,
                llmMs: timingRef.current.commitSentAt
                    ? Math.round(now - timingRef.current.commitSentAt)
                    : currentMetrics.llmMs,
            }));
            return;
        }
        if (event.type === "input.no_speech") {
            sendingTurnRef.current = false;
            audioSendingRef.current = conversationActiveRef.current;
            setTranscript("");
            setAssistantText("I did not catch that. I am still listening.");
            if (conversationActiveRef.current) {
                setConversationState("listening");
            } else {
                setConversationState("idle");
            }
            return;
        }
        if (event.type === "turn.busy") {
            setAssistantText(event.message ?? "Still finishing the previous turn.");
            return;
        }
        if (event.type === "assistant.audio") {
            return;
        }
        if (event.type === "error" && event.message) {
            sendingTurnRef.current = false;
            audioSendingRef.current = conversationActiveRef.current;
            setAssistantText(event.message);
            if (conversationActiveRef.current) {
                setConversationState("listening");
            } else {
                setConversationState("idle");
            }
        }
    }

    function handleListeningError(error: unknown): void {
        setConversationActiveValue(false);
        setSocketStatus("error");
        const message = errorMessage(error);
        note("microphone stopped", message);
        setAssistantText(message);
        setConversationState("idle");
    }

    async function startListening() {
        if (!conversationActiveRef.current) {
            return;
        }
        audioSendingRef.current = true;
        if (streamRef.current && audioContextRef.current) {
            setConversationState("listening");
            note("microphone resumed", "Capture graph already exists.");
            return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        });
        const audioContext = new AudioContext();
        await audioContext.resume();
        setAudioContextState(audioContext.state);
        audioContext.onstatechange = () => {
            setAudioContextState(audioContext.state);
            if (audioContext.state !== "running") {
                note("audio context state", audioContext.state);
            }
        };
        await audioContext.audioWorklet.addModule(`${publicBasePath}/pcm-worklet.js`);
        const source = audioContext.createMediaStreamSource(stream);
        const processor = new AudioWorkletNode(audioContext, "voice-pcm-capture");
        const mutedGain = audioContext.createGain();
        mutedGain.gain.value = 0;
        for (const track of stream.getAudioTracks()) {
            track.onended = () => {
                handleListeningError(new Error("Microphone track ended."));
            };
        }
        streamRef.current = stream;
        audioContextRef.current = audioContext;
        sourceRef.current = source;
        processorRef.current = processor;
        mutedGainRef.current = mutedGain;
        processor.port.onmessage = (event: MessageEvent<AudioWorkletMessage>) => {
            const message = event.data;
            if (typeof message.level === "number") {
                const nextLevel = message.level;
                setLevel((current) => current * 0.7 + Math.min(1, nextLevel * 14) * 0.3);
            }
            if (message.type !== "audio" || !message.buffer) {
                return;
            }
            const socket = socketRef.current;
            if (
                !conversationActiveRef.current
                || !audioSendingRef.current
                || sendingTurnRef.current
                || socket?.readyState !== WebSocket.OPEN
            ) {
                updateAudioBlockedReason(blockedAudioReason(socket));
                return;
            }
            framesSentRef.current += 1;
            updateAudioStats();
            socket.send(message.buffer);
        };
        source.connect(processor);
        processor.connect(mutedGain);
        mutedGain.connect(audioContext.destination);
        note("microphone streaming", "AudioWorklet is sending 20ms PCM frames.");
        setConversationState("listening");
    }

    async function stopConversation() {
        note("conversation stopped", "Main button pressed.");
        setConversationActiveValue(false);
        audioSendingRef.current = false;
        sendingTurnRef.current = false;
        await stopMic();
        outputAudioRef.current?.pause();
        if (outputAudioRef.current) {
            outputAudioRef.current.currentTime = 0;
        }
        setLevel(0);
        setConversationState("idle");
    }

    async function stopMic() {
        if (audioContextRef.current) {
            audioContextRef.current.onstatechange = null;
        }
        if (processorRef.current) {
            processorRef.current.port.onmessage = null;
        }
        processorRef.current?.disconnect();
        sourceRef.current?.disconnect();
        mutedGainRef.current?.disconnect();
        streamRef.current?.getTracks().forEach((track) => {
            track.onended = null;
            track.stop();
        });
        await audioContextRef.current?.close().catch(() => {});
        processorRef.current = null;
        sourceRef.current = null;
        mutedGainRef.current = null;
        streamRef.current = null;
        audioContextRef.current = null;
        setAudioContextState("none");
    }

    function sendTextTurn() {
        if (!draftText.trim()) {
            return;
        }
        void ensureSocket().then(() => {
            const now = performance.now();
            audioSendingRef.current = false;
            sendingTurnRef.current = true;
            timingRef.current = { audioSentAt: now, commitSentAt: now };
            note("text turn sent", draftText);
            setMetrics({ asrMs: 0, llmMs: null, ttsMs: null, totalMs: null });
            setTranscript(draftText);
            setTurns((current) => appendTurn(current, { role: "you", text: draftText }));
            send({ type: "input.text", text: draftText });
            send({ type: "input.commit" });
            setConversationState("thinking");
        });
    }

    function send(event: Record<string, unknown>) {
        socketRef.current?.send(JSON.stringify(event));
    }

    function note(label: string, detail = ""): void {
        const cleanDetail = detail.trim();
        const at = new Date().toLocaleTimeString([], { hour12: false });
        setLastReason(cleanDetail ? `${label}: ${cleanDetail}` : label);
        setDebugEvents((current) => [
            { at, label, detail: cleanDetail },
            ...current,
        ].slice(0, 12));
    }

    function resetAudioStats(): void {
        framesSentRef.current = 0;
        lastAudioStatsAtRef.current = 0;
        setAudioStats({
            framesSent: 0,
            lastFrameAt: null,
            blockedReason: "waiting for microphone",
        });
    }

    function updateAudioStats(): void {
        const now = performance.now();
        if (now - lastAudioStatsAtRef.current < 500) {
            return;
        }
        lastAudioStatsAtRef.current = now;
        setAudioStats({
            framesSent: framesSentRef.current,
            lastFrameAt: now,
            blockedReason: "streaming",
        });
    }

    function updateAudioBlockedReason(reason: string): void {
        const now = performance.now();
        if (now - lastAudioStatsAtRef.current < 500) {
            return;
        }
        lastAudioStatsAtRef.current = now;
        setAudioStats((current) => ({
            ...current,
            lastFrameAt: now,
            blockedReason: reason,
        }));
    }

    function blockedAudioReason(socket: WebSocket | null): string {
        if (!conversationActiveRef.current) return "conversation inactive";
        if (!audioSendingRef.current) return "waiting during assistant turn";
        if (sendingTurnRef.current) return "turn is being processed";
        if (socket?.readyState !== WebSocket.OPEN) return "websocket not open";
        return "blocked";
    }

    return (
        <main className="app-shell">
            <section className="workspace">
                <header className="topbar">
                    <div>
                        <p className="eyebrow">Local server-side voice</p>
                        <h1>Voice Session</h1>
                    </div>
                    <div className="status-row">
                        <span>{health?.ok ? "workload ready" : "starting"}</span>
                        <span>{readiness.ok ? "models ready" : "models loading"}</span>
                        <span>ws {socketStatus}</span>
                        <span>{conversationActive ? "conversation active" : "conversation idle"}</span>
                        <span>mic {audioContextState}</span>
                    </div>
                </header>

                <section className={`voice-stage state-${conversationState}`}>
                    <div className="orb-shell" aria-hidden="true">
                        <div
                            className="voice-orb"
                            style={{ transform: `scale(${1 + level * 0.18})` }}
                        >
                            <span />
                        </div>
                    </div>
                    <p className="state-copy">{stateCopy(conversationState)}</p>
                    <p className="reason-copy">{lastReason}</p>
                    <section className="conversation live-conversation" aria-label="live transcript">
                        <div className="transcript-pane">
                            <span>You</span>
                            <p>{userTranscriptText(transcript, conversationState, conversationActive)}</p>
                        </div>
                        <div className="transcript-pane assistant-pane">
                            <span>Assistant</span>
                            <p>{assistantReplyText(assistantText, conversationState)}</p>
                        </div>
                    </section>
                    <button
                        className="primary-voice-button"
                        type="button"
                        onClick={() => void toggleConversation()}
                    >
                        {primaryLabel}
                    </button>
                    <div className="meter" aria-hidden="true">
                        <span style={{ width: `${Math.max(8, Math.round(level * 100))}%` }} />
                    </div>
                </section>

                <section className="diagnostics" aria-label="voice diagnostics">
                    <Diagnostic label="State" value={conversationState} />
                    <Diagnostic label="Server event" value={lastServerEvent} />
                    <Diagnostic label="Frames sent" value={String(audioStats.framesSent)} />
                    <Diagnostic label="Capture" value={audioStats.blockedReason} />
                    <Diagnostic
                        label="Last frame"
                        value={audioStats.lastFrameAt === null ? "--" : `${Math.round(audioStats.lastFrameAt)}ms`}
                    />
                </section>

                <section className="readiness-panel" aria-label="system readiness">
                    <div className="section-heading">
                        <span>System readiness</span>
                        <strong>{readiness.ok ? "ready" : "starting"}</strong>
                    </div>
                    <div className="readiness-list">
                        {readiness.items.length === 0 ? (
                            <ReadinessRow
                                item={{
                                    name: "system",
                                    kind: "workload",
                                    status: "loading",
                                    detail: "Checking model services.",
                                }}
                            />
                        ) : readiness.items.map((item) => (
                            <ReadinessRow key={item.name} item={item} />
                        ))}
                    </div>
                </section>

                <section className="metrics-grid" aria-label="turn latency">
                    <Metric label="ASR" value={metrics.asrMs} />
                    <Metric label="LLM" value={metrics.llmMs} />
                    <Metric label="TTS" value={metrics.ttsMs} />
                    <Metric label="Total" value={metrics.totalMs} />
                </section>

                <details className="fallback">
                    <summary>Text fallback</summary>
                    <div className="text-fallback-row">
                        <input value={draftText} onChange={(event) => setDraftText(event.target.value)} />
                        <button type="button" onClick={sendTextTurn}>
                            Send
                        </button>
                    </div>
                </details>

                <details className="fallback">
                    <summary>Internal event log</summary>
                    <div className="event-log">
                        {debugEvents.length === 0 ? (
                            <p>No events yet.</p>
                        ) : debugEvents.map((event, index) => (
                            <p key={`${event.at}-${event.label}-${index}`}>
                                <span>{event.at}</span>
                                <strong>{event.label}</strong>
                                {event.detail ? ` ${event.detail}` : ""}
                            </p>
                        ))}
                    </div>
                </details>

                <details className="fallback">
                    <summary>Turn history</summary>
                    <div className="turn-list">
                        {turns.length === 0 ? (
                            <p>No turns yet.</p>
                        ) : turns.map((turn, index) => (
                            <p key={`${turn.role}-${index}`}>
                                <strong>{turn.role === "you" ? "You" : "Assistant"}:</strong> {turn.text}
                            </p>
                        ))}
                    </div>
                </details>

                {audioUrl ? (
                    <audio
                        ref={outputAudioRef}
                        className="hidden-audio"
                        controls
                        src={audioUrl}
                        onEnded={() => {
                            sendingTurnRef.current = false;
                            audioSendingRef.current = conversationActiveRef.current;
                            note("audio playback ended", "Listening resumed.");
                            if (conversationActiveRef.current) {
                                void startListening().catch(handleListeningError);
                            } else {
                                setConversationState("idle");
                            }
                        }}
                    />
                ) : null}
            </section>
        </main>
    );
}

function Metric({ label, value }: { label: string; value: number | null }) {
    return (
        <div className="metric">
            <span>{label}</span>
            <strong>{value === null ? "--" : `${value}ms`}</strong>
        </div>
    );
}

function Diagnostic({ label, value }: { label: string; value: string }) {
    return (
        <div className="diagnostic">
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}

function ReadinessRow({ item }: { item: ReadinessItem }) {
    return (
        <div className={`readiness-row readiness-${item.status}`}>
            <span className="readiness-dot" />
            <div>
                <strong>{item.name}</strong>
                <p>{readinessDetail(item)}</p>
            </div>
        </div>
    );
}

function readinessDetail(item: ReadinessItem): string {
    const loadText = typeof item.loadMs === "number" ? ` loaded in ${item.loadMs}ms` : "";
    const modelText = item.model ? `${item.model}${loadText}` : item.detail;
    if (item.status === "ready") return modelText;
    if (item.status === "error") return item.detail || "Failed.";
    return item.model ? `Loading ${item.model}` : item.detail;
}

function stateCopy(state: ConversationState): string {
    if (state === "connecting") return "Opening a private voice channel.";
    if (state === "listening") return "Streaming audio to the server. Pause briefly and I will answer.";
    if (state === "transcribing") return "Turning your voice into text on the server.";
    if (state === "thinking") return "Asking the local model.";
    if (state === "speaking") return "Speaking the answer from the server.";
    return "One click starts a hands-free local conversation.";
}

function userTranscriptText(
    transcript: string,
    state: ConversationState,
    active: boolean,
): string {
    if (transcript) return transcript;
    if (!active) return "Start the conversation and speak naturally.";
    if (state === "listening") return "Listening...";
    if (state === "transcribing") return "Transcribing your last turn...";
    return "Waiting for your next turn.";
}

function assistantReplyText(assistantText: string, state: ConversationState): string {
    if (assistantText) return assistantText;
    if (state === "thinking") return "Thinking...";
    if (state === "speaking") return "Speaking...";
    return "The assistant reply will appear here.";
}

function appendTurn(
    turns: Array<{ role: "you" | "assistant"; text: string }>,
    next: { role: "you" | "assistant"; text: string },
) {
    const last = turns.at(-1);
    if (last?.role === next.role) {
        return [...turns.slice(0, -1), next].slice(-8);
    }
    return [...turns, next].slice(-8);
}

function parseServerEvent(raw: string): ServerEvent {
    try {
        return JSON.parse(raw) as ServerEvent;
    } catch {
        return {};
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Could not start voice.";
}

function bytesLabel(bytes: number | undefined): string {
    return typeof bytes === "number" ? `${bytes} bytes` : "";
}
