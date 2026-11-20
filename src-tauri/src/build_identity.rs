#[allow(dead_code)] // This shared module also contains build-script-only functions.
#[path = "../../crates/build_identity.rs"]
mod source;

#[tauri::command]
pub(crate) fn get_build_identity() -> source::BuildIdentity {
    source::compiled(
        option_env!("BUZZ_NATIVE_SOURCE_REVISION"),
        option_env!("BUZZ_NATIVE_SOURCE_STATE"),
    )
}
