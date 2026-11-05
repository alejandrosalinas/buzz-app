//! Aggregate text-frame traffic only; fixed buckets, no payloads or per-frame records.
use serde::Serialize;
use std::collections::BTreeMap;
#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Counts {
    tx_frames: u64,
    rx_frames: u64,
    tx_bytes: u64,
    rx_bytes: u64,
}
impl Counts {
    fn add(&mut self, other: Self) {
        self.tx_frames += other.tx_frames;
        self.rx_frames += other.rx_frames;
        self.tx_bytes += other.tx_bytes;
        self.rx_bytes += other.rx_bytes;
    }
}
struct Relay {
    total: Counts,
    buckets: [(u64, Counts); 60],
}
impl Default for Relay {
    fn default() -> Self {
        Self {
            total: Counts::default(),
            buckets: [(0, Counts::default()); 60],
        }
    }
}
#[derive(Default)]
pub(super) struct Traffic(BTreeMap<String, Relay>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot {
    relay: String,
    session: Counts,
    minute: Counts,
    five_minutes: Counts,
}
impl Traffic {
    pub(super) fn frame(&mut self, relay: &str, outgoing: bool, bytes: usize, at: u64) {
        let key = if self.0.contains_key(relay) || self.0.len() < 64 {
            relay
        } else {
            "other-relays"
        };
        let relay = if self.0.contains_key(key) {
            self.0.get_mut(key).expect("existing traffic bucket")
        } else {
            self.0.entry(key.to_owned()).or_default()
        };
        let tick = at / 5000;
        let bucket = &mut relay.buckets[(tick % 60) as usize];
        if bucket.0 != tick {
            *bucket = (tick, Counts::default());
        }
        let counts = if outgoing {
            Counts {
                tx_frames: 1,
                tx_bytes: bytes as u64,
                ..Default::default()
            }
        } else {
            Counts {
                rx_frames: 1,
                rx_bytes: bytes as u64,
                ..Default::default()
            }
        };
        relay.total.add(counts);
        bucket.1.add(counts);
    }
    pub(super) fn snapshot(&self, at: u64) -> Vec<Snapshot> {
        let tick = at / 5000;
        self.0
            .iter()
            .map(|(key, relay)| {
                let mut minute = Counts::default();
                let mut five_minutes = Counts::default();
                for &(when, counts) in &relay.buckets {
                    if when <= tick && tick - when < 60 {
                        five_minutes.add(counts);
                        if tick - when < 12 {
                            minute.add(counts);
                        }
                    }
                }
                Snapshot {
                    relay: key.clone(),
                    session: relay.total,
                    minute,
                    five_minutes,
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rolling_frames_expire_without_losing_totals_and_excess_relays_share_a_bucket() {
        let mut traffic = Traffic::default();
        traffic.frame("relay.test", true, 20, 5_000);
        traffic.frame("relay.test", false, 40, 30_000);
        let rows = traffic.snapshot(65_000);
        assert_eq!(rows[0].session.tx_frames, 1);
        assert_eq!(rows[0].session.rx_bytes, 40);
        assert_eq!(rows[0].minute.tx_frames, 0);
        assert_eq!(rows[0].minute.rx_frames, 1);
        assert_eq!(rows[0].five_minutes.tx_frames, 1);
        assert_eq!(traffic.snapshot(330_000)[0].five_minutes.rx_frames, 0);
        for i in 0..1_000 {
            traffic.frame(&format!("relay-{i}.test"), true, 10, 65_000);
        }
        let rows = traffic.snapshot(65_000);
        assert_eq!(rows.len(), 65);
        assert_eq!(
            rows.iter().map(|row| row.session.tx_frames).sum::<u64>(),
            1_001
        );
        assert!(rows.iter().any(|row| row.relay == "other-relays"));
    }
}
