use std::io::{self, Write};

extern "C" {
    fn render(pixels: *mut u32, width: i32, height: i32, time: f32) -> i32;
}

fn main() {
    let (width, height) = (44, 32);
    let mut pixels = vec![0_u32; width * height];
    let mut out = io::BufWriter::new(io::stdout().lock());
    for frame in 0..8 {
        // The C host function copies exactly width * height pixels back.
        let status = unsafe {
            render(
                pixels.as_mut_ptr(),
                width as i32,
                height as i32,
                frame as f32 * 0.1,
            )
        };
        assert_eq!(
            status, 0,
            "CUDA returned {status}. Check the WebGPU adapter."
        );
        if frame > 0 {
            write!(out, "\x1b[{}A", height / 2).unwrap();
        }
        for y in (0..height).step_by(2) {
            for x in 0..width {
                let a = pixels[y * width + x];
                let b = pixels[(y + 1) * width + x];
                write!(
                    out,
                    "\x1b[38;2;{};{};{}m\x1b[48;2;{};{};{}m▀",
                    a & 255,
                    (a >> 8) & 255,
                    (a >> 16) & 255,
                    b & 255,
                    (b >> 8) & 255,
                    (b >> 16) & 255
                )
                .unwrap();
            }
            writeln!(out, "\x1b[0m").unwrap();
        }
        out.flush().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(60));
    }
}
