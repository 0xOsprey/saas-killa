import { evaluatePending, evaluatorConfigured } from '@/lib/ai-evaluator';
import { getEvent } from '@/lib/queries';

/**
 * Run the AI evaluator from the command line. The same function backs the
 * button on the organizer screen; this exists so a large CFP can be graded from
 * a terminal or a cron job without holding a request open for several minutes.
 */
async function main() {
  if (!evaluatorConfigured()) {
    console.error('ANTHROPIC_API_KEY is not set. Nothing to do.');
    process.exit(1);
  }
  const event = await getEvent();
  const { graded, failed } = await evaluatePending(event.name, 200);
  console.log(`✓ graded ${graded}, failed ${failed}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
