#!/usr/bin/env gjs

imports.gi.versions.Gtk = "3.0";
imports.gi.versions.Gdk = "3.0";

const { Gdk, GLib, Gtk } = imports.gi;

Gtk.init(null);

const SIZE = 64;
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
window.set_default_size(SIZE, SIZE);
window.stick();

const screen = window.get_screen();
const visual = screen.get_rgba_visual();
if (visual) window.set_visual(visual);

const drawingArea = new Gtk.DrawingArea();
drawingArea.set_size_request(SIZE, SIZE);
drawingArea.connect("draw", (_widget, context) => {
  context.setOperator(imports.cairo.Operator.CLEAR);
  context.paint();
  context.setOperator(imports.cairo.Operator.OVER);

  context.arc(SIZE / 2, SIZE / 2, 27, 0, Math.PI * 2);
  context.setSourceRGBA(1, 1, 1, 0.96);
  context.fill();

  context.arc(SIZE / 2, SIZE / 2, 20, 0, Math.PI * 2);
  context.setSourceRGBA(0.92, 0.05, 0.08, 1);
  context.fill();

  return false;
});
window.add(drawingArea);

window.connect("realize", () => {
  const display = Gdk.Display.get_default();
  const monitor = display.get_primary_monitor() ?? display.get_monitor(0);
  const geometry = monitor.get_geometry();
  window.move(
    geometry.x + geometry.width - SIZE - MARGIN,
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
GLib.io_add_watch(input, GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN | GLib.IOCondition.HUP, () => {
  const [status, line] = input.read_line();
  if (status === GLib.IOStatus.NORMAL) {
    if (line.trim() === "show") window.show_all();
    if (line.trim() === "hide") window.hide();
    return true;
  }

  Gtk.main_quit();
  return false;
});

Gtk.main();
