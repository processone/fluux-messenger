use fluux_nse_openpgp::identity::{evaluate, Corpus};
use std::io::{self, Read};
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let corpus: Corpus = serde_json::from_str(&input).unwrap();
    assert_eq!(corpus.version, 1);
    println!(
        "{}",
        serde_json::to_string(&corpus.cases.iter().map(evaluate).collect::<Vec<_>>()).unwrap()
    );
}
