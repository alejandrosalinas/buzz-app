//! The `BUZZ_AGENT_GATEWAY` build descriptor, version 2: the agent gateway's
//! origin, the communities that route through it and the names its context
//! headers and upstream paths take. It holds no credential. The values come
//! only from a private build input; this repository knows none of them.
//!
//! `build.rs` validates the whole descriptor and compiles it canonicalized;
//! the app validates it again at startup and takes only `Native`. The
//! frontend's parser applies the same rules in the same order to the same
//! shared vectors. An error names its rule, never the descriptor's contents.
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// The whole descriptor, in UTF-8 bytes.
pub const MAX_BYTES: usize = 8 * 1024;
const KEYS: [&str; 8] = [
    "access_path",
    "communities",
    "gateway",
    "headers",
    "launcher_client",
    "reserved_prefixes",
    "upstreams",
    "version",
];
const COMMUNITY_LIMIT: usize = 16;
/// The context fields, each mapped to its header name.
pub const FIELDS: [&str; 8] = [
    "launcher_client",
    "launcher_session",
    "human_pubkey",
    "agent_pubkey",
    "community_id",
    "channel_id",
    "message_id",
    "thread_id",
];
const PREFIX_LIMIT: usize = 4;
/// The stable capability names an upstream may be configured for.
const CAPABILITIES: [&str; 4] = ["claude-code", "codex", "goose", "pi"];
/// The capabilities native forwarding serves.
pub const FORWARDED: [&str; 2] = ["claude-code", "goose"];
/// Headers the descriptor may neither name nor strip: the connection's own,
/// routing, credentials, what determines how the unchanged body reads, the
/// harnesses' protocol and session headers.
pub const PROTECTED_EXACT: [&str; 24] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authorization",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "host",
    "origin",
    "content-length",
    "content-type",
    "content-encoding",
    "accept-encoding",
    "expect",
    "authorization",
    "x-api-key",
    "cookie",
    "x-goog-api-key",
    "user-agent",
    "anthropic-version",
    "anthropic-beta",
    "x-claude-code-session-id",
    "agent-session-id",
];
/// Whole protected header families, by prefix.
pub const PROTECTED_FAMILIES: [&str; 6] = [
    "x-amz-",
    "anthropic-",
    "x-stainless-",
    "sec-",
    "proxy-",
    "content-",
];

/// Why a descriptor was refused, as the shared vectors' `error` codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Invalid {
    Size,
    Json,
    Keys,
    Version,
    Gateway,
    Communities,
    Path,
    LauncherClient,
    HeaderName,
    HeaderProtected,
    HeaderDuplicate,
    Prefix,
    PrefixProtected,
    Upstreams,
}
impl Invalid {
    pub fn code(self) -> &'static str {
        match self {
            Invalid::Size => "size",
            Invalid::Json => "json",
            Invalid::Keys => "keys",
            Invalid::Version => "version",
            Invalid::Gateway => "gateway",
            Invalid::Communities => "communities",
            Invalid::Path => "path",
            Invalid::LauncherClient => "launcher_client",
            Invalid::HeaderName => "header_name",
            Invalid::HeaderProtected => "header_protected",
            Invalid::HeaderDuplicate => "header_duplicate",
            Invalid::Prefix => "prefix",
            Invalid::PrefixProtected => "prefix_protected",
            Invalid::Upstreams => "upstreams",
        }
    }
}
impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "BUZZ_AGENT_GATEWAY is invalid ({})", self.code())
    }
}

/// What native forwarding takes from a valid descriptor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Native {
    /// The gateway's `https://` origin.
    pub gateway: String,
    /// The launcher client value the bundle's `launcher_client` header carries.
    pub launcher_client: String,
    /// Context field → its header name.
    pub headers: BTreeMap<String, String>,
    pub reserved_prefixes: Vec<String>,
    /// Forwarded capability → its upstream base path.
    pub upstreams: BTreeMap<String, String>,
}
impl Native {
    /// Whether forwarding may neither pass `name` through from a harness nor
    /// let it be set but by the frozen bundle: a context header or one under
    /// a reserved prefix, whatever its case and with `_` for `-`.
    pub fn reserved(&self, name: &str) -> bool {
        let name = fold(name);
        self.headers.values().any(|header| *header == name)
            || self
                .reserved_prefixes
                .iter()
                .any(|prefix| name.starts_with(prefix.as_str()))
    }
    /// Whether a bundle may set `name`: exactly one of the context headers.
    pub fn context(&self, name: &str) -> bool {
        self.headers.values().any(|header| header == name)
    }
}

/// The descriptor in `raw` and its canonical form, or `None` when it's blank,
/// which keeps the integration off. Anything else that isn't a valid version 2
/// descriptor is refused, a version 1 one included.
pub fn parse(raw: &str) -> Result<Option<(Native, String)>, Invalid> {
    if raw.trim().is_empty() {
        return Ok(None);
    }
    if raw.len() > MAX_BYTES {
        return Err(Invalid::Size);
    }
    let mut value: Value = serde_json::from_str(raw).map_err(|_| Invalid::Json)?;
    let descriptor = value.as_object_mut().ok_or(Invalid::Keys)?;
    // Before the shape, so a version 1 descriptor reads as one.
    if descriptor.get("version").and_then(Value::as_f64) != Some(2.0) {
        return Err(Invalid::Version);
    }
    descriptor
        .entry("launcher_client")
        .or_insert_with(|| Value::String("buzz".into()));
    if !exactly(descriptor, &KEYS) {
        return Err(Invalid::Keys);
    }
    let gateway = descriptor["gateway"]
        .as_str()
        .filter(|gateway| origin(gateway))
        .ok_or(Invalid::Gateway)?;
    let communities = communities(&descriptor["communities"]).ok_or(Invalid::Communities)?;
    let access_path = descriptor["access_path"]
        .as_str()
        .filter(|path| base(path))
        .ok_or(Invalid::Path)?;
    let launcher_client = descriptor["launcher_client"]
        .as_str()
        .filter(|value| {
            (1..=64).contains(&value.len())
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        })
        .ok_or(Invalid::LauncherClient)?;
    let headers = headers(&descriptor["headers"])?;
    let reserved_prefixes = prefixes(&descriptor["reserved_prefixes"])?;
    let upstreams = upstreams(&descriptor["upstreams"])?;
    let canonical = serde_json::json!({
        "version": 2,
        "gateway": gateway,
        "communities": communities
            .iter()
            .map(|(id, origin)| serde_json::json!({ "id": id, "origin": origin }))
            .collect::<Vec<_>>(),
        "access_path": access_path,
        "launcher_client": launcher_client,
        "headers": headers,
        "reserved_prefixes": reserved_prefixes,
        "upstreams": upstreams
            .iter()
            .map(|(capability, base)| (capability.clone(), serde_json::json!({ "base": base })))
            .collect::<Map<_, _>>(),
    });
    let native = Native {
        gateway: gateway.into(),
        launcher_client: launcher_client.into(),
        headers,
        reserved_prefixes,
        upstreams: upstreams
            .into_iter()
            .filter(|(capability, _)| FORWARDED.contains(&capability.as_str()))
            .collect(),
    };
    Ok(Some((native, canonical.to_string())))
}

/// At most this many descriptors in `src/bundled/org-gateways.json`.
const ORG_GATEWAY_LIMIT: usize = 8;

/// The build's descriptor, as the frontend's `selectGatewayDescriptor`
/// chooses it: an explicit `BUZZ_AGENT_GATEWAY` when one is set, else the
/// entry of `src/bundled/org-gateways.json` (an organization's packaged
/// descriptors, `[]` in open-source builds) that lists the build's
/// `BUZZ_DEFAULT_COMMUNITY_URL`, else none. Every listed entry is checked
/// even when none is chosen, and no community may be listed twice, so a bad
/// file fails every build that carries it.
pub fn select(
    explicit: &str,
    listed: &str,
    community_url: &str,
) -> Result<Option<(Native, String)>, String> {
    let fail = |problem: &str| format!("src/bundled/org-gateways.json is invalid: {problem}.");
    let entries: Value = serde_json::from_str(listed).map_err(|_| fail("it is not JSON"))?;
    let entries = entries
        .as_array()
        .filter(|entries| entries.len() <= ORG_GATEWAY_LIMIT)
        .ok_or_else(|| {
            fail(&format!(
                "it must be a list of at most {ORG_GATEWAY_LIMIT} descriptors"
            ))
        })?;
    let mut descriptors = Vec::new();
    for entry in entries {
        if !entry.is_object() {
            return Err(fail("each entry must be a descriptor"));
        }
        let (native, canonical) = parse(&entry.to_string())
            .map_err(|invalid| fail(&format!("an entry is invalid ({})", invalid.code())))?
            .expect("an object is never blank");
        let value: Value = serde_json::from_str(&canonical).expect("canonical JSON");
        let origins: Vec<String> = value["communities"]
            .as_array()
            .expect("canonical communities")
            .iter()
            .map(|community| community["origin"].as_str().unwrap().to_owned())
            .collect();
        descriptors.push((native, canonical, origins));
    }
    let mut seen = std::collections::BTreeSet::new();
    for origin in descriptors.iter().flat_map(|(_, _, origins)| origins) {
        if !seen.insert(origin) {
            return Err(fail("two entries list the same community"));
        }
    }
    if let Some(chosen) = parse(explicit).map_err(|invalid| invalid.to_string())? {
        return Ok(Some(chosen));
    }
    // A blank or non-secure URL selects nothing rather than failing: dev builds
    // may point at a local `ws://` relay, and Vite's `build` already refuses a
    // bad URL for packaged frontends.
    let Some(origin) = relay_origin(community_url) else {
        return Ok(None);
    };
    Ok(descriptors
        .into_iter()
        .find(|(_, _, origins)| origins.contains(&origin))
        .map(|(native, canonical, _)| (native, canonical)))
}

fn exactly(object: &Map<String, Value>, keys: &[&str]) -> bool {
    object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
}

fn fold(name: &str) -> String {
    name.to_ascii_lowercase().replace('_', "-")
}

/// An `https://` origin with nothing after it.
fn origin(value: &str) -> bool {
    url::Url::parse(value)
        .is_ok_and(|url| url.scheme() == "https" && url.origin().ascii_serialization() == value)
}

/// An absolute path of plain segments, without a trailing `/`.
fn base(path: &str) -> bool {
    path.len() <= 256
        && path.strip_prefix('/').is_some_and(|rest| {
            rest.split('/').all(|segment| {
                !segment.is_empty()
                    && segment != "."
                    && segment != ".."
                    && segment
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
            })
        })
}

/// The listed communities as canonical `(id, origin)` pairs, each unique.
fn communities(value: &Value) -> Option<Vec<(String, String)>> {
    let listed = value.as_array()?;
    if listed.is_empty() || listed.len() > COMMUNITY_LIMIT {
        return None;
    }
    let mut communities: Vec<(String, String)> = Vec::with_capacity(listed.len());
    for community in listed {
        let community = community
            .as_object()
            .filter(|c| exactly(c, &["id", "origin"]))?;
        let id = community["id"].as_str().filter(|id| uuid(id))?;
        let origin = relay_origin(community["origin"].as_str()?)?;
        if communities.iter().any(|(i, o)| i == id || *o == origin) {
            return None;
        }
        communities.push((id.into(), origin));
    }
    Some(communities)
}

/// A canonical lowercase UUID other than the nil one.
fn uuid(value: &str) -> bool {
    let groups: Vec<&str> = value.split('-').collect();
    groups.iter().map(|group| group.len()).eq([8, 4, 4, 4, 12])
        && groups.iter().all(|group| {
            group
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        && value != "00000000-0000-0000-0000-000000000000"
}

/// A community's relay as the frontend's `relayOrigin` canonicalizes it: a
/// `wss://` or `https://` host, as its `https://` origin without a final dot.
fn relay_origin(input: &str) -> Option<String> {
    // Match JavaScript's trim() and \s, including BOM but excluding NEL.
    let whitespace = |c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{0085}');
    let value = input.trim_matches(whitespace);
    let lower = value.to_ascii_lowercase();
    let scheme = ["wss://", "https://"]
        .into_iter()
        .find(|s| lower.starts_with(s))?;
    let authority = &value[scheme.len()..];
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    if value.len() > 2048
        || authority.is_empty()
        || authority
            .chars()
            .any(|c| "/?#\\@".contains(c) || whitespace(c))
    {
        return None;
    }
    let mut url = url::Url::parse(&format!("https://{authority}")).ok()?;
    if let Some(host) = url.host_str().and_then(|host| host.strip_suffix('.')) {
        let host = host.to_owned();
        url.set_host(Some(&host)).ok()?;
    }
    Some(url.origin().ascii_serialization())
}

/// Whether `name` is, or belongs to a family of, the protected headers.
fn protected(name: &str) -> bool {
    PROTECTED_EXACT.contains(&name) || PROTECTED_FAMILIES.iter().any(|f| name.starts_with(f))
}

/// The eight context header names: plain lowercase tokens, none protected,
/// each distinct.
fn headers(value: &Value) -> Result<BTreeMap<String, String>, Invalid> {
    let names = value
        .as_object()
        .filter(|headers| exactly(headers, &FIELDS))
        .ok_or(Invalid::HeaderName)?;
    let mut headers = BTreeMap::new();
    for field in FIELDS {
        let name = names[field]
            .as_str()
            .filter(|name| token(name, 1))
            .ok_or(Invalid::HeaderName)?;
        headers.insert(field.to_owned(), name.to_owned());
    }
    if headers.values().any(|name| protected(name)) {
        return Err(Invalid::HeaderProtected);
    }
    let mut distinct: Vec<&String> = headers.values().collect();
    distinct.sort();
    distinct.dedup();
    if distinct.len() != FIELDS.len() {
        return Err(Invalid::HeaderDuplicate);
    }
    Ok(headers)
}

fn token(name: &str, min: usize) -> bool {
    (min..=64).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// Up to four distinct prefixes that strip no protected header, nor sit
/// inside or above a protected family.
fn prefixes(value: &Value) -> Result<Vec<String>, Invalid> {
    let listed = value
        .as_array()
        .filter(|listed| listed.len() <= PREFIX_LIMIT)
        .ok_or(Invalid::Prefix)?;
    let mut prefixes: Vec<String> = Vec::with_capacity(listed.len());
    for prefix in listed {
        let prefix = prefix
            .as_str()
            .filter(|prefix| token(prefix, 4) && prefix.ends_with('-'))
            .filter(|prefix| !prefixes.iter().any(|p| p == prefix))
            .ok_or(Invalid::Prefix)?;
        prefixes.push(prefix.into());
    }
    let overlaps = |prefix: &String| {
        PROTECTED_EXACT
            .iter()
            .any(|name| name.starts_with(prefix.as_str()))
            || PROTECTED_FAMILIES
                .iter()
                .any(|family| prefix.starts_with(family) || family.starts_with(prefix.as_str()))
    };
    if prefixes.iter().any(overlaps) {
        return Err(Invalid::PrefixProtected);
    }
    Ok(prefixes)
}

/// Each configured capability's upstream base path. Every entry's shape is
/// checked before any base, so the outcome doesn't depend on key order.
fn upstreams(value: &Value) -> Result<BTreeMap<String, String>, Invalid> {
    let listed = value.as_object().ok_or(Invalid::Upstreams)?;
    let mut bases = BTreeMap::new();
    for (capability, upstream) in listed {
        let base = upstream
            .as_object()
            .filter(|upstream| {
                CAPABILITIES.contains(&capability.as_str()) && exactly(upstream, &["base"])
            })
            .ok_or(Invalid::Upstreams)?;
        bases.insert(capability.clone(), &base["base"]);
    }
    bases
        .into_iter()
        .map(
            |(capability, path)| match path.as_str().filter(|path| base(path)) {
                Some(path) => Ok((capability, path.to_owned())),
                None => Err(Invalid::Path),
            },
        )
        .collect()
}

#[cfg(test)]
#[path = "gateway/tests.rs"]
mod tests;
