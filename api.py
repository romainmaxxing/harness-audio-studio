"""Audio studio: record voice takes in the browser, keep them on the server, export one MP3.

Files live in <home>/audios/<project id>/ (or $STUDIO_AUDIO_DIR), outside the workspace so the memory backup never
carries audio; the page plays them through the file viewer, so the folder must be inside the files root:
  project.json            name, takes in order (file, duration, trim), last export
  takes/<sid>.webm        one file per take (remuxed so it has a duration and can be seeked)
  <name>.mp3              the last export (takes joined, trims applied, ffmpeg libmp3lame)
Deleted projects go to a `.trash/` folder, never straight to nothing.

Routes (body = JSON, limit 5 MB per request -> takes are uploaded in base64 pieces):
  GET    projects                          list
  POST   projects            {name}        create
  GET    projects/<pid>                    one project (also reports a running export)
  PATCH  projects/<pid>      {name?, order?: [sid]}
  DELETE projects/<pid>
  POST   projects/<pid>/upload   {sid, offset, data}      append a base64 piece to a take being uploaded
  POST   projects/<pid>/takes    {sid, duration, label?}  finish the take: remux, add it at the end
  PUT    projects/<pid>/takes   {takes: [{id, file, label, trim_start, trim_end, gain}]}   the whole edit (split,
                                    trim, reorder, delete, gain): clips point into the recorded files, never change them
  PATCH  projects/<pid>/takes/<sid>  {label?, trim_start?, trim_end?}
  DELETE projects/<pid>/takes/<sid>
  POST   projects/<pid>/export   {normalize?}             start the MP3 export (ffmpeg in the background)
"""
from __future__ import annotations

import base64
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
from pathlib import Path

ROOT = Path(os.environ.get("STUDIO_AUDIO_DIR") or Path.home() / "audios")
ID = re.compile(r"^[a-z0-9]{4,32}$")
LOCK = threading.Lock()
JOBS: dict = {}          # pid -> {"proc", "tmp", "final", "log", "started"}
MAX_TAKE = 500 * 1024 * 1024
REMUX_TIMEOUT = 600


def _num(v, default: float = 0.0) -> float:
    """A JSON number from the client; anything else is a 400, never a 500."""
    if v is None or v == "":
        return default
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        raise ValueError("bad number")
    return float(v)


def _now() -> float:
    return round(time.time(), 3)


def _dir(pid: str) -> Path:
    if not ID.match(pid or ""):
        raise ValueError("bad project id")
    d = ROOT / pid
    if not (d / "project.json").is_file():
        raise LookupError(f"no project {pid}")
    return d


def _load(d: Path) -> dict:
    return json.loads((d / "project.json").read_text())


def _save(d: Path, p: dict) -> None:
    p["updated"] = _now()
    tmp = d / "project.json.tmp"
    tmp.write_text(json.dumps(p, ensure_ascii=False, indent=1))
    tmp.replace(d / "project.json")


def _trash(path: Path, base: Path) -> None:
    t = base / ".trash"
    t.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), str(t / f"{int(time.time())}-{path.name}"))


def _safe_name(name: str) -> str:
    s = re.sub(r"[^\w\- ]+", "", name, flags=re.UNICODE).strip()
    s = re.sub(r"\s+", "-", s)
    return (s or "recording")[:80]


def _probe(path: Path) -> float:
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                              str(path)], capture_output=True, text=True, timeout=10).stdout.strip()
        return round(float(out), 3)
    except (ValueError, subprocess.SubprocessError, OSError):
        return 0.0


def _files(p: dict) -> dict:
    """Recorded file -> duration. Clips (takes) point into these files; a split makes two clips of one file."""
    files = p.setdefault("files", {})
    for t in p.get("takes", []):
        files.setdefault(t["file"], t["duration"])
    return files


def _poll_export(d: Path, p: dict) -> dict:
    """Fold a finished background export into the project (called on every read)."""
    pid = p["id"]
    job = JOBS.get(pid)
    ex = p.get("export") or {}
    if job is None:
        if ex.get("state") == "running":           # the server restarted mid-export
            ex.update(state="error", error="export interrupted (the server restarted): start it again")
            p["export"] = ex
            _save(d, p)
        return p
    rc = job["proc"].poll()
    if rc is None:
        return p
    JOBS.pop(pid, None)
    if rc == 0 and job["tmp"].is_file():
        old = ex.get("file")
        job["tmp"].replace(job["final"])
        if old and old != str(job["final"]) and Path(old).is_file() and Path(old).parent == d:
            Path(old).unlink()
        ex = {"state": "done", "file": str(job["final"]), "at": _now(), "duration": _probe(job["final"]),
              "size": job["final"].stat().st_size}
    else:
        tail = job["log"].read_text(errors="replace")[-400:] if job["log"].is_file() else ""
        job["tmp"].unlink(missing_ok=True)
        ex = {"state": "error", "error": f"ffmpeg failed ({rc}): {tail.strip()}"}
    p["export"] = ex
    _save(d, p)
    return p


def _summary(d: Path, p: dict) -> dict:
    takes = p.get("takes", [])
    total = sum(max(0.0, t["duration"] - t.get("trim_start", 0) - t.get("trim_end", 0)) for t in takes)
    return {"id": p["id"], "name": p["name"], "created": p["created"], "updated": p["updated"],
            "takes": len(takes), "duration": round(total, 1), "export": p.get("export")}


def _project(pid: str) -> tuple[Path, dict]:
    d = _dir(pid)
    return d, _poll_export(d, _load(d))


def _full(d: Path, p: dict) -> dict:
    out = dict(p)
    out["dir"] = str(d)
    out["takes"] = [{**t, "path": str(d / "takes" / t["file"])} for t in p.get("takes", [])]
    out["total"] = _summary(d, p)["duration"]
    return out


def _start_export(d: Path, p: dict, normalize: bool) -> dict:
    takes = p.get("takes", [])
    if not takes:
        raise ValueError("no take to export")
    if p["id"] in JOBS:
        return p
    cmd = ["nice", "-n", "10", "ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    parts = []
    for i, t in enumerate(takes):
        cmd += ["-i", str(d / "takes" / t["file"])]
        start = max(0.0, float(t.get("trim_start", 0)))
        end = max(start + 0.05, float(t["duration"]) - max(0.0, float(t.get("trim_end", 0))))
        parts.append(f"[{i}:a]atrim=start={start:.3f}:end={end:.3f},asetpts=N/SR/TB,volume={float(t.get('gain', 0)):.1f}dB,"
                     f"aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono[a{i}]")
    graph = ";".join(parts) + ";" + "".join(f"[a{i}]" for i in range(len(takes))) + \
        f"concat=n={len(takes)}:v=0:a=1[cat]"
    graph += ";[cat]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[out]" if normalize else ";[cat]anull[out]"
    final = d / f"{_safe_name(p['name'])}.mp3"
    tmp = d / ".export.tmp.mp3"
    log = d / ".export.log"
    cmd += ["-filter_complex", graph, "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3", str(tmp)]
    with open(log, "w") as lf:
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=lf, stdin=subprocess.DEVNULL,
                                start_new_session=True)
    JOBS[p["id"]] = {"proc": proc, "tmp": tmp, "final": final, "log": log, "started": _now()}
    p["export"] = {**(p.get("export") or {}), "state": "running", "started": _now(), "normalize": normalize}
    _save(d, p)
    return p


def _finish_take(pid: str, body: dict) -> dict:
    """Remux an uploaded take (can take a while on a long one: done outside the lock), then add it at the end."""
    d = _dir(pid)
    sid = str(body.get("sid") or "")
    if not ID.match(sid):
        raise ValueError("bad take id")
    part = d / "takes" / f"{sid}.part"
    if not part.is_file():
        raise LookupError("upload not found")
    out = d / "takes" / f"{sid}.webm"
    tmp = d / "takes" / f"{sid}.tmp.webm"
    # MediaRecorder files have no duration / cues: a stream copy rewrites the container properly
    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(part),
                        "-c", "copy", "-f", "webm", str(tmp)], capture_output=True, text=True, timeout=REMUX_TIMEOUT)
    if r.returncode != 0 or not tmp.is_file():       # Safari (mp4/aac) or anything else: re-encode
        r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(part),
                            "-c:a", "libopus", "-b:a", "160k", "-f", "webm", str(tmp)],
                           capture_output=True, text=True, timeout=REMUX_TIMEOUT)
    if r.returncode != 0:
        tmp.unlink(missing_ok=True)
        raise ValueError(f"unreadable audio file: {r.stderr[-300:]}")
    dur = _probe(tmp) or _num(body.get("duration"))
    with LOCK:
        d, p = _project(pid)
        tmp.replace(out)
        part.unlink(missing_ok=True)
        files = _files(p)
        files[out.name] = dur
        label = str(body.get("label") or "").strip()[:60] or "Take"
        take = {"id": sid, "file": out.name, "duration": dur, "label": f"{label} {len(files)}",
                "trim_start": 0, "trim_end": 0, "gain": 0, "at": _now()}
        p["takes"] = [t for t in p["takes"] if t["id"] != sid] + [take]
        _save(d, p)
        return _full(d, p)


def handle(ctx, method, path, query, body):
    body = body if isinstance(body, dict) else {}
    parts = [x for x in path.split("/") if x]
    ROOT.mkdir(parents=True, exist_ok=True)
    if method == "POST" and len(parts) == 3 and parts[0] == "projects" and parts[2] == "takes":
        return _finish_take(parts[1], body)
    with LOCK:
        if parts == ["projects"] and method == "GET":
            items = []
            for f in ROOT.glob("*/project.json"):
                try:
                    d = f.parent
                    items.append(_summary(d, _poll_export(d, _load(d))))
                except (OSError, ValueError, KeyError):
                    continue
            items.sort(key=lambda x: x["updated"], reverse=True)
            return {"projects": items, "root": str(ROOT)}

        if parts == ["projects"] and method == "POST":
            name = str(body.get("name") or "").strip()[:120] or time.strftime("Recording %Y-%m-%d %H:%M")
            pid = secrets.token_hex(4)
            d = ROOT / pid
            (d / "takes").mkdir(parents=True)
            p = {"id": pid, "name": name, "created": _now(), "takes": [], "export": None}
            _save(d, p)
            return _full(d, p)

        if len(parts) < 2 or parts[0] != "projects":
            raise LookupError(f"{method} {path}")
        d, p = _project(parts[1])
        rest = parts[2:]

        if not rest:
            if method == "GET":
                return _full(d, p)
            if method == "PATCH":
                if "name" in body:
                    p["name"] = str(body["name"]).strip()[:120] or p["name"]
                if isinstance(body.get("order"), list):
                    by = {t["id"]: t for t in p["takes"]}
                    order = [by[s] for s in body["order"] if s in by]
                    order += [t for t in p["takes"] if t["id"] not in body["order"]]
                    p["takes"] = order
                _save(d, p)
                return _full(d, p)
            if method == "DELETE":
                job = JOBS.pop(p["id"], None)
                if job:
                    job["proc"].kill()
                    job["proc"].wait(5)
                _trash(d, ROOT)
                return {"ok": True}

        if rest == ["upload"] and method == "POST":
            sid = str(body.get("sid") or "")
            if not ID.match(sid):
                raise ValueError("bad take id")
            part = d / "takes" / f"{sid}.part"
            offset = int(_num(body.get("offset")))
            data = base64.b64decode(str(body.get("data") or ""), validate=True)
            size = part.stat().st_size if part.exists() else 0
            if offset > size:
                return 409, {"error": "gap", "message": "missing piece", "size": size}
            if offset + len(data) > MAX_TAKE:
                raise ValueError("take too long")
            with open(part, "r+b" if part.exists() else "wb") as f:
                f.seek(offset)
                f.write(data)
                f.truncate()
            return {"size": offset + len(data)}

        if rest == ["takes"] and method == "PUT":
            files = _files(p)
            ats = {t["file"]: t.get("at", 0) for t in p["takes"]}
            out, seen = [], set()
            for c in body.get("takes") or []:
                f = str(c.get("file") or "")
                cid = str(c.get("id") or "")
                if f not in files or not ID.match(cid) or cid in seen:
                    raise ValueError(f"invalid clip: {cid or '?'}")
                seen.add(cid)
                dur = float(files[f])
                ts = round(min(max(0.0, _num(c.get("trim_start"))), dur), 3)
                te = round(min(max(0.0, _num(c.get("trim_end"))), dur), 3)
                if ts + te > dur - 0.02:
                    raise ValueError("a take trimmed to zero seconds")
                out.append({"id": cid, "file": f, "duration": dur, "label": str(c.get("label") or "Take")[:80],
                            "trim_start": ts, "trim_end": te,
                            "gain": round(min(max(-24.0, _num(c.get("gain"))), 24.0), 1),
                            "at": ats.get(f) or c.get("at") or _now()})
            p["takes"] = out
            _save(d, p)
            return _full(d, p)

        if len(rest) == 2 and rest[0] == "takes":
            t = next((x for x in p["takes"] if x["id"] == rest[1]), None)
            if t is None:
                raise LookupError("take not found")
            if method == "PATCH":
                if "label" in body:
                    t["label"] = str(body["label"]).strip()[:80] or t["label"]
                for k in ("trim_start", "trim_end"):
                    if k in body:
                        t[k] = round(min(max(0.0, _num(body[k])), t["duration"]), 2)
                if t["trim_start"] + t["trim_end"] > t["duration"] - 0.1:
                    raise ValueError("the trim is longer than the take")
                _save(d, p)
                return _full(d, p)
            if method == "DELETE":
                p["takes"].remove(t)
                _save(d, p)
                return _full(d, p)

        if rest == ["export"] and method == "POST":
            return _full(d, _start_export(d, p, bool(body.get("normalize"))))

    raise LookupError(f"{method} {path}")
