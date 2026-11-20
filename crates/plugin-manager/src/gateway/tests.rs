use super::*;
use serde_json::json;

fn fixture() -> Value {
    json!({
        "version": 2,
        "gateway": "https://gateway.example",
        "communities": [
            { "id": "22222222-2222-4222-8222-222222222222", "origin": "wss://relay.example" }
        ],
        "access_path": "/v9/access",
        "launcher_client": "client-a",
        "headers": {
            "launcher_client": "x-gw-launcher-client",
            "launcher_session": "x-gw-launcher-session",
            "human_pubkey": "x-gw-ctx-human-pubkey",
            "agent_pubkey": "x-gw-ctx-agent-pubkey",
            "community_id": "x-gw-ctx-community-id",
            "channel_id": "x-gw-ctx-channel-id",
            "message_id": "x-gw-ctx-message-id",
            "thread_id": "x-gw-ctx-thread-id"
        },
        "reserved_prefixes": ["x-gw-ctx-"],
        "upstreams": {
            "claude-code": { "base": "/upstream/claude" },
            "goose": { "base": "/upstream/goose" },
            "pi": { "base": "/upstream/pi" }
        }
    })
}
fn with(edit: impl FnOnce(&mut Value)) -> String {
    let mut value = fixture();
    edit(&mut value);
    value.to_string()
}
fn refused(raw: &str) -> &'static str {
    parse(raw).expect_err(raw).code()
}

#[test]
fn blank_is_off_and_the_fixture_takes_only_what_native_forwards() {
    for blank in ["", " \n\t "] {
        assert_eq!(parse(blank), Ok(None));
    }
    let (native, _) = parse(&fixture().to_string()).unwrap().unwrap();
    assert_eq!(native.gateway, "https://gateway.example");
    assert_eq!(native.headers["thread_id"], "x-gw-ctx-thread-id");
    assert_eq!(native.reserved_prefixes, ["x-gw-ctx-"]);
    assert_eq!(
        native.upstreams,
        BTreeMap::from([
            ("claude-code".into(), "/upstream/claude".into()),
            ("goose".into(), "/upstream/goose".into()),
        ])
    );
}

#[test]
fn the_compiled_form_is_one_line_and_parses_to_itself() {
    let pretty = serde_json::to_string_pretty(&fixture()).unwrap();
    let (native, compiled) = parse(&pretty).unwrap().unwrap();
    assert!(!compiled.contains('\n'));
    assert_eq!(parse(&compiled), Ok(Some((native, compiled.clone()))));
    // Communities are compiled as the frontend canonicalizes them.
    let compiled: Value = serde_json::from_str(&compiled).unwrap();
    assert_eq!(
        compiled["communities"][0]["origin"],
        "https://relay.example"
    );
    // Known capabilities may be left out; native opens only what is configured.
    let (native, _) = parse(&with(|v| v["upstreams"] = json!({})))
        .unwrap()
        .unwrap();
    assert!(native.upstreams.is_empty());
}

#[test]
fn errors_name_their_rule_and_never_the_value() {
    let secret = "s3cret-value";
    for raw in [
        format!("{{\"{secret}\": 1}}"),
        format!("{{\"version\": \"{secret}\"}}"),
        with(|v| v["gateway"] = json!(format!("https://{secret}.example/x"))),
        with(|v| v["headers"]["thread_id"] = json!(format!("{secret}_X"))),
        with(|v| v["launcher_client"] = json!(format!("{secret} !"))),
        with(|v| v["upstreams"]["goose"]["base"] = json!(format!("/{secret}/"))),
    ] {
        let error = parse(&raw).unwrap_err().to_string();
        assert!(!error.contains(secret), "{error}");
        assert!(
            error.starts_with("BUZZ_AGENT_GATEWAY is invalid ("),
            "{error}"
        );
    }
}

#[test]
fn size_is_utf8_bytes_and_comes_first() {
    let at = |len: usize| {
        let mut raw = fixture().to_string();
        raw.push_str(&" ".repeat(len - raw.len()));
        raw
    };
    assert!(parse(&at(MAX_BYTES)).is_ok());
    assert_eq!(refused(&at(MAX_BYTES + 1)), "size");
    // Under the cap in characters, over it in bytes.
    let wide = with(|v| v["launcher_client"] = json!("é".repeat(MAX_BYTES / 2)));
    assert!(wide.chars().count() < MAX_BYTES);
    assert_eq!(refused(&wide), "size");
    assert_eq!(refused(&"{".repeat(MAX_BYTES + 1)), "size");
}

#[test]
fn version_is_checked_before_the_shape() {
    assert_eq!(refused("{"), "json");
    for not_object in ["[]", "\"x\"", "null", "2"] {
        assert_eq!(refused(not_object), "keys");
    }
    // A version 1 descriptor reads as one, whatever else it lacks.
    assert_eq!(
        refused(r#"{"version":1,"gateway":"https://gateway.example","communities":[]}"#),
        "version"
    );
    for version in [json!("2"), json!(3), json!(null), json!(1.5)] {
        assert_eq!(refused(&with(|v| v["version"] = version)), "version");
    }
    assert_eq!(
        refused(&with(|v| {
            v.as_object_mut().unwrap().remove("version");
        })),
        "version"
    );
    // The frontend's JSON can't tell 2.0 from 2, so neither does native.
    assert!(parse(&with(|v| v["version"] = json!(2.0))).is_ok());
    assert_eq!(refused(&with(|v| v["probe"] = json!("/x"))), "keys");
    assert_eq!(
        refused(&with(|v| {
            v.as_object_mut().unwrap().remove("upstreams");
        })),
        "keys"
    );
}

#[test]
fn gateway_and_communities_are_secure_origins() {
    for gateway in [
        "http://gateway.example",
        "https://gateway.example/",
        "https://gateway.example/x",
        "https://u:p@gateway.example",
        "https://gateway.example?x",
        "https://GATEWAY.example",
        "gateway.example",
    ] {
        assert_eq!(refused(&with(|v| v["gateway"] = json!(gateway))), "gateway");
    }
    assert_eq!(
        refused(&with(|v| v["communities"] = json!([]))),
        "communities"
    );
    let many: Vec<Value> = (0..17)
        .map(|i| json!({ "id": format!("22222222-2222-4222-8222-2222222222{i:02}"), "origin": format!("wss://r{i}.example") }))
        .collect();
    assert_eq!(
        refused(&with(|v| v["communities"] = json!(many))),
        "communities"
    );
    assert!(parse(&with(|v| v["communities"] = json!(many[..16]))).is_ok());
    for id in [
        "22222222-2222-4222-8222-22222222222A",
        "00000000-0000-0000-0000-000000000000",
        "222222222222422282222222222222222",
    ] {
        assert_eq!(
            refused(&with(|v| v["communities"][0]["id"] = json!(id))),
            "communities"
        );
    }
    for origin in [
        "ws://relay.example",
        "http://relay.example",
        "wss://relay.example/path",
        "wss://u@relay.example",
        "wss://relay.example?x",
        "wss://",
        "wss://relay example",
    ] {
        assert_eq!(
            refused(&with(|v| v["communities"][0]["origin"] = json!(origin))),
            "communities"
        );
    }
    assert_eq!(
        refused(&with(|v| v["communities"][0]["extra"] = json!(1))),
        "communities"
    );
    // `wss://` and `https://`, case, a final dot and padding name one community.
    for twin in [
        "https://relay.example/",
        "WSS://Relay.Example.",
        " wss://relay.example ",
    ] {
        let raw = with(|v| {
            v["communities"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "id": "33333333-3333-4333-8333-333333333333", "origin": twin }))
        });
        assert_eq!(refused(&raw), "communities", "{twin}");
    }
    let duplicate_id = with(|v| {
        v["communities"].as_array_mut().unwrap().push(
            json!({ "id": "22222222-2222-4222-8222-222222222222", "origin": "wss://other.example" }),
        )
    });
    assert_eq!(refused(&duplicate_id), "communities");
}

#[test]
fn paths_cannot_leave_their_base_or_origin() {
    for path in [
        "",
        "/",
        "x",
        "/x/",
        "//x",
        "/x//y",
        "/./x",
        "/x/.",
        "/x/..",
        "/x/../y",
        "/%2e%2e",
        "/x?y",
        "/x#y",
        "/x\\y",
        "/x y",
        "/é",
        "https://elsewhere.example/x",
        "//elsewhere.example",
        "@elsewhere.example",
    ] {
        assert_eq!(
            refused(&with(|v| v["access_path"] = json!(path))),
            "path",
            "{path:?}"
        );
        assert_eq!(
            refused(&with(|v| v["upstreams"]["goose"]["base"] = json!(path))),
            "path",
            "{path:?}"
        );
    }
    assert_eq!(refused(&with(|v| v["access_path"] = json!(9))), "path");
    let long = format!("/{}", "a".repeat(255));
    assert!(parse(&with(|v| v["access_path"] = json!(long))).is_ok());
    assert_eq!(
        refused(&with(|v| v["access_path"] = json!(format!("{long}a")))),
        "path"
    );
}

#[test]
fn upstreams_name_known_capabilities_exactly() {
    for edit in [
        json!({ "other": { "base": "/x" } }),
        json!({ "Goose": { "base": "/x" } }),
        json!({ "claude": { "base": "/x" } }),
        json!({ "goose": { "base": "/x", "extra": 1 } }),
        json!({ "goose": "/x" }),
        json!({ "goose": {} }),
        json!([]),
    ] {
        assert_eq!(
            refused(&with(|v| v["upstreams"] = edit.clone())),
            "upstreams",
            "{edit}"
        );
    }
    // Every entry's shape before any base, whatever the key order.
    for upstreams in [
        json!({ "aaa": { "base": "/x" }, "goose": { "base": "/x/" } }),
        json!({ "claude-code": { "base": "/x/" }, "zzz": { "base": "/x" } }),
    ] {
        assert_eq!(refused(&with(|v| v["upstreams"] = upstreams)), "upstreams");
    }
    // Codex and Pi validate like the rest; native forwards neither.
    assert_eq!(
        refused(&with(
            |v| v["upstreams"]["codex"] = json!({ "base": "/a/./b" })
        )),
        "path"
    );
    let (native, _) = parse(&with(|v| v["upstreams"]["codex"] = json!({ "base": "/c" })))
        .unwrap()
        .unwrap();
    assert!(!native.upstreams.contains_key("codex") && !native.upstreams.contains_key("pi"));
}

#[test]
fn launcher_client_is_a_plain_token() {
    for client in [
        json!(""),
        json!("a b"),
        json!("é"),
        json!("a/"),
        json!("a".repeat(65)),
        json!(5),
    ] {
        assert_eq!(
            refused(&with(|v| v["launcher_client"] = client.clone())),
            "launcher_client",
            "{client}"
        );
    }
    assert!(parse(&with(|v| v["launcher_client"] = json!("A.b_c-9"))).is_ok());
}

#[test]
fn header_names_are_exact_unique_and_unprotected() {
    let header_name = [
        with(|v| {
            v["headers"].as_object_mut().unwrap().remove("thread_id");
        }),
        with(|v| v["headers"]["trigger_id"] = json!("x-gw-ctx-trigger-id")),
        with(|v| v["headers"] = json!([])),
        with(|v| v["headers"]["thread_id"] = json!(3)),
    ];
    for raw in header_name {
        assert_eq!(refused(&raw), "header_name");
    }
    for name in [
        "",
        "X-Gw-Ctx-Thread-Id",
        "x_gw_ctx_thread_id",
        "x-gw ctx",
        &"a".repeat(65),
    ] {
        assert_eq!(
            refused(&with(|v| v["headers"]["thread_id"] = json!(name))),
            "header_name",
            "{name:?}"
        );
    }
    for name in PROTECTED_EXACT.iter().copied().chain([
        "content-md5",
        "anthropic-foo",
        "x-amz-date",
        "sec-fetch-mode",
        "proxy-thing",
        "x-stainless-os",
    ]) {
        assert_eq!(
            refused(&with(|v| v["headers"]["thread_id"] = json!(name))),
            "header_protected",
            "{name}"
        );
    }
    assert_eq!(
        refused(&with(
            |v| v["headers"]["thread_id"] = json!("x-gw-ctx-message-id")
        )),
        "header_duplicate"
    );
    // Protected outranks duplicate.
    assert_eq!(
        refused(&with(|v| {
            v["headers"]["thread_id"] = json!("host");
            v["headers"]["message_id"] = json!("host");
        })),
        "header_protected"
    );
}

#[test]
fn reserved_prefixes_never_cover_protected_headers() {
    for prefixes in [
        json!(["a-1-", "b-1-", "c-1-", "d-1-", "e-1-"]),
        json!(["x-gw-ctx-", "x-gw-ctx-"]),
        json!("x-gw-ctx-"),
    ] {
        assert_eq!(
            refused(&with(|v| v["reserved_prefixes"] = prefixes)),
            "prefix"
        );
    }
    // Short, unterminated, mixed case, underscored or too long.
    for prefix in [
        "x-",
        "x-gw-ctx",
        "X-GW-",
        "x_gw_",
        &format!("{}-", "a".repeat(64)),
    ] {
        assert_eq!(
            refused(&with(|v| v["reserved_prefixes"] = json!([prefix]))),
            "prefix",
            "{prefix}"
        );
    }
    // Covering a protected name, inside a protected family or around one.
    for prefix in [
        "x-api-",
        "x-claude-",
        "agent-",
        "user-",
        "accept-",
        "transfer-",
        "x-goog-",
        "content-",
        "content-x-",
        "x-amz-",
        "x-amz-foo-",
        "proxy-",
        "anthropic-",
        "sec-",
        "x-stainless-a-",
    ] {
        assert_eq!(
            refused(&with(|v| v["reserved_prefixes"] = json!([prefix]))),
            "prefix_protected",
            "{prefix}"
        );
    }
    // Sharing letters with a protected name is not covering it.
    for prefix in [json!([]), json!(["con-", "pro-", "x-am-", "x-gw-ctx-"])] {
        assert!(parse(&with(|v| v["reserved_prefixes"] = prefix)).is_ok());
    }
}

#[test]
fn reserved_folds_case_and_underscores_and_context_is_exact() {
    let (native, _) = parse(&fixture().to_string()).unwrap().unwrap();
    for name in [
        "x-gw-launcher-client",
        "X_GW_LAUNCHER_SESSION",
        "x-gw-ctx-anything",
        "X_Gw_Ctx_Message_Id",
    ] {
        assert!(native.reserved(name), "{name}");
    }
    for name in [
        "x-gw-launcher",
        "x-gw-ctx",
        "x-gw-request-id",
        "authorization",
    ] {
        assert!(!native.reserved(name), "{name}");
    }
    assert!(native.context("x-gw-ctx-message-id"));
    for name in [
        "X-Gw-Ctx-Message-Id",
        "x_gw_ctx_message_id",
        "x-gw-ctx-unknown",
    ] {
        assert!(!native.context(name), "{name}");
    }
}

/// The frontend's canonical vectors: the same protected lists, every valid
/// case to its normalized outputs, every off case off and every invalid case
/// refused with exactly its code.
#[test]
fn matches_the_canonical_vectors() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../src/features/agents/gateway/descriptor-vectors.json"
    ))
    .unwrap();
    let names = |list: &Value| -> Vec<String> { serde_json::from_value(list.clone()).unwrap() };
    assert_eq!(names(&vectors["protected"]["exact"]), PROTECTED_EXACT);
    assert_eq!(names(&vectors["protected"]["families"]), PROTECTED_FAMILIES);
    let raw = |case: &Value| match case.get("raw") {
        Some(raw) => raw.as_str().unwrap().to_owned(),
        None => case["descriptor"].to_string(),
    };
    for case in vectors["off"].as_array().unwrap() {
        assert_eq!(parse(&raw(case)), Ok(None), "{}", case["name"]);
    }
    for case in vectors["valid"].as_array().unwrap() {
        let (native, canonical) = parse(&raw(case)).unwrap().unwrap();
        let canonical: Value = serde_json::from_str(&canonical).unwrap();
        assert_eq!(canonical, case["expect"], "{}", case["name"]);
        let upstreams: Map<String, Value> = native
            .upstreams
            .iter()
            .map(|(capability, base)| (capability.clone(), json!({ "base": base })))
            .collect();
        let expected = json!({
            "gateway": native.gateway,
            "launcher_client": native.launcher_client,
            "headers": native.headers,
            "reserved_prefixes": native.reserved_prefixes,
            "upstreams": upstreams,
        });
        assert_eq!(expected, case["expect_native"], "{}", case["name"]);
    }
    for case in vectors["invalid"].as_array().unwrap() {
        let refused = parse(&raw(case)).map(|_| ()).map_err(Invalid::code);
        assert_eq!(
            refused,
            Err(case["error"].as_str().unwrap()),
            "{}",
            case["name"]
        );
    }
}

/// The frontend's selection vectors: an explicit descriptor wins, else the
/// org-gateways.json entry listing the default community, else none; every
/// listed entry is checked first, failing with exactly the case's message.
#[test]
fn selects_as_the_canonical_vectors() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../src/features/agents/gateway/descriptor-vectors.json"
    ))
    .unwrap();
    for case in vectors["select"].as_array().unwrap() {
        let explicit = match (case.get("explicit_raw"), case.get("explicit")) {
            (Some(raw), _) => raw.as_str().unwrap().to_owned(),
            (None, Some(descriptor)) => descriptor.to_string(),
            (None, None) => String::new(),
        };
        let listed = match case.get("listed_raw") {
            Some(raw) => raw.as_str().unwrap().to_owned(),
            None => case["listed"].to_string(),
        };
        let chosen = select(&explicit, &listed, case["community_url"].as_str().unwrap());
        if let Some(code) = case.get("explicit_error") {
            assert_eq!(
                chosen.map(|_| ()),
                Err(format!(
                    "BUZZ_AGENT_GATEWAY is invalid ({})",
                    code.as_str().unwrap()
                )),
                "{}",
                case["name"]
            );
            continue;
        }
        match case.get("error") {
            Some(error) => assert_eq!(
                chosen.map(|_| ()),
                Err(error.as_str().unwrap().to_owned()),
                "{}",
                case["name"]
            ),
            None => {
                let chosen = chosen
                    .unwrap()
                    .map(|(_, canonical)| serde_json::from_str::<Value>(&canonical).unwrap());
                assert_eq!(
                    chosen.unwrap_or(Value::Null),
                    case["expect"],
                    "{}",
                    case["name"]
                );
            }
        }
    }
}
