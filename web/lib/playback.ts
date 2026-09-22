import type { ActionFrame } from "./types";

export type PlaybackFrame = {
  id: string;
  label: string;
  screenshot?: string;
  available: boolean;
  events: ActionFrame[];
  action?: ActionFrame["action"];
};

/** Keep feedback with its logged action; never infer an action for an orphan image. */
export function buildPlayback(
  frames: ActionFrame[],
  screenshots: string[],
): PlaybackFrame[] {
  const available = new Set(screenshots);
  const used = new Set<string>();
  const timeline: Array<PlaybackFrame & { order: number }> = [];
  const steps = new Map<number, PlaybackFrame>();
  frames.forEach((event, index) => {
    const prior = event.step === undefined ? undefined : steps.get(event.step);
    if (prior && !event.action && !event.screenshot) {
      prior.events.push(event);
      return;
    }
    const screenshot = event.screenshot;
    if (screenshot) used.add(screenshot);
    const item = {
      id: `event-${index}`,
      label:
        event.step === undefined ? `Event ${index + 1}` : `Step ${event.step}`,
      screenshot,
      available: !!screenshot && available.has(screenshot),
      events: [event],
      action: event.action,
      order: event.step ?? index + 1,
    };
    timeline.push(item);
    if (event.step !== undefined) steps.set(event.step, item);
  });
  for (const screenshot of available) {
    if (used.has(screenshot)) continue;
    const isFinal = screenshot === "final.jpg";
    const step = /^\d+\.jpg$/.test(screenshot)
      ? Number(screenshot.slice(0, -4))
      : undefined;
    timeline.push({
      id: `image-${screenshot}`,
      label: isFinal
        ? "Final state"
        : step === undefined
          ? screenshot
          : `Step ${step} · image only`,
      screenshot,
      available: true,
      events: [],
      order: isFinal ? Infinity : (step ?? Infinity),
    });
  }
  return timeline
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...item }) => item);
}

/** The desktop adapter accepts integer coordinates in a 1280 × 720 viewport. */
export function clickPosition(
  action: ActionFrame["action"],
  width: number,
  height: number,
) {
  if (
    width !== 1280 ||
    height !== 720 ||
    !action ||
    ![
      "left_click",
      "right_click",
      "middle_click",
      "double_click",
      "triple_click",
    ].includes(action.kind)
  )
    return null;
  const point = action.params.coordinate;
  if (
    !Array.isArray(point) ||
    point.length !== 2 ||
    point.some(
      (value) => typeof value !== "number" || !Number.isInteger(value),
    ) ||
    point[0] < 0 ||
    point[0] >= width ||
    point[1] < 0 ||
    point[1] >= height
  )
    return null;
  return { left: (point[0] / width) * 100, top: (point[1] / height) * 100 };
}
