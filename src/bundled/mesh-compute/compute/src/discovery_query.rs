//! Bounded legacy discovery pagination; network and signing remain host-owned.
use crate::discovery::{
    authoritative_membership_filter, current_member_pubkeys, mesh_status_filter, verify_evidence,
    MESH_STATUS_PAGE_SIZE,
};
use nostr::{event::Event, key::PublicKey};
use serde_json::Value;
use std::future::Future;

const MAX_STATUS_PAGES: usize = 100;

pub async fn discover<F, Fut>(authority: &PublicKey, mut query: F) -> anyhow::Result<Vec<Event>>
where
    F: FnMut(Value) -> Fut,
    Fut: Future<Output = anyhow::Result<Vec<Value>>>,
{
    let roster = query(authoritative_membership_filter(authority)).await?;
    let mut events = verify_evidence(parse_events(roster), authority)?;
    let members = current_member_pubkeys(&events);
    if members.is_empty() {
        return Ok(events);
    }
    let mut filter = mesh_status_filter();
    filter["authors"] = serde_json::json!(members);
    let mut previous_cursor = None;
    for _ in 0..MAX_STATUS_PAGES {
        let page = query(filter.clone()).await?;
        if page.len() > MESH_STATUS_PAGE_SIZE {
            anyhow::bail!("Oversized Mesh status page");
        }
        let done = page.len() < MESH_STATUS_PAGE_SIZE;
        if !done {
            let last = page
                .last()
                .ok_or_else(|| anyhow::anyhow!("Empty Mesh status page"))?;
            let timestamp = last
                .get("created_at")
                .and_then(Value::as_u64)
                .ok_or_else(|| anyhow::anyhow!("Malformed Mesh pagination cursor"))?;
            let id = last
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or_else(|| anyhow::anyhow!("Malformed Mesh pagination cursor"))?;
            let cursor = (timestamp, id.to_owned());
            filter["until"] = serde_json::json!(cursor.0);
            filter["before_id"] = serde_json::json!(cursor.1);
            if previous_cursor.as_ref() == Some(&cursor) {
                anyhow::bail!("Mesh status pagination did not advance");
            }
            previous_cursor = Some(cursor);
        }
        // A status page must never introduce a second membership snapshot.
        events.extend(
            parse_events(page)
                .into_iter()
                .filter(|event| event.kind.as_u16() != 13534),
        );
        if done {
            return verify_evidence(events, authority);
        }
    }
    anyhow::bail!("Mesh status pagination exceeded its page limit")
}

fn parse_events(page: Vec<Value>) -> Vec<Event> {
    page.into_iter()
        .filter_map(|value| match serde_json::from_value(value) {
            Ok(event) => Some(event),
            Err(_) => {
                eprintln!("Mesh discovery dropped malformed event envelope");
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{
        event::{EventBuilder, FinalizeEvent, Kind, Tag},
        key::Keys,
    };
    #[tokio::test]
    async fn reads_more_than_one_hundred_statuses_with_legacy_cursor() {
        let relay = Keys::generate();
        let member = Keys::generate();
        let roster = EventBuilder::new(Kind::Custom(13534), "")
            .tags([Tag::parse(["member", &member.public_key().to_hex()]).unwrap()])
            .finalize(&relay)
            .unwrap();
        let mut statuses: Vec<_> = (0..101)
            .map(|i| {
                EventBuilder::new(Kind::Custom(30003), format!("{{\"fixture\":{i}}}"))
                    .tags([Tag::parse(["k", "buzz-mesh-status"]).unwrap()])
                    .finalize(&member)
                    .unwrap()
            })
            .collect();
        statuses[2].content = "tampered".into();
        let cursor = statuses[99].clone();
        let mut calls = 0;
        let events = discover(&relay.public_key(), |filter| {
            calls += 1;
            let page = match calls {
                1 => {
                    assert_eq!(
                        filter["authors"],
                        serde_json::json!([relay.public_key().to_hex()])
                    );
                    vec![roster.clone()]
                }
                2 => statuses[..100].to_vec(),
                3 => {
                    assert_eq!(
                        filter["until"],
                        serde_json::json!(cursor.created_at.as_secs())
                    );
                    assert_eq!(filter["before_id"], serde_json::json!(cursor.id.to_hex()));
                    statuses[100..].to_vec()
                }
                _ => panic!("extra page"),
            };
            let mut raw: Vec<_> = page
                .into_iter()
                .map(|event| serde_json::to_value(event).unwrap())
                .collect();
            if calls == 2 {
                raw[3] = serde_json::json!({"broken":true});
            }
            std::future::ready(Ok(raw))
        })
        .await
        .unwrap();
        assert_eq!(calls, 3);
        assert_eq!(events.len(), 100);
    }
}
