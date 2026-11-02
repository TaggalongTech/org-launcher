/** Decides which browser and profile an org opens in. */
import type { OpenTarget, OrgEntry, Settings } from './state.js';

/**
 * The org's own choice wins. Next comes the first of its tags, in the org's tag order, that has a browser.
 * Then the default for every org. Null means the system's default browser.
 */
export function resolveOpen(entry: OrgEntry, settings: Settings): OpenTarget | null {
  if (entry.open) return entry.open;
  for (const tag of entry.tags) {
    if (Object.hasOwn(settings.tagOpen, tag)) return settings.tagOpen[tag];
  }
  return settings.defaultOpen ?? null;
}
