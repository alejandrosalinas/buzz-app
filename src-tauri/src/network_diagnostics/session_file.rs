//! One ordered writer owns session I/O. Network tasks only enqueue metadata;
//! export and clear are barriers in that same queue, never network retries.
use serde_json::Value;
use std::{
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Seek, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
};

type Result<T> = std::result::Result<T, String>;
type Reply<T> = mpsc::Sender<Result<T>>;
enum Command {
    Append(Vec<Value>),
    Clear(Reply<()>),
    Flush(Reply<()>),
    Export(PathBuf, Value, Reply<String>),
}

#[derive(Clone)]
pub(super) struct SessionFile {
    pub(super) path: PathBuf,
    sender: mpsc::Sender<Command>,
    error: Arc<Mutex<Option<String>>>,
    queued: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
}

fn private_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

impl SessionFile {
    pub(super) fn start(directory: &Path) -> Result<Self> {
        std::fs::create_dir_all(directory).map_err(|_| "Session log directory unavailable")?;
        let path = directory.join(format!(
            "buzz-network-{}-{}.jsonl",
            super::timestamp(),
            uuid::Uuid::new_v4()
        ));
        let mut file = private_file(&path).map_err(|_| "Session log could not be created")?;
        let (sender, receiver) = mpsc::channel();
        let error = Arc::new(Mutex::new(None));
        let status = error.clone();
        let queued = Arc::new(AtomicUsize::new(0));
        let pending = queued.clone();
        let peak = Arc::new(AtomicUsize::new(0));
        let source = path.clone();
        std::thread::Builder::new()
            .name("network-diagnostics".into())
            .spawn(move || {
                let mut failure: Option<String> = None;
                for command in receiver {
                    match command {
                        Command::Append(events) => {
                            let count = events.len();
                            let result = if let Some(error) = &failure {
                                Err(error.clone())
                            } else {
                                let mut lines = Vec::new();
                                for event in events {
                                    serde_json::to_writer(&mut lines, &event)
                                        .expect("JSON metadata");
                                    lines.push(b'\n');
                                }
                                file.write_all(&lines)
                                    .map_err(|_| "Session log could not be written".to_owned())
                            };
                            pending.fetch_sub(count, Ordering::Relaxed);
                            if let Err(error) = &result {
                                failure = Some(error.clone());
                                *status.lock().unwrap() = failure.clone();
                            }
                        }
                        Command::Clear(reply) => {
                            let result = file
                                .set_len(0)
                                .and_then(|()| file.rewind())
                                .map_err(|_| "Session log could not be cleared".to_owned());
                            failure = result.as_ref().err().cloned();
                            *status.lock().unwrap() = failure.clone();
                            let _ = reply.send(result);
                        }
                        Command::Flush(reply) => {
                            let result = file
                                .sync_all()
                                .map_err(|_| "Session log could not be flushed".into());
                            let _ = reply.send(result);
                        }
                        Command::Export(directory, metadata, reply) => {
                            let result = if let Some(error) = &failure {
                                Err(error.clone())
                            } else {
                                export(&source, &directory, metadata)
                            };
                            let _ = reply.send(result);
                        }
                    }
                }
            })
            .map_err(|_| "Session log writer could not start")?;
        Ok(Self {
            path,
            sender,
            error,
            queued,
            peak,
        })
    }

    pub(super) fn error(&self) -> Option<String> {
        self.error.lock().unwrap().clone()
    }

    pub(super) fn backlog(&self) -> Value {
        serde_json::json!({"pendingRecords":self.queued.load(Ordering::Relaxed),"peakRecords":self.peak.load(Ordering::Relaxed)})
    }
    pub(super) fn append(&self, events: Vec<Value>) -> Result<()> {
        let count = events.len();
        let queued = self.queued.fetch_add(count, Ordering::Relaxed) + count;
        self.peak.fetch_max(queued, Ordering::Relaxed);
        if self.sender.send(Command::Append(events)).is_err() {
            self.queued.fetch_sub(count, Ordering::Relaxed);
            *self.error.lock().unwrap() = Some("Session log writer stopped".into());
            return Err("Session log writer stopped".into());
        }
        self.error().map_or(Ok(()), Err)
    }

    pub(super) fn clear(&self) -> Result<mpsc::Receiver<Result<()>>> {
        self.enqueue(Command::Clear)
    }

    pub(super) fn flush(&self) -> Result<()> {
        self.request(Command::Flush)
    }

    pub(super) fn export(&self, directory: PathBuf, metadata: Value) -> Result<String> {
        self.request(|reply| Command::Export(directory, metadata, reply))
    }

    fn request<T>(&self, command: impl FnOnce(Reply<T>) -> Command) -> Result<T> {
        self.enqueue(command)?
            .recv()
            .map_err(|_| "Session log writer stopped")?
    }

    fn enqueue<T>(
        &self,
        command: impl FnOnce(Reply<T>) -> Command,
    ) -> Result<mpsc::Receiver<Result<T>>> {
        let (reply, received) = mpsc::channel();
        self.sender
            .send(command(reply))
            .map_err(|_| "Session log writer stopped")?;
        Ok(received)
    }
}

fn export(source: &Path, directory: &Path, mut metadata: Value) -> Result<String> {
    let path = directory.join(format!(
        "buzz-network-{}-{}.diagnostics.json",
        super::timestamp(),
        uuid::Uuid::new_v4()
    ));
    let file = private_file(&path).map_err(|_| "Diagnostics export could not be created")?;
    let result = (|| -> std::io::Result<()> {
        metadata["sessionFile"] = source
            .file_name()
            .unwrap()
            .to_string_lossy()
            .as_ref()
            .into();
        let mut output = BufWriter::new(file);
        let mut header = serde_json::to_vec(&metadata)?;
        // Metadata is an object made by the host, never renderer-supplied text.
        header.pop();
        output.write_all(&header)?;
        output.write_all(b",\"events\":[")?;
        let mut first = true;
        for line in BufReader::new(File::open(source)?).lines() {
            if !first {
                output.write_all(b",")?;
            }
            first = false;
            output.write_all(line?.as_bytes())?;
        }
        output.write_all(b"]}")?;
        output.flush()
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&path);
        return Err("Diagnostics export could not be saved".into());
    }
    Ok(path.to_string_lossy().into_owned())
}
