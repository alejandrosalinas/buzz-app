# FOUNDATION: Shared developer commands. Keep this interface small and stable.

# List available commands.
default:
    @just --list

# Install standard hooks once per clone when lhm is not managing them.
hooks:
    bin/lefthook install

[private]
install:
    pnpm install --frozen-lockfile

# Run the shared frontend in a browser; forward Vite arguments (e.g. --port 1431).
[positional-arguments]
web *args: install
    if [ "${1:-}" = "profile" ]; then shift; set -m; node scripts/profile-dev.mjs web "$@"; else exec pnpm dev "$@"; fi

# Run Tauri; `me` first signs in with your installed Buzz's key, --port selects
# Vite's port, other arguments pass through to Tauri.
[positional-arguments]
desktop *args: install
    if [ "${1:-}" = "profile" ]; then shift; set -m; node scripts/profile-dev.mjs desktop "$@"; else exec node scripts/desktop-dev.mjs "$@"; fi

# Bundle a debug desktop app for deep-link testing; macOS routes a scheme only to a bundle.
[positional-arguments]
desktop-bundle *args: install
    exec node scripts/desktop-build.mjs "$@"

# Remove generated CPU, network, and Instruments profiles.
profile-clean:
    rm -rf -- .profiles

# Open the design system in a browser; forward Vite arguments (e.g. --port 1444).
[positional-arguments]
design *args: install
    pnpm design:dev "$@"

# Run buzzodz; forward arguments unchanged (Rust required).
[positional-arguments]
cli *args:
    @cargo run --quiet --locked --manifest-path crates/plugin-manager/Cargo.toml --bin buzzodz -- "$@"

# Reserved for the frontend and local Docker relay backend.
fullstack:
    @echo "Not implemented: fullstack will run Buzz with a local Docker relay backend." >&2
    @exit 1

# Fast feedback: safe fixes, formatting, type checking, and frontend build; no tests.
iterate: install
    cargo fmt --all
    pnpm exec biome check --write --error-on-warnings .
    pnpm build

# Broader validation; does not auto-fix source files. First Rust build can be slow.
scan: install
    pnpm check
    pnpm test
    cargo fmt --all --check
    pnpm build
    pnpm design:test:browser
    cargo clippy --workspace --locked --all-targets -- -D warnings
    cargo test --manifest-path src-tauri/Cargo.toml --locked
