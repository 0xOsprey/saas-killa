import {
  evaluatorConfigured,
  personasForRun,
  runPersona,
  summarise,
} from '@/lib/ai-evaluator';
import type { PersonaRunResult } from '@/lib/ai-evaluator';
import { activeRound } from '@/lib/rounds';
import { getEvent } from '@/lib/queries';

const USAGE = `Usage: pnpm evaluate [--persona <name>] [--limit <n>] [--replace]

  --persona <name>  run only the persona with this name (default: every active one)
  --limit <n>       cap each persona's run (default: 200)
  --replace         regrade submissions this persona has already graded
`;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return null;
  return process.argv[at + 1] ?? null;
}

/**
 * Run the evaluator from the command line. The same functions back the buttons
 * on the organizer screen; this exists so a large CFP can be graded from a
 * terminal or a cron job without holding a request open for several minutes.
 *
 * The default limit is higher than the organizer screen's cap on purpose: that
 * cap is there because a server action holds a request open, and this does not.
 */
async function main() {
  if (flag('help')) {
    console.log(USAGE);
    return;
  }
  if (!evaluatorConfigured()) {
    console.error('ANTHROPIC_API_KEY is not set. Nothing to do.');
    process.exit(1);
  }

  const limit = Number(option('limit') ?? 200);
  if (!Number.isFinite(limit) || limit < 1) {
    console.error(`--limit must be a positive number, got: ${option('limit')}`);
    process.exit(1);
  }
  const replace = flag('replace');
  const only = option('persona');

  const event = await getEvent();
  const personas = (await personasForRun()).filter(
    (persona) => !only || persona.name.toLowerCase() === only.toLowerCase(),
  );

  if (personas.length === 0) {
    console.error(
      only
        ? `No active persona named "${only}".`
        : 'No active persona. Create one at /organizer/evaluators.',
    );
    process.exit(1);
  }

  // The CLI grades into whichever round is open, the same one the review queue
  // is filing human grades into. Refusing outright beats guessing: writing into
  // a closed round would add scores to a pass already reported on.
  const round = await activeRound();
  if (!round) {
    console.error('No review round is open. Open one at /organizer/cfp first.');
    process.exit(1);
  }
  console.log(`→ grading into ${round.name}`);

  const runs: PersonaRunResult[] = [];
  for (const persona of personas) {
    console.log(
      `→ ${persona.name}: ${replace ? 'replacing its own grades' : 'grading new work'}, up to ${limit}`,
    );
    const run = await runPersona(persona, {
      eventName: event.name,
      roundId: round.id,
      limit,
      replace,
    });
    runs.push(run);
    console.log(
      `  graded ${run.graded}, skipped ${run.skipped}, failed ${run.failed}` +
        (run.overCap > 0 ? `, ${run.overCap} left by the cap` : ''),
    );
    for (const failure of run.failures) {
      console.error(`  ✗ ${failure.title}: ${failure.reason}`);
    }
  }

  const total = summarise(runs);
  console.log(
    `✓ ${total.graded} graded, ${total.skipped} skipped, ${total.failed} failed across ${runs.length} persona(s)`,
  );
  // A failed submission is a job the operator has to come back to, so the exit
  // status says so rather than making a cron job parse the log.
  if (total.failed > 0) process.exit(2);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
