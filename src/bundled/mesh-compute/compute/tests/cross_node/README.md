# Cross-node inference smoke

`scripts/ci-mesh-cross-node.sh` builds the real Buzz lifecycle test worker with the `mesh`
feature and runs two separate processes on Linux x86-64 using a checksum-pinned
v0.78.1 CPU runtime and revision/checksum-pinned SmolLM2-135M GGUF. The workflow
runs on relevant PRs/main pushes and supports manual dispatch. Budget: 20 minutes
including compilation; the Python smoke has a 10-minute outer deadline.

The provider alone receives the model. Both processes receive isolated temporary
homes, new owner identities, a private mesh name, explicit owner allowlists and
no public discovery/iroh relay configuration. No desktop credentials are inherited.
The smoke checks exact remote model visibility, a nonempty `model=mesh` response,
increased provider-local request accounting and zero consumer-local requests.
After provider shutdown a fresh request must fail. Temporary homes and owned
processes are cleaned on success, exceptions and SIGTERM/SIGINT; SIGKILL cannot
run cleanup. Evidence goes to `test-results/mesh-cross-node`.

For macOS or an already provisioned runtime:

```sh
python3 src/bundled/mesh-compute/compute/tests/cross_node/run.py \
  --runtime-bundle /path/to/native-runtime --cache /path/to/model-cache \
  --output /path/to/evidence
```

Negative control: append `--skip-join --readiness-timeout 3`; this must exit
nonzero with `deadline: remote model visible`. It is not a passing smoke.

This covers the old serve/client smoke boundary, **not** signed relay discovery,
stranger admission, the leased gateway/GDK agent loop, desktop packaging or
cross-host firewall/NAT behavior. Two processes on one runner are deliberate:
this detects accidental local-model dependence without requiring two machines.
Native macOS runs do not establish that the Linux CPU workflow passes.

The explicit `cross_node_worker` Cargo test target has `harness = false` and
`test = false`: ordinary crate tests do not launch an interactive child worker.
The orchestrator builds it explicitly with `cargo test --test cross_node_worker
--no-run` and takes the executable path from Cargo JSON (no hashed-path guessing).
Use `--binary` to reuse a prebuilt worker. This is not a shipped example or binary.
