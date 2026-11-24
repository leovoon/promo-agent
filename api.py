#!/usr/bin/env python3
"""Promo Ledger API server (TurboAPI / Zig HTTP core).

A tiny HTTP API + static server for the promo ledger so agents (pi, other
harnesses) and the dashboard can read and update it.

Endpoints:
  GET  /api/promos                      → full list (filter: ?status=&account=&kind=&q=)
  GET  /api/promos/<id>                 → one row
  GET  /api/stats                       → counts
  GET  /api/scan/status                 → state of the last/current rescan job
  POST /api/promos                      → create a row (agent-friendly append)
  PATCH /api/promos/<id>                → update fields (status, expiry, notes, deal, url, proof, service)
  DELETE /api/promos/<id>               → permanently remove a row
  POST /api/scan                        → start a background rescan (returns 202 immediately)
  GET  /                               → dashboard (index.html)
Any other static file under this dir is served too.

Run (needs free-threaded CPython 3.14t + turboapi, see TURBO_NOTES.md):
  .venv/bin/python api.py [--port 8734] [--bind 127.0.0.1]
"""
import argparse
import datetime
import fcntl
import inspect
import json
import os
import re
import shutil
import threading
import time
import urllib.request
from collections import Counter
from urllib.parse import parse_qs

from turboapi import Request, Response, TurboAPI

# Sprites connector gateway (OpenRouter managed connector). Calls through the
# gateway are authenticated by the requesting Sprite's identity (Fly.io
# request signature); no provider token ever lives in this code or on disk.
OPENROUTER_GATEWAY = os.environ.get(
    "OPENROUTER_GATEWAY",
    # BYOK OpenRouter connector (managed connector's prepaid credits were exhausted)
    "https://api.sprites.dev/v1/gateway/openrouter/<connector_id>/v1/chat/completions",
)
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini")
# Keep completions tiny: the BYOK OpenRouter org has a small credit balance.
OPENROUTER_MAX_TOKENS = int(os.environ.get("OPENROUTER_MAX_TOKENS", "80"))

# Levanto custom-api connector (decision model). Gateway holds the credential;
# this code only knows the gateway URL.
LEVANTO_GATEWAY = os.environ.get(
    "LEVANTO_GATEWAY",
    "https://api.sprites.dev/v1/gateway/custom_api/<connector_id>",
)

ROOT = os.path.dirname(os.path.abspath(__file__))
LEDGER = os.path.join(ROOT, "promos.json")
LOCKFILE = os.path.join(ROOT, ".ledger.lock")
ACCESS_LOG = os.path.join(ROOT, ".api-access.log")

VALID_STATUS = {"new", "live", "used", "expired", "blocked", "pending", "archived"}
VALID_KIND = {"promo_confirm", "credit_granted", "trial_start", "expiry_warning", "receipt", "other"}
EDITABLE_FIELDS = {"status", "expiry", "notes", "deal", "url", "proof", "service", "auth", "account"}
CREATEABLE_FIELDS = EDITABLE_FIELDS | {"kind", "date", "subject", "email_id", "thread_id", "email_url", "domain", "confidence", "source", "last_seen"}

_lock = threading.Lock()

# ---- background scan job state ----
_scan_job = {"running": False, "last": None}
_scan_lock = threading.Lock()


# ---------- ledger helpers ----------

def load_ledger_locked() -> dict:
    if not os.path.exists(LEDGER):
        # First run: seed from the sample ledger so `git clone && run` works.
        sample = os.path.join(ROOT, "promos.example.json")
        if os.path.exists(sample):
            with open(sample, encoding="utf-8") as f:
                shutil.copyfile(sample, LEDGER)
        else:
            with open(LEDGER, "w", encoding="utf-8") as f:
                json.dump({"schema_version": 1, "promos": []}, f)
    with open(LEDGER, encoding="utf-8") as f:
        return json.load(f)


def save_ledger_locked(ledger: dict) -> None:
    tmp = LEDGER + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(ledger, f, indent=2, ensure_ascii=False)
    os.replace(tmp, LEDGER)  # atomic


def with_ledger(mutate):
    """Serialize ledger read-modify-write across processes via flock."""
    with _lock:
        fd = os.open(LOCKFILE, os.O_CREAT | os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            ledger = load_ledger_locked()
            result = mutate(ledger)
            save_ledger_locked(ledger)
            return result
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)


def row_id(row: dict) -> str:
    if row.get("email_id"):
        return row["email_id"]
    return row.get("id") or f"mem-{row.get('service','?').lower().replace(' ','-')}"


def ensure_ids(ledger: dict) -> None:
    seen = set()
    for r in ledger["promos"]:
        if r.get("email_id"):
            r.setdefault("id", r["email_id"])
        if not r.get("id"):
            base = re.sub(r"[^a-z0-9]+", "-", (r.get("service") or "row").lower()).strip("-")
            base = base or "row"
            i = 1
            cand = f"mem-{base}"
            while cand in seen:
                cand = f"mem-{base}-{i}"
                i += 1
            r["id"] = cand
        seen.add(r["id"])


# ---------- reconciliation (used by POST /api/scan) ----------

def reconcile(ledger: dict, findings: list, now: str) -> dict:
    """Merge scan findings into ledger. New rows added with status 'new';
    already-known rows only get last_seen touched (manual status preserved)."""
    by_id = {row_id(r): r for r in ledger["promos"]}
    added, seen = 0, 0
    for f in findings:
        fid = f.get("email_id") or f.get("id")
        if not fid:
            continue
        if fid in by_id:
            by_id[fid]["last_seen"] = now
            seen += 1
        else:
            f.setdefault("id", fid)
            f["last_seen"] = now
            ledger["promos"].append(f)
            by_id[fid] = f
            added += 1
    return {"added": added, "seen": seen, "total": len(ledger["promos"])}


# ---------- scan hook (imports scan.py) ----------

def run_scan(accounts=None, limit=40):
    import importlib
    import scan
    importlib.reload(scan)
    ledger = scan.load_ledger()
    # accept readable emails too; map to token-filename stems
    stems = []
    for a in (accounts or ["all"]):
        if a == "all":
            stems.append("all")
        elif "@" in a:
            stems.append(scan.domain_safe(a))
        else:
            stems.append(a)
    findings = scan.collect_findings(stems, limit=limit)
    now = json.dumps(datetime.date.today().isoformat()).strip('"')
    return reconcile(ledger, findings, now)


def background_scan(accounts=None, limit=40):
    """Start a rescan in a background thread; return immediately."""
    with _scan_lock:
        if _scan_job["running"]:
            return {"ok": False, "error": "a scan is already running"}
        _scan_job["running"] = True
        _scan_job["last"] = {"state": "running", "started": datetime.datetime.now().isoformat(timespec="seconds")}

    def work():
        try:
            result = run_scan(accounts, limit)
            _scan_job["last"] = {**result, "state": "done", "finished": datetime.datetime.now().isoformat(timespec="seconds")}
        except Exception as e:
            _scan_job["last"] = {"state": "error", "error": str(e), "finished": datetime.datetime.now().isoformat(timespec="seconds")}
        finally:
            _scan_job["running"] = False

    threading.Thread(target=work, daemon=True).start()
    return {"ok": True, "job": "started", "status": "running"}


def slugify(service: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (service or "row").lower()).strip("-")
    return base or "row"


# ---------- HTTP plumbing ----------
#
# TurboAPI re-serializes handler output (JSON bodies get ASCII-escaped, static
# .json files lose their formatting). To stay byte-identical with the old
# http.server implementation, each handler renders its exact body bytes, parks
# them in a thread-local, and ExactBodyMiddleware.after_request swaps them back
# in. Handler + after_request run synchronously on the same Zig worker thread.

_tls = threading.local()

_MONTHS = [None, "Jan", "Feb", "Mar", "Apr", "May", "Jun",
           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

CORS_HEADERS = {"Access-Control-Allow-Origin": "*"}


def _log_date_time_string() -> str:
    """Same format as BaseHTTPRequestHandler.log_date_time_string()."""
    year, month, day, hh, mm, ss, *_ = time.localtime(time.time())
    return "%02d/%3s/%04d %02d:%02d:%02d" % (day, _MONTHS[month], year, hh, mm, ss)


class ExactBodyMiddleware:
    """Access log + exact-bytes response bodies."""

    def __init__(self, **kwargs):
        pass

    def before_request(self, request):
        _tls.body = None
        # old handler logged self.path, which includes the query string
        target = request.path + (f"?{request.query_string}" if request.query_string else "")
        try:
            with open(ACCESS_LOG, "a") as f:
                f.write(f"{_log_date_time_string()} {request.method} {target}\n")
        except Exception:
            pass

    def after_request(self, request, response):
        body = getattr(_tls, "body", None)
        if body is not None:
            response.content = body
            _tls.body = None
        return response

    def on_error(self, request, exc):
        _tls.body = None
        return None


def _respond(code: int, body: bytes, ctype: str, headers: dict | None = None) -> Response:
    _tls.body = body
    return Response(content=body, status_code=code, media_type=ctype, headers=dict(headers or {}))


def _json(code: int, obj) -> Response:
    body = json.dumps(obj, ensure_ascii=False).encode()
    return _respond(code, body, "application/json; charset=utf-8", CORS_HEADERS)


def _read_body(request: Request):
    """Mirror the old handler: empty body → {}; unparseable JSON → {}."""
    raw = request.body or b""
    if not raw:
        return {}
    try:
        return json.loads(bytes(raw).decode("utf-8"))
    except Exception:
        return {}


def _path(request: Request) -> str:
    return request.path.split("?")[0]


# ---------- Sprites connector-backed classification ----------

def levanto_decide(body: dict) -> Response:
    """Ask Levanto (decision model) a yes/no question via the Sprites connector.

    Body: {content, question: {id, kind: "yesno", instructions}}. Returns
    the decision result including probability. Credential lives in the org
    gateway; works from inside a running Sprite.
    """
    content = (body.get("content") or "").strip()
    question = body.get("question") or {}
    if not content or not isinstance(question, dict) or not question.get("id"):
        return _json(400, {"ok": False, "error": "content and question.id are required"})
    q = {
        "id": str(question["id"]),
        "kind": str(question.get("kind", "yesno")),
        "instructions": str(question.get("instructions", "")),
    }
    payload = {"content": content, "question": q}
    try:
        req = urllib.request.Request(
            LEVANTO_GATEWAY + "/decide",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode())
        return _json(200, {"ok": True, "decision": data, "via": "levanto-sprites-connector"})
    except urllib.error.HTTPError as e:
        return _json(502, {"ok": False, "error": f"gateway HTTP {e.code}", "via": "levanto-sprites-connector"})
    except Exception as e:
        return _json(503, {"ok": False, "error": str(e), "via": "levanto-sprites-connector"})


def _openrouter_classify(text: str):
    """Fallback classifier: OpenRouter LLM returns {status, one_liner}.
    Returns (status, one_liner) or raises.
    """
    prompt = (
        "You triage software promo offers. Given the offer text, return JSON "
        "with exactly two fields: \"status\" (one of: live, blocked, pending, "
        "used, expired, new) and \"one_liner\" (a 12-word max summary of "
        "the deal). Offer text: " + text[:2000]
    )
    payload = {
        "model": OPENROUTER_MODEL,
        "max_tokens": OPENROUTER_MAX_TOKENS,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": "You are a concise promo triage assistant."},
            {"role": "user", "content": prompt},
        ],
    }
    req = urllib.request.Request(
        OPENROUTER_GATEWAY,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        data = json.loads(resp.read().decode())
    content = data["choices"][0]["message"]["content"]
    result = json.loads(content) if isinstance(content, str) else content
    status = str(result.get("status", "new")).lower()
    if status not in VALID_STATUS:
        status = "new"
    return status, str(result.get("one_liner", ""))


def classify_deal(body: dict) -> Response:
    """Triage a promo/deal via the Levanto decision model (primary), falling
    back to the OpenRouter Sprites connector.

    Levanto answers a "choice" question (status options) with probabilities;
    it abstains (chosen=null) below its confidence threshold, in which case
    we fall back. Both calls go through Sprites connector gateways so the
    provider credentials live in the org, never in this code.
    """
    text = (body.get("text") or body.get("deal") or body.get("service") or "").strip()
    if not text:
        return _json(400, {"ok": False, "error": "text/deal/service is required"})

    options = [{"option": s} for s in ("live", "blocked", "pending", "used", "expired", "new")]
    payload = {
        "content": text[:2000],
        "question": {
            "id": "promo_status",
            "kind": "choice",
            "instructions": "Which status best describes this software promo offer?",
            "options": options,
        },
    }
    # 1) Levanto (primary)
    try:
        req = urllib.request.Request(
            LEVANTO_GATEWAY + "/decide",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode())
        chosen = data.get("result", {}).get("chosen")
        probs = data.get("result", {}).get("probabilities", [])
        if chosen and chosen in VALID_STATUS:
            prob = next((p.get("probability") for p in probs if p.get("option") == chosen), None)
            return _json(200, {
                "ok": True,
                "status": chosen,
                "probability": round(prob, 4) if prob is not None else None,
                "one_liner": "",
                "via": "levanto-sprites-connector",
            })
        # abstained → fall through to OpenRouter
    except urllib.error.HTTPError:
        pass  # fall back
    except Exception:
        pass  # fall back

    # 2) OpenRouter (fallback)
    try:
        status, one_liner = _openrouter_classify(text)
        return _json(200, {
            "ok": True,
            "status": status,
            "one_liner": one_liner,
            "via": "openrouter-sprites-connector",
        })
    except urllib.error.HTTPError as e:
        return _json(502, {"ok": False, "error": f"gateway HTTP {e.code}", "via": "openrouter-sprites-connector"})
    except Exception as e:
        return _json(503, {"ok": False, "error": str(e), "via": "openrouter-sprites-connector"})


# ---------- endpoint logic (same semantics as the old Handler) ----------

def get_promos(query_string: str) -> Response:
    q = parse_qs(query_string)

    def one(k):
        return (q.get(k) or [""])[0]

    ledger = load_ledger_locked()
    ensure_ids(ledger)
    rows = ledger["promos"]
    status, account, kind, s = one("status"), one("account"), one("kind"), one("q").lower()
    if status:
        rows = [r for r in rows if r.get("status") == status]
    if account:
        rows = [r for r in rows if r.get("account") == account]
    if kind:
        rows = [r for r in rows if r.get("kind") == kind]
    if s:
        rows = [r for r in rows if s in " ".join([
            str(r.get("service", "")), str(r.get("subject", "")),
            str(r.get("account", "")), str(r.get("notes", "")),
        ]).lower()]
    return _json(200, {"schema_version": ledger.get("schema_version", 1), "promos": rows})


def get_one(rid: str) -> Response:
    ledger = load_ledger_locked()
    ensure_ids(ledger)
    for r in ledger["promos"]:
        if row_id(r) == rid:
            return _json(200, r)
    return _json(404, {"error": "row not found"})


def get_stats() -> Response:
    ledger = load_ledger_locked()
    ensure_ids(ledger)
    rows = ledger["promos"]
    statuses = Counter(r.get("status", "new") for r in rows)
    accounts = Counter(r.get("account", "?") for r in rows)
    return _json(200, {
        "total": len(rows),
        "statuses": dict(statuses),
        "accounts": dict(accounts),
        "by_kind": dict(Counter(r.get("kind", "other") for r in rows)),
    })


def get_scan_status() -> Response:
    return _json(200, {"running": _scan_job["running"], "job": _scan_job["last"]})


def serve_file(rel: str) -> Response:
    safe = os.path.normpath(rel)
    if safe.startswith("..") or os.path.isabs(safe):
        return _json(403, {"error": "forbidden"})
    # Serve the built Foldkit UI (ui/dist) first, then legacy files next to api.py.
    roots = [os.path.join(ROOT, "ui", "dist"), ROOT]
    path = None
    for root in roots:
        candidate = os.path.join(root, safe)
        if os.path.isfile(candidate):
            path = candidate
            break
    if path is None:
        return _json(404, {"error": "not found"})
    ext = os.path.splitext(path)[1].lower()
    ctype = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml",
    }.get(ext, "application/octet-stream")
    with open(path, "rb") as f:
        data = f.read()
    return _respond(200, data, ctype)


def patch_row(rid: str, body) -> Response:
    if not isinstance(body, dict):
        return _json(400, {"error": "body must be a JSON object"})

    def mutate(ledger):
        ensure_ids(ledger)
        for r in ledger["promos"]:
            if row_id(r) == rid:
                for k, v in body.items():
                    if k in EDITABLE_FIELDS:
                        if k == "status" and v not in VALID_STATUS:
                            continue
                        r[k] = v
                r["updated_at"] = datetime.date.today().isoformat()
                return {"ok": True, "row": r}
        return {"ok": False, "error": "row not found"}

    return _json(200, with_ledger(mutate))


def delete_row(rid: str) -> Response:
    def mutate(ledger):
        ensure_ids(ledger)
        before = len(ledger["promos"])
        ledger["promos"] = [r for r in ledger["promos"] if row_id(r) != rid]
        removed = before - len(ledger["promos"])
        return {"ok": True, "removed": removed} if removed else {"ok": False, "error": "row not found"}

    return _json(200, with_ledger(mutate))


def create_row(body) -> Response:
    if not isinstance(body, dict):
        return _json(400, {"error": "body must be a JSON object"})
    service = (body.get("service") or "").strip()
    if not service:
        return _json(400, {"error": "service is required"})
    row = {k: v for k, v in body.items() if k in CREATEABLE_FIELDS and v is not None}
    row["service"] = service

    def mutate(ledger):
        ensure_ids(ledger)
        eid = row.get("email_id")
        for r in ledger["promos"]:
            if eid and r.get("email_id") == eid:
                return {"ok": False, "error": f"row already exists (email_id {eid})"}
            if r.get("id") == row.get("id"):
                return {"ok": False, "error": f"row already exists (id {row.get('id')})"}
        if not row.get("id"):
            base = slugify(service)
            i = 1
            cand = f"mem-{base}"
            taken = {r.get("id") for r in ledger["promos"]}
            while cand in taken:
                cand = f"mem-{base}-{i}"
                i += 1
            row["id"] = cand
        row.setdefault("kind", "promo_confirm")
        row.setdefault("status", "new")
        row.setdefault("source", "agent")
        row.setdefault("date", datetime.date.today().isoformat())
        row["updated_at"] = datetime.date.today().isoformat()
        ledger["promos"].append(row)
        return {"ok": True, "row": row}

    return _json(201, with_ledger(mutate))


def start_scan(body) -> Response:
    body = body or {}
    accts = body.get("accounts") or ["all"]
    limit = int(body.get("limit") or 40)
    try:
        return _json(202, background_scan(accts, limit))
    except Exception as e:
        return _json(500, {"ok": False, "error": str(e)})


# ---------- per-method dispatch (exact old do_GET/do_POST/... routing) ----------
# The explicit routes below cover the documented endpoints; these dispatchers
# handle everything else (static files, unknown paths, trailing slashes) the
# same way the old if/elif chains did.

def dispatch_get(request: Request) -> Response:
    path = _path(request)
    if path == "/api/promos":
        return get_promos(request.query_string)
    elif path.startswith("/api/promos/"):
        return get_one(path.rsplit("/", 1)[1])
    elif path == "/api/stats":
        return get_stats()
    elif path == "/api/scan/status":
        return get_scan_status()
    elif path in ("/", "/index.html"):
        return serve_file("index.html")
    elif path.startswith("/api/"):
        return _json(404, {"error": "not found"})
    else:
        return serve_file(path.lstrip("/"))


def dispatch_post(request: Request) -> Response:
    path = _path(request)
    if path == "/api/scan":
        return start_scan(_read_body(request))
    elif path == "/api/promos":
        return create_row(_read_body(request))
    elif path == "/api/classify":
        return classify_deal(_read_body(request))
    elif path == "/api/decide":
        return levanto_decide(_read_body(request))
    return _json(404, {"error": "not found"})


_ROW_PATH = re.compile(r"^/api/promos/(.+)$")


def dispatch_patch(request: Request) -> Response:
    m = _ROW_PATH.match(_path(request))
    if not m:
        return _json(404, {"error": "not found"})
    return patch_row(m.group(1), _read_body(request))


def dispatch_delete(request: Request) -> Response:
    m = _ROW_PATH.match(_path(request))
    if not m:
        return _json(404, {"error": "not found"})
    return delete_row(m.group(1))


def dispatch_options(request: Request) -> Response:
    return _respond(204, b"", "text/plain", {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, PATCH, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    })


# ---------- app + routes ----------

app = TurboAPI(title="Promo Ledger API", version="1.0.0")
app.add_middleware(ExactBodyMiddleware)


@app.get("/api/promos")
def http_list_promos(request: Request):
    # Zig folds "/api/promos/" onto this route; the old server treated that as get_one("")
    return dispatch_get(request)


@app.get("/api/promos/{rid}")
def http_get_promo(rid: str, request: Request):
    return dispatch_get(request)


@app.get("/api/stats")
def http_stats(request: Request):
    return dispatch_get(request)


@app.get("/api/scan/status")
def http_scan_status(request: Request):
    return dispatch_get(request)


@app.post("/api/promos")
def http_create_promo(request: Request):
    return dispatch_post(request)


@app.patch("/api/promos/{rid}")
def http_patch_promo(rid: str, request: Request):
    return dispatch_patch(request)


@app.delete("/api/promos/{rid}")
def http_delete_promo(rid: str, request: Request):
    return dispatch_delete(request)


@app.post("/api/scan")
def http_start_scan(request: Request):
    return dispatch_post(request)


@app.post("/api/classify")
def http_classify(request: Request):
    return dispatch_post(request)


@app.post("/api/decide")
def http_decide(request: Request):
    return dispatch_post(request)


# TurboAPI has no "{path:path}" catch-all, so register "/", "/{p1}",
# "/{p1}/{p2}", ... per method (the same technique turboapi's own
# StaticFiles mount uses). The Zig router matches literal segments first and
# does not fall back to a sibling wildcard, so catch-alls are also hung under
# every literal prefix of the API routes (/api, /api/promos, ...). Requests
# deeper than CATCHALL_DEPTH segments get Zig's own 404.
CATCHALL_DEPTH = 16
_CATCHALL_PREFIXES = ["", "/api", "/api/promos", "/api/stats", "/api/scan", "/api/scan/status"]
_DISPATCHERS = {
    "get": dispatch_get,
    "post": dispatch_post,
    "patch": dispatch_patch,
    "delete": dispatch_delete,
    "options": dispatch_options,
}


def _shape(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "{}", path)


def _register_catchalls():
    sig = inspect.Signature([
        inspect.Parameter("request", inspect.Parameter.KEYWORD_ONLY, annotation=Request),
    ])
    taken = {(r.method.value, _shape(r.path)) for r in app.registry.get_routes()}
    for method, dispatcher in _DISPATCHERS.items():
        for prefix in _CATCHALL_PREFIXES:
            fixed = prefix.count("/")
            for extra in range(0, CATCHALL_DEPTH - fixed + 1):
                # param name = absolute segment index; the explicit "{rid}" sits at index 3
                names = ["rid" if (prefix == "/api/promos" and i == 3) else f"p{i}"
                         for i in range(fixed + 1, fixed + extra + 1)]
                route = (prefix + "".join("/{%s}" % n for n in names)) or "/"
                if (method.upper(), _shape(route)) in taken:
                    continue
                taken.add((method.upper(), _shape(route)))

                def handler(request, _d=dispatcher, **_segments):
                    return _d(request)

                handler.__signature__ = sig
                handler.__name__ = f"catchall_{method}_{len(taken)}"
                getattr(app, method)(route)(handler)


_register_catchalls()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8734)
    ap.add_argument("--bind", default="127.0.0.1")
    args = ap.parse_args()
    # Every response depends on the ledger / job state; never let Zig cache.
    os.environ.setdefault("TURBO_DISABLE_CACHE", "1")
    with_ledger(lambda L: (ensure_ids(L), None)[1])
    print(f"Promo Ledger API on http://{args.bind}:{args.port}/  (dashboard at /)", flush=True)
    app.run(host=args.bind, port=args.port)


if __name__ == "__main__":
    main()
