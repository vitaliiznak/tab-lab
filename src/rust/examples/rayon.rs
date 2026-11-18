use rayon::prelude::*;

fn main() {
    let total: u64 = (1..=1_000_000_u64).into_par_iter().sum();
    println!("Rayon worker threads: {}", rayon::current_num_threads());
    println!("Parallel sum: {total}");
    assert_eq!(total, 500_000_500_000);
}
