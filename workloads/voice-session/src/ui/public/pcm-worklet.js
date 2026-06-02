const targetSampleRate = 16000;
const targetFrameSamples = 320;

class VoicePcmCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.sourcePosition = 0;
        this.pendingSamples = [];
        this.ratio = sampleRate / targetSampleRate;
    }

    process(inputs) {
        const input = inputs[0]?.[0];
        if (!input || input.length === 0) {
            return true;
        }

        let sum = 0;
        for (const sample of input) {
            sum += sample * sample;
        }
        const level = Math.sqrt(sum / input.length);

        while (this.sourcePosition < input.length - 1) {
            const left = Math.floor(this.sourcePosition);
            const right = Math.min(input.length - 1, left + 1);
            const weight = this.sourcePosition - left;
            const sample = input[left] * (1 - weight) + input[right] * weight;
            const clamped = Math.max(-1, Math.min(1, sample));
            this.pendingSamples.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
            this.sourcePosition += this.ratio;
        }
        this.sourcePosition -= input.length;

        while (this.pendingSamples.length >= targetFrameSamples) {
            const frame = new Int16Array(targetFrameSamples);
            for (let index = 0; index < targetFrameSamples; index += 1) {
                frame[index] = this.pendingSamples[index];
            }
            this.pendingSamples = this.pendingSamples.slice(targetFrameSamples);
            this.port.postMessage(
                {
                    type: "audio",
                    buffer: frame.buffer,
                    level,
                },
                [frame.buffer],
            );
        }

        return true;
    }
}

registerProcessor("voice-pcm-capture", VoicePcmCaptureProcessor);
