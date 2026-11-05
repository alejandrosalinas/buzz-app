use serde::{Deserialize, Serialize};
use std::error::Error as _;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Context {
    #[serde(deserialize_with = "identifier")]
    pub(crate) operation_id: String,
}
fn identifier<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = String::deserialize(input)?;
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_:-".contains(&b))
    {
        return Err(serde::de::Error::custom("Invalid diagnostics correlation"));
    }
    Ok(value)
}
tokio::task_local! { static CURRENT: Context; }
pub(crate) async fn in_context<T>(
    context: Option<Context>,
    work: impl std::future::Future<Output = T>,
) -> T {
    if !super::enabled(super::Level::Debug) {
        return work.await;
    }
    CURRENT
        .scope(
            context.unwrap_or_else(|| Context {
                operation_id: format!("request:{}", uuid::Uuid::new_v4()),
            }),
            work,
        )
        .await
}
pub(super) fn operation_id() -> Option<String> {
    CURRENT
        .try_with(|context| context.operation_id.clone())
        .ok()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SafeError {
    name: &'static str,
    code: String,
    message: Option<&'static str>,
    message_redacted: bool,
    os_code: Option<i32>,
    cause: Option<Box<SafeError>>,
}
impl SafeError {
    pub(super) fn local(reason: &'static str) -> Self {
        Self {
            name: "Error",
            code: reason.into(),
            message: Some(reason),
            message_redacted: false,
            os_code: None,
            cause: None,
        }
    }
    pub(super) fn http(error: &reqwest::Error) -> Self {
        let mut top = Self::local(super::http_failure(error));
        top.name = "reqwest";
        top.cause = error
            .source()
            .map(|source| Box::new(Self::source(source, 0)));
        top
    }
    pub(super) fn transport(error: &tokio_tungstenite::tungstenite::Error) -> Self {
        let mut top = Self::local("socket-transport");
        top.name = "tungstenite";
        top.cause = error
            .source()
            .map(|source| Box::new(Self::source(source, 0)));
        top
    }
    fn source(error: &(dyn std::error::Error + 'static), depth: usize) -> Self {
        let mut result = Self {
            name: "Error",
            code: "unclassified".into(),
            message: None,
            message_redacted: true,
            os_code: None,
            cause: None,
        };
        if depth == 4 {
            result.code = "cause-truncated".into();
            return result;
        }
        if let Some(error) = error.downcast_ref::<std::io::Error>() {
            result.name = "io";
            result.code = format!("{:?}", error.kind());
            result.os_code = error.raw_os_error();
        } else if let Some(error) = error.downcast_ref::<rustls::Error>() {
            result.name = "rustls";
            result.code = match error {
                rustls::Error::InvalidCertificate(_) => "certificate-invalid",
                rustls::Error::NoCertificatesPresented => "certificate-missing",
                _ => "tls-failure",
            }
            .into();
        }
        result.cause = error
            .source()
            .map(|cause| Box::new(Self::source(cause, depth + 1)));
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn original_transport_causes_keep_os_codes_without_urls_or_secret_text() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let error = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://{address}/private?token=secret-token"))
            .send()
            .await
            .unwrap_err();
        let http = serde_json::to_value(SafeError::http(&error)).unwrap();
        assert_eq!(http["code"], "connect");
        assert!(!http["cause"].is_null());
        let mut cause = &http;
        while !cause["cause"].is_null() {
            cause = &cause["cause"];
        }
        assert_eq!(cause["name"], "io");
        assert_eq!(cause["code"], "ConnectionRefused");
        assert!(cause["osCode"].is_i64());
        assert!(!http.to_string().contains("secret-token"));
        assert!(!http.to_string().contains("/private"));

        let io = std::io::Error::new(std::io::ErrorKind::ConnectionReset, "secret-peer-details");
        let socket = serde_json::to_value(SafeError::transport(
            &tokio_tungstenite::tungstenite::Error::Io(io),
        ))
        .unwrap();
        assert_eq!(socket["cause"]["code"], "ConnectionReset");
        assert!(!socket.to_string().contains("secret-peer-details"));
        let tls = SafeError::source(&rustls::Error::NoCertificatesPresented, 0);
        assert_eq!(
            serde_json::to_value(tls).unwrap()["code"],
            "certificate-missing"
        );
    }

    #[test]
    fn ipc_correlation_accepts_only_bounded_opaque_ids() {
        for id in [
            "",
            "bad\nsecret",
            "https://private/?token=secret",
            &"a".repeat(129),
        ] {
            assert!(
                serde_json::from_value::<Context>(serde_json::json!({"operationId":id})).is_err()
            );
        }
        assert!(serde_json::from_value::<Context>(
            serde_json::json!({"operationId":"read:test:1"})
        )
        .is_ok());
    }
}
