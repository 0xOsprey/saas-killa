import type { Mail } from '@/lib/email';
import { env } from '@/lib/env';

/**
 * The one mail this feature sends: a nudge to an accepted speaker who has not
 * yet said whether they can present. It lives here rather than in
 * `src/lib/email.ts` so the main transport file stays a shared seam and this
 * body can change with the onboarding screen.
 */
export function confirmationReminderMail(input: {
  to: string;
  speakerName: string | null;
  eventName: string;
  titles: string[];
}): Mail {
  const talkCount = input.titles.length;
  const listed = input.titles.map((title) => `"${title}"`).join('\n');

  return {
    to: input.to,
    subject:
      talkCount === 1
        ? `Please confirm: "${input.titles[0]!}" at ${input.eventName}`
        : `Please confirm your ${talkCount} talks at ${input.eventName}`,
    text: [
      `Hi ${input.speakerName ?? 'there'},`,
      '',
      talkCount === 1
        ? `You have been accepted to speak at ${input.eventName}: "${input.titles[0]!}".`
        : `You have ${talkCount} talks accepted for ${input.eventName}:`,
      ...(talkCount > 1 ? [listed] : []),
      '',
      'We are building the programme and need to know whether you can present.',
      '',
      `Open your speaker portal to confirm or decline: ${env().APP_URL}/speaker`,
      '',
      talkCount > 1
        ? 'If you have already confirmed one talk, only the ones listed above still need an answer.'
        : '',
      '',
      'Thank you — the programme team.',
    ]
      .filter((line, index, all) => line !== '' || all[index - 1] !== '')
      .join('\n'),
  };
}
