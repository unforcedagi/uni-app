//! Exponential backoff for reconnects.
//!
//! Deterministic (no jitter) so tests can assert the schedule; the live loop
//! resets it after every successful NIP-42 auth. `max_attempts` bounds how
//! many consecutive failures are tolerated before the caller gives up.

use std::time::Duration;

/// Backoff schedule: `base * factor^n`, capped at `max`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backoff {
    /// First delay.
    pub base: Duration,
    /// Upper bound on any delay.
    pub max: Duration,
    /// Growth factor per consecutive failure.
    pub factor: u32,
    /// Consecutive-failure budget; `None` = unbounded.
    pub max_attempts: Option<u32>,
    attempt: u32,
}

impl Default for Backoff {
    fn default() -> Self {
        Self {
            base: Duration::from_secs(1),
            max: Duration::from_secs(60),
            factor: 2,
            max_attempts: None,
            attempt: 0,
        }
    }
}

impl Backoff {
    /// New schedule with the given base/max, factor 2, unbounded attempts.
    pub fn new(base: Duration, max: Duration) -> Self {
        Self {
            base,
            max,
            ..Default::default()
        }
    }

    /// Bound the consecutive-failure budget.
    pub fn with_max_attempts(mut self, n: u32) -> Self {
        self.max_attempts = Some(n);
        self
    }

    /// Consecutive failures recorded since the last [`reset`](Self::reset).
    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    /// Record a failure and return the delay to wait before the next try,
    /// or `None` when the attempt budget is exhausted.
    pub fn next_delay(&mut self) -> Option<Duration> {
        if let Some(max) = self.max_attempts {
            if self.attempt >= max {
                return None;
            }
        }
        let exp = self.attempt.min(31);
        let mult = self.factor.saturating_pow(exp);
        let delay = self.base.saturating_mul(mult).min(self.max);
        self.attempt += 1;
        Some(delay)
    }

    /// Clear the failure count after a success.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubles_and_caps() {
        let mut b = Backoff::new(Duration::from_millis(100), Duration::from_millis(500));
        assert_eq!(b.next_delay(), Some(Duration::from_millis(100)));
        assert_eq!(b.next_delay(), Some(Duration::from_millis(200)));
        assert_eq!(b.next_delay(), Some(Duration::from_millis(400)));
        assert_eq!(b.next_delay(), Some(Duration::from_millis(500)));
        assert_eq!(b.next_delay(), Some(Duration::from_millis(500)));
        assert_eq!(b.attempt(), 5);
        b.reset();
        assert_eq!(b.next_delay(), Some(Duration::from_millis(100)));
    }

    #[test]
    fn budget_exhausts() {
        let mut b =
            Backoff::new(Duration::from_millis(1), Duration::from_millis(1)).with_max_attempts(2);
        assert!(b.next_delay().is_some());
        assert!(b.next_delay().is_some());
        assert_eq!(b.next_delay(), None);
        b.reset();
        assert!(b.next_delay().is_some());
    }

    #[test]
    fn no_overflow_after_many_failures() {
        let mut b = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
        for _ in 0..100 {
            assert_eq!(
                b.next_delay().map(|d| d <= Duration::from_secs(60)),
                Some(true)
            );
        }
    }
}
