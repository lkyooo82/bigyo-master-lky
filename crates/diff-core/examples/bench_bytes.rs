use std::time::Instant;

fn make(n: usize, seed: u32, pattern: bool) -> Vec<u8> {
    let mut x = seed;
    (0..n)
        .map(|i| {
            x = x.wrapping_mul(1103515245).wrapping_add(12345);
            if pattern && i % 64 < 8 {
                0
            } else {
                (x >> 16) as u8
            }
        })
        .collect()
}

fn main() {
    let n: usize = std::env::args()
        .nth(1)
        .map_or(30_000_000, |s| s.parse().unwrap());
    for pattern in [true, false] {
        let (l, r) = (make(n, 7, pattern), make(n, 99, pattern));
        let t = Instant::now();
        let d = diff_core::diff_bytes(&l, &r, &Default::default());
        println!(
            "pattern={pattern} {:?} chunks={} stats={:?}",
            t.elapsed(),
            d.chunks.len(),
            d.stats
        );
    }
}
