use std::collections::BTreeMap;
use std::time::Duration;

use buzzodz_plugins::HostGrants;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, OnceLock};

mod public_image;
mod public_page;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CallContext {
    boot: String,
    page: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Once {
    boot: String,
    page: u64,
    activation: String,
    call_id: String,
}
struct Claims {
    page: Option<u64>,
    consumed: std::collections::HashMap<[u8; 32], [u8; 32]>,
}
pub(crate) struct HostCalls {
    boot: String,
    claims: Mutex<Claims>,
}
impl Default for HostCalls {
    fn default() -> Self {
        Self {
            boot: uuid::Uuid::new_v4().to_string(),
            claims: Mutex::new(Claims {
                page: Some(0),
                consumed: Default::default(),
            }),
        }
    }
}
/// Length framing keeps boundaries (including absent versus empty fields) distinct.
fn fingerprint<'a>(parts: impl IntoIterator<Item = &'a [u8]>) -> [u8; 32] {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part);
    }
    hash.finalize().into()
}
impl HostCalls {
    pub(crate) fn page_load(&self) {
        // Poisoned admission remains permanently unavailable.
        if let Ok(mut state) = self.claims.lock() {
            state.page = state
                .page
                .and_then(|p| p.checked_add(1))
                .filter(|p| *p <= 9_007_199_254_740_991);
            // Old envelopes fail the page check before lookup, so they cannot use freed capacity.
            state.consumed.clear();
        }
    }
    fn context(&self, label: &str) -> Result<CallContext, String> {
        if label != "main" {
            return Err("Protected host calls require the main view".into());
        }
        let state = self
            .claims
            .lock()
            .map_err(|_| "Host admission is unavailable")?;
        Ok(CallContext {
            boot: self.boot.clone(),
            page: state.page.ok_or("Host page generation exhausted")?,
        })
    }
    fn consume(
        &self,
        label: &str,
        kind: &str,
        id: &str,
        revision: &str,
        once: &Once,
        payload: [u8; 32],
    ) -> Result<(), String> {
        if label != "main"
            || [&once.boot, &once.activation, &once.call_id]
                .iter()
                .any(|tag| {
                    uuid::Uuid::parse_str(tag).map_or(true, |uuid| uuid.to_string() != **tag)
                })
        {
            return Err("Invalid protected host authority".into());
        }
        let mut state = self
            .claims
            .lock()
            .map_err(|_| "Host admission is unavailable")?;
        if once.boot != self.boot || Some(once.page) != state.page {
            return Err("Stale protected host authority".into());
        }
        let page = once.page.to_be_bytes();
        let key = fingerprint([
            kind.as_bytes(),
            id.as_bytes(),
            revision.as_bytes(),
            &page,
            once.activation.as_bytes(),
            once.call_id.as_bytes(),
        ]);
        if let Some(previous) = state.consumed.get(&key) {
            return Err(if previous == &payload {
                "Host call already consumed; outcome unknown"
            } else {
                "Host call payload conflict; outcome unknown"
            }
            .into());
        }
        if state.consumed.len() >= 1024 {
            return Err("Host call capacity exhausted".into());
        }
        state.consumed.insert(key, payload);
        Ok(())
    }
}
#[tauri::command]
pub(crate) fn plugin_host_call_context<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    calls: tauri::State<'_, HostCalls>,
) -> Result<CallContext, String> {
    calls.context(webview.label())
}

use crate::{with_manager, PluginManager};

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 8192;
const MAX_RESPONSE_HEADER_BYTES: usize = 16 * 1024;
pub(crate) const DEADLINE: Duration = Duration::from_secs(30);
/// An uploaded file, such as an app artifact.
pub(crate) const MAX_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;
/// A deploy can wait for its rollout before it answers.
pub(crate) const UPLOAD_DEADLINE: Duration = Duration::from_secs(180);
/// What an uploaded file's name must end with: archives only, never a key or
/// a config file a request could carry off.
const UPLOAD_EXTENSION: &str = ".tar.gz";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostRequest {
    url: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
}

impl HostRequest {
    fn fingerprint(&self) -> [u8; 32] {
        let timeout = self.timeout_ms.map(|n| n.to_string()).unwrap_or_default();
        fingerprint(
            [
                self.url.as_bytes(),
                self.method.as_bytes(),
                if self.body.is_some() {
                    b"some"
                } else {
                    b"none"
                },
                self.body.as_deref().unwrap_or_default().as_bytes(),
                timeout.as_bytes(),
            ]
            .into_iter()
            .chain(
                self.headers
                    .iter()
                    .flat_map(|(name, value)| [name.as_bytes(), value.as_bytes()]),
            ),
        )
    }
}

pub(crate) fn request_deadline(timeout_ms: Option<u64>) -> Result<Duration, String> {
    match timeout_ms {
        None => Ok(DEADLINE),
        Some(value @ 1..=180_000) => Ok(Duration::from_millis(value)),
        Some(_) => Err("Host request timeout must be between 1 and 180000 milliseconds".into()),
    }
}

fn default_method() -> String {
    "GET".into()
}

/// A multipart POST of one local file, with text fields beside it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostUpload {
    url: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    fields: BTreeMap<String, String>,
    file: UploadFile,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadFile {
    /// The form field it is sent as.
    field: String,
    /// An absolute path to a regular `.tar.gz` file under the home directory.
    path: String,
    /// The file name the form gives it.
    name: String,
    content_type: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct HostResponse {
    pub(crate) status: u16,
    headers: BTreeMap<String, String>,
    body: String,
}

#[tauri::command]
pub(crate) async fn plugin_host_request<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    calls: tauri::State<'_, HostCalls>,
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
    request: HostRequest,
    once: Option<Once>,
) -> Result<HostResponse, String> {
    let deadline = request_deadline(request.timeout_ms)?;
    let (url, method, headers) = validate_request(&request)?;
    let operation = async {
        let (plugin_id, artifact) = (id.clone(), revision.clone());
        let grants = with_manager(manager, move |manager| {
            manager.host_grants(&plugin_id, &artifact)
        })
        .await
        .map_err(|_| "Host request is unavailable")?;
        if !allows_origin(&grants, &url) {
            return Err("Host request origin is not declared".into());
        }
        if let Some(once) = &once {
            if request.method != "POST" {
                return Err("Protected requests require POST".into());
            }
            calls.consume(
                webview.label(),
                "post",
                &id,
                &revision,
                once,
                request.fingerprint(),
            )?;
        }
        send_request_with_policy(url, method, headers, request.body, deadline, once.is_some()).await
    };
    tokio::time::timeout(deadline, operation)
        .await
        .map_err(|_| "Host request timed out")?
}

const MAX_UPLOAD_METADATA: usize = 16 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ByteUpload {
    url: String,
    field: String,
    name: String,
    content_type: String,
    #[serde(default)]
    fields: BTreeMap<String, String>,
}
impl ByteUpload {
    fn fingerprint(&self, bytes: &[u8]) -> Result<[u8; 32], String> {
        // Reuse the bounded metadata shape, including deterministic BTreeMap order.
        let metadata = serde_json::to_vec(self).map_err(|_| "Invalid upload metadata")?;
        Ok(fingerprint([metadata.as_slice(), bytes]))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ByteUploadMetadata {
    id: String,
    revision: String,
    upload: ByteUpload,
    once: Once,
}
fn validate_byte_upload(upload: &ByteUpload, bytes: &[u8]) -> Result<reqwest::Url, String> {
    if bytes.is_empty() || bytes.len() > MAX_RESPONSE_BYTES {
        return Err("Invalid upload bytes".into());
    }
    // One safe filename and safe form names; no paths or multipart header syntax.
    let safe_name = |name: &str| {
        !name.is_empty()
            && name.len() <= 256
            && !name.starts_with('.')
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    };
    if !safe_name(&upload.name)
        || !safe_name(&upload.field)
        || upload.fields.len() > 16
        || upload
            .fields
            .iter()
            .any(|(name, value)| !safe_name(name) || value.len() > MAX_HEADER_BYTES)
    {
        return Err("Invalid upload form".into());
    }
    // This is a signature check, not an image decoder or a claim of image safety.
    let matches_type = match upload.content_type.as_str() {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    };
    if !matches_type {
        return Err("Upload type must be PNG, JPEG or WebP with matching magic bytes".into());
    }
    let (url, _, _) = validate_request(&HostRequest {
        url: upload.url.clone(),
        method: "POST".into(),
        headers: BTreeMap::new(),
        body: None,
        timeout_ms: None,
    })?;
    Ok(url)
}

/// Raw-only admission: JSON/array fallback never reaches consumption or HTTP.
#[tauri::command]
pub(crate) async fn plugin_host_upload_bytes_once<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    calls: tauri::State<'_, HostCalls>,
    manager: tauri::State<'_, PluginManager>,
    request: tauri::ipc::Request<'_>,
) -> Result<HostResponse, String> {
    let deadline = tokio::time::Instant::now() + DEADLINE;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Protected upload body must be raw bytes; outcome may be unknown".into());
    };
    let metadata = request
        .headers()
        .get("x-buzz-upload")
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.len() <= MAX_UPLOAD_METADATA)
        .ok_or("Invalid upload metadata")?;
    let ByteUploadMetadata {
        id,
        revision,
        upload,
        once,
    } = serde_json::from_str(metadata).map_err(|_| "Invalid upload metadata")?;
    if id.is_empty() || id.len() > 256 || revision.is_empty() || revision.len() > 128 {
        return Err("Invalid upload metadata".into());
    }
    let url = validate_byte_upload(&upload, bytes)?;
    let operation = async {
        // One FIFO queue and work permit for GET/save/upload; queue time is part
        // of this call's entry deadline. Do not clone/build multipart while waiting.
        let _place = crate::host_files::byte_admission(deadline).await?;
        upload_origin(&byte_grants(manager, &id, &revision).await?, &url)?;
        calls.consume(
            webview.label(),
            "upload-bytes",
            &id,
            &revision,
            &once,
            upload.fingerprint(bytes)?,
        )?;
        send_byte_upload(url, &upload, bytes)
            .await
            .map_err(|error| format!("{error}; outcome unknown"))
    };
    tokio::time::timeout_at(deadline, operation)
        .await
        .map_err(|_| "Host upload timed out; outcome unknown")?
}

async fn send_byte_upload(
    url: reqwest::Url,
    upload: &ByteUpload,
    bytes: &[u8],
) -> Result<HostResponse, String> {
    let (content_type, body) = multipart(
        &upload.fields,
        &upload.field,
        &upload.name,
        &upload.content_type,
        bytes,
    )?;
    let client = reqwest::Client::builder()
        .user_agent(crate::relay::user_agent())
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(DEADLINE)
        .build()
        .map_err(|_| "Host request client is unavailable")?;
    read_response(
        client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(body),
    )
    .await
}

/// A GET with no caller headers or body; byte limits apply to actual chunks.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ByteRequest {
    url: String,
    max_bytes: usize,
    timeout_ms: Option<u64>,
}

#[tauri::command]
pub(crate) async fn plugin_host_request_bytes(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
    request: ByteRequest,
) -> Result<tauri::ipc::Response, String> {
    let entered = tokio::time::Instant::now();
    let timeout = request.timeout_ms.unwrap_or(30_000);
    if request.max_bytes == 0
        || request.max_bytes > MAX_RESPONSE_BYTES
        || !(1..=30_000).contains(&timeout)
    {
        return Err("Invalid byte request limits".into());
    }
    let (url, _, _) = validate_request(&HostRequest {
        url: request.url,
        method: "GET".into(),
        headers: BTreeMap::new(),
        body: None,
        timeout_ms: Some(timeout),
    })?;
    let end = entered + Duration::from_millis(timeout);
    let operation = async {
        let _place = crate::host_files::byte_admission(end).await?;
        let reach = byte_origin(manager.clone(), &id, &revision, &url).await?;
        let (status, headers, bytes) = match reach {
            ByteReach::Declared => {
                let get = client(false)?
                    .get(url.clone())
                    .timeout(Duration::from_millis(timeout));
                read_bytes(get, request.max_bytes).await?
            }
            ByteReach::PublicImage => {
                let addresses = public_image::public_addresses(&url).await?;
                public_image::fetch(
                    url.clone(),
                    &addresses,
                    request.max_bytes,
                    Duration::from_millis(timeout),
                )
                .await?
            }
        };
        if byte_origin(manager, &id, &revision, &url).await? != reach {
            return Err("Host request origin is not declared".into());
        }
        byte_frame(status, headers, bytes).map(tauri::ipc::Response::new)
    };
    tokio::time::timeout_at(end, operation)
        .await
        .map_err(|_| "Host byte request timed out")?
}

/// One public page's preview fields, for a plugin whose manifest declares
/// `host.publicPages`. Redirects come back for the plugin to check.
#[tauri::command]
pub(crate) async fn plugin_host_read_page(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
    url: String,
    timeout_ms: Option<u64>,
) -> Result<public_page::PageReply, String> {
    let timeout = timeout_ms.unwrap_or(10_000);
    if !(1..=30_000).contains(&timeout) {
        return Err("Invalid page request timeout".into());
    }
    let (url, _, _) = validate_request(&HostRequest {
        url,
        method: "GET".into(),
        headers: BTreeMap::new(),
        body: None,
        timeout_ms: Some(timeout),
    })?;
    let end = tokio::time::Instant::now() + Duration::from_millis(timeout);
    let operation = async {
        let _place = crate::host_files::byte_admission(end).await?;
        if !byte_grants(manager.clone(), &id, &revision)
            .await?
            .public_pages
        {
            return Err("Plugin may not read public pages".to_owned());
        }
        let reply = public_page::read(url, Duration::from_millis(timeout)).await?;
        if !byte_grants(manager, &id, &revision).await?.public_pages {
            return Err("Plugin may not read public pages".to_owned());
        }
        Ok(reply)
    };
    tokio::time::timeout_at(end, operation)
        .await
        .map_err(|_| "Host page request timed out")?
}

/// How a byte request may reach its URL: a declared origin gets any response;
/// any other origin, with `host.publicImages`, gets only a public image.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ByteReach {
    Declared,
    PublicImage,
}

async fn byte_grants(
    manager: tauri::State<'_, PluginManager>,
    id: &str,
    revision: &str,
) -> Result<HostGrants, String> {
    let (id, revision) = (id.to_owned(), revision.to_owned());
    with_manager(manager, move |m| m.host_grants(&id, &revision))
        .await
        .map_err(|_| "Host byte request is unavailable".into())
}

async fn byte_origin(
    manager: tauri::State<'_, PluginManager>,
    id: &str,
    revision: &str,
    url: &reqwest::Url,
) -> Result<ByteReach, String> {
    let grants = byte_grants(manager, id, revision).await?;
    reach(&grants, url).ok_or_else(|| "Host request origin is not declared".into())
}

/// An upload sends the plugin's bytes and returns the whole reply, so it
/// needs a declared origin: `host.publicImages` widens only image reads.
fn upload_origin(grants: &HostGrants, url: &reqwest::Url) -> Result<(), String> {
    match reach(grants, url) {
        Some(ByteReach::Declared) => Ok(()),
        _ => Err("Host request origin is not declared".into()),
    }
}

fn reach(grants: &HostGrants, url: &reqwest::Url) -> Option<ByteReach> {
    if allows_origin(grants, url) {
        Some(ByteReach::Declared)
    } else if grants.public_images {
        Some(ByteReach::PublicImage)
    } else {
        None
    }
}

fn byte_frame(
    status: u16,
    headers: BTreeMap<String, String>,
    bytes: Vec<u8>,
) -> Result<Vec<u8>, String> {
    let metadata = serde_json::to_vec(&serde_json::json!({"status":status,"headers":headers}))
        .map_err(|_| "Could not encode byte response")?;
    if metadata.len() > 20 * 1024 {
        return Err("Host byte response metadata is too large".into());
    }
    let mut frame = Vec::with_capacity(4 + metadata.len() + bytes.len());
    frame.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
    frame.extend_from_slice(&metadata);
    frame.extend_from_slice(&bytes);
    Ok(frame)
}

/// Uploads one file to an origin the plugin declares, as `plugin_host_request`
/// sends JSON. The plugin names the file, so it may only be an archive in the
/// user's home directory, and never one reached through a link.
#[tauri::command]
pub(crate) async fn plugin_host_upload(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
    upload: HostUpload,
) -> Result<HostResponse, String> {
    let (url, _, headers) = validate_request(&HostRequest {
        url: upload.url.clone(),
        method: "POST".into(),
        headers: upload.headers.clone(),
        body: None,
        timeout_ms: None,
    })?;
    let operation = async {
        let grants = with_manager(manager, move |manager| manager.host_grants(&id, &revision))
            .await
            .map_err(|_| "Host request is unavailable")?;
        let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
        let path = upload_path(&grants, &url, &upload.file.path, home.as_deref())?;
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|_| "Could not read the upload file")?;
        if bytes.len() as u64 > MAX_UPLOAD_BYTES {
            return Err("The upload file is too large".into());
        }
        let (content_type, body) = multipart(
            &upload.fields,
            &upload.file.field,
            &upload.file.name,
            &upload.file.content_type,
            &bytes,
        )?;
        let mut headers = headers;
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            HeaderValue::from_str(&content_type).map_err(|_| "Invalid upload")?,
        );
        let post = client(false)?
            .post(url)
            .headers(headers)
            .body(body)
            .timeout(UPLOAD_DEADLINE);
        read_response(post).await
    };
    tokio::time::timeout(UPLOAD_DEADLINE, operation)
        .await
        .map_err(|_| "Host upload timed out")?
}

/// `path` when files and `url`'s origin are granted and it is an archive
/// [`archive_path`] accepts.
fn upload_path(
    grants: &HostGrants,
    url: &reqwest::Url,
    path: &str,
    home: Option<&std::path::Path>,
) -> Result<std::path::PathBuf, String> {
    if !grants.files {
        return Err("Files are not declared".into());
    }
    if !allows_origin(grants, url) {
        return Err("Host request origin is not declared".into());
    }
    archive_path(path, home)
}

/// `path` when it is an absolute `.tar.gz` regular file, not a link, in
/// `home`, and small enough to upload.
pub(crate) fn archive_path(
    path: &str,
    home: Option<&std::path::Path>,
) -> Result<std::path::PathBuf, String> {
    let invalid = || format!("An upload is a {UPLOAD_EXTENSION} file in your home directory");
    let path = std::path::Path::new(path);
    let home = home
        .and_then(|home| home.canonicalize().ok())
        .ok_or_else(invalid)?;
    if !path.is_absolute() || !path.to_string_lossy().ends_with(UPLOAD_EXTENSION) {
        return Err(invalid());
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "The upload file does not exist")?;
    let resolved = path.canonicalize().map_err(|_| invalid())?;
    if !metadata.is_file() || !resolved.starts_with(&home) || resolved != path {
        return Err(invalid());
    }
    if metadata.len() > MAX_UPLOAD_BYTES {
        return Err("The upload file is too large".into());
    }
    Ok(resolved)
}

/// A `multipart/form-data` body: the text fields, then the file.
fn validate_form(
    fields: &BTreeMap<String, String>,
    field: &str,
    name: &str,
    content_type: &str,
) -> Result<(), String> {
    // Names and types go into headers inside the body, so they stay plain.
    let plain = |text: &str| {
        !text.is_empty()
            && text.len() <= 256
            && text
                .bytes()
                .all(|byte| byte.is_ascii_graphic() && byte != b'"' && byte != b'\\')
    };
    if fields.len() > 16
        || !plain(field)
        || !plain(name)
        || !plain(content_type)
        || fields
            .iter()
            .any(|(name, value)| !plain(name) || value.len() > MAX_HEADER_BYTES)
    {
        return Err("Invalid upload form".into());
    }
    Ok(())
}

pub(crate) fn multipart(
    fields: &BTreeMap<String, String>,
    field: &str,
    name: &str,
    content_type: &str,
    bytes: &[u8],
) -> Result<(String, Vec<u8>), String> {
    validate_form(fields, field, name, content_type)?;
    let boundary = format!("buzz-{}", uuid::Uuid::new_v4().simple());
    let mut body = Vec::with_capacity(bytes.len() + 1024);
    for (name, value) in fields {
        body.extend(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
            field, name, content_type
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend(format!("\r\n--{boundary}--\r\n").as_bytes());
    Ok((format!("multipart/form-data; boundary={boundary}"), body))
}

fn allows_origin(grants: &HostGrants, url: &reqwest::Url) -> bool {
    grants
        .network_origins
        .contains(&url.origin().ascii_serialization())
}

fn validate_request(
    request: &HostRequest,
) -> Result<(reqwest::Url, reqwest::Method, HeaderMap), String> {
    if request.url.len() > 2048 {
        return Err("Invalid host request URL".into());
    }
    let url = reqwest::Url::parse(&request.url).map_err(|_| "Invalid host request URL")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("Host requests require HTTPS without URL credentials".into());
    }
    let method = match request.method.as_str() {
        "GET" => reqwest::Method::GET,
        "HEAD" => reqwest::Method::HEAD,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("Invalid host request method".into()),
    };
    if request
        .body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_REQUEST_BYTES)
    {
        return Err("Host request body is too large".into());
    }
    if request.headers.len() > 32
        || request
            .headers
            .iter()
            .map(|(name, value)| name.len() + value.len())
            .sum::<usize>()
            > MAX_HEADER_BYTES
    {
        return Err("Host request headers are too large".into());
    }
    let mut headers = HeaderMap::new();
    for (name, value) in &request.headers {
        let name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| "Invalid host request header")?;
        if matches!(
            name.as_str(),
            "host"
                | "cookie"
                | "proxy-authorization"
                | "proxy-authenticate"
                | "proxy-connection"
                | "connection"
                | "keep-alive"
                | "te"
                | "trailer"
                | "transfer-encoding"
                | "upgrade"
                | "content-length"
        ) {
            return Err("Host request header is not allowed".into());
        }
        let value = HeaderValue::from_str(value).map_err(|_| "Invalid host request header")?;
        headers.insert(name, value);
    }
    Ok((url, method, headers))
}

pub(crate) async fn send_request(
    url: reqwest::Url,
    method: reqwest::Method,
    headers: HeaderMap,
    body: Option<String>,
    deadline: Duration,
) -> Result<HostResponse, String> {
    send_request_with_policy(url, method, headers, body, deadline, false).await
}

async fn send_request_with_policy(
    url: reqwest::Url,
    method: reqwest::Method,
    headers: HeaderMap,
    body: Option<String>,
    deadline: Duration,
    protected: bool,
) -> Result<HostResponse, String> {
    let mut request = client(protected)?
        .request(method, url)
        .headers(headers)
        .timeout(deadline);
    if let Some(body) = body {
        request = request.body(body);
    }
    read_response(request).await
}

/// Shared clients, as for agent requests, so plugin requests reuse
/// connections instead of building a client and opening a connection on every
/// call. Each request sets its own timeout. A protected request is never
/// retried or pooled.
pub(crate) fn client(protected: bool) -> Result<&'static reqwest::Client, String> {
    static PLAIN: OnceLock<Result<reqwest::Client, reqwest::Error>> = OnceLock::new();
    static PROTECTED: OnceLock<Result<reqwest::Client, reqwest::Error>> = OnceLock::new();
    let cell = if protected { &PROTECTED } else { &PLAIN };
    cell.get_or_init(|| {
        let builder = reqwest::Client::builder()
            .user_agent(crate::relay::user_agent())
            .redirect(reqwest::redirect::Policy::none());
        if protected {
            // No idle connections, so each one-time request opens its own
            // (reqwest is built without HTTP/2, so none are shared either).
            builder
                .retry(reqwest::retry::never())
                .pool_max_idle_per_host(0)
        } else {
            // A connection idle across sleep may be dead; open a new one.
            builder.pool_idle_timeout(Duration::from_secs(30))
        }
        .build()
    })
    .as_ref()
    .map_err(|_| "Host request client is unavailable".into())
}

/// Sends `request` and reads its bounded response, without its cookies.
pub(crate) async fn read_response(
    request: reqwest::RequestBuilder,
) -> Result<HostResponse, String> {
    let (status, headers, bytes) = read_bytes(request, MAX_RESPONSE_BYTES).await?;
    let body = String::from_utf8(bytes).map_err(|_| "Host response is not UTF-8")?;
    Ok(HostResponse {
        status,
        headers,
        body,
    })
}

async fn read_bytes(
    request: reqwest::RequestBuilder,
    max_bytes: usize,
) -> Result<(u16, BTreeMap<String, String>, Vec<u8>), String> {
    let mut response = request.send().await.map_err(|_| "Host request failed")?;
    let status = response.status().as_u16();
    let mut headers = BTreeMap::new();
    let mut header_bytes = 0;
    let mut header_count = 0;
    for (name, value) in response.headers() {
        if name.as_str() == "set-cookie" {
            continue;
        }
        let Ok(value) = value.to_str() else {
            continue;
        };
        header_count += 1;
        header_bytes += name.as_str().len() + value.len();
        if header_count > 64 || header_bytes > MAX_RESPONSE_HEADER_BYTES {
            return Err("Host response headers are too large".into());
        }
        headers.insert(name.to_string(), value.to_owned());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Host response failed")? {
        if bytes.len() + chunk.len() > max_bytes {
            return Err("Host response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((status, headers, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn a_declared_origin_keeps_its_reach_and_public_images_cover_the_rest() {
        let url = |raw| reqwest::Url::parse(raw).unwrap();
        let mut grants = HostGrants {
            network_origins: vec!["https://api.example.com".into()],
            ..HostGrants::default()
        };
        assert_eq!(
            reach(&grants, &url("https://api.example.com/a")),
            Some(ByteReach::Declared)
        );
        assert_eq!(reach(&grants, &url("https://cdn.example.org/a.png")), None);
        grants.public_images = true;
        assert_eq!(
            reach(&grants, &url("https://api.example.com/a")),
            Some(ByteReach::Declared)
        );
        assert_eq!(
            reach(&grants, &url("https://cdn.example.org/a.png")),
            Some(ByteReach::PublicImage)
        );
    }

    #[test]
    fn public_images_never_authorize_an_upload() {
        let url = |raw| reqwest::Url::parse(raw).unwrap();
        let images_only = HostGrants {
            public_images: true,
            ..HostGrants::default()
        };
        for target in [
            "https://cdn.example.org/a.png",
            "https://internal.example:8443/api",
        ] {
            assert!(upload_origin(&images_only, &url(target)).is_err());
        }
        let declared = HostGrants {
            network_origins: vec!["https://api.example.com".into()],
            public_images: true,
            ..HostGrants::default()
        };
        assert!(upload_origin(&declared, &url("https://api.example.com/upload")).is_ok());
        assert!(upload_origin(&declared, &url("https://cdn.example.org/upload")).is_err());
    }

    fn local_response(response: Vec<u8>) -> (reqwest::Url, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0u8; 1024];
            let count = socket.read(&mut request).unwrap();
            assert!(request[..count].starts_with(b"POST /graphql HTTP/1.1"));
            let _ = socket.write_all(&response);
        });
        (
            reqwest::Url::parse(&format!("http://{address}/graphql")).unwrap(),
            server,
        )
    }

    fn request(url: &str) -> HostRequest {
        HostRequest {
            url: url.into(),
            method: "POST".into(),
            headers: BTreeMap::new(),
            body: Some("{}".into()),
            timeout_ms: None,
        }
    }

    #[test]
    fn bounds_explicit_request_deadlines_and_keeps_the_default() {
        assert_eq!(request_deadline(None).unwrap(), Duration::from_secs(30));
        assert_eq!(
            request_deadline(Some(180_000)).unwrap(),
            Duration::from_secs(180)
        );
        assert!(request_deadline(Some(0)).is_err());
        assert!(request_deadline(Some(180_001)).is_err());
        let parsed: HostRequest =
            serde_json::from_str(r#"{"url":"https://example.test/","timeoutMs":180000}"#).unwrap();
        assert_eq!(
            request_deadline(parsed.timeout_ms).unwrap(),
            Duration::from_secs(180)
        );
    }

    #[test]
    fn validates_https_url_and_bounds() {
        assert!(validate_request(&request("https://api.example.test/graphql")).is_ok());
        assert!(validate_request(&request("http://api.example.test/graphql")).is_err());
        assert!(validate_request(&request("https://user:pass@api.example.test/")).is_err());
        let mut large = request("https://api.example.test/");
        large.body = Some("x".repeat(MAX_REQUEST_BYTES + 1));
        assert!(validate_request(&large).is_err());
    }

    #[test]
    fn rejects_cookie_and_routing_headers() {
        for name in [
            "Host",
            "Cookie",
            "Proxy-Authorization",
            "Proxy-Connection",
            "Connection",
            "Transfer-Encoding",
        ] {
            let mut input = request("https://api.example.test/");
            input.headers.insert(name.into(), "private".into());
            assert!(validate_request(&input).is_err(), "{name}");
        }
    }

    #[test]
    fn matches_only_the_declared_origin() {
        let grants = HostGrants {
            commands: vec![],
            network_origins: vec!["https://api.example.test".into()],
            ..HostGrants::default()
        };
        for url in [
            "https://api.example.test/",
            "https://api.example.test/graphql",
        ] {
            assert!(allows_origin(&grants, &reqwest::Url::parse(url).unwrap()));
        }
        for url in [
            "https://sub.api.example.test/",
            "https://api.example.test:8443/",
        ] {
            assert!(!allows_origin(&grants, &reqwest::Url::parse(url).unwrap()));
        }
    }

    #[test]
    fn bundled_builderlab_has_no_renderer_network_or_files() {
        let temp = tempfile::tempdir().unwrap();
        let manager =
            buzzodz_plugins::Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let grants = manager.host_grants("block.builderlab", "bundled").unwrap();
        // Builderlab is reached only through the native FI forwarder.
        assert!(!grants.files && grants.network_origins.is_empty());
        assert_eq!(
            grants.federated_identity.is_some(),
            option_env!("BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG").is_some_and(|c| !c.is_empty())
        );
    }

    #[test]
    fn uploads_only_an_archive_file_in_home() {
        let url = reqwest::Url::parse("https://apps.example.test/deploy").unwrap();
        let mut grants = HostGrants {
            network_origins: vec!["https://apps.example.test".into()],
            ..HostGrants::default()
        };
        // Declared access is checked before any filesystem lookup, including
        // whether the home directory or supplied archive exists.
        assert_eq!(
            upload_path(&grants, &url, "/missing.tar.gz", None).unwrap_err(),
            "Files are not declared"
        );
        grants.files = true;
        let other = reqwest::Url::parse("https://other.example.test/deploy").unwrap();
        assert_eq!(
            upload_path(&grants, &other, "/missing.tar.gz", None).unwrap_err(),
            "Host request origin is not declared"
        );
        let home = tempfile::tempdir().unwrap();
        let home = home.path().canonicalize().unwrap();
        let archive = home.join("app/artifact.tar.gz");
        std::fs::create_dir_all(archive.parent().unwrap()).unwrap();
        std::fs::write(&archive, b"gz").unwrap();
        std::fs::write(home.join("app/secret.txt"), b"key").unwrap();
        let at = |path: &std::path::Path| {
            upload_path(&grants, &url, path.to_str().unwrap(), Some(&home))
        };
        assert_eq!(at(&archive).unwrap(), archive);
        assert!(at(&home.join("app/secret.txt")).is_err());
        assert!(at(&home.join("app/missing.tar.gz")).is_err());
        assert!(at(&home.join("app")).is_err());
        assert!(upload_path(&grants, &url, "app/artifact.tar.gz", Some(&home)).is_err());
        assert!(at(&home.join("app/../app/artifact.tar.gz")).is_err());
        let outside = tempfile::tempdir().unwrap();
        let elsewhere = outside.path().join("artifact.tar.gz");
        std::fs::write(&elsewhere, b"gz").unwrap();
        assert!(at(&elsewhere).is_err());
        #[cfg(unix)]
        {
            let link = home.join("app/link.tar.gz");
            std::os::unix::fs::symlink(home.join("app/secret.txt"), &link).unwrap();
            assert!(at(&link).is_err());
        }
    }

    #[test]
    fn builds_a_multipart_form_of_fields_then_the_file() {
        let file = UploadFile {
            field: "artifact".into(),
            path: String::new(),
            name: "artifact.tar.gz".into(),
            content_type: "application/gzip".into(),
        };
        let fields = BTreeMap::from([("version_id".to_string(), "v1".to_string())]);
        let (content_type, body) =
            multipart(&fields, &file.field, &file.name, &file.content_type, b"GZ").unwrap();
        let boundary = content_type
            .strip_prefix("multipart/form-data; boundary=")
            .unwrap();
        assert_eq!(
            String::from_utf8(body).unwrap(),
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"version_id\"\r\n\r\nv1\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"artifact\"; filename=\"artifact.tar.gz\"\r\nContent-Type: application/gzip\r\n\r\nGZ\r\n--{boundary}--\r\n"
            )
        );
        for bad in ["a\"b", "a b", "", "a\r\nb"] {
            let fields = BTreeMap::from([(bad.to_string(), "v".to_string())]);
            assert!(
                multipart(&fields, &file.field, &file.name, &file.content_type, b"").is_err(),
                "{bad:?}"
            );
        }
    }

    #[tokio::test]
    async fn request_transport_does_not_follow_redirects_or_return_cookies() {
        // The handler rejects HTTP; loopback HTTP exercises the transport without external data.
        let (url, server) = local_response(
            b"HTTP/1.1 302 Found\r\nLocation: https://outside.example/\r\nSet-Cookie: secret=value\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec(),
        );
        let response = send_request_with_policy(
            url,
            reqwest::Method::POST,
            HeaderMap::new(),
            Some("{}".into()),
            DEADLINE,
            false,
        )
        .await
        .unwrap();
        server.join().unwrap();
        assert_eq!(response.status, 302);
        assert_eq!(response.body, "{}");
        assert_eq!(
            response.headers.get("location").unwrap(),
            "https://outside.example/"
        );
        assert!(!response.headers.contains_key("set-cookie"));
    }

    #[tokio::test]
    async fn request_transport_pools_only_unprotected_connections() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = reqwest::Url::parse(&format!(
            "http://{}/graphql",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let accepted = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = accepted.clone();
        std::thread::spawn(move || {
            for socket in listener.incoming() {
                let mut socket = socket.unwrap();
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                std::thread::spawn(move || {
                    let mut request = [0u8; 1024];
                    while matches!(socket.read(&mut request), Ok(count) if count > 0) {
                        let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
                    }
                });
            }
        });
        for protected in [false, false, true, true] {
            send_request_with_policy(
                url.clone(),
                reqwest::Method::POST,
                HeaderMap::new(),
                None,
                DEADLINE,
                protected,
            )
            .await
            .unwrap();
        }
        // Two plain requests share one connection; each protected one opens its own.
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn request_transport_rejects_oversized_responses() {
        let body = vec![b'x'; MAX_RESPONSE_BYTES + 1];
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend(body);
        let (url, server) = local_response(response);
        let result = send_request_with_policy(
            url,
            reqwest::Method::POST,
            HeaderMap::new(),
            None,
            DEADLINE,
            false,
        )
        .await;
        server.join().unwrap();
        assert_eq!(result.err().as_deref(), Some("Host response is too large"));
    }

    #[tokio::test]
    async fn request_transport_bounds_returned_headers() {
        let mut response = b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n".to_vec();
        for index in 0..65 {
            response.extend(format!("x-example-{index}: value\r\n").as_bytes());
        }
        response.extend(b"\r\n");
        let (url, server) = local_response(response);
        let result = send_request_with_policy(
            url,
            reqwest::Method::POST,
            HeaderMap::new(),
            None,
            DEADLINE,
            false,
        )
        .await;
        server.join().unwrap();
        assert_eq!(
            result.err().as_deref(),
            Some("Host response headers are too large")
        );
    }
}

#[cfg(test)]
mod replay_tests;

#[cfg(test)]
#[path = "host_request/byte_tests.rs"]
mod byte_tests;

#[cfg(test)]
#[path = "host_request/user_agent_tests.rs"]
mod user_agent_tests;
