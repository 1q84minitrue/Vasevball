export type BatType = 'normal' | 'torpedo' | 'fryingPan' | 'leftTurnSign';

export interface BatSpec {
  label: string;
  description: string;
  /** Radius of the hittable area around the aim point, in zone units. */
  radius: number;
  /** Exit velocity multiplier. */
  power: number;
  /** Swings further than this from the arrival time (either way) miss. */
  timingWindowMs: number;
  /** How long after the swing button the bat gets to the contact point (heavy bats are slow to get going). */
  swingDelayMs: number;
  /** Added to the launch angle (degrees). */
  launchBias: number;
  /** Added to the spray angle (degrees, negative = toward left field). */
  sprayBias: number;
  /** Multiplier on the chance that weak contact is fouled off. */
  foulRate: number;
}

export const BAT_SPECS: Record<BatType, BatSpec> = {
  normal: {
    label: 'ふつうのバット',
    description: 'くせのない木製バット。',
    radius: 0.5,
    power: 1,
    timingWindowMs: 100,
    swingDelayMs: 0,
    launchBias: 0,
    sprayBias: 0,
    foulRate: 1,
  },
  torpedo: {
    label: 'トーピードバット',
    description: '芯に重さを集めた魚雷型。芯は狭いが当たれば飛ぶ。押してから0.1秒後にバットが出る。',
    radius: 0.44,
    power: 1.07,
    timingWindowMs: 100,
    swingDelayMs: 100,
    launchBias: 2,
    sprayBias: 0,
    foulRate: 0.85,
  },
  fryingPan: {
    label: 'フライパン',
    description: '面が広くてよく当たる。打球は低め。',
    radius: 0.85,
    power: 0.82,
    timingWindowMs: 120,
    swingDelayMs: 0,
    launchBias: -8,
    sprayBias: 0,
    foulRate: 0.6,
  },
  leftTurnSign: {
    label: '左折可の標識',
    description: '白い支柱つき。重い鉄製で押してから0.15秒後にやっと振れるが、打球は強く左へ曲がる。',
    radius: 0.6,
    power: 1.13,
    timingWindowMs: 75,
    swingDelayMs: 150,
    launchBias: 4,
    sprayBias: -14,
    foulRate: 1.1,
  },
};

export const BAT_TYPES = Object.keys(BAT_SPECS) as BatType[];
