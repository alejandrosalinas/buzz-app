//! The executable on the other end of a loopback TCP connection, for the
//! pairing prompt to name. A TCP socket has no peer-credential option, so the
//! connection is found among the processes' open sockets by its whole
//! address pair. What it names is shown to the person, never trusted: the
//! token a pairing issues is bound by their approval, not by the process.
use std::net::{SocketAddr, SocketAddrV4};
use std::time::{Duration, Instant};

/// How long naming may take; past it the caller is unknown.
const LOOKUP: Duration = Duration::from_millis(500);
/// Processes and descriptors examined at most, past which the caller is
/// unknown.
#[cfg(any(target_os = "macos", target_os = "linux", test))]
const PROCESSES: usize = 16_384;
#[cfg(any(target_os = "macos", target_os = "linux", test))]
const DESCRIPTORS: usize = 4_096;

/// One established IPv4 TCP connection, as the process holding it sees it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Connection {
    local: SocketAddrV4,
    remote: SocketAddrV4,
}

/// The executable of the process connected from `peer` to this service at
/// `service`, within [`LOOKUP`]; `None` when it can't be found then, or more
/// than one process holds the socket.
pub(crate) async fn name(peer: SocketAddr, service: SocketAddr) -> Option<String> {
    let (SocketAddr::V4(local), SocketAddr::V4(remote)) = (peer, service) else {
        return None;
    };
    let want = Connection { local, remote };
    bounded(LOOKUP, move |deadline| {
        imp::owner(want, deadline)
            .and_then(imp::path)
            .map(|path| path.display().to_string())
    })
    .await
}

/// Runs `lookup` off the async runtime with a deadline it must honor, and
/// stops waiting for it once that has passed.
async fn bounded<T: Send + 'static>(
    budget: Duration,
    lookup: impl FnOnce(Instant) -> Option<T> + Send + 'static,
) -> Option<T> {
    let deadline = Instant::now() + budget;
    let work = tauri::async_runtime::spawn_blocking(move || lookup(deadline));
    tokio::time::timeout(budget + Duration::from_millis(50), work)
        .await
        .ok()?
        .ok()
        .flatten()
}

/// A scan cut short, by the deadline or a cap: what it missed may hold the
/// socket too.
#[cfg(any(target_os = "macos", target_os = "linux", test))]
#[derive(Debug, PartialEq, Eq)]
struct Cut;

/// Whether process `pid` holds the socket, among its descriptors `fds`,
/// stopping at `deadline` or past [`DESCRIPTORS`].
#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn scan<F>(
    pid: u32,
    fds: impl IntoIterator<Item = F>,
    deadline: Instant,
    mut holds: impl FnMut(F) -> bool,
) -> Result<Option<u32>, Cut> {
    for (seen, fd) in fds.into_iter().enumerate() {
        if seen >= DESCRIPTORS || Instant::now() >= deadline {
            return Err(Cut);
        }
        if holds(fd) {
            return Ok(Some(pid));
        }
    }
    Ok(None)
}

/// The one process among `holders` (pids holding the matching socket),
/// stopping at `deadline` or past [`PROCESSES`]: none, several, or an
/// unfinished scan of any process name nobody.
#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn unique(
    holders: impl Iterator<Item = Result<Option<u32>, Cut>>,
    deadline: Instant,
) -> Option<u32> {
    let mut found = None;
    for (seen, holder) in holders.enumerate() {
        if seen >= PROCESSES || Instant::now() >= deadline {
            return None;
        }
        match (holder.ok()?, found) {
            (Some(pid), None) => found = Some(pid),
            (Some(pid), Some(other)) if pid != other => return None,
            _ => {}
        }
    }
    found
}

#[cfg(target_os = "macos")]
mod imp {
    //! libproc, through typed mirrors of `<sys/proc_info.h>`; the layout
    //! assertions below hold them to the SDK's.
    use super::{scan, unique, Connection, Cut};
    use std::ffi::c_void;
    use std::mem::{offset_of, size_of, zeroed};
    use std::net::{Ipv4Addr, SocketAddrV4};
    use std::path::PathBuf;
    use std::time::Instant;

    const PROC_PIDFDSOCKETINFO: i32 = 3;
    const SOCKINFO_TCP: i32 = 2;
    const TSI_S_ESTABLISHED: i32 = 4;
    const INI_IPV4: u8 = 1;

    /// `struct socket_fdinfo`.
    #[repr(C)]
    pub(super) struct SocketFdInfo {
        pfi: [u64; 3],
        pub(super) psi: SocketInfo,
    }
    /// `struct socket_info`, up to its protocol union.
    #[repr(C)]
    pub(super) struct SocketInfo {
        stat: [u64; 17],
        so: u64,
        pcb: u64,
        kind_type: i32,
        protocol: i32,
        pub(super) family: i32,
        shorts: [i16; 8],
        oobmark: u32,
        buffers: [u32; 12],
        pub(super) kind: i32,
        rfu: u32,
        pub(super) tcp: TcpSockInfo,
    }
    /// `struct tcp_sockinfo`, the largest member of `soi_proto` padded out.
    #[repr(C)]
    pub(super) struct TcpSockInfo {
        pub(super) foreign_port: i32,
        pub(super) local_port: i32,
        gencnt: u64,
        flags: u32,
        flow: u32,
        pub(super) vflag: u8,
        ttl: u8,
        rfu: u32,
        /// `in4in6_addr`: the IPv4 address is its last four bytes.
        pub(super) foreign: [u8; 16],
        pub(super) local: [u8; 16],
        v4v6: [u8; 16],
        pub(super) state: i32,
        rest: [u8; 444],
    }
    // The SDK's layout, from `offsetof` and `sizeof` over `<sys/proc_info.h>`.
    const _: () = {
        assert!(size_of::<SocketFdInfo>() == 792);
        assert!(offset_of!(SocketFdInfo, psi) == 24);
        assert!(24 + offset_of!(SocketInfo, family) == 184);
        assert!(24 + offset_of!(SocketInfo, kind) == 256);
        assert!(24 + offset_of!(SocketInfo, tcp) == 264);
        assert!(264 + offset_of!(TcpSockInfo, vflag) == 288);
        assert!(264 + offset_of!(TcpSockInfo, foreign) == 296);
        assert!(264 + offset_of!(TcpSockInfo, local) == 312);
        assert!(264 + offset_of!(TcpSockInfo, state) == 344);
    };

    fn address(raw: &[u8; 16], port: i32) -> SocketAddrV4 {
        let ip = Ipv4Addr::new(raw[12], raw[13], raw[14], raw[15]);
        // The port is in network order in an `int`.
        SocketAddrV4::new(ip, u16::from_be(port as u16))
    }

    /// The established IPv4 TCP connection `info` describes, if it is one.
    pub(super) fn connection(info: &SocketFdInfo) -> Option<Connection> {
        let (psi, tcp) = (&info.psi, &info.psi.tcp);
        (psi.kind == SOCKINFO_TCP
            && psi.family == libc::AF_INET
            && tcp.vflag & INI_IPV4 != 0
            && tcp.state == TSI_S_ESTABLISHED)
            .then(|| Connection {
                local: address(&tcp.local, tcp.local_port),
                remote: address(&tcp.foreign, tcp.foreign_port),
            })
    }

    /// Every pid, or `Cut` when the list may have been truncated.
    fn pids() -> Result<Vec<i32>, Cut> {
        // SAFETY: a null buffer asks only for the count.
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        let mut pids = vec![0i32; count.max(0) as usize + 64];
        let bytes = (pids.len() * size_of::<i32>()) as i32;
        // SAFETY: the buffer holds `bytes` bytes.
        let found = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        if found <= 0 || found as usize >= pids.len() {
            return Err(Cut);
        }
        pids.truncate(found as usize);
        Ok(pids)
    }

    /// The process's socket descriptors, or `Cut` when the list may have
    /// been truncated.
    fn sockets(pid: i32) -> Result<Vec<i32>, Cut> {
        let entry = size_of::<libc::proc_fdinfo>();
        // SAFETY: a null buffer asks only for the size.
        let size =
            unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
        if size <= 0 {
            return Ok(Vec::new());
        }
        let empty = libc::proc_fdinfo {
            proc_fd: 0,
            proc_fdtype: 0,
        };
        let mut fds = vec![empty; size as usize / entry + 16];
        let bytes = (fds.len() * entry) as i32;
        // SAFETY: the buffer holds `bytes` bytes.
        let used = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDLISTFDS,
                0,
                fds.as_mut_ptr().cast(),
                bytes,
            )
        };
        let used = used.max(0) as usize / entry;
        if used >= fds.len() {
            return Err(Cut);
        }
        fds.truncate(used);
        Ok(fds
            .into_iter()
            .filter(|fd| fd.proc_fdtype == libc::PROX_FDTYPE_SOCKET as u32)
            .map(|fd| fd.proc_fd)
            .collect())
    }

    fn holds(pid: i32, fd: i32, want: Connection) -> bool {
        // SAFETY: all-zero is a valid value of these plain-data structs.
        let mut info: SocketFdInfo = unsafe { zeroed() };
        let size = size_of::<SocketFdInfo>() as i32;
        // SAFETY: the buffer is a whole `socket_fdinfo`.
        let read = unsafe {
            libc::proc_pidfdinfo(
                pid,
                fd,
                PROC_PIDFDSOCKETINFO,
                (&mut info as *mut SocketFdInfo).cast::<c_void>(),
                size,
            )
        };
        read == size && connection(&info) == Some(want)
    }

    pub(super) fn owner(want: Connection, deadline: Instant) -> Option<u32> {
        let holders = pids().ok()?.into_iter().filter(|&pid| pid > 0).map(|pid| {
            scan(pid as u32, sockets(pid)?, deadline, |fd| {
                holds(pid, fd, want)
            })
        });
        unique(holders, deadline)
    }

    pub(super) fn path(pid: u32) -> Option<PathBuf> {
        let pid = i32::try_from(pid).ok()?;
        let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: the buffer holds its length in bytes.
        let len =
            unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        (len > 0).then(|| {
            buffer.truncate(len as usize);
            PathBuf::from(String::from_utf8_lossy(&buffer).into_owned())
        })
    }
}

/// The established IPv4 connections in `/proc/net/tcp` text, with their
/// socket inodes.
/// Stops at `deadline`.
#[cfg(any(target_os = "linux", test))]
fn proc_net_tcp(table: &str, deadline: Instant) -> impl Iterator<Item = (Connection, &str)> {
    fn address(field: &str) -> Option<SocketAddrV4> {
        let (ip, port) = field.split_once(':')?;
        // The address is printed as a host-order word of network-order bytes.
        let ip = u32::from_str_radix(ip, 16).ok()?.to_ne_bytes();
        Some(SocketAddrV4::new(
            ip.into(),
            u16::from_str_radix(port, 16).ok()?,
        ))
    }
    let lines = table.lines().skip(1);
    lines
        .take_while(move |_| Instant::now() < deadline)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            // State 01 is ESTABLISHED.
            if fields.len() <= 9 || fields[3] != "01" {
                return None;
            }
            let connection = Connection {
                local: address(fields[1])?,
                remote: address(fields[2])?,
            };
            Some((connection, fields[9]))
        })
}

/// The inode of the one socket for `want` in `table`; none for several, or
/// once `deadline` has passed.
#[cfg(any(target_os = "linux", test))]
fn inode(table: &str, want: Connection, deadline: Instant) -> Option<&str> {
    let mut matches = proc_net_tcp(table, deadline).filter(|(connection, _)| *connection == want);
    let (_, inode) = matches.next()?;
    (matches.next().is_none() && Instant::now() < deadline).then_some(inode)
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{inode, scan, unique, Connection};
    use std::path::PathBuf;
    use std::time::Instant;

    pub(super) fn owner(want: Connection, deadline: Instant) -> Option<u32> {
        let table = std::fs::read_to_string("/proc/net/tcp").ok()?;
        let socket = PathBuf::from(format!("socket:[{}]", inode(&table, want, deadline)?));
        let holders = std::fs::read_dir("/proc")
            .ok()?
            .flatten()
            .filter_map(|entry| {
                let pid: u32 = entry.file_name().to_str()?.parse().ok()?;
                let fds = std::fs::read_dir(entry.path().join("fd")).ok();
                Some(scan(
                    pid,
                    fds.into_iter().flatten().flatten(),
                    deadline,
                    |fd| std::fs::read_link(fd.path()).is_ok_and(|link| link == socket),
                ))
            });
        unique(holders, deadline)
    }

    pub(super) fn path(pid: u32) -> Option<PathBuf> {
        std::fs::read_link(format!("/proc/{pid}/exe")).ok()
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod imp {
    use super::Connection;
    use std::path::PathBuf;
    use std::time::Instant;

    pub(super) fn owner(_: Connection, _: Instant) -> Option<u32> {
        None
    }
    pub(super) fn path(_: u32) -> Option<PathBuf> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use std::io::{Read, Write};

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    const CONNECT: &str = "BUZZ_PEER_TEST_CONNECT";

    fn v4(raw: &str) -> SocketAddrV4 {
        raw.parse().unwrap()
    }

    /// Run by [`names_a_separate_process`]: connects, then holds the
    /// connection until the other end closes it.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    #[ignore = "a helper process, run by names_a_separate_process"]
    fn connect_and_wait() {
        let Ok(address) = std::env::var(CONNECT) else {
            return;
        };
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        stream.write_all(b"x").unwrap();
        let _ = stream.read(&mut [0]);
    }

    /// Kills and reaps the helper on every way out of the test.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    struct Reaped(std::process::Child);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    impl Drop for Reaped {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn names_a_separate_process() {
        let limit = Instant::now() + Duration::from_secs(30);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let service = listener.local_addr().unwrap();
        let mut child = Reaped(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "credential_service::peer::tests::connect_and_wait",
                ])
                .args(["--ignored", "--test-threads=1"])
                .env(CONNECT, service.to_string())
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let (mut stream, peer) = loop {
            match listener.accept() {
                Ok(accepted) => break accepted,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    let exited = child.0.try_wait().unwrap();
                    assert!(exited.is_none(), "the helper exited first: {exited:?}");
                    assert!(Instant::now() < limit, "the helper never connected");
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("accept: {error}"),
            }
        };
        let SocketAddr::V4(peer) = peer else {
            panic!("an IPv4 peer");
        };
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        stream.read_exact(&mut [0]).unwrap();
        let SocketAddr::V4(remote) = service else {
            panic!("an IPv4 service");
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        let want = Connection {
            local: peer,
            remote,
        };
        assert_eq!(imp::owner(want, deadline), Some(child.0.id()));
        // This process holds the other end, which is not the caller's.
        let reversed = Connection {
            local: remote,
            remote: peer,
        };
        assert_eq!(imp::owner(reversed, deadline), Some(std::process::id()));
        drop(stream);
        while child.0.try_wait().unwrap().is_none() {
            assert!(Instant::now() < limit, "the helper never exited");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// The `<sys/proc_info.h>` layout the mirrors assert, as the SDK's C
    /// compiler reports it.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_layout_matches_the_sdk() {
        let dir = std::env::temp_dir().join(format!("buzz-peer-layout-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (source, probe) = (dir.join("probe.c"), dir.join("probe"));
        std::fs::write(
            &source,
            r#"#include <stdio.h>
#include <stddef.h>
#include <sys/proc_info.h>
#define T struct socket_fdinfo
#define P(f) printf("%zu ", offsetof(T, f))
int main(void) {
    printf("%zu ", sizeof(T));
    P(psi); P(psi.soi_family); P(psi.soi_kind); P(psi.soi_proto.pri_tcp);
    P(psi.soi_proto.pri_tcp.tcpsi_ini.insi_vflag);
    P(psi.soi_proto.pri_tcp.tcpsi_ini.insi_faddr);
    P(psi.soi_proto.pri_tcp.tcpsi_ini.insi_laddr);
    P(psi.soi_proto.pri_tcp.tcpsi_state);
    return 0;
}"#,
        )
        .unwrap();
        let built = std::process::Command::new("cc")
            .arg(&source)
            .arg("-o")
            .arg(&probe)
            .status()
            .unwrap();
        assert!(built.success());
        let out = std::process::Command::new(&probe).output().unwrap().stdout;
        let _ = std::fs::remove_dir_all(&dir);
        use std::mem::{offset_of, size_of};
        let (psi, tcp) = (
            offset_of!(imp::SocketFdInfo, psi),
            offset_of!(imp::SocketInfo, tcp),
        );
        let ours = [
            size_of::<imp::SocketFdInfo>(),
            psi,
            psi + offset_of!(imp::SocketInfo, family),
            psi + offset_of!(imp::SocketInfo, kind),
            psi + tcp,
            psi + tcp + offset_of!(imp::TcpSockInfo, vflag),
            psi + tcp + offset_of!(imp::TcpSockInfo, foreign),
            psi + tcp + offset_of!(imp::TcpSockInfo, local),
            psi + tcp + offset_of!(imp::TcpSockInfo, state),
        ];
        let sdk: Vec<usize> = String::from_utf8(out)
            .unwrap()
            .split_whitespace()
            .map(|n| n.parse().unwrap())
            .collect();
        assert_eq!(sdk, ours);
    }

    #[test]
    fn a_passed_deadline_names_nobody() {
        let past = Instant::now();
        assert_eq!(unique([Ok(Some(1))].into_iter(), past), None);
        let later = Instant::now() + Duration::from_secs(10);
        assert_eq!(
            unique([Ok(None), Ok(Some(7)), Ok(Some(7))].into_iter(), later),
            Some(7)
        );
        // Two processes holding the socket (an inherited descriptor) name nobody.
        assert_eq!(unique([Ok(Some(7)), Ok(Some(8))].into_iter(), later), None);
        assert_eq!(unique([Ok(None)].into_iter(), later), None);
    }

    /// One visible holder, and another process whose scan hit the descriptor
    /// cap before reaching its copy of the socket: nobody is named.
    #[test]
    fn a_capped_scan_names_nobody() {
        let later = Instant::now() + Duration::from_secs(10);
        let competing = scan(8, 0..=DESCRIPTORS, later, |fd| fd == DESCRIPTORS);
        assert_eq!(competing, Err(Cut));
        assert_eq!(scan(8, 0..DESCRIPTORS, later, |_| false), Ok(None));
        assert_eq!(scan(7, 0..=DESCRIPTORS, later, |fd| fd == 3), Ok(Some(7)));
        assert_eq!(unique([Ok(Some(7)), competing].into_iter(), later), None);
    }

    /// Past the deadline the scan stops reading descriptors, mid-process.
    #[test]
    fn the_scan_stops_at_the_deadline() {
        let deadline = Instant::now() + Duration::from_millis(50);
        let mut read = 0;
        let found = scan(7, 0.., deadline, |_| {
            read += 1;
            std::thread::sleep(Duration::from_millis(10));
            false
        });
        assert_eq!(found, Err(Cut));
        assert!(read < 20, "read {read} descriptors");
    }

    /// The blocking work itself ends soon after the deadline, not only the wait.
    #[tokio::test]
    async fn a_lookup_past_its_deadline_stops_working() {
        let (done, finished) = std::sync::mpsc::channel();
        let found = bounded(Duration::from_millis(50), move |deadline| {
            let found = scan(7, 0.., deadline, |_| {
                std::thread::sleep(Duration::from_millis(1));
                false
            });
            done.send(()).unwrap();
            found.ok().flatten()
        })
        .await;
        assert_eq!(found, None);
        finished.recv_timeout(Duration::from_millis(200)).unwrap();
    }

    #[tokio::test]
    async fn a_slow_lookup_is_given_up_on() {
        let started = Instant::now();
        let found = bounded(Duration::from_millis(50), |_| {
            std::thread::sleep(Duration::from_secs(2));
            Some(1)
        })
        .await;
        assert_eq!(found, None);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    /// Only the socket whose addresses and ports all match is chosen; one
    /// with the same ports and another address is not, nor one not
    /// established.
    #[test]
    fn proc_net_tcp_matches_the_whole_connection() {
        let want = Connection {
            local: v4("127.0.0.1:50000"),
            remote: v4("127.0.0.1:40000"),
        };
        let header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
        let line = |local: &str, remote: &str, state: &str, inode: &str| {
            format!("   0: {local} {remote} {state} 00000000:00000000 00:00000000 00000000  1000        0 {inode}\n")
        };
        let exact = line("0100007F:C350", "0100007F:9C40", "01", "111");
        let other_address = line("0200007F:C350", "0100007F:9C40", "01", "222");
        let listening = line("0100007F:C350", "0100007F:9C40", "0A", "333");
        let table = format!("{header}{other_address}{listening}{exact}");
        let later = Instant::now() + Duration::from_secs(10);
        assert_eq!(inode(&table, want, later), Some("111"));
        assert_eq!(
            inode(&format!("{header}{other_address}{listening}"), want, later),
            None
        );
        assert_eq!(inode(&table, want, Instant::now()), None);
        // Two exact matches are ambiguous.
        let twice = format!(
            "{header}{exact}{}",
            line("0100007F:C350", "0100007F:9C40", "01", "444")
        );
        assert_eq!(inode(&twice, want, later), None);
    }

    /// The same, for libproc's socket records.
    #[cfg(target_os = "macos")]
    #[test]
    fn libproc_matches_the_whole_connection() {
        let record = |local: [u8; 4], state: i32, family: i32| {
            // SAFETY: all-zero is a valid value of this plain-data struct.
            let mut info: imp::SocketFdInfo = unsafe { std::mem::zeroed() };
            info.psi.kind = 2;
            info.psi.family = family;
            let tcp = &mut info.psi.tcp;
            tcp.vflag = 1;
            tcp.state = state;
            tcp.local[12..].copy_from_slice(&local);
            tcp.foreign[12..].copy_from_slice(&[127, 0, 0, 1]);
            tcp.local_port = i32::from(50000u16.to_be());
            tcp.foreign_port = i32::from(40000u16.to_be());
            info
        };
        let want = Connection {
            local: v4("127.0.0.1:50000"),
            remote: v4("127.0.0.1:40000"),
        };
        assert_eq!(
            imp::connection(&record([127, 0, 0, 1], 4, libc::AF_INET)),
            Some(want)
        );
        let other = imp::connection(&record([127, 0, 0, 2], 4, libc::AF_INET));
        assert!(other.is_some_and(|other| other != want));
        assert_eq!(
            imp::connection(&record([127, 0, 0, 1], 1, libc::AF_INET)),
            None
        );
        assert_eq!(
            imp::connection(&record([127, 0, 0, 1], 4, libc::AF_INET6)),
            None
        );
    }
}
