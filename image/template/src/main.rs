fn main() {
    let squares: Vec<_> = (1..=5).map(|n| n * n).collect();
    println!("{squares:?}");
}
