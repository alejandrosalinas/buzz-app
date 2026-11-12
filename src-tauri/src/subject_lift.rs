//! Lifts the subject out of a photo, as Photos and Messages do for stickers.
//!
//! On macOS 14 and later, Vision's foreground instance mask finds every
//! subject, keeps them over a transparent background and crops to them. Buzz
//! then scales the result down to at most [`LIFT_SIZE`] and returns a PNG. Elsewhere,
//! and on older macOS, lifting is unavailable and the caller keeps the whole
//! image.

/// The longest side of a lifted subject, in pixels: sharp at reaction and
/// message sizes on Retina displays, and small enough to upload quickly.
const LIFT_SIZE: u32 = 512;
/// The largest source the host fetches to lift.
pub(crate) const MAX_SOURCE_BYTES: usize = 50 * 1024 * 1024;
/// The most source pixels Vision decodes, as attachment preparation allows.
const MAX_SOURCE_PIXELS: u64 = 25_000_000;

/// Whether this host can lift subjects; checked before fetching any media.
pub(crate) fn supported() -> Result<(), String> {
    platform::supported()
}

/// Whether this host can lift subjects, so plugins offer it only where it works.
#[tauri::command]
pub(crate) fn media_lift_subject_supported() -> bool {
    supported().is_ok()
}

/// Returns a transparent PNG of the image's subjects, cropped to them and at
/// most [`LIFT_SIZE`] on its longer side. Only GIF, JPEG, PNG and WebP
/// within [`MAX_SOURCE_PIXELS`] reach the system decoder: message images come
/// from other members, so their bytes and declared type are untrusted.
pub(crate) fn lift_subject(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err("Image too large to lift a subject".into());
    }
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "Could not read this image")?;
    if !matches!(
        reader.format(),
        Some(
            image::ImageFormat::Gif
                | image::ImageFormat::Jpeg
                | image::ImageFormat::Png
                | image::ImageFormat::WebP
        )
    ) {
        return Err("Choose a GIF, JPEG, PNG, or WebP image".into());
    }
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| "Could not read this image")?;
    if u64::from(width) * u64::from(height) > MAX_SOURCE_PIXELS {
        return Err("Image too large to lift a subject".into());
    }
    let lifted = platform::lift(bytes)?;
    fit(&lifted)
}

/// Scales a lifted PNG down to [`LIFT_SIZE`], keeping its aspect ratio.
fn fit(png: &[u8]) -> Result<Vec<u8>, String> {
    let image = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .map_err(|_| "Could not read the lifted subject")?;
    let image = if image.width().max(image.height()) > LIFT_SIZE {
        image.resize(LIFT_SIZE, LIFT_SIZE, image::imageops::FilterType::Lanczos3)
    } else {
        image
    };
    let mut out = std::io::Cursor::new(Vec::new());
    image
        .to_rgba8()
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|_| "Could not encode the image")?;
    Ok(out.into_inner())
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2::{rc::autoreleasepool, AnyThread as _};
    use objc2_core_graphics::{kCGColorSpaceSRGB, CGColorSpace};
    use objc2_core_image::{kCIFormatRGBA8, CIContext, CIImage};
    use objc2_foundation::{NSArray, NSData, NSDictionary};
    use objc2_vision::{VNGenerateForegroundInstanceMaskRequest, VNImageRequestHandler, VNRequest};

    const NO_SUBJECT: &str = "No subject found in this image";

    pub(super) fn supported() -> Result<(), String> {
        if !objc2_foundation::NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(
            objc2_foundation::NSOperatingSystemVersion {
                majorVersion: 14,
                minorVersion: 0,
                patchVersion: 0,
            },
        ) {
            return Err("Lifting a subject needs macOS 14 or later".into());
        }
        Ok(())
    }

    pub(super) fn lift(bytes: &[u8]) -> Result<Vec<u8>, String> {
        supported()?;
        autoreleasepool(|_| {
            let data = NSData::with_bytes(bytes);
            let handler = VNImageRequestHandler::initWithData_options(
                VNImageRequestHandler::alloc(),
                &data,
                &NSDictionary::new(),
            );
            // SAFETY: a plain allocation and init of a Vision request.
            let request = unsafe { VNGenerateForegroundInstanceMaskRequest::new() };
            let base: &VNRequest = &request;
            handler
                .performRequests_error(&NSArray::from_slice(&[base]))
                .map_err(|_| "Could not analyze this image")?;
            // SAFETY: read after the request finished on this thread.
            let observation = unsafe { request.results() }
                .and_then(|results| results.firstObject())
                .ok_or(NO_SUBJECT)?;
            // SAFETY: the observation came from this handler's request.
            let instances = unsafe { observation.allInstances() };
            if instances.count() == 0 {
                return Err(NO_SUBJECT.into());
            }
            // SAFETY: as above; Vision returns a new, retained pixel buffer.
            let buffer = unsafe {
                observation
                    .generateMaskedImageOfInstances_fromRequestHandler_croppedToInstancesExtent_error(
                        &instances, &handler, true,
                    )
            }
            .map_err(|_| "Could not lift the subject")?;
            // SAFETY: Core Image retains the buffer for the image's lifetime.
            let image = unsafe { CIImage::imageWithCVPixelBuffer(&buffer) };
            // SAFETY: a constant Core Graphics provides.
            let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))
                .ok_or("Could not encode the image")?;
            // SAFETY: an empty options dictionary; RGBA8 is a valid PNG format.
            let png = unsafe {
                CIContext::new().PNGRepresentationOfImage_format_colorSpace_options(
                    &image,
                    kCIFormatRGBA8,
                    &space,
                    &NSDictionary::new(),
                )
            }
            .ok_or("Could not encode the image")?;
            Ok(png.to_vec())
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub(super) fn supported() -> Result<(), String> {
        Err("Lifting a subject is available on macOS".into())
    }

    pub(super) fn lift(_bytes: &[u8]) -> Result<Vec<u8>, String> {
        supported().map(|()| Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(width, height, image::Rgba([10, 20, 30, 128]))
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    fn crc32(bytes: &[u8]) -> u32 {
        !bytes.iter().fold(!0u32, |crc, byte| {
            (0..8).fold(crc ^ u32::from(*byte), |crc, _| {
                (crc >> 1) ^ (0xEDB8_8320 & (crc & 1).wrapping_neg())
            })
        })
    }

    fn size(png: &[u8]) -> (u32, u32) {
        let image = image::load_from_memory(png).unwrap();
        (image.width(), image.height())
    }

    #[test]
    fn fit_scales_the_longer_side_to_lift_size() {
        assert_eq!(size(&fit(&png(2048, 1024)).unwrap()), (512, 256));
        assert_eq!(size(&fit(&png(300, 1200)).unwrap()), (128, 512));
    }

    #[test]
    fn fit_keeps_small_subjects_and_their_transparency() {
        let fitted = fit(&png(40, 30)).unwrap();
        let image = image::load_from_memory(&fitted).unwrap().to_rgba8();
        assert_eq!(image.dimensions(), (40, 30));
        assert_eq!(image.get_pixel(0, 0).0, [10, 20, 30, 128]);
    }

    #[test]
    fn lift_subject_refuses_unlisted_formats_and_huge_images_before_vision() {
        let tiff = b"II*\0\x08\0\0\0\0\0\0\0\0\0\0\0";
        assert_eq!(
            lift_subject(tiff).unwrap_err(),
            "Choose a GIF, JPEG, PNG, or WebP image"
        );
        // A tiny file declaring a 6000×5000 canvas: dimensions come from the header.
        let mut header = png(1, 1);
        header[16..24].copy_from_slice(&[0, 0, 0x17, 0x70, 0, 0, 0x13, 0x88]);
        let crc = crc32(&header[12..29]).to_be_bytes();
        header[29..33].copy_from_slice(&crc);
        assert_eq!(
            lift_subject(&header).unwrap_err(),
            "Image too large to lift a subject"
        );
    }

    #[test]
    fn lift_subject_refuses_oversized_sources_before_decoding() {
        let error = lift_subject(&vec![0; MAX_SOURCE_BYTES + 1]).unwrap_err();
        assert_eq!(error, "Image too large to lift a subject");
    }
}
