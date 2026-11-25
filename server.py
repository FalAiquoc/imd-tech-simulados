#!/usr/bin/env python3
"""Servidor local e banco de dados SQLite para o IMD Quest."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import sqlite3
import threading
import urllib.parse
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "simulados.db"
HTML_ENTRY = "imd_quest_plataforma_de_simulados_e_aprendizado_imd_ufrn_3.html"

DB_LOCK = threading.Lock()


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    return conn


def init_db() -> None:
    with DB_LOCK:
        conn = get_conn()
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    client_uid TEXT UNIQUE,
                    date TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    order_mode TEXT NOT NULL,
                    label TEXT,
                    total INTEGER NOT NULL,
                    correct INTEGER NOT NULL,
                    score REAL NOT NULL,
                    accuracy REAL NOT NULL,
                    elapsed_sec INTEGER NOT NULL,
                    by_subject_json TEXT NOT NULL DEFAULT '{}',
                    by_difficulty_json TEXT NOT NULL DEFAULT '{}',
                    by_lesson_json TEXT NOT NULL DEFAULT '{}'
                );

                CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date DESC);

                CREATE TABLE IF NOT EXISTS session_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    q_id TEXT NOT NULL,
                    subject TEXT NOT NULL,
                    lesson TEXT NOT NULL,
                    lesson_num INTEGER,
                    difficulty TEXT NOT NULL,
                    chosen INTEGER,
                    correct_option INTEGER NOT NULL,
                    is_correct INTEGER NOT NULL,
                    flagged INTEGER NOT NULL DEFAULT 0
                );

                CREATE INDEX IF NOT EXISTS idx_session_items_sid ON session_items(session_id);
                CREATE INDEX IF NOT EXISTS idx_session_items_qid ON session_items(q_id);

                CREATE TABLE IF NOT EXISTS question_stats (
                    q_id TEXT PRIMARY KEY,
                    subject TEXT NOT NULL,
                    lesson TEXT NOT NULL,
                    lesson_num INTEGER,
                    difficulty TEXT NOT NULL,
                    seen_count INTEGER NOT NULL DEFAULT 0,
                    correct_count INTEGER NOT NULL DEFAULT 0,
                    wrong_count INTEGER NOT NULL DEFAULT 0,
                    streak INTEGER NOT NULL DEFAULT 0,
                    last_result INTEGER NOT NULL DEFAULT 0,
                    last_answered_at TEXT
                );

                CREATE TABLE IF NOT EXISTS daily_activity (
                    day TEXT PRIMARY KEY,
                    sessions INTEGER NOT NULL DEFAULT 0,
                    answered INTEGER NOT NULL DEFAULT 0,
                    correct INTEGER NOT NULL DEFAULT 0,
                    elapsed_sec INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS active_session (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    payload_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )
            conn.commit()
        finally:
            conn.close()


def make_client_uid(sess: dict) -> str:
    if sess.get("clientUid"):
        return str(sess["clientUid"])
    raw = f"{sess.get('date','')}|{sess.get('mode','')}|{sess.get('total',0)}|{sess.get('correct',0)}|{sess.get('elapsedSec',0)}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


def insert_session_tx(conn: sqlite3.Connection, payload: dict) -> tuple[int, bool]:
    """Insere uma sessão de forma idempotente e atualiza question_stats e daily_activity."""
    uid = make_client_uid(payload)
    existing = conn.execute("SELECT id FROM sessions WHERE client_uid = ?", (uid,)).fetchone()
    if existing:
        return int(existing["id"]), False

    total = int(payload.get("total", 0))
    correct = int(payload.get("correct", 0))
    score = float(payload.get("score", 0.0))
    accuracy = float(
        payload.get("accuracy", round((correct / total) * 100, 1) if total > 0 else 0.0)
    )
    elapsed_sec = int(payload.get("elapsedSec", 0))
    date_str = str(payload.get("date") or datetime.now(timezone.utc).isoformat())

    cur = conn.execute(
        """
        INSERT INTO sessions (
            client_uid, date, mode, order_mode, label, total, correct,
            score, accuracy, elapsed_sec, by_subject_json, by_difficulty_json, by_lesson_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            uid,
            date_str,
            str(payload.get("mode", "explicado")),
            str(payload.get("orderMode", "segmentado")),
            payload.get("label"),
            total,
            correct,
            score,
            accuracy,
            elapsed_sec,
            json.dumps(payload.get("bySubject") or {}, ensure_ascii=False),
            json.dumps(payload.get("byDifficulty") or {}, ensure_ascii=False),
            json.dumps(payload.get("byLesson") or {}, ensure_ascii=False),
        ),
    )
    session_id = int(cur.lastrowid)

    items = payload.get("items") or []
    for item in items:
        is_ok = 1 if item.get("isCorrect") else 0
        q_id = str(item.get("qId", ""))
        subject = str(item.get("subject", ""))
        lesson = str(item.get("lesson", ""))
        lesson_num = item.get("lessonNum")
        difficulty = str(item.get("difficulty", "medio"))
        chosen = item.get("chosen")
        correct_opt = int(item.get("correct", 0))
        flagged = 1 if item.get("flagged") else 0

        conn.execute(
            """
            INSERT INTO session_items (
                session_id, q_id, subject, lesson, lesson_num, difficulty,
                chosen, correct_option, is_correct, flagged
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                q_id,
                subject,
                lesson,
                lesson_num,
                difficulty,
                chosen,
                correct_opt,
                is_ok,
                flagged,
            ),
        )

        if not payload.get("skipAggregateUpdates"):
            prev = conn.execute(
                "SELECT seen_count, correct_count, wrong_count, streak FROM question_stats WHERE q_id = ?",
                (q_id,),
            ).fetchone()
            if prev:
                seen_count = prev["seen_count"] + 1
                correct_count = prev["correct_count"] + is_ok
                wrong_count = prev["wrong_count"] + (0 if is_ok else 1)
                streak = (prev["streak"] + 1) if is_ok else 0
                conn.execute(
                    """
                    UPDATE question_stats
                    SET subject = ?, lesson = ?, lesson_num = ?, difficulty = ?,
                        seen_count = ?, correct_count = ?, wrong_count = ?,
                        streak = ?, last_result = ?, last_answered_at = ?
                    WHERE q_id = ?
                    """,
                    (
                        subject,
                        lesson,
                        lesson_num,
                        difficulty,
                        seen_count,
                        correct_count,
                        wrong_count,
                        streak,
                        is_ok,
                        date_str,
                        q_id,
                    ),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO question_stats (
                        q_id, subject, lesson, lesson_num, difficulty,
                        seen_count, correct_count, wrong_count, streak, last_result, last_answered_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        q_id,
                        subject,
                        lesson,
                        lesson_num,
                        difficulty,
                        1,
                        is_ok,
                        0 if is_ok else 1,
                        1 if is_ok else 0,
                        is_ok,
                        date_str,
                    ),
                )

    if not payload.get("skipAggregateUpdates"):
        day_str = str(payload.get("localDay") or date_str[:10])
        conn.execute(
            """
            INSERT INTO daily_activity (day, sessions, answered, correct, elapsed_sec)
            VALUES (?, 1, ?, ?, ?)
            ON CONFLICT(day) DO UPDATE SET
                sessions = sessions + 1,
                answered = answered + excluded.answered,
                correct = correct + excluded.correct,
                elapsed_sec = elapsed_sec + excluded.elapsed_sec
            """,
            (day_str, total, correct, elapsed_sec),
        )

    return session_id, True


def fetch_full_state(conn: sqlite3.Connection) -> dict:
    sess_rows = conn.execute(
        "SELECT * FROM sessions ORDER BY date DESC, id DESC"
    ).fetchall()
    sessions = []
    by_subject_agg: dict[str, dict[str, int]] = {}

    for r in sess_rows:
        by_sub = json.loads(r["by_subject_json"] or "{}")
        for sub_id, val in by_sub.items():
            if sub_id not in by_subject_agg:
                by_subject_agg[sub_id] = {"correct": 0, "total": 0}
            by_subject_agg[sub_id]["correct"] += int(val.get("correct", 0))
            by_subject_agg[sub_id]["total"] += int(val.get("total", 0))

        sessions.append(
            {
                "id": r["id"],
                "clientUid": r["client_uid"],
                "date": r["date"],
                "mode": r["mode"],
                "orderMode": r["order_mode"],
                "label": r["label"],
                "total": r["total"],
                "correct": r["correct"],
                "score": r["score"],
                "accuracy": r["accuracy"],
                "elapsedSec": r["elapsed_sec"],
                "bySubject": by_sub,
                "byDifficulty": json.loads(r["by_difficulty_json"] or "{}"),
                "byLesson": json.loads(r["by_lesson_json"] or "{}"),
            }
        )

    q_rows = conn.execute("SELECT * FROM question_stats").fetchall()
    question_stats = []
    wrong_ids = []
    seen_ids = []
    for qr in q_rows:
        seen_ids.append(qr["q_id"])
        if qr["last_result"] == 0:
            wrong_ids.append(qr["q_id"])
        question_stats.append(
            {
                "qId": qr["q_id"],
                "subject": qr["subject"],
                "lesson": qr["lesson"],
                "lessonNum": qr["lesson_num"],
                "difficulty": qr["difficulty"],
                "seenCount": qr["seen_count"],
                "correctCount": qr["correct_count"],
                "wrongCount": qr["wrong_count"],
                "streak": qr["streak"],
                "lastResult": qr["last_result"],
                "lastAnsweredAt": qr["last_answered_at"],
            }
        )

    d_rows = conn.execute("SELECT * FROM daily_activity ORDER BY day ASC").fetchall()
    daily_activity = [
        {
            "day": dr["day"],
            "sessions": dr["sessions"],
            "answered": dr["answered"],
            "correct": dr["correct"],
            "elapsedSec": dr["elapsed_sec"],
        }
        for dr in d_rows
    ]

    act_row = conn.execute(
        "SELECT payload_json, updated_at FROM active_session WHERE id = 1"
    ).fetchone()
    active_session = json.loads(act_row["payload_json"]) if act_row else None

    return {
        "history": sessions,
        "wrongIds": wrong_ids,
        "seenIds": seen_ids,
        "bySubject": by_subject_agg,
        "questionStats": question_stats,
        "dailyActivity": daily_activity,
        "activeSession": active_session,
    }


class IMDQuestHandler(BaseHTTPRequestHandler):
    server_version = "IMDQuestHTTP/1.0"

    def log_message(self, format: str, *args) -> None:
        # Log compacto para não poluir terminal
        return

    def send_json(self, status: int, data: object) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            self.send_json(
                HTTPStatus.OK,
                {"ok": True, "db": DB_PATH.name, "engine": "sqlite"},
            )
            return

        if path == "/api/stats":
            with DB_LOCK:
                conn = get_conn()
                try:
                    data = fetch_full_state(conn)
                finally:
                    conn.close()
            self.send_json(HTTPStatus.OK, data)
            return

        if path == "/api/export":
            with DB_LOCK:
                conn = get_conn()
                try:
                    full = fetch_full_state(conn)
                    items_rows = conn.execute(
                        "SELECT * FROM session_items ORDER BY session_id ASC, id ASC"
                    ).fetchall()
                    items_by_sid: dict[int, list] = {}
                    for ir in items_rows:
                        items_by_sid.setdefault(ir["session_id"], []).append(
                            {
                                "qId": ir["q_id"],
                                "subject": ir["subject"],
                                "lesson": ir["lesson"],
                                "lessonNum": ir["lesson_num"],
                                "difficulty": ir["difficulty"],
                                "chosen": ir["chosen"],
                                "correct": ir["correct_option"],
                                "isCorrect": bool(ir["is_correct"]),
                                "flagged": bool(ir["flagged"]),
                            }
                        )
                    for s in full["history"]:
                        s["items"] = items_by_sid.get(s["id"], [])
                finally:
                    conn.close()

            export_payload = {
                "app": "IMD Quest",
                "version": 1,
                "exportedAt": datetime.now(timezone.utc).isoformat(),
                "sessions": full["history"],
                "questionStats": full["questionStats"],
                "dailyActivity": full["dailyActivity"],
            }
            self.send_json(HTTPStatus.OK, export_payload)
            return

        # Arquivos estáticos
        rel = HTML_ENTRY if path in ("/", "") else urllib.parse.unquote(path.lstrip("/"))
        target = (BASE_DIR / rel).resolve()
        try:
            target.relative_to(BASE_DIR)
        except ValueError:
            self.send_error(HTTPStatus.FORBIDDEN, "Acesso negado")
            return

        if target.suffix.lower() in (".db", ".db-wal", ".db-shm", ".py", ".bat"):
            self.send_error(HTTPStatus.FORBIDDEN, "Arquivo protegido")
            return

        if not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "Arquivo não encontrado")
            return

        mime, _ = mimetypes.guess_type(str(target))
        content = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{mime or 'application/octet-stream'}; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        try:
            payload = self.read_json_body()
        except Exception as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return

        if path == "/api/sessions":
            with DB_LOCK:
                conn = get_conn()
                try:
                    session_id, created = insert_session_tx(conn, payload)
                    conn.execute("DELETE FROM active_session WHERE id = 1")
                    conn.commit()
                finally:
                    conn.close()
            self.send_json(
                HTTPStatus.CREATED if created else HTTPStatus.OK,
                {"ok": True, "id": session_id, "created": created},
            )
            return

        if path == "/api/import":
            sessions = payload.get("sessions") or payload.get("history") or []
            q_stats = payload.get("questionStats") or []
            daily = payload.get("dailyActivity") or []
            imported_sessions = 0

            with DB_LOCK:
                conn = get_conn()
                try:
                    # Se vier com questionStats e dailyActivity explícitos, importamos sessões sem duplicar agregados
                    has_explicit_agg = bool(q_stats or daily)
                    for sess in sessions:
                        sess_copy = dict(sess)
                        if has_explicit_agg:
                            sess_copy["skipAggregateUpdates"] = True
                        _, created = insert_session_tx(conn, sess_copy)
                        if created:
                            imported_sessions += 1

                    for qs in q_stats:
                        q_id = str(qs.get("qId", ""))
                        if not q_id:
                            continue
                        conn.execute(
                            """
                            INSERT INTO question_stats (
                                q_id, subject, lesson, lesson_num, difficulty,
                                seen_count, correct_count, wrong_count, streak, last_result, last_answered_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(q_id) DO UPDATE SET
                                seen_count = MAX(seen_count, excluded.seen_count),
                                correct_count = MAX(correct_count, excluded.correct_count),
                                wrong_count = MAX(wrong_count, excluded.wrong_count),
                                streak = excluded.streak,
                                last_result = excluded.last_result,
                                last_answered_at = COALESCE(excluded.last_answered_at, last_answered_at)
                            """,
                            (
                                q_id,
                                str(qs.get("subject", "")),
                                str(qs.get("lesson", "")),
                                qs.get("lessonNum"),
                                str(qs.get("difficulty", "medio")),
                                int(qs.get("seenCount", 0)),
                                int(qs.get("correctCount", 0)),
                                int(qs.get("wrongCount", 0)),
                                int(qs.get("streak", 0)),
                                int(qs.get("lastResult", 0)),
                                qs.get("lastAnsweredAt"),
                            ),
                        )

                    for d in daily:
                        day = str(d.get("day", ""))
                        if not day:
                            continue
                        conn.execute(
                            """
                            INSERT INTO daily_activity (day, sessions, answered, correct, elapsed_sec)
                            VALUES (?, ?, ?, ?, ?)
                            ON CONFLICT(day) DO UPDATE SET
                                sessions = MAX(sessions, excluded.sessions),
                                answered = MAX(answered, excluded.answered),
                                correct = MAX(correct, excluded.correct),
                                elapsed_sec = MAX(elapsed_sec, excluded.elapsed_sec)
                            """,
                            (
                                day,
                                int(d.get("sessions", 0)),
                                int(d.get("answered", 0)),
                                int(d.get("correct", 0)),
                                int(d.get("elapsedSec", 0)),
                            ),
                        )

                    conn.commit()
                finally:
                    conn.close()

            self.send_json(
                HTTPStatus.OK,
                {"ok": True, "importedSessions": imported_sessions},
            )
            return

        self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Endpoint não encontrado"})

    def do_PUT(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/active-session":
            try:
                payload = self.read_json_body()
            except Exception as exc:
                self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
                return

            now = datetime.now(timezone.utc).isoformat()
            with DB_LOCK:
                conn = get_conn()
                try:
                    conn.execute(
                        """
                        INSERT INTO active_session (id, payload_json, updated_at)
                        VALUES (1, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            payload_json = excluded.payload_json,
                            updated_at = excluded.updated_at
                        """,
                        (json.dumps(payload, ensure_ascii=False), now),
                    )
                    conn.commit()
                finally:
                    conn.close()
            self.send_json(HTTPStatus.OK, {"ok": True})
            return

        self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Endpoint não encontrado"})

    def do_DELETE(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/active-session":
            with DB_LOCK:
                conn = get_conn()
                try:
                    conn.execute("DELETE FROM active_session WHERE id = 1")
                    conn.commit()
                finally:
                    conn.close()
            self.send_json(HTTPStatus.OK, {"ok": True})
            return

        if parsed.path == "/api/stats":
            with DB_LOCK:
                conn = get_conn()
                try:
                    conn.executescript(
                        """
                        DELETE FROM session_items;
                        DELETE FROM sessions;
                        DELETE FROM question_stats;
                        DELETE FROM daily_activity;
                        DELETE FROM active_session;
                        """
                    )
                    conn.commit()
                finally:
                    conn.close()
            self.send_json(HTTPStatus.OK, {"ok": True})
            return

        self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Endpoint não encontrado"})


def main() -> None:
    parser = argparse.ArgumentParser(description="Servidor local IMD Quest com SQLite")
    parser.add_argument("--host", default="127.0.0.1", help="Endereço de escuta")
    parser.add_argument("--port", type=int, default=8765, help="Porta HTTP")
    args = parser.parse_args()

    init_db()
    server = ThreadingHTTPServer((args.host, args.port), IMDQuestHandler)
    print(f"IMD Quest ativo em http://{args.host}:{args.port} (Banco: {DB_PATH.name})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nEncerrando servidor IMD Quest.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
