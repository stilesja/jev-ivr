# jev-ivr

A mixed-initiative voice IVR front end driven by a fast, calibrated,
non-generative decision model (TypeSafe's Jev), demonstrated on a healthcare
scheduling flow. See `JEV-IVR-HANDOFF.md` for the thesis and
`docs/superpowers/specs/` for the design.

Status: Phase 0–1 (decision core and text harness). No Jev API key yet; the
harness runs against a deterministic stub keyed on a labeled corpus.

## Setup

Node 20+ and pnpm required.

    pnpm install
    pnpm test          # unit tests
    pnpm typecheck

## Text harness

    pnpm cli                                   # REPL against the fixture stub
    pnpm cli --client heuristic                # keyword stub, any input
    pnpm cli --corpus fixtures/corpus.jsonl    # every labeled utterance
    pnpm cli --scenarios fixtures/scenarios    # multi-turn scripts
    pnpm cli --trace traces/run.jsonl          # write JSONL trace records
    pnpm cli --threshold INTENT_ROUTE=0.9      # override any threshold
    pnpm cli --today 2026-09-18                # fix the clock for date slots
    pnpm cli --client jev                      # real model; needs TYPESAFE_API_KEY

In the REPL, type an utterance, `dtmf:44718293` to send keypad digits, or
`/reset` to start a new call. The corpus has 150 labeled utterances and there
are 33 scenarios available for multi-turn testing.

## Regression

    pnpm regress            # diff outcomes against fixtures/expected
    pnpm regress --update   # re-record after an intended change

Outcomes include the final decision, prompt id, deciding gate, filled slots, and implicit-confirm acks, so a threshold change that only alters spoken confirmations still shows up in the diff.

## Layout

    src/domain        intents, forms, slot specs, provider roster
    src/core          state, question set, gate ladder, form loop, extraction, turn
    src/jev           client interface, stubs, SDK client
    src/channel       ConversationRelay frame types
    src/prompts       prompt manifest and rendering
    src/trace         JSONL trace record
    src/harness-text  CLI, runner, metrics, regression
    fixtures          corpus, scenarios, recorded outcomes

## DTMF baseline

`src/domain/dtmf-baseline.json` counts caller turns under a conventional
keypad tree: main menu, ID entry, ID confirm, provider menu, date entry, date
confirm, final confirm. The metrics summary reports observed turns against it.
