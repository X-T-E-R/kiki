//! Taskbar overlay for the active space: a round, anti-aliased dot in the
//! space's colour, ringed so it separates from any taskbar ground, and — when
//! something waits on the user — a round count badge in the top-right corner.
//!
//! Drawn at 32×32 (Windows scales the overlay to the small-icon size, and at
//! 150 % / 200 % DPI it shows at 24 / 32 px, where a 16 px source goes soft).
//! Shapes are 4×4 supersampled for coverage; the digits are a 5×7 pixel font
//! placed on whole pixels so they stay crisp instead of being smoothed away.

/// Token A ink-blue (`--color-selected-ink`): the dot for a space without a colour.
pub const DEFAULT_SPACE_RGB: [u8; 3] = [0x1d, 0x4d, 0x6d];
/// Token A attention vermilion (`--color-attention`): the "needs you" badge.
const BADGE_RGB: [u8; 3] = [0xb3, 0x3a, 0x12];
const RING_RGB: [u8; 3] = [0xff, 0xff, 0xff];
const SIZE: usize = 32;
const SAMPLES: usize = 4;

/// Parse `#rrggbb`; anything else falls back to the default ink-blue.
pub fn space_rgb(color: Option<&str>) -> [u8; 3] {
    color
        .and_then(|value| value.strip_prefix('#'))
        .filter(|value| value.len() == 6)
        .and_then(|value| u32::from_str_radix(value, 16).ok())
        .map(|value| [(value >> 16) as u8, (value >> 8) as u8, value as u8])
        .unwrap_or(DEFAULT_SPACE_RGB)
}

/// A filled circle in pixel coordinates (centre, radius).
#[derive(Clone, Copy)]
struct Circle {
    cx: f32,
    cy: f32,
    r: f32,
}

impl Circle {
    /// Fraction of the pixel at (x, y) the circle covers, by supersampling.
    fn coverage(self, x: usize, y: usize) -> f32 {
        let mut hits = 0;
        for sy in 0..SAMPLES {
            for sx in 0..SAMPLES {
                let px = x as f32 + (sx as f32 + 0.5) / SAMPLES as f32 - self.cx;
                let py = y as f32 + (sy as f32 + 0.5) / SAMPLES as f32 - self.cy;
                if px * px + py * py <= self.r * self.r {
                    hits += 1;
                }
            }
        }
        hits as f32 / (SAMPLES * SAMPLES) as f32
    }
}

/// Source-over a colour at `alpha` onto a premultiplied-free RGBA pixel.
fn blend(pixel: &mut [u8], rgb: [u8; 3], alpha: f32) {
    if alpha <= 0.0 {
        return;
    }
    let dst_a = pixel[3] as f32 / 255.0;
    let out_a = alpha + dst_a * (1.0 - alpha);
    for channel in 0..3 {
        let src = rgb[channel] as f32 / 255.0;
        let dst = pixel[channel] as f32 / 255.0;
        let value = (src * alpha + dst * dst_a * (1.0 - alpha)) / out_a;
        pixel[channel] = (value * 255.0).round() as u8;
    }
    pixel[3] = (out_a * 255.0).round() as u8;
}

fn paint(rgba: &mut [u8], circle: Circle, rgb: [u8; 3]) {
    for y in 0..SIZE {
        for x in 0..SIZE {
            let cover = circle.coverage(x, y);
            let offset = (y * SIZE + x) * 4;
            blend(&mut rgba[offset..offset + 4], rgb, cover);
        }
    }
}

/// 5×7 digits and a plus sign; each row is 5 bits, most significant = left.
const GLYPHS: [[u8; 7]; 11] = [
    [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], // 0
    [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e], // 1
    [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], // 2
    [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e], // 3
    [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], // 4
    [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e], // 5
    [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], // 6
    [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08], // 7
    [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], // 8
    [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c], // 9
    [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00], // +
];

fn stamp(rgba: &mut [u8], glyph: &[u8; 7], left: usize, top: usize, width: usize) {
    for (row, bits) in glyph.iter().enumerate() {
        for col in 0..width {
            if bits & (1 << (4 - col)) != 0 {
                let offset = ((top + row) * SIZE + left + col) * 4;
                rgba[offset..offset + 4].copy_from_slice(&[255, 255, 255, 255]);
            }
        }
    }
}

/// The overlay as 32×32 RGBA, or `None` when there is nothing to show (the
/// main space with nothing pending keeps the plain app icon).
pub fn render(is_main: bool, rgb: [u8; 3], pending: usize) -> Option<Vec<u8>> {
    if is_main && pending == 0 {
        return None;
    }
    let mut rgba = vec![0u8; SIZE * SIZE * 4];
    if !is_main {
        // Space dot: a white ring 2 px wide around the colour, so a dark space
        // colour still reads on a dark taskbar and a light one on a light bar.
        paint(&mut rgba, Circle { cx: 16.0, cy: 16.0, r: 15.0 }, RING_RGB);
        paint(&mut rgba, Circle { cx: 16.0, cy: 16.0, r: 12.5 }, rgb);
    }
    if pending > 0 {
        // Count badge, top-right, ringed the same way so it cuts cleanly into
        // the dot beneath it.
        let (cx, cy) = (22.0, 10.0);
        paint(&mut rgba, Circle { cx, cy, r: 10.0 }, RING_RGB);
        paint(&mut rgba, Circle { cx, cy, r: 8.5 }, BADGE_RGB);
        if pending > 9 {
            // "9+": the nine and a narrow plus, centred as one 9-px word.
            stamp(&mut rgba, &GLYPHS[9], 17, 7, 5);
            stamp(&mut rgba, &GLYPHS[10], 22, 7, 5);
        } else {
            stamp(&mut rgba, &GLYPHS[pending], 20, 7, 5);
        }
    }
    Some(rgba)
}

pub const OVERLAY_SIZE: u32 = SIZE as u32;

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(rgba: &[u8], x: usize, y: usize) -> [u8; 4] {
        let offset = (y * SIZE + x) * 4;
        [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]]
    }

    #[test]
    fn main_space_without_pending_keeps_the_plain_icon() {
        assert!(render(true, DEFAULT_SPACE_RGB, 0).is_none());
        assert!(render(true, DEFAULT_SPACE_RGB, 3).is_some());
    }

    #[test]
    fn a_space_without_a_colour_takes_token_a_ink_blue() {
        assert_eq!(space_rgb(None), DEFAULT_SPACE_RGB);
        assert_eq!(space_rgb(Some("nope")), DEFAULT_SPACE_RGB);
        assert_eq!(space_rgb(Some("#0f766e")), [0x0f, 0x76, 0x6e]);
    }

    #[test]
    fn the_dot_is_round_ringed_and_anti_aliased() {
        let rgba = render(false, [0x0f, 0x76, 0x6e], 0).unwrap();
        // Corners are empty: a circle, not a square.
        assert_eq!(pixel(&rgba, 0, 0)[3], 0);
        assert_eq!(pixel(&rgba, 31, 31)[3], 0);
        // The centre is the space colour, fully opaque.
        assert_eq!(pixel(&rgba, 16, 16), [0x0f, 0x76, 0x6e, 255]);
        // The ring is white just inside the rim.
        assert_eq!(pixel(&rgba, 16, 2), [255, 255, 255, 255]);
        // The rim has partial alpha somewhere: edges are smoothed.
        assert!((0..SIZE).any(|x| { let a = pixel(&rgba, x, 1)[3]; a > 0 && a < 255 }));
    }

    #[test]
    fn counts_cap_at_nine_plus_and_draw_white_digits_on_the_badge() {
        let one = render(false, DEFAULT_SPACE_RGB, 1).unwrap();
        let many = render(false, DEFAULT_SPACE_RGB, 42).unwrap();
        assert_ne!(one, many);
        assert_eq!(render(false, DEFAULT_SPACE_RGB, 10), render(false, DEFAULT_SPACE_RGB, 99));
        // Badge ground at its edge is the attention colour.
        assert_eq!(&pixel(&one, 15, 10)[..3], &BADGE_RGB);
        // A white digit pixel inside the badge: the 1's stem.
        assert_eq!(pixel(&one, 22, 10), [255, 255, 255, 255]);
    }

    /// `KIKI_BADGE_DUMP=<dir> cargo test --lib space_badge -- --ignored`
    /// writes each variant's raw 32×32 RGBA for a pixel preview.
    #[test]
    #[ignore]
    fn dump_variants_for_preview() {
        let Ok(dir) = std::env::var("KIKI_BADGE_DUMP") else { return };
        let variants: [(&str, bool, [u8; 3], usize); 7] = [
            ("space-default", false, DEFAULT_SPACE_RGB, 0),
            ("space-teal", false, space_rgb(Some("#0f766e")), 0),
            ("space-stone", false, space_rgb(Some("#78716c")), 0),
            ("space-teal-3", false, space_rgb(Some("#0f766e")), 3),
            ("space-purple-9plus", false, space_rgb(Some("#7e22ce")), 27),
            ("main-1", true, DEFAULT_SPACE_RGB, 1),
            ("main-7", true, DEFAULT_SPACE_RGB, 7),
        ];
        for (name, main, rgb, pending) in variants {
            let rgba = render(main, rgb, pending).unwrap();
            std::fs::write(format!("{dir}/{name}.rgba"), rgba).unwrap();
        }
    }
}
