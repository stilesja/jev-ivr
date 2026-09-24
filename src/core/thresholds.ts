// Every value here is a PLACEHOLDER until tuned against real Jev fixtures
// (handoff §6, §12). Change values here or via `--threshold NAME=VALUE`.

export const DEFAULT_THRESHOLDS = {
  // gate ladder
  // 0.70 → 0.65 on 2026-09-24: "Agent" alone scored 0.67 on jev-1.13.0 once timeOfDay joined the opener's
  // questions; the sweep grid gains that one outcome anywhere from 0.55 to 0.65 and loses none, and declined
  // to move on its own, so this is a judgment step like GATE_INTELLIGIBLE's. The trade: "um" scores 0.66, so
  // a filler now gets the open re-ask instead of being ignored, which costs a caller one rung; "Agent" being
  // ignored until the no-input timer is the worse failure.
  GATE_ADDRESSED: 0.65,
  // 0.50 → 0.45 on 2026-09-20: "Agent" alone scored 0.49 on jev-1.13.0; the sweep grid is flat from 0.05 to 0.45 (one
  // outcome better, none worse) and the unbounded-plateau rule declined to move it, so this is a judgment step.
  GATE_INTELLIGIBLE: 0.45,
  GATE_COMPLETE: 0.6,
  GATE_WANTS_HUMAN: 0.7,
  INTENT_ROUTE: 0.7,
  INTENT_IMPLICIT: 0.6,
  INTENT_EXPLICIT: 0.4,
  INTENT_SWITCH: 0.85,
  GATE_INTENT_MARGIN: 0.15,
  GATE_FRUSTRATION_HIGH: 0.6,
  // question redesign (spec 2026-09-19 §8)
  INTENT_TENTATIVE: 0.5,
  INTENT_CHANGE: 0.6,
  PROVIDER_UNSURE: 0.45,
  // final confirm (spec 2026-09-19 final-confirm §6)
  SLOT_CHANGE: 0.6,
  INTENT_SECOND: 0.6,
  // slots
  SLOT_DETECT: 0.6,
  SLOT_CHOICE_FILL: 0.55,
  SLOT_CHOICE_CONFIRM: 0.45,
  SLOT_CHOICE_MARGIN: 0.15,
  SLOT_HELP: 0.6,
  // appointment slots (spec 2026-09-24 appointment-slots §7)
  TIME_OF_DAY: 0.6,
  TIME_PREFERENCE: 0.6,
  // confirmations and menus
  CONFIRM_YES: 0.7,
  CONFIRM_NO: 0.7,
  MENU_NUMBER: 0.7,
  // retry policy
  MAX_ATTEMPTS: 3,
  // stub and client
  STUB_SHARPNESS: 0.9,
  JEV_TIMEOUT_MS: 1500,
  JEV_PRICE_PER_MTOK: 0.042,
} as const;

export type ThresholdName = keyof typeof DEFAULT_THRESHOLDS;
export type Thresholds = { -readonly [K in ThresholdName]: number };

export function withOverrides(overrides: Partial<Thresholds>): Thresholds {
  return { ...DEFAULT_THRESHOLDS, ...overrides };
}

export function parseOverride(spec: string): Partial<Thresholds> {
  const parts = spec.split('=');
  if (parts.length !== 2) throw new Error(`bad threshold override: ${spec}`);
  const [name, raw] = parts;
  if (!name) throw new Error(`bad threshold override: ${spec}`);
  if (!Object.hasOwn(DEFAULT_THRESHOLDS, name)) throw new Error(`unknown threshold: ${name}`);
  if (!raw || !raw.trim()) throw new Error(`bad threshold value: ${spec}`);
  const value = Number(raw);
  if (Number.isNaN(value)) throw new Error(`bad threshold value: ${spec}`);
  return { [name]: value } as Partial<Thresholds>;
}
