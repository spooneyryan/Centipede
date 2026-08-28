// Background music, on GameBase's `platform/music` — recorded pieces, assigned
// per level, one sounding at a time.
//
// That module plays FILES: a track is a URL its loader fetches and hands to
// `decodeAudioData`. This game has no audio files and does not want any — the
// sound effects are synth documents rendered on the machine that plays them,
// and shipping megabytes of MP3 to a game whose whole client is 370 kB would
// be a strange trade. So the tunes are synthesised here, rendered to WAV with
// the sfx module's own encoder, and handed over as blob URLs. The music module
// cannot tell the difference; it fetches a URL either way.
//
// Music is PRESENTATION, always. Nothing in this file is reachable from
// `step()`, and a rolled-back tick cannot start, stop or restart a track —
// the level number is read out in the render path, once a tick has settled.

import { createMusic, type Music } from "@ccllc/arcade/platform";
import { samplesToWav } from "@ccllc/arcade/sfx";

/** 22 kHz mono. Chiptune has nothing above 11 kHz to lose, and it renders and
 *  decodes in a quarter of the time of 44.1 stereo. */
const RATE = 22050;

// --- A very small tracker. --------------------------------------------------

type Wave = "square" | "triangle" | "noise";

interface Part {
  wave: Wave;
  /** Level, 0..1, before the track's own gain. */
  gain: number;
  /** Square duty cycle. Ignored by the other waves. */
  duty?: number;
  /** Seconds the note takes to decay to silence. Shorter than the step makes
   *  it plucked; longer makes it sustain into its neighbour. */
  decay: number;
  /** One entry per step. A note name ("A4", "C#3"), "-" for a rest, or "="
   *  to hold the previous note rather than re-strike it. */
  steps: string[];
}

interface Tune {
  /** Steps per minute, not beats — a step is a sixteenth here. */
  stepsPerMinute: number;
  parts: Part[];
}

const SEMITONES: Record<string, number> = {
  C: -9, "C#": -8, D: -7, "D#": -6, E: -5, F: -4,
  "F#": -3, G: -2, "G#": -1, A: 0, "A#": 1, B: 2,
};

/** "C#4" → hertz, tuned to A4 = 440. */
function hz(note: string): number {
  const match = /^([A-G]#?)(-?\d)$/.exec(note);
  if (!match) return 0;
  const semitone = SEMITONES[match[1]] + (Number(match[2]) - 4) * 12;
  return 440 * Math.pow(2, semitone / 12);
}

/** Render one tune to mono float samples, exactly a whole number of steps long
 *  so the loop seam falls on the beat. */
function render(tune: Tune): Float32Array {
  const stepSamples = Math.round((60 / tune.stepsPerMinute) * RATE);
  const steps = Math.max(...tune.parts.map((p) => p.steps.length));
  const total = steps * stepSamples;
  const out = new Float32Array(total);

  for (const part of tune.parts) {
    // One running register per part, so a drum is the same drum every bar.
    let noise = 0x2acf;
    const at = (i: number) => part.steps[i % part.steps.length];

    for (let step = 0; step < steps; step++) {
      const cell = at(step);
      if (cell === "-" || cell === "=") continue; // not an onset
      const freq = hz(cell);
      if (freq <= 0) continue;

      // A note owns its own step, every "=" that follows it, and every "-"
      // after THAT. Letting a rest ring rather than gating the note off is the
      // difference between a tune and a stutter: with a decay longer than a
      // step, cutting at the step boundary chopped every note short and left
      // a third of the march as silence.
      let end = step + 1;
      while (end < steps && at(end) === "=") end++;
      while (end < steps && at(end) === "-") end++;
      const room = (end - step) * stepSamples;

      let phase = 0;
      for (let i = 0; i < room; i++) {
        const env = Math.exp(-i / RATE / part.decay);
        if (env < 0.0005) break;

        let sample: number;
        if (part.wave === "noise") {
          // Galois LFSR, the shape every one of these chips used.
          noise = (noise >>> 1) ^ (-(noise & 1) & 0xb400);
          sample = (noise & 1) * 2 - 1;
        } else {
          phase += freq / RATE;
          if (phase >= 1) phase -= 1;
          sample = part.wave === "square"
            ? (phase < (part.duty ?? 0.5) ? 1 : -1)
            : 4 * Math.abs(phase - 0.5) - 1; // triangle
        }
        // Modulo: a note still sounding at the end of the loop carries into
        // the loop's own beginning, which is what makes a repeat continuous
        // rather than a restart.
        out[(step * stepSamples + i) % total] += sample * env * part.gain;
      }
    }
  }

  // Soft clip rather than a hard ceiling: the parts are summed, and a loud bar
  // should be loud rather than buzz on the limit.
  for (let i = 0; i < total; i++) out[i] = Math.tanh(out[i] * 1.2) * 0.8;

  // The seam. These loop forever, and the last sample meeting the first at a
  // different amplitude is a click every few seconds -- measured at 0.5 of
  // full scale before this existed. Four milliseconds at each end pins both to
  // zero; it is two hundred samples and nobody has ever heard one.
  const fade = Math.min(Math.round(0.004 * RATE), (total / 8) | 0);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    out[i] *= k;
    out[total - 1 - i] *= k;
  }
  return out;
}

// --- The tunes. -------------------------------------------------------------
//
// Three pieces, all in A minor so a crossfade between any two is not a lurch.
// Sixteen steps to the bar.

const MARCH: Tune = {
  stepsPerMinute: 500,
  parts: [
    { wave: "square", gain: 0.22, duty: 0.5, decay: 0.16, steps: [
      "A4", "-", "E4", "-", "A4", "-", "C5", "-", "B4", "-", "G4", "-", "E4", "-", "-", "-",
      "A4", "-", "E4", "-", "A4", "-", "C5", "-", "D5", "-", "C5", "-", "B4", "-", "-", "-",
      "E5", "-", "D5", "-", "C5", "-", "B4", "-", "A4", "-", "C5", "-", "E5", "-", "-", "-",
      "F5", "-", "E5", "-", "D5", "-", "C5", "-", "B4", "-", "A4", "-", "-", "-", "-", "-",
    ] },
    { wave: "triangle", gain: 0.42, decay: 0.30, steps: [
      "A2", "=", "-", "-", "A2", "=", "-", "-", "E2", "=", "-", "-", "E2", "=", "-", "-",
      "F2", "=", "-", "-", "F2", "=", "-", "-", "G2", "=", "-", "-", "G2", "=", "-", "-",
      "A2", "=", "-", "-", "A2", "=", "-", "-", "C3", "=", "-", "-", "C3", "=", "-", "-",
      "D3", "=", "-", "-", "D3", "=", "-", "-", "E3", "=", "-", "-", "E3", "=", "-", "-",
    ] },
    { wave: "noise", gain: 0.13, decay: 0.05, steps: [
      "A4", "-", "-", "-", "A4", "-", "A4", "-", "A4", "-", "-", "-", "A4", "-", "-", "-",
    ] },
  ],
};

const CHASE: Tune = {
  stepsPerMinute: 660,
  parts: [
    { wave: "square", gain: 0.20, duty: 0.25, decay: 0.10, steps: [
      "A4", "C5", "E5", "C5", "A4", "C5", "E5", "C5", "G4", "B4", "D5", "B4", "G4", "B4", "D5", "B4",
      "F4", "A4", "C5", "A4", "F4", "A4", "C5", "A4", "E4", "G4", "B4", "G4", "E4", "G4", "B4", "G4",
      "A4", "E5", "A5", "E5", "A4", "E5", "A5", "E5", "G4", "D5", "G5", "D5", "G4", "D5", "G5", "D5",
      "F4", "C5", "F5", "C5", "E4", "B4", "E5", "B4", "D4", "A4", "D5", "A4", "E4", "B4", "E5", "B4",
    ] },
    { wave: "triangle", gain: 0.40, decay: 0.18, steps: [
      "A2", "-", "A2", "-", "A2", "-", "A2", "-", "G2", "-", "G2", "-", "G2", "-", "G2", "-",
      "F2", "-", "F2", "-", "F2", "-", "F2", "-", "E2", "-", "E2", "-", "E2", "-", "E2", "-",
    ] },
    { wave: "noise", gain: 0.15, decay: 0.04, steps: [
      "A4", "-", "A4", "-", "A4", "A4", "-", "A4", "A4", "-", "A4", "-", "A4", "-", "A4", "A4",
    ] },
  ],
};

const ATTRACT: Tune = {
  stepsPerMinute: 300,
  parts: [
    { wave: "triangle", gain: 0.34, decay: 0.55, steps: [
      "A3", "=", "C4", "=", "E4", "=", "A4", "=", "G4", "=", "E4", "=", "C4", "=", "=", "=",
      "F3", "=", "A3", "=", "C4", "=", "F4", "=", "E4", "=", "C4", "=", "A3", "=", "=", "=",
    ] },
    { wave: "square", gain: 0.10, duty: 0.125, decay: 0.30, steps: [
      "A5", "-", "-", "-", "-", "-", "E5", "-", "-", "-", "-", "-", "C5", "-", "-", "-",
      "F5", "-", "-", "-", "-", "-", "C5", "-", "-", "-", "-", "-", "A4", "-", "-", "-",
    ] },
  ],
};

export const MUSIC_TRACKS = { march: MARCH, chase: CHASE, attract: ATTRACT } as const;
export type TrackName = keyof typeof MUSIC_TRACKS;

export interface GameMusic {
  music: Music;
  /** Milliseconds spent synthesising, for the telemetry line. */
  renderMs: number;
  /** The blob URL behind each track. Diagnostics: a track that decodes to
   *  silence still plays without error, so being able to fetch the bytes back
   *  is the difference between "it started" and "there is music". */
  urls: Readonly<Record<string, string>>;
  destroy(): void;
}

/** Synthesise every track, wrap each as a blob URL, and hand the lot to
 *  GameBase. Levels alternate between the two gameplay loops in PAIRS, so
 *  `playFor` is a no-op on half of them — a level retried, or its sibling
 *  starting, does not restart the music. */
export function createGameMusic(options: {
  report?: (name: string, data?: unknown) => void;
  enabled?: boolean;
  masterGain?: number;
} = {}): GameMusic {
  const started = Date.now();
  const urls: string[] = [];
  const tracks: Record<string, { src: string; volume?: number }> = {};

  for (const [name, tune] of Object.entries(MUSIC_TRACKS)) {
    const wav = samplesToWav(render(tune), RATE);
    const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    urls.push(url);
    tracks[name] = { src: url };
  }
  const renderMs = Date.now() - started;

  // Levels 1..60 in pairs: 1-2 march, 3-4 chase, 5-6 march… Beyond that the
  // level is unmapped, and an unmapped level leaves the music alone, which is
  // the right answer for a run that has gone that far.
  const levels: Record<number, string> = {};
  for (let level = 1; level <= 60; level++) {
    levels[level] = Math.floor((level - 1) / 2) % 2 === 0 ? "march" : "chase";
  }

  const music = createMusic({
    tracks,
    levels,
    crossfadeSeconds: 1.2,
    enabled: options.enabled ?? true,
    masterGain: options.masterGain ?? 0.5,
    report: options.report,
  });

  return {
    music,
    renderMs,
    urls: Object.fromEntries(Object.entries(tracks).map(([n, t]) => [n, t.src])),
    destroy() {
      music.destroy();
      for (const url of urls) URL.revokeObjectURL(url);
    },
  };
}
