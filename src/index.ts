import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { SpeechPipeline } from "./speech.js";

const VOICE_HOLD_DELAY_MS = 1_000;

const PHRASE_SHORTCUTS = [
  { symbol: "y", keycode: 29, label: "Y/Н", text: "Да" },
  { symbol: "u", keycode: 30, label: "U/Г", text: "Нет" },
  { symbol: "i", keycode: 31, label: "I/Ш", text: "Согласовано, делай" },
  { symbol: "h", keycode: 43, label: "H/Р", text: "Готово" },
] as const;

interface ShortcutKeycodes {
  control: Set<number>;
  space: number;
  phrases: Map<number, string>;
}

function findShortcutKeycodes(): ShortcutKeycodes {
  const result = spawnSync("xmodmap", ["-pk"], { encoding: "utf8" });

  if (result.error || result.status !== 0) {
    throw new Error("Не удалось определить коды горячих клавиш через xmodmap");
  }

  const control = new Set<number>();
  let space: number | null = null;

  for (const line of result.stdout.split("\n")) {
    const keycode = Number(line.match(/^\s*(\d+)/)?.[1]);
    if (!Number.isFinite(keycode)) continue;

    if (/\bControl_[LR]\b/.test(line)) control.add(keycode);
    if (/\bspace\b/.test(line)) space = keycode;
  }

  if (control.size === 0 || space === null) {
    throw new Error("Не удалось найти Ctrl или Space в текущей X11-раскладке");
  }

  const phrases = new Map<number, string>(
    PHRASE_SHORTCUTS.map(({ keycode, text }) => [keycode, text]),
  );
  return { control, space, phrases };
}

function startIndicator(onEmergencyStop: () => void): ChildProcess {
  const scriptPath = join(__dirname, "indicator.js");
  const process = spawn("gjs", [scriptPath], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  let bufferedOutput = "";
  process.stdout?.setEncoding("utf8");
  process.stdout?.on("data", (chunk: string) => {
    bufferedOutput += chunk;
    const lines = bufferedOutput.split("\n");
    bufferedOutput = lines.pop() ?? "";
    if (lines.some((line) => line.trim() === "emergency")) onEmergencyStop();
  });

  process.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`Индикатор завершился с кодом ${code}`);
    }
  });

  return process;
}

async function main(): Promise<void> {
  if (process.env.XDG_SESSION_TYPE !== "x11") {
    throw new Error("Текущая версия прототипа поддерживает только X11");
  }

  const keycodes = findShortcutKeycodes();
  let indicator: ChildProcess | null = null;
  const speech = new SpeechPipeline(
    (state) => {
      indicator?.stdin?.write(state === "idle" ? "hide\n" : `status:${state}\n`);
    },
    (text) => {
      const encodedText = Buffer.from(text, "utf8").toString("base64");
      indicator?.stdin?.write(`copy:${encodedText}\n`);
    },
  );
  await speech.start();
  const keyboard = spawn("xinput", ["test-xi2", "--root"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  indicator = startIndicator(() => {
    console.error("Аварийное завершение по кнопке индикатора");
    keyboard.kill();
    speech.shutdown();
    indicator?.kill();
    process.exit(0);
  });

  let currentEvent: "press" | "release" | null = null;
  let bufferedOutput = "";
  let holdTimer: NodeJS.Timeout | null = null;
  const pressedKeys = new Set<number>();
  let listeningIsActive = false;

  const setListening = (active: boolean): void => {
    if (listeningIsActive === active) return;
    listeningIsActive = active;
    if (active) {
      speech.startListening();
      indicator?.stdin?.write("recording\n");
    } else {
      indicator?.stdin?.write("processing\n");
      speech.stopListening();
    }
    console.log(active ? "Режим прослушивания включён" : "Режим прослушивания выключен");
  };

  const controlIsDown = (): boolean =>
    [...keycodes.control].some((keycode) => pressedKeys.has(keycode));

  const activationKeysAreDown = (): boolean =>
    controlIsDown() && pressedKeys.has(keycodes.space);

  const cancelActivation = (): void => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    setListening(false);
  };

  const beginActivation = (): void => {
    if (holdTimer || listeningIsActive || !activationKeysAreDown()) return;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (activationKeysAreDown()) setListening(true);
    }, VOICE_HOLD_DELAY_MS);
  };

  const submitPhrase = (text: string): void => {
    const encodedText = Buffer.from(text, "utf8").toString("base64");
    indicator?.stdin?.write(`submit:${encodedText}\n`);
  };

  const handlePress = (keycode: number): void => {
    if (pressedKeys.has(keycode)) return;
    pressedKeys.add(keycode);

    const phrase = keycodes.phrases.get(keycode);
    if (phrase && controlIsDown()) submitPhrase(phrase);
    beginActivation();
  };

  const handleRelease = (keycode: number): void => {
    pressedKeys.delete(keycode);
    if (!activationKeysAreDown()) cancelActivation();
  };

  keyboard.stdout.setEncoding("utf8");
  keyboard.stdout.on("data", (chunk: string) => {
    bufferedOutput += chunk;
    const lines = bufferedOutput.split("\n");
    bufferedOutput = lines.pop() ?? "";

    for (const line of lines) {
      if (line.includes("RawKeyPress")) currentEvent = "press";
      if (line.includes("RawKeyRelease")) currentEvent = "release";

      const detail = line.match(/^\s*detail:\s*(\d+)/);
      if (detail) {
        const keycode = Number(detail[1]);
        if (currentEvent === "press") handlePress(keycode);
        if (currentEvent === "release") handleRelease(keycode);
      }
    }
  });

  const shutdown = (exitCode = 0): void => {
    keyboard.kill();
    indicator?.stdin?.end();
    indicator?.kill();
    speech.shutdown();
    process.exit(exitCode);
  };

  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());
  keyboard.once("error", (error) => {
    console.error("Не удалось запустить xinput:", error.message);
    shutdown(1);
  });

  console.log(
    `Ctrl+Space (${VOICE_HOLD_DELAY_MS} мс) — прослушивание; команды: ${PHRASE_SHORTCUTS.map(({ label, text }) => `Ctrl+${label} — «${text}»`).join("; ")}. Для выхода нажмите Ctrl+C.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
