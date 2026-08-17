import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const HOLD_DELAY_MS = 1_000;

interface ShortcutKeycodes {
  control: Set<number>;
  space: number;
  yes: number;
}

function findShortcutKeycodes(): ShortcutKeycodes {
  const result = spawnSync("xmodmap", ["-pk"], { encoding: "utf8" });

  if (result.error || result.status !== 0) {
    throw new Error("Не удалось определить коды горячих клавиш через xmodmap");
  }

  const control = new Set<number>();
  let space: number | null = null;
  let yes: number | null = null;

  for (const line of result.stdout.split("\n")) {
    const keycode = Number(line.match(/^\s*(\d+)/)?.[1]);
    if (!Number.isFinite(keycode)) continue;

    if (/\bControl_[LR]\b/.test(line)) control.add(keycode);
    if (/\bspace\b/.test(line)) space = keycode;
    if (/\by\b/.test(line)) yes = keycode;
  }

  if (control.size === 0 || space === null || yes === null) {
    throw new Error("Не удалось найти Ctrl, Space или Y/Н в текущей X11-раскладке");
  }

  return { control, space, yes };
}

function startIndicator(): ChildProcess {
  const scriptPath = join(__dirname, "indicator.js");
  const process = spawn("gjs", [scriptPath], {
    stdio: ["pipe", "inherit", "inherit"],
  });

  process.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`Индикатор завершился с кодом ${code}`);
    }
  });

  return process;
}

function main(): void {
  if (process.env.XDG_SESSION_TYPE !== "x11") {
    throw new Error("Текущая версия прототипа поддерживает только X11");
  }

  const keycodes = findShortcutKeycodes();
  const indicator = startIndicator();
  const keyboard = spawn("xinput", ["test-xi2", "--root"], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  let currentEvent: "press" | "release" | null = null;
  let bufferedOutput = "";
  let holdTimer: NodeJS.Timeout | null = null;
  const pressedKeys = new Set<number>();
  let listeningIsActive = false;

  const setListening = (active: boolean): void => {
    if (listeningIsActive === active) return;
    listeningIsActive = active;
    indicator.stdin?.write(active ? "show\n" : "hide\n");
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
    }, HOLD_DELAY_MS);
  };

  const insertYes = (): void => {
    const typer = spawn("xdotool", ["type", "--clearmodifiers", "--delay", "0", "--", "Да"], {
      stdio: "inherit",
    });
    typer.once("error", (error) => {
      console.error("Не удалось вставить «Да»:", error.message);
    });
    typer.once("exit", (code) => {
      if (code !== 0) console.error(`Вставка «Да» завершилась с кодом ${code}`);
    });
  };

  const handlePress = (keycode: number): void => {
    if (pressedKeys.has(keycode)) return;
    pressedKeys.add(keycode);

    if (keycode === keycodes.yes && controlIsDown()) {
      insertYes();
    }
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

  const shutdown = (): void => {
    keyboard.kill();
    indicator.stdin?.end();
    indicator.kill();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  keyboard.once("error", (error) => {
    console.error("Не удалось запустить xinput:", error.message);
    shutdown();
    process.exitCode = 1;
  });

  console.log(
    `Ctrl+Space (${HOLD_DELAY_MS} мс) — прослушивание; Ctrl+Y/Н — вставить «Да». Для выхода нажмите Ctrl+C.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
