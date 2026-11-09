//! Allowlisted runtime-session activity, not member contribution accounting.
use serde_json::{json, Value};

pub fn snapshot(payload: &Value) -> Option<Value> {
    let metrics = payload.get("routing_metrics")?.as_object()?;
    let count = |name: &str| metrics.get(name).and_then(Value::as_u64);
    let peers = payload.get("peers").and_then(Value::as_array);
    let node_id = payload.get("node_id").and_then(Value::as_str);
    let peer_count = |serving_only: bool| {
        peers.map(|peers| {
            peers
                .iter()
                .filter(|peer| {
                    !serving_only || peer.get("state").and_then(Value::as_str) == Some("serving")
                })
                .filter_map(|peer| peer.get("id").and_then(Value::as_str))
                .filter(|id| !id.is_empty() && Some(*id) != node_id)
                .collect::<std::collections::HashSet<_>>()
                .len()
        })
    };
    Some(json!({
        "otherNodes": peer_count(false),
        "sharingNodes": peer_count(true),
        "outputTokens": count("completion_tokens_observed"),
        "completedRequests": count("successful_requests"),
        "finishedRequests": count("request_count"),
        "retries": count("retry_count"),
        "activeRequests": metrics.get("local_node")
            .and_then(|local| local.get("current_inflight_requests"))
            .and_then(Value::as_u64),
        "tokensPerSecond": metrics.get("avg_tokens_per_second")
            .and_then(Value::as_f64).filter(|value| value.is_finite() && *value >= 0.0),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_only_known_session_counters() {
        let result = snapshot(&json!({"routing_metrics": {
            "completion_tokens_observed": 1912, "successful_requests": 7,
            "request_count": 9, "retry_count": 2,
            "local_node": {"current_inflight_requests": 1},
            "avg_tokens_per_second": 12.5, "private": "not exposed"
        }, "invite_token": "not exposed"}))
        .unwrap();
        assert_eq!(
            result,
            json!({"outputTokens": 1912, "completedRequests": 7,
            "finishedRequests": 9, "retries": 2, "activeRequests": 1,
            "tokensPerSecond": 12.5, "otherNodes": null, "sharingNodes": null})
        );
    }

    #[test]
    fn counts_unique_other_nodes_and_only_serving_nodes_as_sharing() {
        let result = snapshot(&json!({"routing_metrics": {}, "node_id": "self", "peers": [
            {"id": "self", "state": "serving"},
            {"id": "provider", "state": "serving"},
            {"id": "provider", "state": "serving"},
            {"id": "consumer", "state": "client"},
            {"id": "idle", "state": "standby"},
            {"id": "loading", "state": "loading"},
            {"state": "serving"}
        ]}))
        .unwrap();
        assert_eq!(result["otherNodes"], 4);
        assert_eq!(result["sharingNodes"], 1);
        let empty = snapshot(&json!({"routing_metrics": {}, "peers": []})).unwrap();
        assert_eq!(empty["sharingNodes"], 0);
    }

    #[test]
    fn missing_or_invalid_metrics_are_not_reported_as_zero() {
        assert_eq!(snapshot(&json!({})), None);
        assert_eq!(snapshot(&json!({"routing_metrics": null})), None);
        let result = snapshot(&json!({"routing_metrics": {
            "completion_tokens_observed": -1, "successful_requests": "7",
            "retry_count": 0, "avg_tokens_per_second": -2
        }}))
        .unwrap();
        assert_eq!(result["outputTokens"], Value::Null);
        assert_eq!(result["completedRequests"], Value::Null);
        assert_eq!(result["activeRequests"], Value::Null);
        assert_eq!(result["tokensPerSecond"], Value::Null);
        assert_eq!(result["retries"], 0);
    }
}
