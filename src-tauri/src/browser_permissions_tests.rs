use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
    webview::InvokeRequest,
    WebviewUrl, WebviewWindowBuilder,
};

fn invoke(
    webview: &tauri::Webview<MockRuntime>,
    command: &str,
    origin: &str,
) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
    invoke_with_body(webview, command, origin, InvokeBody::default())
}

fn invoke_with_body(
    webview: &tauri::Webview<MockRuntime>,
    command: &str,
    origin: &str,
    body: impl Into<InvokeBody>,
) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
    struct BorrowedWebview<'a>(&'a tauri::Webview<MockRuntime>);
    impl AsRef<tauri::Webview<MockRuntime>> for BorrowedWebview<'_> {
        fn as_ref(&self) -> &tauri::Webview<MockRuntime> {
            self.0
        }
    }
    get_ipc_response(
        &BorrowedWebview(webview),
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: origin.parse().unwrap(),
            body: body.into(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
}

#[test]
fn native_command_permissions_isolate_webviews() {
    let builder = mock_builder()
        // A marker handler proves which requests pass the real generated ACL,
        // without starting terminals, importing plugins or showing notifications.
        .invoke_handler(|request| {
            request.resolver.resolve("authorized");
            true
        });
    #[cfg(all(feature = "native-mcp", target_os = "macos"))]
    let builder = builder.plugin(
        tauri::plugin::Builder::<MockRuntime>::new("mcp-bridge")
            .invoke_handler(|request| {
                request.resolver.resolve("authorized");
                true
            })
            .build(),
    );
    let app = builder.build(super::app_context()).unwrap();
    let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
        .build()
        .unwrap();
    // Production uses a raw Wry guest with no IPC. A Tauri webview under its
    // label catches grants that would reach it if it ever gained IPC.
    let guest = WebviewWindowBuilder::new(&app, "browser-content", WebviewUrl::default())
        .build()
        .unwrap();

    let huddle = WebviewWindowBuilder::new(&app, "huddle", WebviewUrl::default())
        .build()
        .unwrap();

    let application_commands = [
        "network_diagnostics_configure",
        "network_diagnostics_read",
        "network_diagnostics_clear",
        "network_diagnostics_append",
        "network_diagnostics_export",
        "federated_identity_snapshot",
        "federated_identity_servers",
        "federated_identity_requires",
        "federated_identity_ask_again",
        "federated_identity_sign_in",
        "federated_identity_cancel_sign_in",
        "federated_identity_sign_out",
        "credential_pair_answer",
        "credential_pair_prompt",
        "credential_pairings_list",
        "credential_pairing_revoke",
        "credential_pairing_communities",
        "federated_identity_register",
        "federated_identity_unregister",
        "federated_identity_request",
        "relay_socket_connect",
        "relay_socket_start",
        "relay_socket_send",
        "relay_socket_close",
        "identity_restore",
        "identity_import",
        "identity_legacy_available",
        "identity_import_legacy",
        "identity_create",
        "identity_export",
        "nsec_backup_available",
        "nsec_backup_confirmed",
        "nsec_backup_session",
        "nsec_backup_retry",
        "nsec_backup_state",
        "nsec_backup_watch",
        "nsec_restore_begin",
        "nsec_restore_wait",
        "nsec_restore_install",
        "nsec_restore_cancel",
        "nsec_backup_choice",
        "nsec_backup_set_choice",
        "relay_sign",
        "identity_prepare_remote_agent_authorization",
        "identity_sign_builderlab_binding",
        "relay_decode_read_state",
        "relay_sign_read_state",
        "relay_publish_read_state",
        "relay_http",
        "relay_http_cancel",
        "relay_verify_signatures",
        "relay_workflow_runs",
        "relay_project_git",
        "relay_project_git_cancel",
        "relay_channel_sign",
        "relay_channel_publish",
        "relay_kit_sign",
        "relay_kit_prepare",
        "relay_kit_decode",
        "relay_direct_message",
        "relay_decode_sidebar",
        "relay_sign_sidebar",
        "relay_decode_reminders",
        "relay_sign_reminder",
        "relay_agent_resolve",
        "relay_git_authorization",
        "relay_agent_log_proof",
        "relay_agent_observer",
        "relay_archive",
        "relay_agent_memories_read",
        "relay_agent_library",
        "relay_upload_begin",
        "relay_upload_chunk",
        "relay_upload",
        "relay_upload_cancel",
        "media_download",
        "file_download",
        "media_copy_image",
        "media_lift_subject",
        "media_lift_subject_supported",
        "clipboard_write_text",
        "media_stream_base",
        "get_os_idle_seconds",
        "system_hour_cycle",
        "plugin_import_folder",
        "plugin_update_check",
        "plugin_update_preview",
        "plugin_import_git",
        "plugin_import_url",
        "plugin_import_install",
        "plugin_import_discard",
        "plugin_catalog",
        "plugin_managed_refresh",
        "plugin_change",
        "plugin_reload",
        "plugin_module",
        "plugin_recover",
        "plugin_host_run_command",
        "plugin_host_request",
        "plugin_host_upload",
        "plugin_host_process_spawn",
        "plugin_host_process_write",
        "plugin_host_process_kill",
        "plugin_host_mcp_serve",
        "plugin_host_mcp_authorize",
        "plugin_host_mcp_pairing",
        "plugin_host_mcp_reply",
        "plugin_host_mcp_close",
        "plugin_host_read_file",
        "plugin_host_resolve_directory",
        "app_agent_list",
        "app_agent_set_protection",
        "app_agent_protection_defaults",
        "app_agent_set_protection_defaults",
        "app_agent_create",
        "app_agent_portable",
        "app_agent_port",
        "app_agent_rename",
        "app_agent_set_picture",
        "app_agent_set_type",
        "app_agent_delete",
        "app_agent_begin_delete",
        "app_agent_begin_leave",
        "app_agent_join",
        "app_agent_forget",
        "app_agent_publish",
        "app_agent_publish_profile",
        "app_agent_query",
        "app_agent_search_profiles",
        "app_agent_upload",
        "app_agent_media",
        "app_agent_git_auth",
        "app_agent_remember",
        "app_agent_claim",
        "app_agent_release",
        "claude_api_key_status",
        "claude_api_key_set",
        "claude_api_key_clear",
        "jev_classifier_status",
        "jev_classifier_set_key",
        "jev_classifier_clear_key",
        "app_agent_state_load",
        "app_agent_state_set",
        "decide",
        "title_bar_double_click",
        "notification_show",
        #[cfg(target_os = "macos")]
        "notification_permission_state",
        #[cfg(target_os = "macos")]
        "request_notification_access",
        "dock_permission",
        "unread_indicator_set",
        "keep_awake_set",
        "deep_link_take",
        "deep_link_watch",
        "terminal_create_owner",
        "terminal_spawn",
        "terminal_read",
        "terminal_write",
        "terminal_resize",
        "terminal_close",
        "terminal_close_owner",
        "update_restart",
        "browser_attach",
        "browser_set_bounds",
        "browser_set_media_suspended",
        "browser_detach",
        "browser_navigate",
        "browser_action",
        "browser_status",
    ];
    let local_origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    // Exercise the real event plugin with the same payload shape as the frontend
    // API. Valid requests succeed for main and fail only at the capability
    // boundary for sibling webviews or remote origins.
    let event = "pr869-capability-test";
    let listen_body = serde_json::json!({
        "event": event,
        "target": { "kind": "Any" },
        "handler": 42
    });
    let event_id = invoke_with_body(
        main.as_ref(),
        "plugin:event|listen",
        local_origin,
        listen_body.clone(),
    )
    .expect("main should be able to register an event listener")
    .deserialize::<u32>()
    .expect("event plugin should return the listener id");
    let unlisten_body = serde_json::json!({
        "event": event,
        "eventId": event_id
    });
    assert!(
        invoke_with_body(
            main.as_ref(),
            "plugin:event|emit",
            local_origin,
            serde_json::json!({ "event": event, "payload": { "source": "test" } })
        )
        .is_err(),
        "main must not receive event emission permission"
    );
    assert!(
        invoke_with_body(
            main.as_ref(),
            "plugin:event|emit_to",
            local_origin,
            serde_json::json!({
                "target": { "kind": "Webview", "label": "main" },
                "event": event,
                "payload": { "source": "test" }
            })
        )
        .is_err(),
        "main must not receive targeted event emission permission"
    );

    for (webview, origin, source) in [
        (&guest, local_origin, "guest webview"),
        (&main, "https://example.org", "remote content"),
    ] {
        assert!(
            invoke_with_body(
                webview.as_ref(),
                "plugin:event|listen",
                origin,
                listen_body.clone()
            )
            .is_err(),
            "{source} must not listen to events"
        );
        assert!(
            invoke_with_body(
                webview.as_ref(),
                "plugin:event|unlisten",
                origin,
                unlisten_body.clone()
            )
            .is_err(),
            "{source} must not unregister event listeners"
        );
    }
    assert!(invoke_with_body(
        main.as_ref(),
        "plugin:event|unlisten",
        local_origin,
        unlisten_body
    )
    .is_ok());

    // Window fallback belongs to trusted app UI, never a sibling or remote page.
    for origin in [local_origin, "https://example.org", "http://localhost:1430"] {
        assert!(invoke(guest.as_ref(), "plugin:window|close", origin).is_err());
    }
    assert!(invoke(main.as_ref(), "plugin:window|close", "https://example.org").is_err());
    // The removed owner attestation cannot acquire a main-webview grant.
    assert!(invoke(main.as_ref(), "relay_agent_authorize", local_origin).is_err());
    assert!(invoke(main.as_ref(), "relay_agent_history_decode", local_origin).is_err());
    for command in application_commands {
        assert!(
            invoke(main.as_ref(), command, local_origin).is_ok(),
            "{command}"
        );
        assert_eq!(
            invoke(huddle.as_ref(), command, local_origin).is_ok(),
            matches!(command, "media_download" | "clipboard_write_text"),
            "huddle must only acquire bounded download and text copy: {command}"
        );
        assert!(invoke(huddle.as_ref(), command, "https://example.org").is_err());
        for origin in [local_origin, "https://example.org", "http://localhost:1430"] {
            assert!(
                invoke(guest.as_ref(), command, origin).is_err(),
                "guest must reject {command} from {origin}"
            );
        }
        assert!(
            invoke(main.as_ref(), command, "https://example.org").is_err(),
            "remote content must not use main grants: {command}"
        );
    }
    for command in ["plugin:window|close", "plugin:window|is_focused"] {
        assert!(
            invoke(main.as_ref(), command, local_origin).is_ok(),
            "main must receive {command}"
        );
        assert!(invoke(main.as_ref(), command, "https://example.org").is_err());
        assert!(invoke(guest.as_ref(), command, local_origin).is_err());
        assert!(invoke(huddle.as_ref(), command, local_origin).is_err());
    }

    #[cfg(all(feature = "native-mcp", target_os = "macos"))]
    {
        use tauri::Manager as _;
        let callbacks = [
            "script_result",
            "request_script_injection",
            "report_ipc_event",
        ];
        for callback in callbacks {
            assert!(invoke(
                main.as_ref(),
                &format!("plugin:mcp-bridge|{callback}"),
                local_origin
            )
            .is_err());
        }
        // Apply the actual opt-in overlay capability through Tauri's ACL resolver.
        // The marker plugin has no bridge server or identity side effects.
        let overlay: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.native-mcp.conf.json")).unwrap();
        for capability in overlay["app"]["security"]["capabilities"]
            .as_array()
            .unwrap()
        {
            if capability.is_object() {
                app.add_capability(capability.to_string()).unwrap();
            }
        }
        for callback in callbacks {
            let command = format!("plugin:mcp-bridge|{callback}");
            assert!(
                invoke(main.as_ref(), &command, local_origin).is_ok(),
                "{command}"
            );
            assert!(invoke(main.as_ref(), &command, "https://example.org").is_err());
            assert!(invoke(guest.as_ref(), &command, local_origin).is_err());
            assert!(invoke(huddle.as_ref(), &command, local_origin).is_err());
        }
        assert!(invoke(
            main.as_ref(),
            "plugin:mcp-bridge|execute_command",
            local_origin
        )
        .is_err());
        assert!(invoke(main.as_ref(), "identity_restore", local_origin).is_ok());
    }
}
