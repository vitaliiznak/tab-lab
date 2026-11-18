use std::collections::BTreeMap;
use std::error::Error;

const CSV: &str = "station,watts\nZürich,18\nBasel,11\nZürich,26\nBern,8\nBasel,15";

fn main() -> Result<(), Box<dyn Error>> {
    let mut stations = Vec::new();
    let mut watts = Vec::new();
    for line in CSV.lines().skip(1) {
        let (city, value) = line.split_once(',').ok_or("expected two columns")?;
        stations.push(city);
        watts.push(value.parse::<u32>()?);
    }

    // SELECT station, SUM(watts) WHERE watts >= 10 GROUP BY station
    let mut groups = BTreeMap::new();
    for (city, power) in stations.iter().zip(watts) {
        if power >= 10 {
            *groups.entry(city).or_insert(0) += power;
        }
    }

    println!("{:<12} {:>7}", "Station", "Watts");
    for (city, total) in groups {
        println!("{city:<12} {total:>7}");
    }
    Ok(())
}
