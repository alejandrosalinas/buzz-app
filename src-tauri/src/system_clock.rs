/// The system's 12- or 24-hour time setting as an `Intl` hour cycle. The
/// webview's locale ignores it, so en-US with 24-hour time still formats
/// "2:05 PM".
#[tauri::command]
pub fn system_hour_cycle() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{ns_string, NSDateFormatter, NSLocale};

        let pattern = NSDateFormatter::dateFormatFromTemplate_options_locale(
            ns_string!("j"),
            0,
            Some(&NSLocale::autoupdatingCurrentLocale()),
        )?;
        hour_cycle(&pattern.to_string())
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Globalization::{GetLocaleInfoEx, LOCALE_SSHORTTIME};

        // A null name is LOCALE_NAME_USER_DEFAULT, which keeps the user's overrides.
        // The first call returns the size, including the terminator.
        let read = |buffer: &mut [u16]| unsafe {
            GetLocaleInfoEx(
                std::ptr::null(),
                LOCALE_SSHORTTIME,
                buffer.as_mut_ptr(),
                i32::try_from(buffer.len()).unwrap_or(0),
            )
        };
        let mut pattern = vec![0u16; usize::try_from(read(&mut [])).ok()?];
        let length = usize::try_from(read(&mut pattern)).ok()?.checked_sub(1)?;
        hour_cycle(&String::from_utf16_lossy(pattern.get(..length)?))
    }
    #[cfg(target_os = "linux")]
    {
        gnome_hour_cycle().or_else(locale_hour_cycle)
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        None
    }
}

/// GNOME keeps its 12/24-hour switch apart from the region. Other desktops
/// may install the schema without using it, so only a GNOME session reads it.
#[cfg(target_os = "linux")]
fn gnome_hour_cycle() -> Option<&'static str> {
    use gtk::gio::{prelude::SettingsExt as _, Settings, SettingsBackend, SettingsSchemaSource};

    let desktop = std::env::var("XDG_CURRENT_DESKTOP").ok()?;
    if !desktop
        .split(':')
        .any(|name| name.eq_ignore_ascii_case("GNOME"))
    {
        return None;
    }
    // Settings::new aborts on a missing schema, so look it up first.
    let schema = SettingsSchemaSource::default()?.lookup("org.gnome.desktop.interface", true)?;
    if !schema.has_key("clock-format") {
        return None;
    }
    match Settings::new_full(&schema, None::<&SettingsBackend>, None)
        .string("clock-format")
        .as_str()
    {
        "12h" => Some("h12"),
        "24h" => Some("h23"),
        _ => None,
    }
}

/// The LC_TIME time format, which the webview ignores in favour of LC_CTYPE.
#[cfg(target_os = "linux")]
fn locale_hour_cycle() -> Option<&'static str> {
    // A private locale object reads the environment without changing the
    // process-wide locale.
    unsafe {
        let locale = libc::newlocale(libc::LC_TIME_MASK, c"".as_ptr(), std::ptr::null_mut());
        if locale.is_null() {
            return None;
        }
        let format = std::ffi::CStr::from_ptr(libc::nl_langinfo_l(libc::T_FMT, locale))
            .to_string_lossy()
            .into_owned();
        libc::freelocale(locale);
        posix_hour_cycle(&format)
    }
}

/// Reads the hour conversion of a strftime format such as "%r" or "%H:%M:%S".
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn posix_hour_cycle(format: &str) -> Option<&'static str> {
    let mut chars = format.chars();
    while let Some(symbol) = chars.next() {
        if symbol != '%' {
            continue;
        }
        // Skip glibc flags, field widths and the E and O modifiers.
        let conversion =
            chars.find(|c| !matches!(c, '-' | '_' | '0'..='9' | '^' | '#' | 'E' | 'O'));
        match conversion {
            Some('I' | 'l' | 'r') => return Some("h12"),
            Some('H' | 'k' | 'R' | 'T') => return Some("h23"),
            _ => {}
        }
    }
    None
}

/// Reads the hour symbol of a date pattern, skipping quoted literals.
#[cfg_attr(not(any(target_os = "macos", windows, test)), allow(dead_code))]
fn hour_cycle(pattern: &str) -> Option<&'static str> {
    let mut quoted = false;
    for symbol in pattern.chars() {
        match symbol {
            '\'' => quoted = !quoted,
            'h' | 'K' if !quoted => return Some("h12"),
            'H' | 'k' if !quoted => return Some("h23"),
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{hour_cycle, posix_hour_cycle};

    #[test]
    fn reads_the_unquoted_hour_symbol() {
        assert_eq!(hour_cycle("h a"), Some("h12"));
        assert_eq!(hour_cycle("HH"), Some("h23"));
        assert_eq!(hour_cycle("'h'H"), Some("h23"));
        assert_eq!(hour_cycle("h:mm tt"), Some("h12"));
        assert_eq!(hour_cycle("a"), None);
    }

    #[test]
    fn reads_the_strftime_hour_conversion() {
        assert_eq!(posix_hour_cycle("%r"), Some("h12"));
        assert_eq!(posix_hour_cycle("%-l:%M %p"), Some("h12"));
        assert_eq!(posix_hour_cycle("%T"), Some("h23"));
        assert_eq!(posix_hour_cycle("%%H %OH:%M"), Some("h23"));
        assert_eq!(posix_hour_cycle("%%I"), None);
    }
}
