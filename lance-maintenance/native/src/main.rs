use gmax_bounded_maintenance::engine::{Request, emit, run};
use serde_json::json;
use std::io::{BufRead, Read};

fn main() {
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
    let result = resource_limits()
        .and_then(|()| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .map_err(anyhow::Error::from)
        })
        .and_then(|runtime| {
            runtime.block_on(async {
                let mut line = String::new();
                std::io::stdin()
                    .lock()
                    .take(64 * 1024)
                    .read_line(&mut line)?;
                let request: Request = serde_json::from_str(&line)?;
                run(request).await
            })
        });
    if let Err(error) = result {
        eprintln!("Bounded maintenance refused: {error}");
        let _ = emit(json!({"phase":"error","status":"blocked","reason":error.to_string()}));
        std::process::exit(3);
    }
}

fn resource_limits() -> anyhow::Result<()> {
    // These environment changes happen before constructing any runtime or
    // native thread pool, and affect this short-lived helper only. Two Lance
    // pool threads support streaming; one compaction task runs at a time.
    for (key, value) in [
        ("LANCE_CPU_THREADS", "2"),
        ("LANCE_IO_THREADS", "2"),
        ("LANCE_DEFAULT_IO_BUFFER_SIZE", "33554432"),
        ("RAYON_NUM_THREADS", "1"),
        ("OMP_NUM_THREADS", "1"),
        ("OPENBLAS_NUM_THREADS", "1"),
        ("MKL_NUM_THREADS", "1"),
    ] {
        unsafe {
            std::env::set_var(key, value);
        }
    }
    for (kind, soft, hard) in [(libc::RLIMIT_CPU, 90, 91), (libc::RLIMIT_NOFILE, 256, 256)] {
        let limit = libc::rlimit {
            rlim_cur: soft,
            rlim_max: hard,
        };
        if unsafe { libc::setrlimit(kind, &limit) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(target_os = "linux")]
    {
        // Match the existing prune helper's address-space ceiling. Cache sizes
        // are 8 MiB each; this ceiling is not a claimed 512 MiB RSS cap.
        let limit = libc::rlimit {
            rlim_cur: 2 * 1024 * 1024 * 1024,
            rlim_max: 2 * 1024 * 1024 * 1024,
        };
        if unsafe { libc::setrlimit(libc::RLIMIT_AS, &limit) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    Ok(())
}
