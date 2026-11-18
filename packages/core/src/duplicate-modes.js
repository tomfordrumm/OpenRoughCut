export const LAST_TAKE_DUPLICATE_MODE = "last-take";
export const DEFAULT_DUPLICATE_MODE = LAST_TAKE_DUPLICATE_MODE;
export const DUPLICATE_MODES = [LAST_TAKE_DUPLICATE_MODE, "rules"];
// Modes whose auto-remove threshold is the user's text-confidence setting.
export const usesTextConfidence = (mode) => mode === "rules" || mode === LAST_TAKE_DUPLICATE_MODE;
export function assertDuplicateMode(value = "rules") {
  if (!DUPLICATE_MODES.includes(value)) throw new Error("Unsupported duplicate detection mode.");
  return value;
}
// Projects saved with the removed local-model mode reopen with last-take; their
// stored analysis no longer matches, so it is treated as stale and re-run.
export const savedDuplicateMode = (value = "rules") => value === "gemma-conservative" ? LAST_TAKE_DUPLICATE_MODE : value;
