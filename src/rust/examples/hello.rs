fn squares(limit: i32) -> Vec<i32> {
    (1..=limit).map(|n| n * n).collect()
}

fn main() {
    println!("Hello from Linux!");
    println!("Squares: {:?}", squares(6));
}

#[test]
fn first_three_squares() {
    assert_eq!(squares(3), vec![1, 4, 9]);
}
