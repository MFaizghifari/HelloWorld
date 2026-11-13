"""Shared Gemini helpers (stdlib only). Key from env GEMINI_API_KEY or poc/.env.local."""
import json, os, sys, time, urllib.request, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GEN_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")
API = "https://generativelanguage.googleapis.com/v1beta/models/"


def load_key():
    if os.environ.get("GEMINI_API_KEY"):
        return os.environ["GEMINI_API_KEY"]
    env = ROOT / ".env.local"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("GEMINI_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"')
    sys.exit("GEMINI_API_KEY tidak ditemukan")


KEY = load_key()


def call(model, method, body, tries=5):
    url = f"{API}{model}:{method}"
    data = json.dumps(body).encode()
    for i in range(tries):
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", "x-goog-api-key": KEY})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:300]
            if e.code in (429, 500, 503) and i < tries - 1:
                time.sleep(2 ** i * 3)
                continue
            raise RuntimeError(f"{e.code} {msg}")
        except (urllib.error.URLError, TimeoutError):
            if i < tries - 1:
                time.sleep(2 ** i * 3)
                continue
            raise


def generate_json(prompt, schema, max_tokens=16000):
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.1, "maxOutputTokens": max_tokens,
            "responseMimeType": "application/json", "responseSchema": schema,
            "thinkingConfig": {"thinkingLevel": "minimal"},
        },
    }
    for attempt in range(3):
        r = call(GEN_MODEL, "generateContent", body)
        try:
            text = "".join(p.get("text", "") for p in r["candidates"][0]["content"]["parts"])
            return json.loads(text), r.get("usageMetadata", {})
        except (KeyError, json.JSONDecodeError):
            if attempt == 2:
                raise
