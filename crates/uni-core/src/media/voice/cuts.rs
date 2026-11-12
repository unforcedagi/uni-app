//! Where a long recording is cut: at a pause, as late as one can be found, never past the longest part allowed.
//!
//! Loudness is measured over short steps (20 ms). A step's score is the loudest step within a short reach either side,
//! so a low score means a stretch of quiet at least twice the reach long, not one soft step inside a word. Within the
//! last stretch before a part would be too long, the cut goes at the lowest score; scores are compared in coarse bands,
//! and among equals the latest wins, so parts run as long as they may.

/// One loudness step: 20 ms.
pub const STEP_SECONDS: f64 = 0.02;
/// How far either side a step looks for sound: a pause has to be at least twice this to count as quiet.
const REACH_STEPS: usize = 10;
/// Loudness bands, in dB: a cut at a pause 2 dB quieter than a later pause isn't worth a shorter part.
const BAND_DB: f32 = 3.0;

/// Loudness in dB (full scale) of 16-bit samples: their RMS.
pub fn loudness_db(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return -120.0;
    }
    let sum: f64 = samples.iter().map(|s| f64::from(*s) * f64::from(*s)).sum();
    let rms = (sum / samples.len() as f64).sqrt() / 32768.0;
    (20.0 * rms.max(1e-6).log10()) as f32
}

/// Steps at which to cut `steps` loudness steps into parts of at most `max_steps`, each cut chosen in the last
/// `search_steps` before the limit. Empty when it fits in one part.
pub fn choose(steps: &[f32], max_steps: usize, search_steps: usize) -> Vec<usize> {
    let max_steps = max_steps.max(1);
    let search_steps = search_steps.clamp(1, max_steps);
    let mut cuts = Vec::new();
    let mut start = 0usize;
    while steps.len() - start > max_steps {
        let hi = start + max_steps; // a cut here makes a part exactly max_steps long
        let lo = hi + 1 - search_steps;
        let mut best = (i32::MAX, hi);
        for c in lo..=hi {
            // The quiet around the cut: the steps just before and just after it.
            let from = c.saturating_sub(REACH_STEPS);
            let to = (c + REACH_STEPS).min(steps.len());
            let peak = steps[from..to].iter().copied().fold(f32::MIN, f32::max);
            let band = (peak / BAND_DB).floor() as i32;
            if band <= best.0 {
                best = (band, c);
            }
        }
        cuts.push(best.1);
        start = best.1;
    }
    cuts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn talk(seconds: f64) -> Vec<f32> {
        vec![-12.0; (seconds / STEP_SECONDS) as usize]
    }
    fn pause(seconds: f64) -> Vec<f32> {
        vec![-60.0; (seconds / STEP_SECONDS) as usize]
    }
    fn steps(s: f64) -> usize {
        (s / STEP_SECONDS).round() as usize
    }

    #[test]
    fn short_recordings_are_not_cut() {
        assert!(choose(&talk(590.0), steps(590.0), steps(120.0)).is_empty());
    }

    #[test]
    fn the_cut_lands_in_a_pause_not_at_the_limit() {
        // Talk to 500 s, a 1 s pause, talk on to 700 s: the cut is inside the pause, not at 590 s mid-word.
        let s = [talk(500.0), pause(1.0), talk(199.0)].concat();
        let cuts = choose(&s, steps(590.0), steps(120.0));
        assert_eq!(cuts.len(), 1);
        let at = cuts[0] as f64 * STEP_SECONDS;
        assert!((500.19..=500.81).contains(&at), "cut at {at}");
    }

    #[test]
    fn the_latest_of_equal_pauses_wins() {
        let s = [talk(480.0), pause(1.0), talk(80.0), pause(1.0), talk(200.0)].concat();
        let at = choose(&s, steps(590.0), steps(120.0))[0] as f64 * STEP_SECONDS;
        assert!((561.19..=561.81).contains(&at), "cut at {at}");
    }

    #[test]
    fn a_soft_step_inside_a_word_is_not_a_pause() {
        // A 60 ms dip is shorter than a pause has to be; the real pause earlier wins.
        let s = [talk(490.0), pause(0.6), talk(60.0), pause(0.06), talk(149.34)].concat();
        let at = choose(&s, steps(590.0), steps(120.0))[0] as f64 * STEP_SECONDS;
        assert!((490.19..=490.41).contains(&at), "cut at {at}");
    }

    #[test]
    fn no_pause_at_all_cuts_at_the_limit_and_every_part_fits() {
        let s = talk(1800.0);
        let cuts = choose(&s, steps(590.0), steps(120.0));
        let mut start = 0;
        for c in cuts.iter().chain(std::iter::once(&s.len())) {
            assert!(c - start <= steps(590.0));
            start = *c;
        }
        assert_eq!(cuts, vec![steps(590.0), steps(1180.0), steps(1770.0)]);
    }

    #[test]
    fn loudness_of_silence_and_full_scale() {
        assert!(loudness_db(&[0; 960]) <= -119.0);
        assert!(loudness_db(&[i16::MAX; 960]).abs() < 0.01);
    }
}
