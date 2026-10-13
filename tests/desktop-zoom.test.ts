import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { handleZoomShortcut } = require("../electron/zoom.cjs");

function createZoom(initial = 1) {
  let factor = initial;
  let prevented = false;
  const contents = {
    getZoomFactor: () => factor,
    setZoomFactor: (next: number) => { factor = next; },
  };
  const press = (key: string, options: Record<string, unknown> = {}) => {
    prevented = false;
    handleZoomShortcut(
      { preventDefault: () => { prevented = true; } },
      { type: "keyDown", key, control: true, meta: false, alt: false, ...options },
      contents,
    );
    return { factor, prevented };
  };
  return { press, get factor() { return factor; } };
}

test("desktop zoom shortcuts increase, decrease and restore the default", () => {
  const zoom = createZoom();
  assert.deepEqual(zoom.press("="), { factor: 1.1, prevented: true });
  assert.deepEqual(zoom.press("+", { shift: true, meta: true, control: false }), { factor: 1.25, prevented: true });
  assert.deepEqual(zoom.press("-"), { factor: 1.1, prevented: true });
  assert.deepEqual(zoom.press("0"), { factor: 1, prevented: true });
});

test("desktop zoom shortcuts stay between 50% and 200%", () => {
  const zoom = createZoom();
  for (let step = 0; step < 20; step += 1) zoom.press("+");
  assert.equal(zoom.factor, 2);
  for (let step = 0; step < 20; step += 1) zoom.press("-");
  assert.equal(zoom.factor, 0.5);
});

test("unrelated keys and key-up events are not intercepted", () => {
  const zoom = createZoom();
  assert.deepEqual(zoom.press("a"), { factor: 1, prevented: false });
  assert.deepEqual(zoom.press("=", { type: "keyUp" }), { factor: 1, prevented: false });
  assert.deepEqual(zoom.press("=", { control: false, meta: false }), { factor: 1, prevented: false });
  assert.deepEqual(zoom.press("=", { alt: true }), { factor: 1, prevented: false });
});
