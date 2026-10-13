const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

function handleZoomShortcut(event, input, contents) {
  if (input.type !== "keyDown" || (!input.control && !input.meta) || input.alt) return;
  const key = input.key.toLowerCase();
  if (!["+", "=", "-", "0", "add", "subtract"].includes(key)) return;

  event.preventDefault();
  if (key === "0") {
    contents.setZoomFactor(1);
    return;
  }

  const current = contents.getZoomFactor();
  if (key === "-" || key === "subtract") {
    const next = [...ZOOM_LEVELS].reverse().find((factor) => factor < current - 0.01);
    if (next !== undefined) contents.setZoomFactor(next);
    return;
  }

  const next = ZOOM_LEVELS.find((factor) => factor > current + 0.01);
  if (next !== undefined) contents.setZoomFactor(next);
}

module.exports = { handleZoomShortcut };
