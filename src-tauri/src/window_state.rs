use serde::Deserialize;
use std::collections::HashMap;
use tauri::{LogicalSize, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, Runtime, Window};
use tauri_plugin_window_state::{AppHandleExt, Builder, StateFlags, WindowExt};

pub(crate) fn builder() -> Builder {
    Builder::default()
        // Closing on macOS hides the window. Never persist that hidden state or
        // platform-owned decorations; a fresh launch must remain reachable.
        .with_state_flags(
            StateFlags::SIZE
                | StateFlags::POSITION
                | StateFlags::MAXIMIZED
                | StateFlags::FULLSCREEN,
        )
        .with_filter(|label| label == "main")
        // Restore geometry and validate reachability before entering a saved mode.
        .skip_initial_state("main")
}

// Called from app setup, after the configured main window has been created.
const INTRO_GEOMETRY: &str = "onboarding-window-restore.json";

/// Preserve normal geometry for the next launch, without resizing this session.
#[tauri::command]
pub(crate) fn onboarding_preserve_window<R: Runtime>(
    window: tauri::WebviewWindow<R>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Main window required".into());
    }
    #[cfg(target_os = "macos")]
    {
        let native = window.ns_window().map_err(|error| error.to_string())?;
        let native: &objc2_app_kit::NSWindow = unsafe { &*native.cast() };
        native.setAnimationBehavior(objc2_app_kit::NSWindowAnimationBehavior::None);
        // Undo `opaque_background` while still hidden: the intro shows the desktop.
        native.setBackgroundColor(Some(&objc2_app_kit::NSColor::clearColor()));
    }
    let app = window.app_handle();
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let target = dir.join(INTRO_GEOMETRY);
    if target.exists() {
        return Ok(());
    }
    app.save_window_state(
        StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN,
    )
    .map_err(|e| e.to_string())?;
    let bytes = std::fs::read(dir.join(app.filename())).map_err(|e| e.to_string())?;
    preserve_intro_geometry(&target, &bytes)
}

/// The Mac window shows `--bg-app` (tokens.css) under the page instead of the
/// desktop, so it is solid before first paint and if WebKit never paints. Only
/// the first-welcome intro is see-through: `onboarding_preserve_window` clears
/// this again before the intro shows the window.
#[cfg(target_os = "macos")]
pub(crate) fn opaque_background<R: Runtime>(window: &tauri::WebviewWindow<R>) -> tauri::Result<()> {
    use objc2_app_kit::{NSAppearance, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSColor};
    let native: &objc2_app_kit::NSWindow = unsafe { &*window.ns_window()?.cast() };
    let srgb = |r: f64, g: f64, b: f64| {
        NSColor::colorWithSRGBRed_green_blue_alpha(r / 255.0, g / 255.0, b / 255.0, 1.0)
    };
    // Resolved by the system appearance: Buzz's own light/dark choice is page
    // state, so it can differ until the page paints.
    let (light, dark) = (srgb(241.0, 241.0, 242.0), srgb(16.0, 16.0, 16.0));
    let provider = block2::RcBlock::new(move |appearance: std::ptr::NonNull<NSAppearance>| {
        let names = unsafe { [NSAppearanceNameAqua, NSAppearanceNameDarkAqua] };
        let best = unsafe { appearance.as_ref() }
            .bestMatchFromAppearancesWithNames(&objc2_foundation::NSArray::from_slice(&names));
        let color = if best.as_deref() == Some(names[1]) {
            &dark
        } else {
            &light
        };
        // The block owns both colours, and the dynamic colour retains the block.
        std::ptr::NonNull::from(&**color)
    });
    let color = unsafe { NSColor::colorWithName_dynamicProvider(None, &provider) };
    native.setBackgroundColor(Some(&color));
    Ok(())
}

fn preserve_intro_geometry(target: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    if target.exists() {
        return Ok(());
    }
    if saved_geometry(bytes, "main").is_none() {
        return Err("Window geometry unavailable".into());
    }
    std::fs::write(target, bytes).map_err(|e| e.to_string())
}

pub(crate) fn restore<R: Runtime>(window: &Window<R>) -> tauri::Result<()> {
    let pending = window
        .app_handle()
        .path()
        .app_config_dir()?
        .join(INTRO_GEOMETRY);
    if let Ok(bytes) = std::fs::read(&pending) {
        if let Some(saved) = saved_geometry(&bytes, window.label()) {
            window.set_fullscreen(false)?;
            window.unmaximize()?;
            restore_geometry_from(window, Some(bytes))?;
            window.set_fullscreen(saved.fullscreen)?;
            if saved.maximized {
                window.maximize()?;
            }
            std::fs::remove_file(pending)?;
            return Ok(());
        }
    }
    if let Err(error) = restore_geometry(window) {
        eprintln!("Could not restore Buzz window geometry: {error}");
    }
    window.restore_state(StateFlags::MAXIMIZED | StateFlags::FULLSCREEN)
}

// Read-only adapter for window-state 2.4.1's format: position is the outer
// origin, size is the client size, and maximized windows use prev_x/prev_y.
// Keep all required fields typed so corrupt state falls back just as it does
// in the plugin. The plugin remains the only writer and mode/lifecycle owner.
#[derive(Deserialize)]
struct SavedGeometry {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    prev_x: i32,
    prev_y: i32,
    maximized: bool,
    #[serde(rename = "visible")]
    _visible: bool,
    #[serde(rename = "decorated")]
    _decorated: bool,
    #[serde(rename = "fullscreen")]
    fullscreen: bool,
}

fn saved_geometry(bytes: &[u8], label: &str) -> Option<SavedGeometry> {
    serde_json::from_slice::<HashMap<String, SavedGeometry>>(bytes)
        .ok()?
        .remove(label)
        .filter(|state| state.width > 0 && state.height > 0)
}

fn restore_geometry<R: Runtime>(window: &Window<R>) -> tauri::Result<()> {
    restore_geometry_from(window, None)
}

fn restore_geometry_from<R: Runtime>(
    window: &Window<R>,
    override_bytes: Option<Vec<u8>>,
) -> tauri::Result<()> {
    let path = window
        .app_handle()
        .path()
        .app_config_dir()?
        .join(window.app_handle().filename());
    let Some(saved) = override_bytes
        .or_else(|| std::fs::read(path).ok())
        .and_then(|bytes| saved_geometry(&bytes, window.label()))
    else {
        return Ok(());
    };
    let monitors = window.available_monitors()?;
    let areas: Vec<_> = monitors
        .iter()
        .map(|monitor| *monitor.work_area())
        .collect();
    let fallback = window
        .primary_monitor()?
        .or_else(|| monitors.first().cloned())
        .map(|monitor| (*monitor.work_area(), monitor.scale_factor()));
    if let Some(fallback) = fallback {
        // Only the client-to-frame origin offset is needed. Linux's initial
        // outer_size is not reliable until its first configure event.
        let outer = window.outer_position()?;
        let inner = window.inner_position()?;
        let offset = PhysicalPosition::new(
            inner.x.saturating_sub(outer.x),
            inner.y.saturating_sub(outer.y),
        );
        // AppShell owns a 48 logical-pixel header on all desktop platforms.
        let header_height = (48.0 * window.scale_factor()?).ceil() as u32;
        let windows = &window.config().app.windows;
        let config = windows.first().cloned().unwrap_or_default();
        let (position, size, relocated) =
            restore_request(&saved, offset, header_height, &areas, fallback, &config);
        // Validate the requested geometry BEFORE sending it. Native setters
        // may apply asynchronously (Linux/macOS); getters can still report the
        // startup frame.
        // Move first: Windows rescales on DPI change. macOS/GTK convert at the startup scale.
        if let Some(scale) = relocated.filter(|_| cfg!(not(windows))) {
            window.set_position(position.to_logical::<f64>(scale))?;
            return window.set_size(size.to_logical::<f64>(scale));
        }
        window.set_position(position)?;
        window.set_size(size)?;
    }
    Ok(())
}

fn restore_request(
    saved: &SavedGeometry,
    client_offset: PhysicalPosition<i32>,
    header_height: u32,
    areas: &[PhysicalRect<i32, u32>],
    (fallback, scale): (PhysicalRect<i32, u32>, f64),
    config: &tauri::utils::config::WindowConfig,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>, Option<f64>) {
    let position = if saved.maximized {
        PhysicalPosition::new(saved.prev_x, saved.prev_y)
    } else {
        PhysicalPosition::new(saved.x, saved.y)
    };
    let client = PhysicalRect {
        position: PhysicalPosition::new(
            position.x.saturating_add(client_offset.x),
            position.y.saturating_add(client_offset.y),
        ),
        size: PhysicalSize::new(saved.width, saved.height),
    };
    // A size below the minimum at the fallback's scale (rounded as tao rounds it) was
    // saved at a lower scale and would reopen below it. Windows applies the minimum to
    // the frame: take off tao's shadow insets (default metrics, Windows 11 top).
    let win = u32::from(cfg!(windows));
    let side = win * (4 * (scale * 96.0).round() as u32 + 48) / 96 * 2;
    let top = win * scale.round() as u32;
    let px = |logical: Option<f64>| (logical.unwrap_or(0.0) * scale).round() as u32;
    let below = saved.width < px(config.min_width).saturating_sub(2 * side)
        || saved.height < px(config.min_height).saturating_sub(side + top);
    let default = below.then(|| LogicalSize::new(config.width, config.height).to_physical(scale));
    let relocated = reachable_client(client, header_height, areas, fallback, default);
    let target = relocated.unwrap_or(client);
    (
        PhysicalPosition::new(
            target.position.x.saturating_sub(client_offset.x),
            target.position.y.saturating_sub(client_offset.y),
        ),
        target.size,
        relocated.map(|_| scale),
    )
}

fn reachable_client(
    mut client: PhysicalRect<i32, u32>,
    header_height: u32,
    areas: &[PhysicalRect<i32, u32>],
    fallback: PhysicalRect<i32, u32>,
    default: Option<PhysicalSize<u32>>,
) -> Option<PhysicalRect<i32, u32>> {
    let x = i64::from(client.position.x);
    let y = i64::from(client.position.y);
    let right = x + i64::from(client.size.width.saturating_sub(1));
    let bottom = y + i64::from(header_height.saturating_sub(1));
    // A header may span adjacent monitors. Both control regions must remain
    // reachable, but need not belong to the same monitor.
    let reachable = [(x, y), (right, y), (x, bottom), (right, bottom)]
        .into_iter()
        .all(|(x, y)| {
            areas.iter().any(|area| {
                x >= i64::from(area.position.x)
                    && y >= i64::from(area.position.y)
                    && x < i64::from(area.position.x) + i64::from(area.size.width)
                    && y < i64::from(area.position.y) + i64::from(area.size.height)
            })
        });
    // A lone monitor's scale is known, so a sub-minimum size is replaced even there.
    if reachable && !(default.is_some() && areas.len() == 1) {
        return None;
    }
    client.size = default.unwrap_or(client.size);
    // Unlike any-corner intersection, this keeps the drag strip and both sets
    // of platform controls on-screen, including after removing an upper monitor.
    let size = PhysicalSize::new(
        client.size.width.min(fallback.size.width),
        client.size.height.min(fallback.size.height),
    );
    Some(PhysicalRect {
        position: PhysicalPosition::new(
            fallback
                .position
                .x
                .saturating_add(((fallback.size.width - size.width) / 2) as i32),
            fallback.position.y,
        ),
        size,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use tauri::{
        plugin::Plugin,
        test::{mock_builder, mock_context, noop_assets, MockRuntime},
        Manager,
    };
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};

    fn rect(x: i32, y: i32, width: u32, height: u32) -> tauri::PhysicalRect<i32, u32> {
        tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(x, y),
            size: tauri::PhysicalSize::new(width, height),
        }
    }

    fn assert_frame(
        actual: Option<tauri::PhysicalRect<i32, u32>>,
        expected: Option<tauri::PhysicalRect<i32, u32>>,
    ) {
        assert_eq!(
            actual.map(|r| (r.position, r.size)),
            expected.map(|r| (r.position, r.size))
        );
    }

    // Mirrors the main window in tauri.conf.json.
    fn config() -> tauri::utils::config::WindowConfig {
        tauri::utils::config::WindowConfig {
            width: 1200.0,
            height: 800.0,
            min_width: Some(480.0),
            min_height: Some(400.0),
            ..Default::default()
        }
    }

    #[test]
    fn saved_size_is_kept_with_monitors_attached_and_recovered_on_a_lone_monitor() {
        let external = rect(1512, 0, 1920, 1080);
        let laptop = rect(0, 50, 3024, 1840);
        let saved = decode(&saved_state(1600, 100, 602, 470));
        let offset = tauri::PhysicalPosition::new(0, 0);
        let request = |areas: &[tauri::PhysicalRect<i32, u32>]| {
            super::restore_request(&saved, offset, 96, areas, (laptop, 2.0), &config())
        };
        // The 1x external overlaps the 2x laptop's physical rect, so the scale
        // this rect was saved at is ambiguous. Keep it as saved.
        assert_eq!(
            request(&[laptop, external]),
            (
                tauri::PhysicalPosition::new(1600, 100),
                tauri::PhysicalSize::new(602, 470),
                None
            ),
        );
        // Unplugged: the laptop's physical rect still contains the saved rect,
        // but 301x235 points is below the minimum at its known scale. Send the
        // default in the laptop's logical units.
        assert_eq!(
            request(&[laptop]),
            (
                tauri::PhysicalPosition::new(312, 50),
                tauri::PhysicalSize::new(2400, 1600),
                Some(2.0)
            ),
        );
    }

    #[test]
    fn fallback_uses_default_size_when_saved_size_is_below_minimum_at_its_scale() {
        let laptop = rect(0, 50, 3024, 1840);
        let left = rect(-3024, 0, 3024, 1964);
        let fallback = |width, height, area| {
            let saved = decode(&saved_state(5530, 100, width, height));
            let offset = tauri::PhysicalPosition::new(0, 0);
            let (position, size, scale) =
                super::restore_request(&saved, offset, 96, &[area, left], (area, 2.0), &config());
            assert_eq!(scale, Some(2.0));
            Some(tauri::PhysicalRect { position, size })
        };
        // Saved on a 1x monitor that is gone: 301x235 points on a 2x laptop.
        assert_frame(fallback(602, 470, laptop), Some(rect(312, 50, 2400, 1600)));
        // One axis below the minimum is enough (781 is under the Windows client too).
        assert_frame(fallback(960, 781, laptop), Some(rect(312, 50, 2400, 1600)));
        // At or above the minimum at the fallback's scale, the saved size stays.
        assert_frame(fallback(960, 800, laptop), Some(rect(1032, 50, 960, 800)));
        // The default still fits inside a small fallback work area.
        let small = rect(0, 25, 1440, 875);
        assert_frame(fallback(602, 470, small), Some(small));
    }

    #[test]
    fn minimum_allows_windows_shadow_insets_but_a_lower_scale_size_is_replaced() {
        let area = rect(0, 0, 3840, 2160);
        let offset = tauri::PhysicalPosition::new(0, 0);
        let relocated = |scale, width, height| {
            let saved = decode(&saved_state(100, 100, width, height));
            super::restore_request(&saved, offset, 96, &[area], (area, scale), &config())
                .2
                .is_some()
        };
        // tao applies the 480x400 minimum to an undecorated Windows frame. The
        // shadow insets (size frame plus padded border on the sides and bottom,
        // one scaled pixel on top on Windows 11) come off the saved client.
        for (scale, width, height) in [(1.0, 464, 391), (1.25, 580, 489), (2.0, 928, 782)] {
            assert_eq!(relocated(scale, width, height), !cfg!(windows));
        }
        // One pixel under that client is replaced everywhere.
        assert!(relocated(1.0, 463, 391));
        assert!(relocated(1.0, 464, 390));
        assert!(relocated(2.0, 927, 782));
        // Neither tao on Windows nor macOS clamps a programmatic resize, so a 1x
        // save of 900x750 would open at 450x375 points on a 2x laptop.
        assert!(relocated(2.0, 900, 750));
        // At 110 DPI the minimum rounds to 550x458, and the Windows client to 530x447.
        let scale = 110.0 / 96.0;
        assert!(!relocated(scale, 550, 458));
        assert_eq!(relocated(scale, 550, 457), !cfg!(windows));
        assert_eq!(relocated(scale, 530, 447), !cfg!(windows));
        assert!(relocated(scale, 529, 447));
        // At 100 DPI the height rounds up (416.67 to 417; 408 on Windows).
        let scale = 100.0 / 96.0;
        assert_eq!(relocated(scale, 500, 416), !cfg!(windows));
        assert!(relocated(scale, 484, 407));
        // A client saved at the minimum one scale step lower is replaced
        // everywhere, including across the smallest step, 225% to 250%.
        assert!(relocated(1.25, 464, 391));
        assert!(relocated(2.5, 1044, 880));
        assert!(relocated(2.5, 1080, 900));
        assert!(!relocated(2.0, 960, 800));
    }

    #[test]
    fn partial_overlap_after_removing_upper_monitor_recovers_entire_header() {
        let laptop = rect(0, 25, 1440, 875);
        let saved = rect(100, -450, 960, 640);
        assert_frame(
            super::reachable_client(saved, 48, &[laptop], laptop, None),
            Some(rect(240, 25, 960, 640)),
        );
        let upper = rect(0, -900, 1440, 900);
        assert_frame(
            super::reachable_client(saved, 48, &[laptop, upper], laptop, None),
            None,
        );
    }

    #[test]
    fn reachable_geometry_is_unchanged_including_negative_coordinates() {
        let primary = rect(0, 25, 1440, 875);
        let left = rect(-1920, 0, 1920, 1080);
        for saved in [rect(100, 120, 960, 640), rect(-1800, 80, 960, 640)] {
            assert_frame(
                super::reachable_client(saved, 48, &[primary, left], primary, None),
                None,
            );
        }
    }

    #[test]
    fn side_overlap_and_menu_bar_occlusion_recover_controls_not_just_a_corner() {
        let area = rect(0, 25, 1440, 875);
        for saved in [
            rect(-600, 100, 960, 640),
            rect(1300, 100, 960, 640),
            rect(100, 0, 960, 640),
            rect(100, 860, 960, 640),
        ] {
            assert_frame(
                super::reachable_client(saved, 48, &[area], area, None),
                Some(rect(240, 25, 960, 640)),
            );
        }
    }

    #[test]
    fn oversized_window_fits_remaining_work_area_and_scaled_header_is_checked() {
        let area = rect(0, 50, 1440, 850);
        assert_frame(
            super::reachable_client(rect(0, 50, 2800, 1800), 96, &[area], area, None),
            Some(area),
        );
        assert_frame(
            super::reachable_client(rect(100, 820, 960, 640), 48, &[area], area, None),
            None,
        );
        assert_frame(
            super::reachable_client(rect(100, 820, 960, 640), 96, &[area], area, None),
            Some(rect(240, 50, 960, 640)),
        );
    }

    #[test]
    fn invisible_windows_frame_border_does_not_displace_edge_flush_client() {
        let area = rect(0, 0, 1920, 1040);
        let saved = decode(&saved_state(-7, 0, 1920, 1040));
        assert_eq!(
            super::restore_request(
                &saved,
                tauri::PhysicalPosition::new(7, 0),
                48,
                &[area],
                (area, 1.0),
                &config()
            ),
            (tauri::PhysicalPosition::new(-7, 0), area.size, None),
        );
    }

    #[test]
    fn header_can_span_adjacent_monitors_but_not_extend_above_either() {
        let left = rect(-1920, 0, 1920, 1080);
        let right = rect(0, 0, 1920, 1080);
        let spanning = rect(-480, 100, 960, 640);
        assert_frame(
            super::reachable_client(spanning, 48, &[left, right], right, None),
            None,
        );
        let below = rect(0, 300, 1920, 1080);
        assert_frame(
            super::reachable_client(spanning, 48, &[left, below], left, None),
            Some(rect(-1440, 0, 960, 640)),
        );
    }

    fn saved_state(x: i32, y: i32, width: u32, height: u32) -> Value {
        json!({"main": {
            "width": width, "height": height, "x": x, "y": y,
            "prev_x": x, "prev_y": y, "maximized": false,
            "fullscreen": false, "visible": false, "decorated": false
        }})
    }

    fn decode(state: &Value) -> super::SavedGeometry {
        super::saved_geometry(&serde_json::to_vec(state).unwrap(), "main").unwrap()
    }

    #[test]
    fn requested_geometry_is_safe_even_while_getters_still_report_startup_bounds() {
        let area = rect(0, 25, 1440, 875);
        let startup = rect(100, 120, 1200, 800);
        let completed = rect(100, -450, 960, 640);
        let saved = decode(&saved_state(100, -450, 960, 640));
        // The old post-set guard approves this stale, reachable startup frame.
        assert_frame(
            super::reachable_client(startup, 48, &[area], area, None),
            None,
        );
        // The planner accepts no current bounds: they can be either startup or
        // completed bounds. Only the frame-to-client offset (zero for this
        // undecorated window) is used. The unsafe origin is never sent to GTK.
        let expected = (
            tauri::PhysicalPosition::new(240, 25),
            tauri::PhysicalSize::new(960, 640),
            Some(1.0),
        );
        assert_frame(
            super::reachable_client(completed, 48, &[area], area, None),
            Some(rect(240, 25, 960, 640)),
        );
        let offset = tauri::PhysicalPosition::new(0, 0);
        assert_eq!(
            super::restore_request(&saved, offset, 48, &[area], (area, 1.0), &config()),
            expected
        );
        // Resize is asynchronous too: validating only startup width misses
        // the right-hand controls of a wider saved client.
        let saved = decode(&saved_state(100, 120, 1800, 800));
        assert_eq!(
            super::restore_request(&saved, offset, 48, &[area], (area, 1.0), &config()),
            (
                area.position,
                tauri::PhysicalSize::new(1440, 800),
                Some(1.0)
            ),
        );
    }

    #[test]
    fn requested_geometry_uses_client_size_and_normal_origin_for_saved_modes() {
        let area = rect(0, 0, 1920, 1040);
        let offset = tauri::PhysicalPosition::new(7, 0);
        let saved = decode(&saved_state(-7, 0, 1920, 1000));
        assert_eq!(
            super::restore_request(&saved, offset, 48, &[area], (area, 1.0), &config()),
            (
                tauri::PhysicalPosition::new(-7, 0),
                tauri::PhysicalSize::new(1920, 1000),
                None
            ),
        );
        let mut state = saved_state(0, 0, 960, 640);
        state["main"]["maximized"] = json!(true);
        state["main"]["prev_x"] = json!(100);
        state["main"]["prev_y"] = json!(-450);
        assert_eq!(
            super::restore_request(&decode(&state), offset, 48, &[area], (area, 1.0), &config()),
            (
                tauri::PhysicalPosition::new(473, 0),
                tauri::PhysicalSize::new(960, 640),
                Some(1.0)
            ),
        );
        // Fullscreen uses x/y, not prev_x/prev_y, matching the plugin format.
        state["main"]["maximized"] = json!(false);
        state["main"]["fullscreen"] = json!(true);
        assert_eq!(
            super::restore_request(&decode(&state), offset, 48, &[area], (area, 1.0), &config()),
            (
                tauri::PhysicalPosition::new(0, 0),
                tauri::PhysicalSize::new(960, 640),
                None
            ),
        );
    }

    #[test]
    fn saved_geometry_matches_plugin_schema_and_rejects_invalid_snapshots() {
        let valid = saved_state(100, 120, 960, 640);
        let mut missing_mode = valid.clone();
        missing_mode["main"]
            .as_object_mut()
            .unwrap()
            .remove("fullscreen");
        let mut invalid_other_window = valid.clone();
        invalid_other_window["other"] = json!({"width": 960});
        let mut wrong_type = valid.clone();
        wrong_type["main"]["maximized"] = json!("false");
        for state in [
            json!({}),
            json!(null),
            missing_mode,
            invalid_other_window,
            wrong_type,
            saved_state(0, 0, 0, 0),
        ] {
            assert!(super::saved_geometry(&serde_json::to_vec(&state).unwrap(), "main").is_none());
        }
        assert!(super::saved_geometry(b"not json", "main").is_none());
        assert!(super::saved_geometry(&serde_json::to_vec(&valid).unwrap(), "other").is_none());
        assert!(super::saved_geometry(&serde_json::to_vec(&valid).unwrap(), "main").is_some());
    }

    fn fixture() -> (tempfile::TempDir, tauri::App<MockRuntime>) {
        let dir = tempfile::tempdir().unwrap();
        let mut context = mock_context(noop_assets());
        // Absolute identifiers keep the plugin's real config-file IO inside the
        // fixture without changing process-global HOME or touching user state.
        context.config_mut().identifier = dir.path().to_string_lossy().into_owned();
        let app = mock_builder().build(context).unwrap();
        assert_eq!(app.path().app_config_dir().unwrap(), dir.path());
        (dir, app)
    }

    #[test]
    fn onboarding_snapshot_is_kept_until_next_launch_restore() {
        let (dir, app) = fixture();
        let mut plugin = super::builder().build();
        plugin.initialize(app.handle(), Value::Null).unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let window = webview.as_ref().window();
        plugin.window_created(window.clone());
        let path = dir.path().join(super::INTRO_GEOMETRY);
        let bytes = serde_json::to_vec(&saved_state(100, 120, 960, 640)).unwrap();
        super::preserve_intro_geometry(&path, &bytes).unwrap();
        let original = std::fs::read(&path).unwrap();
        super::onboarding_preserve_window(webview).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);
        super::restore(&window).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn exit_saves_only_the_main_window() {
        let (dir, app) = fixture();
        let mut plugin = super::builder().build();
        plugin.initialize(app.handle(), Value::Null).unwrap();
        for label in ["main", "other"] {
            let window = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
                .build()
                .unwrap()
                .as_ref()
                .window();
            plugin.window_created(window.clone());
            if label == "main" {
                super::restore(&window).unwrap();
            }
        }
        plugin.on_event(app.handle(), &tauri::RunEvent::Exit);
        let state: Value = serde_json::from_slice(
            &std::fs::read(dir.path().join(tauri_plugin_window_state::DEFAULT_FILENAME)).unwrap(),
        )
        .unwrap();
        assert_eq!(state.as_object().unwrap().len(), 1);
        assert!(state.get("main").is_some());
    }

    #[test]
    fn reload_keeps_geometry_without_restoring_visibility_or_decorations() {
        let (dir, app) = fixture();
        let path = dir.path().join(tauri_plugin_window_state::DEFAULT_FILENAME);
        let saved = json!({"main": {
            "width": 960, "height": 640, "x": 100, "y": 120,
            "prev_x": 100, "prev_y": 120, "maximized": true,
            "fullscreen": true, "visible": false, "decorated": false
        }});
        std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
        let mut plugin = super::builder().build();
        plugin.initialize(app.handle(), Value::Null).unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        plugin.window_created(view.as_ref().window().clone());
        super::restore(&view.as_ref().window()).unwrap();
        app.handle().save_window_state(StateFlags::empty()).unwrap();
        let loaded: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(loaded, saved);

        // MockRuntime reports false modes, true visibility/decorations, zero
        // size/position. Exit must update modes/position, keep the last nonzero
        // size, and leave visibility/decorations alone. Native restore itself
        // needs OS acceptance: MockRuntime's geometry setters are no-ops.
        plugin.on_event(app.handle(), &tauri::RunEvent::Exit);
        let stored: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored["main"]["width"], 960);
        assert_eq!(stored["main"]["height"], 640);
        assert_eq!(stored["main"]["x"], 0);
        assert_eq!(stored["main"]["y"], 0);
        assert_eq!(stored["main"]["maximized"], false);
        assert_eq!(stored["main"]["fullscreen"], false);
        assert_eq!(stored["main"]["visible"], false);
        assert_eq!(stored["main"]["decorated"], false);
        // Parse an actual plugin-produced snapshot, not just our handwritten fixture.
        let geometry = super::saved_geometry(&std::fs::read(&path).unwrap(), "main").unwrap();
        assert_eq!(
            (geometry.width, geometry.height, geometry.x, geometry.y),
            (960, 640, 0, 0)
        );
    }

    #[test]
    fn missing_or_corrupt_state_does_not_block_window_creation() {
        for contents in [None, Some("not json")] {
            let (dir, app) = fixture();
            let path = dir.path().join(tauri_plugin_window_state::DEFAULT_FILENAME);
            if let Some(contents) = contents {
                std::fs::write(&path, contents).unwrap();
            }
            let mut plugin = super::builder().build();
            plugin.initialize(app.handle(), Value::Null).unwrap();
            let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap()
                .as_ref()
                .window();
            plugin.window_created(window.clone());
            super::restore(&window).unwrap();
            plugin.on_event(app.handle(), &tauri::RunEvent::Exit);
            let state: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert!(state.get("main").is_some());
        }
    }
}
