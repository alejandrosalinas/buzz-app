//! Relay images that survive navigation and relaunch.
//!
//! WebKit keeps no disk cache for custom-scheme responses, so every launch and
//! every lazy remount fetched each avatar and thumbnail again through a signed
//! relay read. Relay media is content-addressed (`/media/<sha256>…`), so a
//! cached response never goes stale; only a purge or the byte budget removes
//! it. Entries are grouped by community origin, so clearing or leaving one
//! community drops only its media, and a message's images also by channel, so
//! losing access to a channel drops its images with its saved messages. The
//! identity never changes within a process, and signing out deletes the whole
//! cache directory.

use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{self, Write as _},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, SystemTime},
};
use url::Url;

/// The cache's folder in the app cache directory.
pub(crate) const DIR: &str = "media";
/// Bytes kept on disk before the least recently used entries are deleted.
const BUDGET: u64 = 256 * 1024 * 1024;
/// Larger images, such as full-size photos, are fetched each time, so a few of
/// them cannot evict the avatars and thumbnails this cache is for.
pub(super) const ENTRY_MAX: usize = 2 * 1024 * 1024;
const CLEARED: &str = ".cleared";
/// A hit refreshes its age at most this often, so reads rarely write.
const TOUCH_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone)]
pub(crate) struct MediaCache(Arc<Inner>);

/// Which of a community's channels to forget the images of.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Channels {
    Only(Vec<String>),
    AllExcept(Vec<String>),
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

struct Inner {
    root: Option<PathBuf>,
    budget: u64,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// Bumped by every purge; a fetch that began before it is not stored.
    generation: u64,
    /// Bytes on disk as of the last scan, plus writes since.
    bytes: u64,
    /// Bytes ever written, so a scan can add the writes it may have missed.
    written: u64,
    measured: bool,
    evicting: bool,
    /// Purges still deleting their folders, which a scan must not sweep.
    purging: usize,
}

impl MediaCache {
    /// Without a cache directory every read misses and nothing is stored.
    pub(crate) fn new(root: Option<PathBuf>) -> Self {
        Self::with_budget(root, BUDGET)
    }

    fn with_budget(root: Option<PathBuf>, budget: u64) -> Self {
        Self(Arc::new(Inner {
            root,
            budget,
            state: Mutex::default(),
        }))
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.0
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn partition(&self, origin: &Url) -> Option<PathBuf> {
        Some(
            self.0
                .root
                .as_ref()?
                .join(digest(&origin.origin().ascii_serialization())),
        )
    }

    /// A channel's images sit in a folder of the community's.
    fn path(&self, url: &Url, channel: Option<&str>) -> Option<PathBuf> {
        let mut path = self.partition(url)?;
        if let Some(channel) = channel {
            path.push(digest(channel));
        }
        Some(path.join(digest(url.as_str())))
    }

    /// Taken before a fetch and passed to `put`.
    pub(super) fn ticket(&self) -> u64 {
        self.lock().generation
    }

    /// The cached `Content-Type` and body for `url`.
    pub(super) fn get(&self, url: &Url, channel: Option<&str>) -> Option<(String, Vec<u8>)> {
        let path = self.path(url, channel)?;
        let mut bytes = fs::read(&path).ok()?;
        let split = bytes.iter().position(|&b| b == b'\n')?;
        let kind = std::str::from_utf8(&bytes[..split]).ok()?.to_owned();
        bytes.drain(..=split);
        let stale = fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .is_ok_and(|at| at.elapsed().is_ok_and(|age| age > TOUCH_AFTER));
        if stale {
            let _ = fs::File::options()
                .write(true)
                .open(&path)
                .and_then(|file| file.set_modified(SystemTime::now()));
        }
        Some((kind, bytes))
    }

    /// Stores a complete image response unless a purge ran since `ticket`.
    pub(super) fn put(
        &self,
        url: &Url,
        channel: Option<&str>,
        ticket: u64,
        kind: &str,
        body: &[u8],
    ) -> io::Result<()> {
        let (Some(root), Some(path)) = (self.0.root.as_ref(), self.path(url, channel)) else {
            return Ok(());
        };
        let Some(dir) = path.parent().filter(|_| body.len() <= ENTRY_MAX) else {
            return Ok(());
        };
        fs::create_dir_all(dir)?;
        // Written whole and synced, then renamed: entries are never refetched,
        // so a torn one would be served until evicted. A temporary file
        // orphaned by a crash ages out with the entries beside it.
        let mut file = tempfile::Builder::new().prefix(".tmp").tempfile_in(dir)?;
        file.write_all(kind.as_bytes())?;
        file.write_all(b"\n")?;
        file.write_all(body)?;
        file.as_file().sync_data()?;
        let size = (kind.len() + 1 + body.len()) as u64;
        let evict = {
            let mut state = self.lock();
            if state.generation != ticket {
                return Ok(());
            }
            file.persist(&path).map_err(|error| error.error)?;
            state.bytes += size;
            state.written += size;
            let evict = (!state.measured || state.bytes > self.0.budget) && !state.evicting;
            state.evicting |= evict;
            evict
        };
        if evict {
            self.evict(root);
        }
        Ok(())
    }

    /// Measures the cache and, over budget, deletes the least recently used
    /// entries.
    fn evict(&self, root: &Path) {
        let start = self.lock().written;
        let total = self.trim(root);
        self.settle(start, total);
    }

    /// The bytes left on disk after deleting the least recently used entries
    /// over budget. Runs without the lock, so writes may land meanwhile.
    fn trim(&self, root: &Path) -> u64 {
        let entry = |meta: &fs::Metadata, path| {
            let at = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            (at, meta.len(), path)
        };
        let mut entries = Vec::new();
        for dir in fs::read_dir(root).into_iter().flatten().flatten() {
            if !dir.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            // A purge's leftovers, if it was interrupted. Swept under the lock
            // while no purge runs, so a running purge's folder is never taken.
            if dir.file_name().to_string_lossy().starts_with(CLEARED) {
                if self.lock().purging == 0 {
                    let _ = fs::remove_dir_all(dir.path());
                }
                continue;
            }
            for file in fs::read_dir(dir.path()).into_iter().flatten().flatten() {
                let Ok(meta) = file.metadata() else { continue };
                if !meta.is_dir() {
                    entries.push(entry(&meta, file.path()));
                    continue;
                }
                for file in fs::read_dir(file.path()).into_iter().flatten().flatten() {
                    if let Ok(meta) = file.metadata() {
                        entries.push(entry(&meta, file.path()));
                    }
                }
            }
        }
        let mut total: u64 = entries.iter().map(|(_, len, _)| len).sum();
        if total > self.0.budget {
            // Down to 80%, so a full cache is not rescanned on every write.
            let low = self.0.budget / 10 * 8;
            entries.sort_unstable_by_key(|(at, _, _)| *at);
            for (_, len, path) in entries {
                if total <= low {
                    break;
                }
                if fs::remove_file(path).is_ok() {
                    total -= len;
                }
            }
        }
        total
    }

    /// Records a scan that began when `written` was `start`. A write the scan
    /// also saw counts twice, which only brings the next scan sooner.
    fn settle(&self, start: u64, total: u64) {
        let mut state = self.lock();
        state.bytes = total + (state.written - start);
        state.measured = true;
        state.evicting = false;
    }

    /// Bytes saved for one community, bytes saved in all, and the budget.
    pub(crate) fn usage(&self, origin: &Url) -> (u64, u64, u64) {
        let files = |dir: &Path| -> u64 {
            fs::read_dir(dir)
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|file| file.metadata().ok())
                .filter(|meta| !meta.is_dir())
                .map(|meta| meta.len())
                .sum()
        };
        // A community's own entries and its channels' folders.
        let size = |dir: &Path| -> u64 {
            let channels: u64 = fs::read_dir(dir)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .map(|channel| files(&channel.path()))
                .sum();
            files(dir) + channels
        };
        let (Some(root), Some(own)) = (self.0.root.as_ref(), self.partition(origin)) else {
            return (0, 0, self.0.budget);
        };
        let total = fs::read_dir(root)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|dir| !dir.file_name().to_string_lossy().starts_with(CLEARED))
            .map(|dir| size(&dir.path()))
            .sum();
        (size(&own), total, self.0.budget)
    }

    /// Forgets one community's media. Fetches already in flight are not stored.
    pub(crate) fn clear(&self, origin: &Url) -> io::Result<()> {
        self.discard(origin, |partition| vec![partition.to_owned()])
    }

    /// Forgets the images saved from some of a community's channels. Fetches
    /// already in flight are not stored.
    pub(crate) fn forget(&self, origin: &Url, channels: Channels) -> io::Result<()> {
        let (ids, keep) = match channels {
            Channels::Only(ids) => (ids, false),
            Channels::AllExcept(ids) => (ids, true),
        };
        let digests: HashSet<_> = ids.iter().map(|id| digest(id)).collect();
        self.discard(origin, |partition| {
            fs::read_dir(partition)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|dir| dir.file_type().is_ok_and(|kind| kind.is_dir()))
                .filter(|dir| digests.contains(&*dir.file_name().to_string_lossy()) != keep)
                .map(|dir| dir.path())
                .collect()
        })
    }

    /// Deletes the folders `select` picks from a community's.
    fn discard(&self, origin: &Url, select: impl FnOnce(&Path) -> Vec<PathBuf>) -> io::Result<()> {
        let Some(partition) = self.partition(origin) else {
            return Ok(());
        };
        let (trash, moved) = {
            let mut state = self.lock();
            state.generation += 1;
            state.measured = false;
            let dirs: Vec<_> = select(&partition)
                .into_iter()
                .filter(|dir| dir.exists())
                .collect();
            let Some(root) = self.0.root.as_ref().filter(|_| !dirs.is_empty()) else {
                return Ok(());
            };
            // Moved aside under the lock, so no write lands in them; deleting
            // many small files then runs without blocking media requests.
            let trash = tempfile::Builder::new().prefix(CLEARED).tempdir_in(root)?;
            let moved = dirs
                .iter()
                .enumerate()
                .try_for_each(|(index, dir)| fs::rename(dir, trash.path().join(index.to_string())));
            state.purging += 1;
            (trash, moved)
        };
        let closed = trash.close();
        self.lock().purging -= 1;
        moved.and(closed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(name: &str) -> Url {
        Url::parse(&format!(
            "https://relay.example.org/media/{}.thumb.webp",
            name.repeat(64)
        ))
        .unwrap()
    }

    #[test]
    fn stores_and_reads_back_an_image() {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::new(Some(dir.path().into()));
        assert!(cache.get(&url("a"), None).is_none());
        cache
            .put(
                &url("a"),
                None,
                cache.ticket(),
                "image/webp",
                b"bytes\nmore",
            )
            .unwrap();
        assert_eq!(
            cache.get(&url("a"), None),
            Some(("image/webp".into(), b"bytes\nmore".to_vec()))
        );
    }

    #[test]
    fn clearing_a_community_keeps_others_and_drops_in_flight_fetches() {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::new(Some(dir.path().into()));
        let other = Url::parse(&format!(
            "https://other.example.org/media/{}",
            "b".repeat(64)
        ))
        .unwrap();
        cache
            .put(&url("a"), None, cache.ticket(), "image/webp", b"a")
            .unwrap();
        cache
            .put(&other, None, cache.ticket(), "image/png", b"b")
            .unwrap();
        let in_flight = cache.ticket();
        cache
            .clear(&Url::parse("https://relay.example.org").unwrap())
            .unwrap();
        assert!(cache.get(&url("a"), None).is_none());
        assert!(cache.get(&other, None).is_some());
        cache
            .put(&url("c"), None, in_flight, "image/webp", b"c")
            .unwrap();
        assert!(cache.get(&url("c"), None).is_none());
        cache
            .put(&url("c"), None, cache.ticket(), "image/webp", b"c")
            .unwrap();
        assert!(cache.get(&url("c"), None).is_some());
    }

    #[test]
    fn evicts_least_recently_used_entries_over_budget() {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::with_budget(Some(dir.path().into()), 160);
        let old = SystemTime::now() - Duration::from_secs(3 * 24 * 60 * 60);
        // `b` is a message's image, so it counts from its channel's folder.
        let channel = |name| (name == "b").then_some("channel");
        for name in ["a", "b", "c"] {
            cache
                .put(
                    &url(name),
                    channel(name),
                    cache.ticket(),
                    "image/webp",
                    &[0; 30],
                )
                .unwrap();
        }
        // Each entry is 41 bytes. `a` is older but was read again; `b` was not.
        for name in ["a", "b"] {
            let path = cache.path(&url(name), channel(name)).unwrap();
            fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(old)
                .unwrap();
        }
        assert!(cache.get(&url("a"), None).is_some());
        cache
            .put(&url("d"), None, cache.ticket(), "image/webp", &[0; 30])
            .unwrap();
        assert!(cache.get(&url("b"), Some("channel")).is_none());
        for name in ["a", "c", "d"] {
            assert!(cache.get(&url(name), None).is_some(), "{name}");
        }
    }

    #[test]
    fn a_write_during_an_eviction_scan_still_counts() {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::with_budget(Some(dir.path().into()), 1000);
        cache
            .put(&url("a"), None, cache.ticket(), "image/webp", &[0; 30])
            .unwrap();
        // A scan that sees only `a`, while `b` is written before it settles.
        cache.lock().evicting = true;
        let start = cache.lock().written;
        let total = cache.trim(dir.path());
        cache
            .put(&url("b"), None, cache.ticket(), "image/webp", &[0; 30])
            .unwrap();
        cache.settle(start, total);
        assert_eq!(cache.lock().bytes, 82);
    }

    #[test]
    fn a_scan_sweeps_an_interrupted_purge_but_not_a_running_one() {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::new(Some(dir.path().into()));
        let trash = dir.path().join(format!("{CLEARED}-a"));
        fs::create_dir(&trash).unwrap();
        cache.lock().purging = 1;
        cache.evict(dir.path());
        assert!(trash.exists());
        cache.lock().purging = 0;
        cache.evict(dir.path());
        assert!(!trash.exists());
    }

    #[test]
    fn forgets_only_the_selected_channels_images() {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::new(Some(dir.path().into()));
        let community = Url::parse("https://relay.example.org").unwrap();
        for channel in [None, Some("kept"), Some("lost"), Some("left")] {
            cache
                .put(&url("a"), channel, cache.ticket(), "image/webp", b"a")
                .unwrap();
        }
        let in_flight = cache.ticket();
        cache
            .forget(&community, Channels::Only(vec!["lost".into()]))
            .unwrap();
        assert!(cache.get(&url("a"), Some("lost")).is_none());
        assert!(cache.get(&url("a"), Some("left")).is_some());
        cache
            .put(&url("b"), Some("kept"), in_flight, "image/webp", b"b")
            .unwrap();
        assert!(cache.get(&url("b"), Some("kept")).is_none());
        cache
            .forget(&community, Channels::AllExcept(vec!["kept".into()]))
            .unwrap();
        assert!(cache.get(&url("a"), Some("left")).is_none());
        assert!(cache.get(&url("a"), Some("kept")).is_some());
        // Avatars and emoji belong to no channel.
        assert!(cache.get(&url("a"), None).is_some());
    }

    #[test]
    fn reports_one_community_and_all_against_the_budget() {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::with_budget(Some(dir.path().into()), 1000);
        let relay = Url::parse("https://relay.example.org").unwrap();
        let other = Url::parse(&format!(
            "https://other.example.org/media/{}",
            "b".repeat(64)
        ))
        .unwrap();
        assert_eq!(cache.usage(&relay), (0, 0, 1000));
        cache
            .put(
                &url("a"),
                Some("channel"),
                cache.ticket(),
                "image/webp",
                &[0; 30],
            )
            .unwrap();
        cache
            .put(&other, None, cache.ticket(), "image/png", &[0; 9])
            .unwrap();
        assert_eq!(cache.usage(&relay), (41, 60, 1000));
        cache.clear(&relay).unwrap();
        assert_eq!(cache.usage(&relay), (0, 19, 1000));
    }

    #[test]
    fn skips_oversized_entries_and_missing_directories() {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::new(Some(dir.path().into()));
        cache
            .put(
                &url("a"),
                None,
                cache.ticket(),
                "image/png",
                &vec![0; ENTRY_MAX + 1],
            )
            .unwrap();
        assert!(cache.get(&url("a"), None).is_none());
        let none = MediaCache::new(None);
        none.put(&url("a"), None, none.ticket(), "image/png", b"a")
            .unwrap();
        assert!(none.get(&url("a"), None).is_none());
    }
}
