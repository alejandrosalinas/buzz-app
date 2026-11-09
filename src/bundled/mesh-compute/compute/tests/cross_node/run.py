#!/usr/bin/env python3
"""Real Buzz lifecycle -> remote inference smoke; no desktop or public discovery."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

MODEL_URL = "https://huggingface.co/jc-builds/SmolLM2-135M-Instruct-Q4_K_M-GGUF/resolve/62aa73156aea1ea66d752916ad281b9e344115b3/SmolLM2-135M-Instruct.Q4_K_M.gguf"
MODEL_SHA = "8030f04528538d47bda434f6f0bdf3952c40a58123e4d5e755332f23731a8684"
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(url, body=None, timeout=90):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with HTTP.open(req, timeout=timeout) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


def until(label, predicate, seconds=120):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(0.2)
    raise AssertionError(f"deadline: {label}")


class Node:
    def __init__(self, binary, root, name, output, bundle):
        home = root / name
        home.mkdir()
        (home / "SMOKE_ONLY").touch()
        # Allowlist inherited environment: no live app credentials, mesh config or proxies.
        env = {key: os.environ[key] for key in ("PATH", "SystemRoot", "TMPDIR") if key in os.environ}
        env.update(HOME=str(home), XDG_CACHE_HOME=str(home / "cache"),
                   XDG_CONFIG_HOME=str(home / "config"), BUZZ_MESH_TEST_HOME=str(home),
                   BUZZ_MESH_IROH_RELAYS="0", MESH_LLM_RUNTIME_ROOT=str(home / "runtime"),
                   MESH_LLM_NATIVE_RUNTIME_CACHE_DIR=str(home / "native"),
                   MESH_LLM_NATIVE_RUNTIME_BUNDLE_DIR=str(bundle), NO_COLOR="1")
        self.log = open(output / f"{name}.log", "w")
        self.process = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.log, text=True, env=env, cwd=home)
        self.responses = queue.Queue()
        def read():
            for line in self.process.stdout:
                if line.startswith("BUZZ_SMOKE "):
                    self.responses.put(json.loads(line[len("BUZZ_SMOKE "):]))
                else:
                    self.log.write(line)
            self.responses.put({"error": "child exited"})
        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()

    def call(self, op, **args):
        self.process.stdin.write(json.dumps(dict(op=op, **args)) + "\n")
        self.process.stdin.flush()
        response = self.responses.get(timeout=260)
        if "error" in response:
            raise RuntimeError(response["error"])
        return response["ok"]

    def close(self, require_success=False):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
        self.reader.join(timeout=5)
        self.process.stdout.close()
        self.log.close()
        if require_success:
            assert self.process.returncode == 0, f"child exit: {self.process.returncode}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, help="Prebuilt worker; otherwise build the explicit test target")
    parser.add_argument("--runtime-bundle", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--skip-join", action="store_true", help="Negative control: must fail readiness")
    parser.add_argument("--readiness-timeout", type=int, default=240)
    args = parser.parse_args()
    if args.binary is None:
        repo = Path(__file__).resolve().parents[6]
        started = time.monotonic()
        build = subprocess.run([
            str(repo / "bin/cargo"), "test", "--locked", "-p", "buzz-mesh-compute",
            "--test", "cross_node_worker", "--no-run",
            "--message-format=json",
        ], cwd=repo, stdout=subprocess.PIPE, text=True, check=True)
        artifacts = [json.loads(line) for line in build.stdout.splitlines()]
        executables = [item["executable"] for item in artifacts
                       if item.get("reason") == "compiler-artifact"
                       and item.get("target", {}).get("name") == "cross_node_worker"
                       and item.get("executable")]
        assert len(executables) == 1, "expected exactly one cross-node worker"
        args.binary = Path(executables[0])
        print(f"Worker build: {time.monotonic() - started:.2f}s", flush=True)
    binary, bundle = args.binary.resolve(), args.runtime_bundle.resolve()
    assert binary.is_file() and bundle.is_dir()
    args.cache.mkdir(parents=True, exist_ok=True)
    args.output.mkdir(parents=True, exist_ok=True)
    model = (args.cache / "SmolLM2-135M-Instruct.Q4_K_M.gguf").resolve()
    if not model.exists():
        with urllib.request.urlopen(MODEL_URL, timeout=120) as response:
            model.write_bytes(response.read())
    assert hashlib.sha256(model.read_bytes()).hexdigest() == MODEL_SHA, "model checksum mismatch"
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="buzz-cross-node-") as directory:
        root = Path(directory)
        nodes = []
        try:
            provider = Node(binary, root, "provider", args.output, bundle)
            nodes.append(provider)
            consumer = Node(binary, root, "consumer", args.output, bundle)
            nodes.append(consumer)
            owners = [node.call("identity") for node in nodes]
            mesh = "buzz-test-" + uuid.uuid4().hex
            # Reserve all four ports together. The SDK accepts ports, not listeners.
            sockets = [socket.socket() for _ in range(4)]
            try:
                for sock in sockets:
                    sock.bind(("127.0.0.1", 0))
                ports = [sock.getsockname()[1] for sock in sockets]
            finally:
                for sock in sockets:
                    sock.close()
            provider.call("start", api_port=ports[0], console_port=ports[1], owners=owners, mesh=mesh, model=str(model))
            consumer.call("start", api_port=ports[2], console_port=ports[3], owners=owners, mesh=mesh)
            p = provider.call("status")
            c = consumer.call("status")
            (args.output / "provider-start.json").write_text(json.dumps(p, indent=2))
            (args.output / "consumer-start.json").write_text(json.dumps(c, indent=2))
            assert c["payload"]["hosted_models"] == [], "consumer unexpectedly hosts a model"
            assert c["payload"]["is_client"] is True
            assert c["payload"]["nostr_discovery"] is False
            assert c["payload"]["publication_state"] == "private"
            if not args.skip_join:
                consumer.call("join", token=p["invite"])
            def visible():
                code, body = request(c["api"] + "/models", timeout=5)
                return body if code == 200 and any(
                    item["id"] == "local-gguf/sha256-" + MODEL_SHA
                    for item in body.get("data", [])
                ) else None
            models = until("remote model visible", visible, args.readiness_timeout)
            before = provider.call("status")
            body = {"model": "mesh", "messages": [{"role": "user", "content": "Say hello."}],
                    "temperature": 0, "max_tokens": 32, "stream": False}
            code, answer = request(c["api"] + "/chat/completions", body)
            assert code == 200, (code, answer)
            assert answer["choices"][0]["message"]["content"].strip(), answer
            after = until("provider accounted for completion", lambda: (
                value if value["payload"]["routing_metrics"]["pressure"]["locally_served_request_count"]
                > before["payload"]["routing_metrics"]["pressure"]["locally_served_request_count"] else None
            ) if (value := provider.call("status")) else None, 10)
            (args.output / "provider-before.json").write_text(json.dumps(before, indent=2))
            (args.output / "provider-after.json").write_text(json.dumps(after, indent=2))
            final_consumer = consumer.call("status")["payload"]
            assert final_consumer["hosted_models"] == []
            assert final_consumer["routing_metrics"]["pressure"]["locally_served_request_count"] == 0
            provider.call("stop")
            provider.close(require_success=True)
            nodes.remove(provider)
            code, unavailable = request(c["api"] + "/chat/completions", body)
            assert code >= 400, ("unexpected local fallback", code, unavailable)
            consumer.call("stop")
            consumer.close(require_success=True)
            nodes.remove(consumer)
            summary = dict(model_sha256=MODEL_SHA, models=models, completion=answer,
                           provider_stopped_status=code, elapsed_seconds=time.monotonic() - started)
            (args.output / "result.json").write_text(json.dumps(summary, indent=2))
            print(json.dumps(summary, indent=2))
        finally:
            for node in reversed(nodes):
                node.close()


if __name__ == "__main__":
    def interrupted(signum, frame):
        raise RuntimeError(f"smoke interrupted by signal {signum}")

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
        signal.signal(signum, interrupted)
    signal.alarm(600)
    try:
        main()
    finally:
        signal.alarm(0)
