/**
 * The in-progress proposal, held in the visitor's own browser.
 *
 * The CFP form is reachable logged out and a first-time speaker has no row to
 * hang a server-side draft off, so there is nowhere on this server to put one
 * until they submit. Writing a partial row into `submissions` was the other
 * option and it is the wrong one: `submissionStatusEnum` has no draft value,
 * and every organizer list, reviewer queue, count and CSV export reads
 * `submissions.status` without asking whether the row was finished. A draft
 * that leaks into a reviewer's queue is worse than no draft at all.
 *
 * The consequence to be honest about on screen: a draft does not follow the
 * speaker to another browser or survive a cleared cache. The copy says so.
 */

/** One saved draft: what was in the form, and when it was put there. */
export type CfpDraft = {
  savedAt: string;
  values: Record<string, string>;
};

/**
 * Keyed per event, because one browser can meet more than one conference
 * running this software and a shared key would hand the second one the first
 * one's abstract.
 */
export function draftKey(eventId: string): string {
  return `saas-killa:cfp-draft:${eventId}`;
}

/**
 * Every entry point swallows its own failure. `localStorage` throws rather than
 * returning null when a browser is in private mode or storage is disabled, and
 * a speaker with cookies off should still get a working submit button.
 */
export function readDraft(eventId: string): CfpDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(eventId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    // Hand-written or half-written storage is treated as no draft. Anything
    // reaching the form as a `defaultValue` has to be a string by then.
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { savedAt, values } = parsed as Partial<CfpDraft>;
    if (typeof savedAt !== 'string' || typeof values !== 'object' || values === null) return null;
    const clean: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === 'string') clean[name] = value;
    }
    return { savedAt, values: clean };
  } catch {
    return null;
  }
}

/**
 * Put a draft back exactly as it was, original stamp included.
 *
 * Separate from `writeDraft` because the one caller that needs it is putting
 * back a draft it took away a moment earlier, and re-stamping it would tell the
 * speaker their draft was saved at a moment they did nothing.
 */
export function restoreDraft(eventId: string, draft: CfpDraft): boolean {
  try {
    window.localStorage.setItem(draftKey(eventId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function writeDraft(eventId: string, values: Record<string, string>): CfpDraft | null {
  const draft: CfpDraft = { savedAt: new Date().toISOString(), values };
  return restoreDraft(eventId, draft) ? draft : null;
}

export function clearDraft(eventId: string): void {
  try {
    window.localStorage.removeItem(draftKey(eventId));
  } catch {
    // Nothing to tell the speaker. The draft they are discarding is already
    // gone from the screen either way.
  }
}

/**
 * Read the form as text.
 *
 * `FormData` is used rather than a hand-listed set of field names so the
 * organizer's own questions, whose field names are only known at runtime, are
 * saved with everything else. Empty fields are dropped so that a draft holding
 * a title alone stays a draft holding a title alone.
 */
export function collectDraftValues(form: HTMLFormElement): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, value] of new FormData(form).entries()) {
    // A `File` has no text form worth storing and would serialize to
    // "[object File]", so an upload control is skipped rather than saved wrong.
    if (typeof value !== 'string' || value === '') continue;
    // React posts a server action through hidden fields named `$ACTION_ID`,
    // `$ACTION_KEY` and friends. They are this render's plumbing, not the
    // speaker's answer, and a draft holding a stale action key is a draft
    // holding something that will never be read back and may not be valid by
    // the time it is. Measured: three such fields on every save.
    if (name.startsWith('$')) continue;
    values[name] = value;
  }
  return values;
}

/**
 * The visitor's own wall clock, not the event's. A draft is a fact about this
 * browser, so `inEventZone` and friends would date it in a timezone the person
 * reading the line is not standing in.
 */
export function draftStamp(savedAt: string): string {
  const when = new Date(savedAt);
  if (Number.isNaN(when.getTime())) return 'earlier';
  return when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
