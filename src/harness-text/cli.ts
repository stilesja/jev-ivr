import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dtmfFrames, promptFrame, setupFrame } from '../channel/frames';
import { newSession, type Session } from '../core/session';
import { loadCorpus } from '../jev/corpus';
import { TraceWriter } from '../trace/writer';
import type { TraceRecord } from '../trace/types';
import { loadScenarios, runCorpusEntry, runScenario, runTurn, type RunOptions, type TurnRun } from './runner';
import { summarize } from './metrics';
import { formatAnswers, formatDecision, formatGates, formatMetrics } from './print';
export { buildThresholds, buildClient, DEFAULT_CORPUS_FILE } from '../run/client';
import { buildThresholds, buildClient, DEFAULT_CORPUS_FILE } from '../run/client';

/** Parsed inside main() so a bad flag reports through the same clean error path as a bad run. */
function parseCliArgs() {
  return parseArgs({
    options: {
      corpus: { type: 'string' },
      scenarios: { type: 'string' },
      client: { type: 'string', default: 'stub' },
      trace: { type: 'string' },
      threshold: { type: 'string', multiple: true, default: [] },
      today: { type: 'string', default: new Date().toISOString().slice(0, 10) },
      quiet: { type: 'boolean', default: false },
      'corpus-file': { type: 'string' },
    },
  }).values;
}

/** The fixture stub reads --corpus-file; running a corpus defaults it to that same file. */
export function corpusFileOf(corpusFile: string | undefined, corpus: string | undefined): string {
  return corpusFile ?? corpus ?? DEFAULT_CORPUS_FILE;
}

function printRun(run: TurnRun, quiet: boolean): void {
  if (quiet) return;
  const { result, questions, response } = run;
  if (questions && response) {
    console.log(formatAnswers(questions, response.answers));
    console.log('');
  }
  if (result.rows.length) {
    console.log(formatGates(result.rows));
    console.log('');
  }
  if (run.error) console.log(`client error: ${run.error.name}: ${run.error.message}`);
  console.log(formatDecision(result.decision, result.frames));
  console.log(`timing ms  ask ${run.record.timing.askMs.toFixed(1)}  total ${run.record.timing.totalMs.toFixed(1)}   source ${run.record.source}`);
  console.log('');
}

async function repl(opts: RunOptions, quiet: boolean): Promise<TraceRecord[]> {
  const records: TraceRecord[] = [];
  let session: Session = newSession(`repl-${Date.now()}`, Date.now());
  const start = async () => {
    const run = await runTurn(session, setupFrame(session.sessionId), opts);
    session = run.result.session;
    records.push(run.record);
    printRun(run, quiet);
  };
  await start();
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'caller> ' });
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (text === '/reset') {
      session = newSession(`repl-${Date.now()}`, Date.now());
      await start();
    } else if (text.startsWith('dtmf:')) {
      for (const event of dtmfFrames(text.slice(5))) {
        const run = await runTurn(session, event, opts);
        session = run.result.session;
        records.push(run.record);
        if (run.result.decision.kind !== 'ignore') printRun(run, quiet);
      }
    } else if (text) {
      if (!session.ended) {
        const run = await runTurn(session, promptFrame(text), opts);
        session = run.result.session;
        records.push(run.record);
        printRun(run, quiet);
      }
    }
    if (session.ended) console.log('(call ended; /reset to start another)');
    rl.prompt();
  }
  return records;
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const thresholds = buildThresholds(args.threshold ?? []);
  const client = buildClient(args.client!, corpusFileOf(args['corpus-file'], args.corpus), thresholds);
  const trace = args.trace ? new TraceWriter(args.trace) : null;
  const opts: RunOptions = { client, thresholds, todayIso: args.today!, trace };
  const records: TraceRecord[] = [];

  if (args.corpus) {
    for (const entry of loadCorpus(args.corpus)) {
      const { run, setup, outcome } = await runCorpusEntry(entry, opts);
      records.push(setup.record, run.record);
      if (!args.quiet) {
        console.log(`=== ${entry.id}  "${entry.text}"  [${entry.context}]`);
        printRun(run, false);
      } else {
        console.log(`${entry.id.padEnd(16)} ${outcome.decision.padEnd(9)} ${outcome.promptId ?? outcome.reason ?? ''}`);
      }
    }
  }

  if (args.scenarios) {
    let failed = 0;
    for (const scenario of loadScenarios(args.scenarios)) {
      const r = await runScenario(scenario, opts);
      for (const run of r.runs) records.push(run.record);
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${scenario.id}`);
      for (const m of r.mismatches) console.log(`      ${m}`);
      if (!r.pass) failed += 1;
      if (!args.quiet && !r.pass) for (const run of r.runs) printRun(run, false);
    }
    if (failed) process.exitCode = 1;
  }

  if (!args.corpus && !args.scenarios) {
    records.push(...(await repl(opts, args.quiet!)));
  }

  if (records.length) {
    console.log('');
    console.log(formatMetrics(summarize(records)));
  }
}

/** Only runs as the entry point, so tests can import the builders without starting a REPL. */
const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    if (e instanceof Error) console.error(`error: ${e.message}`);
    else console.error(e);
    process.exit(1);
  });
}
