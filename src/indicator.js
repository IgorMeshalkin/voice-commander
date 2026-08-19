#!/usr/bin/env gjs

imports.gi.versions.Gtk = "3.0";
imports.gi.versions.Gdk = "3.0";

const { Gdk, GLib, Gtk } = imports.gi;
const ByteArray = imports.byteArray;

Gtk.init(null);

const SIZE = 64;
const WIDTH = 220;
const MARGIN = 28;

const window = new Gtk.Window({
  type: Gtk.WindowType.TOPLEVEL,
  decorated: false,
  resizable: false,
  skipPagerHint: true,
  skipTaskbarHint: true,
  typeHint: Gdk.WindowTypeHint.NOTIFICATION,
});

window.set_app_paintable(true);
window.set_keep_above(true);
window.set_accept_focus(false);
window.set_focus_on_map(false);
window.set_default_size(WIDTH, SIZE);
window.set_size_request(WIDTH, SIZE);
window.stick();

const screen = window.get_screen();
const visual = screen.get_rgba_visual();
if (visual) window.set_visual(visual);

const drawingArea = new Gtk.DrawingArea();
drawingArea.set_size_request(SIZE, SIZE);
const statusLabel = new Gtk.Label();
statusLabel.set_size_request(WIDTH - SIZE, SIZE);
statusLabel.set_margin_end(12);
statusLabel.set_xalign(1);
statusLabel.set_markup('<span foreground="white" weight="bold" size="large"></span>');
let indicatorColor = [0.92, 0.05, 0.08];
let pointerIsOverIndicator = false;
drawingArea.connect("draw", (_widget, context) => {
  context.setOperator(imports.cairo.Operator.CLEAR);
  context.paint();
  context.setOperator(imports.cairo.Operator.OVER);

  context.arc(SIZE / 2, SIZE / 2, 27, 0, Math.PI * 2);
  context.setSourceRGBA(1, 1, 1, 0.96);
  context.fill();

  context.arc(SIZE / 2, SIZE / 2, 20, 0, Math.PI * 2);
  context.setSourceRGBA(indicatorColor[0], indicatorColor[1], indicatorColor[2], 1);
  context.fill();

  if (pointerIsOverIndicator) {
    context.setSourceRGBA(1, 1, 1, 1);
    context.setLineWidth(4);
    context.setLineCap(imports.cairo.LineCap.ROUND);
    context.moveTo(24, 24);
    context.lineTo(40, 40);
    context.moveTo(40, 24);
    context.lineTo(24, 40);
    context.stroke();
  }

  return false;
});
drawingArea.add_events(
  Gdk.EventMask.ENTER_NOTIFY_MASK |
    Gdk.EventMask.LEAVE_NOTIFY_MASK |
    Gdk.EventMask.BUTTON_PRESS_MASK,
);
drawingArea.connect("enter-notify-event", () => {
  pointerIsOverIndicator = true;
  drawingArea.queue_draw();
  return true;
});
drawingArea.connect("leave-notify-event", () => {
  pointerIsOverIndicator = false;
  drawingArea.queue_draw();
  return true;
});
drawingArea.connect("button-press-event", () => {
  print("emergency");
  return true;
});
const content = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
content.pack_start(statusLabel, true, true, 0);
content.pack_end(drawingArea, false, false, 0);
window.add(content);

window.connect("realize", () => {
  const display = Gdk.Display.get_default();
  const monitor = display.get_primary_monitor() ?? display.get_monitor(0);
  const geometry = monitor.get_geometry();
  window.move(
    geometry.x + geometry.width - WIDTH - MARGIN,
    geometry.y + geometry.height - SIZE - MARGIN,
  );
});

window.connect("delete-event", () => {
  Gtk.main_quit();
  return true;
});

window.show_all();
window.hide();

const input = GLib.IOChannel.unix_new(0);
input.set_encoding("UTF-8");
input.set_flags(input.get_flags() | GLib.IOFlags.NONBLOCK);

function handleCommand(command) {
  if (command === "recording") {
    indicatorColor = [0.92, 0.05, 0.08];
    statusLabel.set_markup('<span foreground="white" weight="bold" size="large"></span>');
    drawingArea.queue_draw();
    window.show_all();
  }
  if (command === "processing") {
    indicatorColor = [1, 0.72, 0.02];
    statusLabel.set_markup(
      '<span foreground="white" weight="bold" size="large">Распознаю</span>',
    );
    drawingArea.queue_draw();
    window.show_all();
  }
  if (command === "status:recognizing") {
    statusLabel.set_markup(
      '<span foreground="white" weight="bold" size="large">Распознаю</span>',
    );
    window.show_all();
  }
  if (command === "status:inserting") {
    statusLabel.set_markup(
      '<span foreground="white" weight="bold" size="large">Вставляю текст</span>',
    );
    window.show_all();
  }
  if (command === "hide") window.hide();
  if (command.startsWith("submit:")) {
    const encodedText = command.slice("submit:".length);
    const text = ByteArray.toString(GLib.base64_decode(encodedText));
    const clipboard = Gtk.Clipboard.get(Gdk.Atom.intern("CLIPBOARD", false));
    const primary = Gtk.Clipboard.get(Gdk.Atom.intern("PRIMARY", false));
    clipboard.set_text(text, -1);
    primary.set_text(text, -1);
    clipboard.store();
    primary.store();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
      GLib.spawn_async(
        null,
        [
          "xdotool",
          "keyup",
          "Control_L",
          "Control_R",
          "Shift_L",
          "Shift_R",
          "key",
          "shift+Insert",
          "key",
          "Return",
        ],
        null,
        GLib.SpawnFlags.SEARCH_PATH,
        null,
      );
      return GLib.SOURCE_REMOVE;
    });
  }
}

GLib.io_add_watch(input, GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN | GLib.IOCondition.HUP, () => {
  while (true) {
    const [status, line] = input.read_line();
    if (status === GLib.IOStatus.NORMAL) {
      handleCommand(line.trim());
      continue;
    }
    if (status === GLib.IOStatus.AGAIN) return true;
    Gtk.main_quit();
    return false;
  }
});

Gtk.main();
