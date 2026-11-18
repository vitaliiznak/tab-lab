use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Reading {
    station: String,
    celsius: f64,
}

fn main() -> serde_json::Result<()> {
    let data = r#"[{"station":"Zürich","celsius":16.0},{"station":"Basel","celsius":18.5}]"#;
    let readings: Vec<Reading> = serde_json::from_str(data)?;
    for r in readings {
        println!(
            "{}",
            json!({
                "station": r.station,
                "fahrenheit": r.celsius * 1.8 + 32.0
            })
        );
    }
    Ok(())
}
