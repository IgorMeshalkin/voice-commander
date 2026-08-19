import { spawn, type ChildProcess } from "node:child_process";
import { availableParallelism } from "node:os";
import { join } from "node:path";

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const DEFAULT_CHUNK_MS = 8_000;
const MIN_FINAL_CHUNK_MS = 200;
const RECORDER_DRAIN_MS = 250;
const RECORDER_LATENCY_MS = 50;
const SILENCE_RMS_THRESHOLD = 250;
const SERVER_HOST = "127.0.0.1";
const SERVER_PORT = 18_080;
const DEFAULT_MAX_THREADS = 4;

interface WhisperResponse {
  text?: string;
}

interface RecognitionResult {
  session: number;
  text: string;
}

export type ProcessingState = "idle" | "recognizing" | "inserting";

export class SpeechPipeline {
  private readonly projectRoot = join(__dirname, "..");
  private readonly serverBinary =
    process.env.WHISPER_SERVER_PATH ??
    join(this.projectRoot, "vendor/whisper.cpp/build/bin/whisper-server");
  private readonly modelPath =
    process.env.WHISPER_MODEL_PATH ??
    join(this.projectRoot, "vendor/whisper.cpp/models/ggml-small-q5_1.bin");
  private readonly audioSource = process.env.VOICE_AUDIO_SOURCE ?? "@DEFAULT_SOURCE@";
  private readonly chunkMs = Number(process.env.VOICE_CHUNK_MS ?? DEFAULT_CHUNK_MS);
  private readonly chunkBytes = Math.round(
    (SAMPLE_RATE * BYTES_PER_SAMPLE * this.chunkMs) / 1_000,
  );
  private readonly threads = Number(
    process.env.VOICE_WHISPER_THREADS ??
      Math.min(DEFAULT_MAX_THREADS, Math.max(1, availableParallelism() - 2)),
  );

  private server: ChildProcess | null = null;
  private recorder: ChildProcess | null = null;
  private recorderIsStopping = false;
  private audioBuffer = Buffer.alloc(0);
  private sessionNumber = 0;
  private sequenceNumber = 0;
  private nextSequenceToInsert = 0;
  private readonly recognitionResults = new Map<number, RecognitionResult>();
  private pendingRecognitions = 0;
  private pendingInsertions = 0;
  private pendingRecorderStops = 0;

  constructor(private readonly onProcessingChange: (state: ProcessingState) => void) {}

  async start(): Promise<void> {
    this.server = spawn(
      this.serverBinary,
      [
        "--host",
        SERVER_HOST,
        "--port",
        String(SERVER_PORT),
        "--model",
        this.modelPath,
        "--language",
        "ru",
        "--threads",
        String(this.threads),
        "--no-timestamps",
      ],
      { cwd: this.projectRoot, stdio: ["ignore", "ignore", "pipe"] },
    );

    let serverError = "";
    this.server.stderr?.setEncoding("utf8");
    this.server.stderr?.on("data", (chunk: string) => {
      serverError = `${serverError}${chunk}`.slice(-4_000);
    });
    this.server.once("error", (error) => {
      console.error("Не удалось запустить whisper-server:", error.message);
    });

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (this.server.exitCode !== null) {
        throw new Error(`whisper-server завершился при запуске:\n${serverError.trim()}`);
      }

      try {
        await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/`);
        console.log("Локальная модель Whisper готова");
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }

    throw new Error("whisper-server не запустился за 60 секунд");
  }

  startListening(): void {
    if (this.recorder) return;

    this.sessionNumber += 1;
    this.recognitionResults.clear();
    this.nextSequenceToInsert = this.sequenceNumber;
    this.audioBuffer = Buffer.alloc(0);
    const session = this.sessionNumber;

    this.recorder = spawn(
      "parec",
      [
        "--raw",
        `--device=${this.audioSource}`,
        "--format=s16le",
        `--rate=${SAMPLE_RATE}`,
        "--channels=1",
        `--latency-msec=${RECORDER_LATENCY_MS}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    this.recorder.stdout?.on("data", (chunk: Buffer) => {
      this.audioBuffer = Buffer.concat([this.audioBuffer, chunk]);
      while (this.audioBuffer.length >= this.chunkBytes) {
        const audio = this.audioBuffer.subarray(0, this.chunkBytes);
        this.audioBuffer = this.audioBuffer.subarray(this.chunkBytes);
        this.enqueueRecognition(Buffer.from(audio), session);
      }
    });

    this.recorder.stderr?.setEncoding("utf8");
    this.recorder.stderr?.on("data", (message: string) => {
      if (message.trim()) console.error("parec:", message.trim());
    });
    this.recorder.once("error", (error) => {
      console.error("Не удалось запустить parec:", error.message);
      this.recorder = null;
    });
  }

  stopListening(): void {
    if (!this.recorder || this.recorderIsStopping) return;

    const recorder = this.recorder;
    const session = this.sessionNumber;
    this.recorderIsStopping = true;
    this.pendingRecorderStops += 1;
    this.notifyProcessingState();

    recorder.once("close", () => {
      if (this.recorder === recorder) this.recorder = null;
      this.recorderIsStopping = false;
      const minimumBytes = (SAMPLE_RATE * BYTES_PER_SAMPLE * MIN_FINAL_CHUNK_MS) / 1_000;
      if (this.audioBuffer.length >= minimumBytes) {
        const finalAudio = this.audioBuffer;
        this.audioBuffer = Buffer.alloc(0);
        this.enqueueRecognition(finalAudio, session);
      } else {
        this.audioBuffer = Buffer.alloc(0);
      }

      this.pendingRecorderStops -= 1;
      this.notifyProcessingState();
    });

    setTimeout(() => recorder.kill("SIGINT"), RECORDER_DRAIN_MS);
  }

  shutdown(): void {
    this.stopListening();
    this.server?.kill("SIGTERM");
    this.server = null;
  }

  private enqueueRecognition(pcm: Buffer, session: number): void {
    if (!this.hasAudibleSpeech(pcm)) return;

    const sequence = this.sequenceNumber;
    this.sequenceNumber += 1;
    this.pendingRecognitions += 1;
    this.notifyProcessingState();

    void this.recognize(pcm)
      .then((text) => {
        if (session !== this.sessionNumber) return;
        this.recognitionResults.set(sequence, { session, text });
        this.flushRecognitionResults();
      })
      .catch((error: unknown) => {
        console.error("Ошибка распознавания:", error instanceof Error ? error.message : error);
        if (session !== this.sessionNumber) return;
        this.recognitionResults.set(sequence, { session, text: "" });
        this.flushRecognitionResults();
      })
      .finally(() => {
        this.pendingRecognitions -= 1;
        this.notifyProcessingState();
      });
  }

  private flushRecognitionResults(): void {
    while (this.recognitionResults.has(this.nextSequenceToInsert)) {
      const result = this.recognitionResults.get(this.nextSequenceToInsert);
      this.recognitionResults.delete(this.nextSequenceToInsert);
      this.nextSequenceToInsert += 1;

      if (result?.text) this.insertText(result.text, result.session);
    }
  }

  private async recognize(pcm: Buffer): Promise<string> {
    const wav = this.createWav(pcm);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
    form.append("language", "ru");
    form.append("response_format", "json");
    form.append("temperature", "0.0");

    const response = await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/inference`, {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      throw new Error(`whisper-server вернул HTTP ${response.status}`);
    }

    const result = (await response.json()) as WhisperResponse;
    return (result.text ?? "")
      .replace(/\[[^\]]+]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private insertText(text: string, session: number): void {
    if (session !== this.sessionNumber) return;

    const value = `${text} `;
    console.log(`Распознано: ${text}`);

    const typer = spawn("xdotool", ["type", "--clearmodifiers", "--delay", "0", "--", value], {
      stdio: "inherit",
    });
    this.pendingInsertions += 1;
    let insertionFinished = false;
    const finishInsertion = (): void => {
      if (insertionFinished) return;
      insertionFinished = true;
      this.pendingInsertions -= 1;
      this.notifyProcessingState();
    };
    typer.once("error", (error) => {
      console.error("Не удалось вставить распознанный текст:", error.message);
      finishInsertion();
    });
    typer.once("exit", finishInsertion);
  }

  private notifyProcessingState(): void {
    if (this.recorder) return;
    if (this.pendingRecorderStops > 0 || this.pendingRecognitions > 0) {
      this.onProcessingChange("recognizing");
      return;
    }
    if (this.pendingInsertions > 0) {
      this.onProcessingChange("inserting");
      return;
    }
    this.onProcessingChange("idle");
  }

  private hasAudibleSpeech(pcm: Buffer): boolean {
    if (pcm.length < 2) return false;

    let sumSquares = 0;
    let samples = 0;
    for (let offset = 0; offset + 1 < pcm.length; offset += 8) {
      const sample = pcm.readInt16LE(offset);
      sumSquares += sample * sample;
      samples += 1;
    }

    return Math.sqrt(sumSquares / samples) >= SILENCE_RMS_THRESHOLD;
  }

  private createWav(pcm: Buffer): Buffer {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
    header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
  }
}
