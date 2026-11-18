function normalized(range, durationFrames) {
  const startFrame = Math.max(0, Math.min(durationFrames, Math.round(range.startFrame)));
  const endFrame = Math.max(0, Math.min(durationFrames, Math.round(range.endFrame)));
  return startFrame <= endFrame
    ? { ...range, startFrame, endFrame }
    : { ...range, startFrame: endFrame, endFrame: startFrame };
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.startFrame <= previous.endFrame) {
      previous.endFrame = Math.max(previous.endFrame, range.endFrame);
    } else {
      merged.push({ startFrame: range.startFrame, endFrame: range.endFrame });
    }
  }
  return merged;
}

export function keepsFromRemovals(removals, durationFrames) {
  const keeps = [];
  let cursor = 0;
  for (const removal of removals) {
    if (removal.startFrame > cursor) keeps.push({ startFrame: cursor, endFrame: removal.startFrame });
    cursor = Math.max(cursor, removal.endFrame);
  }
  if (cursor < durationFrames) keeps.push({ startFrame: cursor, endFrame: durationFrames });
  return keeps;
}

export function removalAtFrame(removals, frame) {
  let low = 0;
  let high = removals.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = removals[middle];
    if (frame < range.startFrame) high = middle - 1;
    else if (frame >= range.endFrame) low = middle + 1;
    else return range;
  }
  return null;
}

// Later manual overrides win when overrides overlap. All times remain in source frames.
export function applyManualOverrides(automaticRemovals, manualOverrides, durationFrames) {
  const automatic = automaticRemovals
    .map((range) => normalized(range, durationFrames))
    .filter((range) => range.endFrame > range.startFrame);
  const overrides = manualOverrides
    .map((range) => normalized(range, durationFrames))
    .filter((range) => range.endFrame > range.startFrame && ["remove", "keep"].includes(range.action));
  const events = new Map();
  const eventAt = (frame) => {
    let event = events.get(frame);
    if (!event) {
      event = { automaticDelta: 0, overrideStarts: [], overrideEnds: [] };
      events.set(frame, event);
    }
    return event;
  };
  eventAt(0);
  eventAt(durationFrames);
  for (const range of automatic) {
    eventAt(range.startFrame).automaticDelta += 1;
    eventAt(range.endFrame).automaticDelta -= 1;
  }
  for (let index = 0; index < overrides.length; index += 1) {
    eventAt(overrides[index].startFrame).overrideStarts.push(index);
    eventAt(overrides[index].endFrame).overrideEnds.push(index);
  }

  // A max heap keeps the most recently-created active override at the top.
  // Ended entries are removed lazily, keeping the sweep O(n log n).
  const heap = [];
  const active = new Uint8Array(overrides.length);
  const push = (value) => {
    heap.push(value);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (heap[parent] >= value) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = value;
  };
  const pop = () => {
    const last = heap.pop();
    if (!heap.length || last === undefined) return;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      const child = right < heap.length && heap[right] > heap[left] ? right : left;
      if (heap[child] <= last) break;
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = last;
  };

  const points = [...events.keys()].sort((a, b) => a - b);
  const removals = [];
  let automaticDepth = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const startFrame = points[index];
    const endFrame = points[index + 1];
    const event = events.get(startFrame);
    automaticDepth += event.automaticDelta;
    for (const overrideIndex of event.overrideEnds) active[overrideIndex] = 0;
    for (const overrideIndex of event.overrideStarts) {
      active[overrideIndex] = 1;
      push(overrideIndex);
    }
    while (heap.length && !active[heap[0]]) pop();
    const currentOverride = heap.length ? overrides[heap[0]] : null;
    const removed = currentOverride ? currentOverride.action === "remove" : automaticDepth > 0;
    if (removed) removals.push({ startFrame, endFrame });
  }
  const mergedRemovals = mergeRanges(removals);
  return {
    durationFrames,
    removals: mergedRemovals,
    keeps: keepsFromRemovals(mergedRemovals, durationFrames),
  };
}
