//! Styled QR codes for pairing and community invites.
//! Visual geometry matches the original Buzz StyledQrCode component.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use qrcode::{Color, EcLevel, QrCode};
use serde::Deserialize;
use std::fmt::Write;

/// Longest value `qr_code` renders; matches the invite link parser's bound.
const MAX_VALUE_LEN: usize = 4096;

/// Light: dark dots on white, as pairing shows. Dark: light dots on black.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Variant {
    Light,
    Dark,
}

/// Renders a shareable, non-secret value such as a community invite link.
#[tauri::command]
pub fn qr_code(value: String, variant: Variant) -> Result<String, String> {
    if value.is_empty() || value.len() > MAX_VALUE_LEN {
        return Err("Couldn’t create the QR code.".into());
    }
    render(&value, variant).map_err(|()| "Couldn’t create the QR code.".into())
}

pub(crate) fn render(value: &str, variant: Variant) -> Result<String, ()> {
    let (bg, fg) = match variant {
        Variant::Light => ("white", "black"),
        Variant::Dark => ("black", "white"),
    };
    // Match the original component’s correction level and bounded logo area.
    let code = QrCode::with_error_correction_level(value.as_bytes(), EcLevel::M).map_err(|_| ())?;
    let size = code.width();
    let mut center = ((size * size) as f64 * 0.1).sqrt().floor() as usize;
    if center.is_multiple_of(2) {
        center -= 1;
    }
    let start = (size - center) / 2;
    let end = start + center;
    let icon_size = center as f64 * 0.8;
    let icon_start = (size as f64 - icon_size) / 2.0;
    let extent = size + 8;
    let mut svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="-4 -4 {extent} {extent}"><rect x="-4" y="-4" width="{extent}" height="{extent}" fill="{bg}"/><g fill="{fg}">"#
    );
    svg.push_str("<style>");
    svg.push_str(include_str!("qr-reveal.css"));
    svg.push_str("</style>");
    for row in 0..size {
        // Original 250ms reveal: row travel plus a 58ms dot animation.
        let delay = (row as f64 / size as f64 * (250.0 / 1.3)).round() as u32;
        for col in 0..size {
            let finder = (row < 7 && (col < 7 || col >= size - 7)) || (row >= size - 7 && col < 7);
            let logo = (start..end).contains(&row) && (start..end).contains(&col);
            if code[(col, row)] == Color::Dark && !finder && !logo {
                write!(svg, r#"<circle class="buzz-qr-cell-reveal" style="--buzz-qr-reveal-delay:{delay}ms" cx="{}.5" cy="{}.5" r="0.4"/>"#, col, row).unwrap();
            }
        }
    }
    svg.push_str("</g>");
    for (x, y) in [(0, 0), (size - 7, 0), (0, size - 7)] {
        write!(svg, r#"<rect x="{x}" y="{y}" width="7" height="7" rx="2" fill="{fg}"/><rect x="{}" y="{}" width="5" height="5" rx="0.8" fill="{bg}"/><rect x="{}" y="{}" width="3" height="3" rx="0.4" fill="{fg}"/>"#, x + 1, y + 1, x + 2, y + 2).unwrap();
    }
    // The icon is a black tile; on the dark variant it sits flush with the background.
    let icon = STANDARD.encode(include_bytes!("../../public/app-icon.png"));
    write!(svg, r##"<defs><clipPath id="logo"><rect x="{icon_start}" y="{icon_start}" width="{icon_size}" height="{icon_size}" rx="2"/></clipPath></defs><rect x="{icon_start}" y="{icon_start}" width="{icon_size}" height="{icon_size}" rx="2" fill="black"/><image href="data:image/png;base64,{icon}" x="{icon_start}" y="{icon_start}" width="{icon_size}" height="{icon_size}" clip-path="url(#logo)"/></svg>"##).unwrap();
    Ok(svg)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn styled_code_keeps_quiet_zone_and_embeds_the_logo() {
        let svg = render("pairing-test", Variant::Light).unwrap();
        assert!(svg.contains("viewBox=\"-4 -4 "));
        assert!(svg.contains(r#"fill="white"/><g fill="black">"#));
        assert!(svg.contains("<circle"));
        assert!(svg.contains("--buzz-qr-reveal-delay:0ms"));
        assert!(svg.contains("prefers-reduced-motion: reduce"));
        assert_eq!(svg.matches("width=\"7\" height=\"7\"").count(), 3);
        assert!(svg.contains("data:image/png;base64,"));
        assert!(!svg.contains("href=\"http"));
    }
    #[test]
    fn dark_variant_inverts_dots_and_finders_only() {
        let light = render("invite-test", Variant::Light).unwrap();
        let dark = render("invite-test", Variant::Dark).unwrap();
        // Same quiet zone, dots and logo; light dots and finders on black.
        assert!(dark.contains("viewBox=\"-4 -4 "));
        assert!(dark.contains(r#"fill="black"/><g fill="white">"#));
        assert_eq!(
            dark.matches(r#"width="7" height="7" rx="2" fill="white"/>"#)
                .count(),
            3
        );
        assert_eq!(
            dark.matches(r#"width="5" height="5" rx="0.8" fill="black"/>"#)
                .count(),
            3
        );
        assert_eq!(
            dark.matches(r#"width="3" height="3" rx="0.4" fill="white"/>"#)
                .count(),
            3
        );
        assert_eq!(
            dark.matches("<circle").count(),
            light.matches("<circle").count()
        );
        assert!(dark.contains("data:image/png;base64,"));
    }
    #[test]
    fn command_renders_bounded_values_only() {
        assert!(
            qr_code("https://example.org/invite/abc".into(), Variant::Dark)
                .unwrap()
                .starts_with("<svg")
        );
        assert!(qr_code(String::new(), Variant::Dark).is_err());
        assert!(qr_code("a".repeat(MAX_VALUE_LEN + 1), Variant::Dark).is_err());
    }
    #[test]
    fn command_variant_is_light_or_dark() {
        let parse = |value| serde_json::from_value::<Variant>(serde_json::json!(value));
        assert_eq!(parse("light").unwrap(), Variant::Light);
        assert_eq!(parse("dark").unwrap(), Variant::Dark);
        assert!(parse("Dark").is_err());
    }
}
