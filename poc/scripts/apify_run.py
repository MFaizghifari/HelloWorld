#!/usr/bin/env python3
"""Run an Apify actor, wait for it, and save its dataset items to JSON.

Usage: apify_run.py <actor-id> <input.json> <output.json>

Auth: requests go to api.apify.com without a token in code. In the cloud
session a proxy injects the token. Locally, set APIFY_TOKEN and it is sent
as a Bearer header.
"""
import json
import os
import sys
import time
import urllib.request

API = "https://api.apify.com/v2"


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method)
    req.add_header("Content-Type", "application/json")
    token = os.environ.get("APIFY_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    data = json.dumps(body).encode() if body is not None else None
    with urllib.request.urlopen(req, data=data, timeout=120) as r:
        return json.load(r)


def main():
    actor, inp, out = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(inp) as f:
        payload = json.load(f)
    run = call("POST", f"/acts/{actor.replace('/', '~')}/runs", payload)["data"]
    run_id = run["id"]
    print(f"[{actor}] run {run_id} started", flush=True)
    while True:
        time.sleep(10)
        run = call("GET", f"/actor-runs/{run_id}")["data"]
        if run["status"] not in ("READY", "RUNNING"):
            break
    usage = run.get("usageTotalUsd")
    print(f"[{actor}] status={run['status']} usage=${usage}", flush=True)
    items = call("GET", f"/datasets/{run['defaultDatasetId']}/items?clean=true&format=json")
    with open(out, "w") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)
    print(f"[{actor}] {len(items)} items -> {out}", flush=True)


if __name__ == "__main__":
    main()
