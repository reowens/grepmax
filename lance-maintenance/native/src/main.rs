use gmax_bounded_maintenance::engine::{Request, emit, run};
use serde_json::json;
use std::io::{BufRead, Read};

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    if std::env::args().skip(1).eq(["--capabilities"]) {
        // Report source-enforced guarantees. Packaging must independently pass
        // native acceptance and verify the executable checksum before use.
        emit(
            json!({"protocolVersion":1,"engine":"12.0.0","nativeTotalWriteBudgetEnforced":true,
            "budgetKind":"cumulative-writes","protectedReaderProtocol":1}),
        )
        .unwrap();
        return;
    }
    let result = async {
        let mut line = String::new();
        std::io::stdin()
            .lock()
            .take(64 * 1024)
            .read_line(&mut line)?;
        let request: Request = serde_json::from_str(&line)?;
        run(request).await
    }
    .await;
    if let Err(error) = result {
        eprintln!("Bounded maintenance refused: {error}");
        let _ = emit(json!({"phase":"error","status":"blocked","reason":error.to_string()}));
        std::process::exit(3);
    }
}
