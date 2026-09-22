# Design: Frustration acknowledgment and transfer offer

**Date:** 2026-09-22
**Status:** approved in conversation; implementation plan to follow
**Depends on:** the live dashboard (PR #13), which shows the frustration gate row and the confirmation group

## 1. Purpose

Today a caller who sounds frustrated is transferred to a person only when the frustration arrives on a repeated attempt, and nothing is said about it otherwise. The system should visibly react: acknowledge once, offer a transfer the second time, and transfer the third time. The wording never implies a problem the system does not know about.

## 2. Rungs

The `frustration` Score question is unchanged (levels none, mild, high). A turn is **frustrated** when the probability of `high` is at or above `GATE_FRUSTRATION_HIGH` (0.6). Mild changes nothing. The session counts frustrated turns in `frustratedTurns` and remembers whether the offer was declined in `transferDeclined`.

| frustrated turn on this call | behaviour |
| --- | --- |
| first | acknowledge, then continue: `ack_frustration` "I understand, let's get this sorted." plays before whatever the turn would have said anyway |
| second (and the offer not yet declined) | the turn's content is processed as usual (slots fill, an intent routes), then instead of the next question the system asks `offer_transfer` "Would you like me to connect you to a person, or keep going?" |
| third or later, or second after a decline | transfer with reason `frustrated`; `handoff_frustrated` becomes "Let me get you to someone who can help." |

The previous rule (high frustration on a repeated attempt transfers immediately) is removed; a repeated attempt no longer matters.

Consecutive frustrated turns step through the rungs one per turn: a caller who is frustrated on two turns in a row hears the acknowledgment on the first and the offer on the second. The acknowledgment is played at most once per call.

## 3. The offer

`offer_transfer` is a yes/no confirmation with a new pending-confirmation target `transfer`. The model sees `pendingConfirmation: { target: 'transfer', value: 'connect you to a person' }`, and the existing `confirmsYes` / `confirmsNo` questions decide it.

- **Yes** → handoff, reason `frustrated`.
- **No, or an answer that is neither** → `transferDeclined = true`, the confirmation clears, and the turn is processed as an ordinary utterance: content in it fills slots or routes, and the next prompt is whatever the form loop would ask now (the question the caller was on, or the next missing slot). A bare "no" or "keep going" therefore re-asks the question they were on.
- **Silence** at the offer: "I didn't hear anything." then the offer once more; a second silence counts as declining and continues. The offer never walks to the keypad or the agent rung.
- The keypad is not offered for this question.

While the offer is pending, a frustrated turn does not count again (the caller is answering the offer); the count resumes after it clears.

## 4. Prompts

New: `ack_frustration` "I understand, let's get this sorted." (an ack, not interruptible, like `no_input`); `offer_transfer` "Would you like me to connect you to a person, or keep going?" (interruptible, options yes / no). Changed: `handoff_frustrated` text. Three clips for Jason to record; `prompts:check` reports two missing and one stale.

## 5. Harness

- Corpus: the existing `fr-*` entries keep their labels; their expected outcomes change from `prompt` to `prompt` with the ack (first frustrated turn) and are re-recorded in the baseline. New entries at a new context `offer_transfer` (seeded like a `confirm_` context but with the transfer target and no form summary): "yes please", "transfer me", "no, keep going", "keep going", "no", "Dr. Chen" (content, treated as no), with `confirm: yes|no` labels the fixture stub answers through `confirmsYes` / `confirmsNo`.
- Scenarios: `frustration-escalation` becomes a five-step call (frustrated once → ack; frustrated again → offer; "no" → re-ask; frustrated again → handoff); new `frustration-offer-yes`, `frustration-offer-silence` (two silences → continues), `frustration-content-at-offer` ("keep going, it's Dr. Chen" fills the provider and continues).
- Cassette: the new corpus entries and scenarios add turns; existing keys are untouched except where the state's `frustratedTurns` field changes a turn's key. `pnpm regress --client record` appends the misses. The frustration count is part of the session, not the model's state, so keys change only where the pending confirmation differs.

## 6. Dashboard

No change. The gate row's outcome (`ack`, `offer`, `handoff`) appears in the decision line; the offer shows as a `confirmation` group and a `confirm · transfer` pending line, which is the moment to narrate in the video.

## 7. Tests

Gate: the three rungs by count, the decline rule, no count while the offer is pending, mild ignored. Turn: ack prepended to a prompt decision and never to a handoff; the offer replaces the next question after the turn's fills; yes → handoff frustrated; no and content answers; silence ladder at the offer. Prompts: manifest, tags, snapshot. Harness: labels, scenarios, baseline re-recorded; `pnpm regress` clean.

## 8. README

The confirmation section gains a paragraph on the three rungs and the offer; the live-call checklist gains a call that says "this is ridiculous" twice and answers the offer both ways; the clip list gains the two prompts and the re-recorded handoff line.
