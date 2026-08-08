import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { submissions } from '@/db/schema';
import {
  calendarAttachment,
  scheduleNoticeMail,
  sendAndLog,
  type MailPlacement,
} from './email';
import { dayLabel, timeOfDay } from './format';
import type { CalendarParty } from './ics';
import {
  UNSCHEDULED,
  cancellationFor,
  inviteFor,
  placements,
  slotFromNoticeKey,
  type Placement,
} from './speaker-calendar';
import type { AgendaSlot } from './agenda-filters';

/**
 * Telling speakers where and when they are on.
 *
 * The unit of work is "the placement differs from the one we last emailed
 * about", not "something happened". An organizer drags a talk across the grid
 * four times while building the schedule and the speaker gets one mail, for the
 * position it ended in; a talk moved out and back gets none at all, because the
 * key it ends on is the key it started on.
 */

export type NoticeKind = 'scheduled' | 'moved' | 'cancelled';

export type NoticeResult = {
  submissionId: string;
  title: string;
  to: string;
  kind: NoticeKind;
};

function describePlacement(slot: AgendaSlot, timezone: string): MailPlacement {
  return {
    when: `${dayLabel(slot.startsAt, timezone)}, ${timeOfDay(slot.startsAt, timezone)}–${timeOfDay(
      slot.endsAt,
      timezone,
    )}`,
    room: slot.roomName,
  };
}

/** Placements whose current position differs from the one last emailed about. */
export function pendingNotices(rows: Placement[]): Placement[] {
  return rows.filter((row) => {
    // Never emailed and never scheduled is not a change, it is a talk that has
    // simply not been placed yet. Mailing "you are not scheduled" to every
    // accepted speaker the first time an organizer presses the button would be
    // a hundred confusing emails.
    if (row.noticeKey === null && row.key === UNSCHEDULED) return false;
    return row.noticeKey !== row.key;
  });
}

async function record(row: Placement): Promise<void> {
  await db
    .update(submissions)
    .set({ scheduleNoticeKey: row.key, scheduleNoticeSeq: row.noticeSeq + 1 })
    .where(eq(submissions.id, row.submissionId));
}

/**
 * Send one notice per changed placement and record what was sent.
 *
 * The key is written per row immediately after that row's send, matching
 * `notifyDecided`: a failure halfway through leaves the speakers already told
 * marked as told, and a retry resumes rather than mailing them a second time.
 */
export async function sendScheduleNotices(options: {
  eventName: string;
  timezone: string;
  organizer: CalendarParty;
}): Promise<NoticeResult[]> {
  const rows = pendingNotices(await placements());
  const sent: NoticeResult[] = [];

  for (const row of rows) {
    const previousSlot =
      row.noticeKey && row.noticeKey !== UNSCHEDULED
        ? await slotFromNoticeKey(row, row.noticeKey)
        : null;
    const previous = previousSlot ? describePlacement(previousSlot, options.timezone) : null;
    const sequence = row.noticeSeq + 1;

    const kind: NoticeKind = !row.slot ? 'cancelled' : previous ? 'moved' : 'scheduled';
    const ics = row.slot
      ? inviteFor(row, { eventName: options.eventName, organizer: options.organizer, sequence })
      : previousSlot
        ? cancellationFor(row, previousSlot, {
            eventName: options.eventName,
            organizer: options.organizer,
            sequence,
          })
        : null;

    const mail = scheduleNoticeMail({
      to: row.speakerEmail,
      title: row.title,
      eventName: options.eventName,
      placement: row.slot ? describePlacement(row.slot, options.timezone) : null,
      previous,
    });

    await sendAndLog(
      ics
        ? {
            ...mail,
            attachments: [
              calendarAttachment(ics, kind === 'cancelled' ? 'cancelled.ics' : 'invite.ics'),
            ],
          }
        : mail,
      {
        userId: row.speakerId,
        kind: `schedule_${kind}`,
        submissionId: row.submissionId,
      },
    );

    await record(row);
    sent.push({ submissionId: row.submissionId, title: row.title, to: row.speakerEmail, kind });
  }

  return sent;
}
