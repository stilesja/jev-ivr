import type { DashboardBus } from './bus';
import { redactRecord } from './events';
import type { SessionStore } from '../sessions';
import type { TurnObserver } from '../../run/turn';
import { spokenText } from '../../prompts/render';

/**
 * The live watcher of one call's dialogue: what the core hands the dashboard bus at each turn.
 * The server wires this into the session's run options; the adapter's own moments (the call
 * starting, a digit, a hangup) are published from the adapter and this webhook side instead.
 *
 * `store` rather than the entry itself: the store spreads the created resources into its own
 * entry, and it is the entry's `session` the adapter replaces after every turn, so the live
 * counter is only readable through the store. (`history` is no substitute: HISTORY_WINDOW caps it.)
 */
export function makeObserver(bus: DashboardBus, store: SessionStore, callSid: string): TurnObserver {
  // The turn index the record of the turn now starting will carry. `bookkeep` increments the
  // session's counter before the record is built, so the record of the first turn is 1 and the
  // live session's counter is one behind. See the `asked` variant in events.ts for why a page
  // must not pair the two events by this number.
  const askedTurnIndex = () => (store.get(callSid)?.session.turnIndex ?? 0) + 1;
  return {
    asked: (questions, turnState, at) => bus.publish({ type: 'asked', callSid, at, turnIndex: askedTurnIndex(), questions, turnState }),
    // The published record is redacted: the dashboard route is unauthenticated, and a setup
    // record carries the caller's whole number. The trace file on disk (written by opts.trace)
    // keeps the unredacted record.
    turn: (record, at) => bus.publish({ type: 'turn', callSid, at, record: redactRecord(record), spoken: spokenText(record.decision) }),
  };
}
