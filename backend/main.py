from datetime import datetime, timezone
from datetime import timedelta
from email.message import EmailMessage
from pathlib import Path
import hashlib
import json
import logging
import os
import secrets
import smtplib
import sqlite3
from typing import Any
from urllib.parse import quote

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr

# Always keep the database beside this main.py file.
# This prevents a second empty DB being created when Uvicorn is started
# from the frontend folder or another working directory.
BASE_DIR = Path(__file__).resolve().parent
DB = BASE_DIR / "block_quest.db"

app = FastAPI(title="TileTuck API", version="1.0.0")
logger = logging.getLogger(__name__)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:5501",
        "http://127.0.0.1:5501",
        "https://localhost",
        "http://localhost",
        "capacitor://localhost",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def db():
    con = sqlite3.connect(str(DB), timeout=10)
    con.row_factory = sqlite3.Row
    return con


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_db():
    con = db()
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          dob TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          avatar TEXT,
          lives INTEGER NOT NULL DEFAULT 5,
          hammer INTEGER NOT NULL DEFAULT 1,
          break_tool INTEGER NOT NULL DEFAULT 1,
          hint INTEGER NOT NULL DEFAULT 1,
          best_stage INTEGER NOT NULL DEFAULT 1,
          best_level INTEGER NOT NULL DEFAULT 1,
          best_score INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS scores (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          stage INTEGER NOT NULL DEFAULT 1,
          level INTEGER NOT NULL,
          score INTEGER NOT NULL,
          elapsed_seconds INTEGER NOT NULL,
          submitted_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS game_progress (
          user_id INTEGER PRIMARY KEY,
                    stage INTEGER NOT NULL DEFAULT 1,
          level INTEGER NOT NULL DEFAULT 0,
          score INTEGER NOT NULL DEFAULT 0,
          lives INTEGER NOT NULL DEFAULT 5,
          hammer INTEGER NOT NULL DEFAULT 1,
          break_tool INTEGER NOT NULL DEFAULT 1,
          hint INTEGER NOT NULL DEFAULT 1,
          board_json TEXT,
          pieces_json TEXT,
          race_json TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

                CREATE TABLE IF NOT EXISTS active_players (
                    user_id INTEGER PRIMARY KEY,
                    stage INTEGER NOT NULL,
                    level INTEGER NOT NULL,
                    last_seen TEXT NOT NULL
                );
        """
    )
    for table, column, definition in (
        ("users", "best_stage", "INTEGER NOT NULL DEFAULT 1"),
        ("scores", "stage", "INTEGER NOT NULL DEFAULT 1"),
        ("game_progress", "stage", "INTEGER NOT NULL DEFAULT 1"),
    ):
        columns = {row["name"] for row in con.execute(f"PRAGMA table_info({table})")}
        if column not in columns:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
    con.commit()
    con.close()


init_db()


class RegisterRequest(BaseModel):
    username: str
    email: EmailStr
    dob: str
    password: str
    avatar: str | None = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class PasswordResetRequest(BaseModel):
    email: EmailStr


class PasswordResetConfirm(BaseModel):
    token: str
    new_password: str


class ScoreRequest(BaseModel):
    token: str
    stage: int = 1
    level: int
    score: int
    elapsed_seconds: int


class ProgressRequest(BaseModel):
    token: str
    stage: int = 1
    level: int
    score: int
    lives: int
    hammer: int
    break_tool: int
    hint: int
    board: list[list[Any]]
    pieces: list[dict[str, Any]]
    race: dict[str, Any] | None = None


class ActivityRequest(BaseModel):
    token: str
    stage: int
    level: int


def ph(password: str) -> str:
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def smtp_settings():
    host = os.getenv("SMTP_HOST")
    username = os.getenv("SMTP_USERNAME")
    password = os.getenv("SMTP_PASSWORD")
    sender = os.getenv("SMTP_FROM") or username
    if not all((host, username, password, sender)):
        raise HTTPException(
            status_code=503,
            detail=(
            "Password recovery is not configured. Set SMTP_HOST, SMTP_USERNAME, "
            "SMTP_PASSWORD, and SMTP_FROM."
            ),
        )
    return host, username, password, sender


def send_password_reset_email(recipient: str, reset_url: str):
    host, username, password, sender = smtp_settings()

    message = EmailMessage()
    message["Subject"] = "Reset your TileTuck password"
    message["From"] = sender
    message["To"] = recipient
    message.set_content(
        "Use the link below to reset your TileTuck password. "
        "This link expires in 30 minutes and can only be used once.\n\n"
        f"{reset_url}\n\n"
        "If you did not request this, you can ignore this email."
    )

    port = int(os.getenv("SMTP_PORT", "587"))
    timeout = 15
    if os.getenv("SMTP_USE_SSL", "false").lower() == "true":
        with smtplib.SMTP_SSL(host, port, timeout=timeout) as server:
            server.login(username, password)
            server.send_message(message)
    else:
        with smtplib.SMTP(host, port, timeout=timeout) as server:
            server.starttls()
            server.login(username, password)
            server.send_message(message)


def user_from_token(token: str):
    if not token:
        return None
    con = db()
    row = con.execute(
        """
        SELECT u.*
        FROM users u
        JOIN sessions s ON s.user_id = u.id
        WHERE s.token = ?
        """,
        (token,),
    ).fetchone()
    con.close()
    return row


def public_user(row):
    if not row:
        return None
    data = dict(row)
    data.pop("password_hash", None)
    return data


def require_user(token: str):
    row = user_from_token(token)
    if not row:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    return row


@app.get("/")
def root():
    return {
        "message": "TileTuck API Running Successfully",
        "version": "1.0.0",
        "database": str(DB),
    }


@app.get("/api/health")
def health():
    con = db()
    con.execute("SELECT 1").fetchone()
    con.close()
    return {"ok": True, "service": "TileTuck API", "version": "1.0.0"}


@app.post("/api/users/register")
def register(req: RegisterRequest):
    username = req.username.strip()
    email = str(req.email).strip().lower()
    password = req.password

    if not username:
        raise HTTPException(status_code=400, detail="Username is required")
    if len(username) > 20:
        raise HTTPException(status_code=400, detail="Username must be 20 characters or less")
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    if not req.dob:
        raise HTTPException(status_code=400, detail="Date of birth is required")

    con = db()
    try:
        cur = con.execute(
            """
            INSERT INTO users(
              username,email,dob,password_hash,avatar,created_at
            ) VALUES(?,?,?,?,?,?)
            """,
            (username, email, req.dob, ph(password), req.avatar, now_iso()),
        )
        uid = cur.lastrowid

        con.execute(
            """
            INSERT INTO game_progress(
              user_id,level,score,lives,hammer,break_tool,hint,updated_at
            ) VALUES(?,?,?,?,?,?,?,?)
            """,
            (uid, 0, 0, 5, 1, 1, 1, now_iso()),
        )

        token = secrets.token_urlsafe(32)
        con.execute(
            "INSERT INTO sessions(token,user_id,created_at) VALUES(?,?,?)",
            (token, uid, now_iso()),
        )
        con.commit()

        row = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    except sqlite3.IntegrityError:
        con.rollback()
        con.close()
        raise HTTPException(status_code=409, detail="Email already registered")
    finally:
        try:
            con.close()
        except Exception:
            pass

    return {"token": token, "user": public_user(row)}


@app.post("/api/users/login")
def login(req: LoginRequest):
    email = str(req.email).strip().lower()
    con = db()
    row = con.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()

    if not row or row["password_hash"] != ph(req.password):
        con.close()
        raise HTTPException(status_code=401, detail="Invalid email or password")

    token = secrets.token_urlsafe(32)
    con.execute(
        "INSERT INTO sessions(token,user_id,created_at) VALUES(?,?,?)",
        (token, row["id"], now_iso()),
    )
    con.commit()
    con.close()

    return {"token": token, "user": public_user(row)}


@app.post("/api/users/password-reset/request")
def request_password_reset(req: PasswordResetRequest):
    smtp_settings()
    email = str(req.email).strip().lower()
    con = db()
    row = con.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
    if not row:
        con.close()
        return {"message": "If that email matches an account, a reset link will be sent."}

    raw_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc)
    expires_at = (now + timedelta(minutes=30)).isoformat()
    con.execute("DELETE FROM password_reset_tokens WHERE user_id=?", (row["id"],))
    con.execute(
        "INSERT INTO password_reset_tokens(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
        (token_hash, row["id"], expires_at, now.isoformat()),
    )
    con.commit()
    con.close()

    app_url = os.getenv("PUBLIC_APP_URL", "http://localhost:5500").rstrip("/")
    reset_url = f"{app_url}/?reset_token={quote(raw_token)}"
    try:
        send_password_reset_email(email, reset_url)
    except Exception:
        logger.exception("Password reset email delivery failed")
        con = db()
        con.execute("DELETE FROM password_reset_tokens WHERE token_hash=?", (token_hash,))
        con.commit()
        con.close()

    return {"message": "If that email matches an account, a reset link will be sent."}


@app.post("/api/users/password-reset/confirm")
def confirm_password_reset(req: PasswordResetConfirm):
    if len(req.new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    token_hash = hashlib.sha256(req.token.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc).isoformat()
    con = db()
    row = con.execute(
        "SELECT user_id FROM password_reset_tokens WHERE token_hash=? AND expires_at>?",
        (token_hash, now),
    ).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=400, detail="This reset link is invalid or expired")

    con.execute("UPDATE users SET password_hash=? WHERE id=?", (ph(req.new_password), row["user_id"]))
    con.execute("DELETE FROM password_reset_tokens WHERE user_id=?", (row["user_id"],))
    con.execute("DELETE FROM sessions WHERE user_id=?", (row["user_id"],))
    con.commit()
    con.close()
    return {"message": "Password updated. You can now log in."}


@app.post("/api/users/logout")
def logout(token: str):
    con = db()
    con.execute("DELETE FROM sessions WHERE token=?", (token,))
    con.commit()
    con.close()
    return {"ok": True}


@app.get("/api/users/me")
def me(token: str):
    return public_user(require_user(token))


@app.get("/api/users/progress")
def get_progress(token: str):
    row = require_user(token)
    con = db()
    progress = con.execute(
        "SELECT * FROM game_progress WHERE user_id=?", (row["id"],)
    ).fetchone()
    con.close()

    if not progress:
        return {"progress": None}

    result = dict(progress)
    for src, dst in (
        ("board_json", "board"),
        ("pieces_json", "pieces"),
        ("race_json", "race"),
    ):
        raw = result.pop(src, None)
        try:
            result[dst] = json.loads(raw) if raw else None
        except (TypeError, ValueError, json.JSONDecodeError):
            result[dst] = None

    return {"progress": result}


@app.put("/api/users/progress")
def save_progress(req: ProgressRequest):
    row = require_user(req.token)

    if req.stage < 1:
        raise HTTPException(status_code=400, detail="Invalid stage")
    if not 0 <= req.level <= 9:
        raise HTTPException(status_code=400, detail="Invalid level")
    if req.score < 0:
        raise HTTPException(status_code=400, detail="Invalid score")
    if not 0 <= req.lives <= 5:
        raise HTTPException(status_code=400, detail="Invalid lives")
    if any(not isinstance(v, int) or v < 0 for v in (req.hammer, req.break_tool, req.hint)):
        raise HTTPException(status_code=400, detail="Invalid tool count")

    # Basic shape protection. The frontend is still the source of the puzzle rules,
    # but malformed requests should not be stored as valid progress.
    if not isinstance(req.board, list) or len(req.board) > 8:
        raise HTTPException(status_code=400, detail="Invalid board")
    if not isinstance(req.pieces, list) or len(req.pieces) > 100:
        raise HTTPException(status_code=400, detail="Invalid pieces")

    now = now_iso()
    con = db()
    con.execute(
        """
        INSERT INTO game_progress(
                    user_id,stage,level,score,lives,hammer,break_tool,hint,
          board_json,pieces_json,race_json,updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET
                    stage=excluded.stage,
          level=excluded.level,
          score=excluded.score,
          lives=excluded.lives,
          hammer=excluded.hammer,
          break_tool=excluded.break_tool,
          hint=excluded.hint,
          board_json=excluded.board_json,
          pieces_json=excluded.pieces_json,
          race_json=excluded.race_json,
          updated_at=excluded.updated_at
        """,
        (
            row["id"], req.stage, req.level, req.score, req.lives,
            req.hammer, req.break_tool, req.hint,
            json.dumps(req.board, separators=(",", ":")),
            json.dumps(req.pieces, separators=(",", ":")),
            json.dumps(req.race or {}, separators=(",", ":")),
            now,
        ),
    )
    con.execute(
        """
                UPDATE users SET
                    lives=?,hammer=?,break_tool=?,hint=?,
                    best_stage=CASE WHEN ? > best_stage THEN ? ELSE best_stage END,
                    best_level=CASE
                        WHEN ? > best_stage THEN ? + 1
                        WHEN ? = best_stage AND ? + 1 > best_level THEN ? + 1
                        ELSE best_level
                    END,
                    best_score=MAX(best_score,?)
                WHERE id=?
        """,
                (
                        req.lives, req.hammer, req.break_tool, req.hint,
                        req.stage, req.stage,
                        req.stage, req.level,
                        req.stage, req.level, req.level,
                        req.score, row["id"],
                ),
    )
    con.commit()
    con.close()

    return {"ok": True, "saved_at": now}


@app.post("/api/leaderboard/submit")
def submit_score(req: ScoreRequest):
    row = require_user(req.token)

    if req.stage < 1:
        raise HTTPException(status_code=400, detail="Invalid stage")
    if not 1 <= req.level <= 10:
        raise HTTPException(status_code=400, detail="Invalid level")
    if req.score < 0 or req.elapsed_seconds < 0:
        raise HTTPException(status_code=400, detail="Invalid score data")

    con = db()
    con.execute(
        """
        INSERT INTO scores(user_id,stage,level,score,elapsed_seconds,submitted_at)
        VALUES(?,?,?,?,?,?)
        """,
        (row["id"], req.stage, req.level, req.score, req.elapsed_seconds, now_iso()),
    )
    con.execute(
        """
        UPDATE users SET
                    best_stage=CASE WHEN ? > best_stage THEN ? ELSE best_stage END,
                    best_level=CASE
                        WHEN ? > best_stage THEN ?
                        WHEN ? = best_stage AND ? > best_level THEN ?
                        ELSE best_level
                    END,
                    best_score=MAX(best_score,?)
        WHERE id=?
        """,
                (
                        req.stage, req.stage,
                        req.stage, req.level,
                        req.stage, req.level, req.level,
                        req.score, row["id"],
                ),
    )
    con.commit()
    con.close()
    return {"ok": True}


@app.get("/api/leaderboard")
def leaderboard():
    con = db()
    rows = con.execute(
        """
                SELECT
                    u.username,
                    u.best_stage AS stage,
                    u.best_level AS level,
                    u.best_score AS score,
                    COALESCE(MIN(s.elapsed_seconds), 0) AS elapsed_seconds
                FROM users u
                LEFT JOIN scores s ON s.user_id=u.id
                GROUP BY u.id
                ORDER BY u.best_stage DESC, u.best_level DESC, u.best_score DESC,
                    elapsed_seconds ASC, u.username COLLATE NOCASE ASC
        LIMIT 50
        """
    ).fetchall()
    con.close()
    return {"items": [dict(r) for r in rows]}


@app.get("/api/dashboard")
def dashboard(token: str, stage: int | None = None):
    user = require_user(token)
    con = db()
    progress = con.execute(
        "SELECT * FROM game_progress WHERE user_id=?", (user["id"],)
    ).fetchone()

    current_stage = int(progress["stage"] if progress else user["best_stage"] or 1)
    current_level = int(progress["level"] + 1 if progress else user["best_level"] or 1)
    selected_stage = max(1, int(stage or current_stage))

    try:
        board = json.loads(progress["board_json"] or "[]") if progress else []
    except (TypeError, ValueError, json.JSONDecodeError):
        board = []
    current_complete = bool(board) and all(
        cell is not None for row in board for cell in row
    )

    completed_levels: dict[int, set[int]] = {}
    for row in con.execute(
        "SELECT DISTINCT stage,level FROM scores WHERE user_id=?",
        (user["id"],),
    ):
        completed_levels.setdefault(int(row["stage"]), set()).add(int(row["level"]))
    for previous_stage in range(1, current_stage):
        completed_levels[previous_stage] = set(range(1, 11))
    current_completions = completed_levels.setdefault(current_stage, set())
    current_completions.update(range(1, min(current_level, 11)))
    if current_complete:
        current_completions.add(current_level)
    if current_complete and current_level >= 10:
        resume_stage, resume_level = current_stage + 1, 1
    elif current_complete:
        resume_stage, resume_level = current_stage, current_level + 1
    else:
        resume_stage, resume_level = current_stage, current_level

    global_stage = con.execute(
        """
        SELECT COALESCE(MAX(stage), 1) AS value FROM (
          SELECT stage FROM scores
          UNION ALL SELECT stage FROM game_progress
          UNION ALL SELECT best_stage AS stage FROM users
        )
        """
    ).fetchone()["value"]

    players = con.execute(
        """
        SELECT
          u.username,
                    CASE
                        WHEN ap.user_id IS NOT NULL THEN ap.level
                        WHEN p.stage=? THEN p.level+1
                        ELSE COALESCE(MAX(s.level), 0)
                    END AS level,
          CASE
            WHEN ap.user_id IS NOT NULL THEN 'Playing now'
            WHEN p.stage=? AND p.board_json IS NOT NULL THEN 'On this trail'
            WHEN MAX(s.level)>=10 THEN 'Stage cleared'
            ELSE 'Played this stage'
          END AS status,
          COALESCE(MAX(s.score), 0) AS score,
          CASE WHEN ap.user_id IS NOT NULL THEN 1 ELSE 0 END AS playing
        FROM users u
        LEFT JOIN game_progress p ON p.user_id=u.id
            LEFT JOIN active_players ap ON ap.user_id=u.id AND ap.stage=? AND ap.last_seen>=?
        LEFT JOIN scores s ON s.user_id=u.id AND s.stage=?
            WHERE ap.user_id IS NOT NULL OR (p.stage=? AND p.board_json IS NOT NULL) OR s.id IS NOT NULL
        GROUP BY u.id
        ORDER BY playing DESC, level DESC, score DESC, u.username COLLATE NOCASE ASC
        """,
        (
            selected_stage,
            selected_stage,
            selected_stage,
            (datetime.now(timezone.utc) - timedelta(minutes=3)).isoformat(),
            selected_stage,
            selected_stage,
        ),
    ).fetchall()
    con.close()

    return {
        "username": user["username"],
        "current_stage": current_stage,
        "current_level": current_level,
        "current_complete": current_complete,
        "resume_stage": resume_stage,
        "resume_level": resume_level,
        "stage_count": max(int(global_stage), current_stage + 1),
        "completed_levels": {
            str(stage_number): sorted(levels)
            for stage_number, levels in completed_levels.items()
        },
        "best_stage": int(user["best_stage"] or 1),
        "best_level": int(user["best_level"] or 1),
        "best_score": int(user["best_score"] or 0),
        "selected_stage": selected_stage,
        "players": [dict(row) for row in players],
    }


@app.post("/api/activity")
def update_activity(req: ActivityRequest):
    user = require_user(req.token)
    if req.stage < 1 or req.level < 1 or req.level > 10:
        raise HTTPException(status_code=400, detail="Invalid stage progress")
    con = db()
    con.execute(
        """
        INSERT INTO active_players(user_id,stage,level,last_seen) VALUES(?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET
          stage=excluded.stage,
          level=excluded.level,
          last_seen=excluded.last_seen
        """,
        (user["id"], req.stage, req.level, now_iso()),
    )
    con.commit()
    con.close()
    return {"ok": True}
