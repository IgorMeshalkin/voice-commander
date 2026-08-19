import { rename, stat } from "node:fs/promises";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const RECORDINGS_DIR = process.env.VOICE_RECORDINGS_DIR ?? "/recordings";

export type AudioRecordingState =
  | { type: "recording"; elapsedSeconds: number }
  | { type: "saving" }
  | { type: "idle" };

export interface SavedAudioFile {
  filename: string;
  savedAt: Date;
  durationMs: number;
  sizeBytes: number;
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function pulseSource(command: "get-default-source" | "get-default-sink"): string {
  const result = spawnSync("pactl", [command], { encoding: "utf8" });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Не удалось определить PulseAudio-устройство: pactl ${command}`);
  }
  return result.stdout.trim();
}

export class AudioRecorder {
  private process: ChildProcess | null = null;
  private startedAt = 0;
  private elapsedTimer: NodeJS.Timeout | null = null;
  private temporaryPath: string | null = null;
  private stopping = false;

  constructor(
    private readonly onStateChange: (state: AudioRecordingState) => void,
    private readonly onFileSaved: (file: SavedAudioFile) => Promise<void>,
  ) {}

  get isBusy(): boolean {
    return this.process !== null || this.stopping;
  }

  get isRecording(): boolean {
    return this.process !== null && !this.stopping;
  }

  start(): void {
    if (this.isBusy) return;

    const inputSource = process.env.VOICE_AUDIO_SOURCE ?? pulseSource("get-default-source");
    const outputSource =
      process.env.VOICE_OUTPUT_SOURCE ?? `${pulseSource("get-default-sink")}.monitor`;
    this.temporaryPath = join(RECORDINGS_DIR, `.recording-${process.pid}-${Date.now()}.wav`);
    this.startedAt = Date.now();
    this.stopping = false;

    this.process = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-thread_queue_size",
        "1024",
        "-f",
        "pulse",
        "-i",
        inputSource,
        "-thread_queue_size",
        "1024",
        "-f",
        "pulse",
        "-i",
        outputSource,
        "-filter_complex",
        "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[a]",
        "-map",
        "[a]",
        "-ar",
        "48000",
        "-c:a",
        "pcm_s16le",
        "-y",
        this.temporaryPath,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );

    this.process.stderr?.setEncoding("utf8");
    this.process.stderr?.on("data", (message: string) => {
      if (message.trim()) console.error("ffmpeg:", message.trim());
    });
    this.process.once("error", (error) => {
      console.error("Не удалось запустить запись звука:", error.message);
      this.finishWithError();
    });
    this.process.once("exit", (code) => void this.finish(code));

    this.onStateChange({ type: "recording", elapsedSeconds: 0 });
    this.elapsedTimer = setInterval(() => {
      this.onStateChange({
        type: "recording",
        elapsedSeconds: Math.floor((Date.now() - this.startedAt) / 1_000),
      });
    }, 1_000);
    console.log(`Запись звука началась: ${inputSource} + ${outputSource}`);
  }

  stop(): void {
    if (!this.process || this.stopping) return;
    this.stopping = true;
    this.clearElapsedTimer();
    this.onStateChange({ type: "saving" });
    this.process.stdin?.write("q\n");
    this.process.stdin?.end();
  }

  shutdown(): void {
    this.clearElapsedTimer();
    this.process?.kill("SIGTERM");
  }

  private async finish(code: number | null): Promise<void> {
    const temporaryPath = this.temporaryPath;
    if (!temporaryPath) return;
    this.process = null;
    this.temporaryPath = null;
    this.stopping = false;
    this.clearElapsedTimer();

    if (code === 0) {
      const savedAt = new Date();
      const filename = `${timestamp(savedAt)}.wav`;
      const finalPath = join(RECORDINGS_DIR, filename);
      try {
        await rename(temporaryPath, finalPath);
        const fileStat = await stat(finalPath);
        const durationResult = spawnSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            finalPath,
          ],
          { encoding: "utf8" },
        );
        const measuredDuration = Number(durationResult.stdout.trim());
        const durationSeconds = Number.isFinite(measuredDuration)
          ? measuredDuration
          : Math.max(0, (savedAt.getTime() - this.startedAt) / 1_000);
        await this.onFileSaved({
          filename,
          savedAt,
          durationMs: Math.round(durationSeconds * 1_000),
          sizeBytes: fileStat.size,
        });
        console.log(`Запись сохранена: ${finalPath}`);
      } catch (error: unknown) {
        console.error("Не удалось сохранить запись:", error instanceof Error ? error.message : error);
      }
    } else {
      console.error(`Запись звука завершилась с кодом ${code ?? "unknown"}`);
    }
    this.onStateChange({ type: "idle" });
  }

  private finishWithError(): void {
    this.process = null;
    this.temporaryPath = null;
    this.stopping = false;
    this.clearElapsedTimer();
    this.onStateChange({ type: "idle" });
  }

  private clearElapsedTimer(): void {
    if (!this.elapsedTimer) return;
    clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
  }
}
