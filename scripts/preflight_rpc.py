#!/usr/bin/env python3
"""
Preflight check for EVM RPC availability.

Design goals:
  - Never print or log the RPC URL (it usually embeds an API key).
  - Two modes:
      default   -> missing secret means "skip", exit 0. Correct for the
                   agent's ephemeral sandbox and for fork PRs, which
                   legitimately cannot see the secret.
      --require -> missing secret is a hard failure, exit 1. Correct for the
                   gated live-checks workflow, where a silent skip would
                   produce a green run with no live tests actually executed.

Exit codes:
  0  -> RPC reachable, or EVM_RPC_URL unset in non-strict mode
  1  -> RPC required but missing, or configured but unreachable/broken
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

TIMEOUT_SECONDS = 10


def fail(message: str) -> None:
    print(f"::error::{message}", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--require",
        action="store_true",
        help="Fail (exit 1) if EVM_RPC_URL is not set, instead of skipping.",
    )
    args = parser.parse_args()

    rpc_url = os.environ.get("EVM_RPC_URL", "").strip()

    if not rpc_url:
        if args.require:
            fail(
                "EVM_RPC_URL is not set. In this job it is required. "
                "Check that the 'live-rpc' environment has the secret defined "
                "and that this job declares `environment: live-rpc`."
            )
        print("EVM_RPC_URL is not set - skipping live RPC checks.")
        return 0

    if not rpc_url.startswith(("http://", "https://")):
        fail("EVM_RPC_URL is set but is not an http(s) URL.")

    payload = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []}
    ).encode()

    request = urllib.request.Request(
        rpc_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            body = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        # 401/403 = bad or expired key. 429 = rate limited.
        fail(f"RPC returned HTTP {exc.code}. Check that the secret is valid.")
    except urllib.error.URLError as exc:
        fail(f"RPC unreachable: {exc.reason}")
    except (TimeoutError, json.JSONDecodeError) as exc:
        fail(f"RPC response was not usable JSON ({type(exc).__name__}).")

    if "error" in body:
        fail(f"RPC returned an error object: {body['error'].get('message', 'unknown')}")

    chain_id = int(body.get("result", "0x0"), 16)
    expected = os.environ.get("EXPECTED_CHAIN_ID", "").strip()

    # Chain ID is public information; safe to log and useful evidence in CI.
    if expected and chain_id != int(expected):
        fail(f"Chain ID mismatch: endpoint reports {chain_id}, expected {expected}.")

    print(f"RPC OK - chain ID {chain_id}" + (f" (expected {expected})" if expected else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
