import os
import time
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request

from scheduler import build_plan, parse_date

BASE_DIR = Path(__file__).parent
DB_PATH = BASE_DIR / "planner.db"

COLOR_SLOTS = 8 

# Hosts run on UTC. Use Indian time so schedules and reminders match the student.
os.environ["TZ"] = "Asia/Kolkata"
if hasattr(time, "tzset"):
    time.tzset()

app = Flask(__name__)


# ---------- database helpers ----------
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS subjects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            exam_date TEXT NOT NULL,
            difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
            topics TEXT DEFAULT '',
            color INTEGER
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
            date TEXT NOT NULL,
            start_time TEXT NOT NULL,
            minutes INTEGER NOT NULL,
            done INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
            due_date TEXT,
            done INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS pomodoros (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
            minutes INTEGER NOT NULL,
            date TEXT NOT NULL,
            finished_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS decks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
            front TEXT NOT NULL,
            back TEXT NOT NULL,
            known INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        INSERT OR IGNORE INTO settings (key, value) VALUES ('daily_hours', '4');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('start_time', '18:00');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('reminder_lead', '10');
        """
    )
    # Upgrade databases created before subjects had a colour slot
    columns = [row[1] for row in db.execute("PRAGMA table_info(subjects)")]
    if "color" not in columns:
        db.execute("ALTER TABLE subjects ADD COLUMN color INTEGER")
    session_cols = [row[1] for row in db.execute("PRAGMA table_info(sessions)")]
    if "done_at" not in session_cols:
        db.execute("ALTER TABLE sessions ADD COLUMN done_at TEXT")
    missing = db.execute("SELECT id FROM subjects WHERE color IS NULL ORDER BY id").fetchall()
    for index, row in enumerate(missing):
        db.execute("UPDATE subjects SET color = ? WHERE id = ?", (index % COLOR_SLOTS, row[0]))
    db.commit()
    db.close()


def next_color(db):
    """Lowest unused colour slot, so a subject keeps its colour for life."""
    used = {r[0] for r in db.execute("SELECT color FROM subjects") if r[0] is not None}
    for slot in range(COLOR_SLOTS):
        if slot not in used:
            return slot
    return len(used) % COLOR_SLOTS


def get_settings(db):
    rows = db.execute("SELECT key, value FROM settings").fetchall()
    s = {r["key"]: r["value"] for r in rows}
    return {
        "daily_hours": float(s["daily_hours"]),
        "start_time": s["start_time"],
        "reminder_lead": int(s.get("reminder_lead", 10)),
    }


def regenerate_plan(db):
    """Delete future unfinished sessions and rebuild them."""
    today = date.today()
    settings = get_settings(db)

    subjects = [
        {"id": r["id"], "exam_date": parse_date(r["exam_date"]), "difficulty": r["difficulty"]}
        for r in db.execute("SELECT * FROM subjects")
    ]

    done_today = db.execute(
        "SELECT COALESCE(SUM(minutes), 0) FROM sessions WHERE date = ? AND done = 1",
        (today.isoformat(),),
    ).fetchone()[0]

    db.execute("DELETE FROM sessions WHERE done = 0 AND date >= ?", (today.isoformat(),))

    plan = build_plan(
        subjects,
        daily_minutes=int(settings["daily_hours"] * 60),
        start_time=settings["start_time"],
        today=today,
        minutes_done_today=done_today,
    )
    db.executemany(
        "INSERT INTO sessions (subject_id, date, start_time, minutes) VALUES (?, ?, ?, ?)",
        [(p["subject_id"], p["date"], p["start_time"], p["minutes"]) for p in plan],
    )
    db.commit()


# ---------- pages ----------
@app.route("/")
def index():
    return render_template("index.html")


# ---------- API: subjects ----------
@app.get("/api/subjects")
def list_subjects():
    rows = get_db().execute("SELECT * FROM subjects ORDER BY exam_date").fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/subjects")
def add_subject():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    exam_date = data.get("exam_date") or ""
    try:
        difficulty = int(data.get("difficulty", 3))
        exam = parse_date(exam_date)
    except (ValueError, TypeError):
        return jsonify(error="Invalid date or difficulty"), 400

    if not name:
        return jsonify(error="Subject name is required"), 400
    if not 1 <= difficulty <= 5:
        return jsonify(error="Difficulty must be between 1 and 5"), 400
    if exam <= date.today():
        return jsonify(error="Exam date must be in the future"), 400

    db = get_db()
    db.execute(
        "INSERT INTO subjects (name, exam_date, difficulty, topics, color) VALUES (?, ?, ?, ?, ?)",
        (name, exam_date, difficulty, (data.get("topics") or "").strip(), next_color(db)),
    )
    db.commit()
    regenerate_plan(db)
    return jsonify(ok=True), 201


@app.delete("/api/subjects/<int:subject_id>")
def delete_subject(subject_id):
    db = get_db()
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("DELETE FROM sessions WHERE subject_id = ?", (subject_id,))
    for table in ("todos", "pomodoros", "decks"):
        db.execute(f"UPDATE {table} SET subject_id = NULL WHERE subject_id = ?", (subject_id,))
    db.execute("DELETE FROM subjects WHERE id = ?", (subject_id,))
    db.commit()
    regenerate_plan(db)
    return jsonify(ok=True)


# ---------- API: to-do list ----------
def todo_rows(db):
    rows = db.execute(
        """
        SELECT t.id, t.title, t.due_date, t.done, t.subject_id,
               sub.name AS subject, sub.color
        FROM todos t LEFT JOIN subjects sub ON sub.id = t.subject_id
        ORDER BY t.done, t.due_date IS NULL, t.due_date, t.id
        """
    ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/todos")
def list_todos():
    return jsonify(todo_rows(get_db()))


@app.post("/api/todos")
def add_todo():
    data = request.get_json(force=True)
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify(error="Write the task first"), 400
    if len(title) > 120:
        return jsonify(error="Keep the task under 120 characters"), 400

    due = data.get("due_date") or None
    if due:
        try:
            parse_date(due)
        except (ValueError, TypeError):
            return jsonify(error="Invalid due date"), 400

    db = get_db()
    subject_id = data.get("subject_id") or None
    if subject_id is not None:
        try:
            subject_id = int(subject_id)
        except (ValueError, TypeError):
            return jsonify(error="Invalid subject"), 400
        if not db.execute("SELECT 1 FROM subjects WHERE id = ?", (subject_id,)).fetchone():
            return jsonify(error="That subject no longer exists"), 400

    db.execute(
        "INSERT INTO todos (title, subject_id, due_date) VALUES (?, ?, ?)",
        (title, subject_id, due),
    )
    db.commit()
    return jsonify(ok=True), 201


@app.patch("/api/todos/<int:todo_id>")
def update_todo(todo_id):
    data = request.get_json(force=True)
    db = get_db()
    if "done" in data:
        db.execute("UPDATE todos SET done = ? WHERE id = ?", (1 if data["done"] else 0, todo_id))
    if "title" in data:
        title = (data["title"] or "").strip()
        if not title or len(title) > 120:
            return jsonify(error="Task must be 1 to 120 characters"), 400
        db.execute("UPDATE todos SET title = ? WHERE id = ?", (title, todo_id))
    db.commit()
    return jsonify(ok=True)


@app.delete("/api/todos/<int:todo_id>")
def delete_todo(todo_id):
    db = get_db()
    db.execute("DELETE FROM todos WHERE id = ?", (todo_id,))
    db.commit()
    return jsonify(ok=True)


@app.delete("/api/todos")
def clear_done_todos():
    """DELETE /api/todos?done=1 removes every completed task."""
    db = get_db()
    if request.args.get("done") == "1":
        db.execute("DELETE FROM todos WHERE done = 1")
        db.commit()
    return jsonify(ok=True)


# ---------- API: settings ----------
@app.get("/api/settings")
def read_settings():
    return jsonify(get_settings(get_db()))


@app.put("/api/settings")
def update_settings():
    data = request.get_json(force=True)
    try:
        hours = float(data["daily_hours"])
        datetime.strptime(data["start_time"], "%H:%M")
    except (KeyError, ValueError, TypeError):
        return jsonify(error="Invalid hours or start time"), 400
    if not 0.5 <= hours <= 16:
        return jsonify(error="Daily hours must be between 0.5 and 16"), 400
    try:
        lead = int(data.get("reminder_lead", 10))
    except (ValueError, TypeError):
        return jsonify(error="Reminder time must be a whole number of minutes"), 400
    if not 0 <= lead <= 120:
        return jsonify(error="Reminder time must be between 0 and 120 minutes"), 400

    db = get_db()
    db.execute("INSERT OR REPLACE INTO settings VALUES ('reminder_lead', ?)", (str(lead),))
    db.execute("INSERT OR REPLACE INTO settings VALUES ('daily_hours', ?)", (str(hours),))
    db.execute("INSERT OR REPLACE INTO settings VALUES ('start_time', ?)", (data["start_time"],))
    db.commit()
    regenerate_plan(db)
    return jsonify(ok=True)


# ---------- API: schedule ----------
@app.get("/api/schedule")
def schedule():
    rows = get_db().execute(
        """
        SELECT s.id, s.subject_id, s.date, s.start_time, s.minutes, s.done,
               sub.name AS subject, sub.difficulty, sub.exam_date, sub.color
        FROM sessions s JOIN subjects sub ON sub.id = s.subject_id
        ORDER BY s.date, s.start_time
        """
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.get("/api/dashboard")
def dashboard():
    """Everything the dashboard needs in one call: KPIs, per-subject stats, workload."""
    db = get_db()
    today = date.today()
    today_iso = today.isoformat()

    subjects = db.execute("SELECT * FROM subjects ORDER BY exam_date, id").fetchall()
    sessions = [
        dict(r)
        for r in db.execute(
            """
            SELECT s.id, s.subject_id, s.date, s.start_time, s.minutes, s.done, s.done_at,
                   sub.name AS subject, sub.color
            FROM sessions s JOIN subjects sub ON sub.id = s.subject_id
            ORDER BY s.date, s.start_time
            """
        )
    ]

    # Per-subject totals
    totals = {s["id"]: {"planned": 0, "done": 0} for s in subjects}
    for s in sessions:
        totals[s["subject_id"]]["planned"] += s["minutes"]
        if s["done"]:
            totals[s["subject_id"]]["done"] += s["minutes"]

    subject_stats = []
    for s in subjects:
        planned, done = totals[s["id"]]["planned"], totals[s["id"]]["done"]
        subject_stats.append({
            "id": s["id"],
            "name": s["name"],
            "color": s["color"] or 0,
            "topics": s["topics"],
            "difficulty": s["difficulty"],
            "exam_date": s["exam_date"],
            "days_left": (parse_date(s["exam_date"]) - today).days,
            "planned_min": planned,
            "done_min": done,
            "percent": round(100 * done / planned) if planned else 0,
        })

    # Overall numbers
    total_min = sum(t["planned"] for t in totals.values())
    done_min = sum(t["done"] for t in totals.values())
    missed = sum(1 for s in sessions if s["date"] < today_iso and not s["done"])

    # Today
    today_sessions = [s for s in sessions if s["date"] == today_iso]
    today_info = {
        "sessions": today_sessions,
        "count": len(today_sessions),
        "done_count": sum(1 for s in today_sessions if s["done"]),
        "total_min": sum(s["minutes"] for s in today_sessions),
        "done_min": sum(s["minutes"] for s in today_sessions if s["done"]),
    }

    # Next exam that is still in the future
    upcoming = [s for s in subject_stats if s["days_left"] > 0]
    next_exam = min(upcoming, key=lambda s: s["days_left"]) if upcoming else None

    # Study streak: a day counts if a session was finished or a focus timer completed
    # that day. Sessions count on the day they were ticked off, not the day planned.
    minutes_by_day = {}
    for s in sessions:
        if s["done"]:
            finished = (s["done_at"] or s["date"])[:10]
            minutes_by_day[finished] = minutes_by_day.get(finished, 0) + s["minutes"]
    for r in db.execute("SELECT date, SUM(minutes) AS m FROM pomodoros GROUP BY date"):
        minutes_by_day[r["date"]] = minutes_by_day.get(r["date"], 0) + r["m"]
    studied = set(minutes_by_day)

    done_today = today_iso in studied
    day = today if done_today else today - timedelta(days=1)
    streak = 0
    while day.isoformat() in studied:
        streak += 1
        day -= timedelta(days=1)

    best, run, prev = 0, 0, None
    for iso in sorted(studied):
        d = parse_date(iso)
        run = run + 1 if prev and (d - prev).days == 1 else 1
        best, prev = max(best, run), d

    week = []
    for back in range(6, -1, -1):
        d = today - timedelta(days=back)
        week.append({"date": d.isoformat(), "studied": d.isoformat() in studied,
                     "minutes": minutes_by_day.get(d.isoformat(), 0)})

    # Workload for the next 14 days, split by subject
    daily = []
    for offset in range(14):
        day_iso = (today + timedelta(days=offset)).isoformat()
        day_sessions = [s for s in sessions if s["date"] == day_iso]
        by_subject = {}
        for s in day_sessions:
            by_subject[s["subject_id"]] = by_subject.get(s["subject_id"], 0) + s["minutes"]
        daily.append({
            "date": day_iso,
            "total": sum(by_subject.values()),
            "done": sum(s["minutes"] for s in day_sessions if s["done"]),
            "by_subject": [
                {"subject_id": sid, "minutes": mins}
                for sid, mins in sorted(by_subject.items())
            ],
        })

    return jsonify(
        today=today_info,
        overall={
            "total_min": total_min,
            "done_min": done_min,
            "percent": round(100 * done_min / total_min) if total_min else 0,
            "missed": missed,
        },
        next_exam=next_exam,
        streak={"days": streak, "done_today": done_today, "best": best, "week": week},
        subjects=subject_stats,
        daily=daily,
    )


@app.post("/api/schedule/regenerate")
def regenerate():
    regenerate_plan(get_db())
    return jsonify(ok=True)


@app.patch("/api/sessions/<int:session_id>")
def toggle_session(session_id):
    done = 1 if request.get_json(force=True).get("done") else 0
    db = get_db()
    done_at = datetime.now().isoformat(timespec="seconds") if done else None
    db.execute("UPDATE sessions SET done = ?, done_at = ? WHERE id = ?", (done, done_at, session_id))
    db.commit()
    return jsonify(ok=True)


@app.get("/api/progress")
def progress():
    row = get_db().execute(
        "SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done, "
        "COALESCE(SUM(minutes), 0) AS total_min, "
        "COALESCE(SUM(CASE WHEN done = 1 THEN minutes END), 0) AS done_min FROM sessions"
    ).fetchone()
    total, done = row["total"], row["done"]
    return jsonify(
        total=total,
        done=done,
        percent=round(100 * row["done_min"] / row["total_min"]) if row["total_min"] else 0,
    )


# ---------- API: reminders ----------
@app.get("/api/reminders")
def reminders():
    """Sessions to alert about right now, plus the next upcoming one.

    A session is "due" from `reminder_lead` minutes before it starts until
    10 minutes after it started, so opening the page a little late still alerts.
    """
    db = get_db()
    lead = get_settings(db)["reminder_lead"]
    now = datetime.now()

    rows = db.execute(
        """
        SELECT s.id, s.date, s.start_time, s.minutes, sub.name AS subject
        FROM sessions s JOIN subjects sub ON sub.id = s.subject_id
        WHERE s.done = 0 AND s.date = ?
        ORDER BY s.start_time
        """,
        (now.date().isoformat(),),
    ).fetchall()

    due, upcoming = [], None
    for r in rows:
        start = datetime.strptime(f"{r['date']} {r['start_time']}", "%Y-%m-%d %H:%M")
        minutes_until = (start - now).total_seconds() / 60
        item = {**dict(r), "minutes_until": round(minutes_until, 1)}
        if -10 <= minutes_until <= lead:
            due.append(item)
        if minutes_until > 0 and upcoming is None:
            upcoming = item
    return jsonify(due=due, next=upcoming, lead=lead)


# ---------- API: focus timer (pomodoro) ----------
@app.post("/api/pomodoros")
def log_pomodoro():
    data = request.get_json(force=True)
    try:
        minutes = int(data.get("minutes", 25))
    except (ValueError, TypeError):
        return jsonify(error="Invalid minutes"), 400
    if not 1 <= minutes <= 180:
        return jsonify(error="A focus session must be between 1 and 180 minutes"), 400

    db = get_db()
    subject_id = data.get("subject_id") or None
    if subject_id is not None and not db.execute("SELECT 1 FROM subjects WHERE id = ?", (subject_id,)).fetchone():
        subject_id = None
    now = datetime.now()
    db.execute(
        "INSERT INTO pomodoros (subject_id, minutes, date, finished_at) VALUES (?, ?, ?, ?)",
        (subject_id, minutes, now.date().isoformat(), now.isoformat(timespec="seconds")),
    )
    db.commit()
    return jsonify(ok=True), 201


@app.get("/api/pomodoros")
def list_pomodoros():
    db = get_db()
    today_iso = date.today().isoformat()
    today = db.execute(
        "SELECT COUNT(*) AS n, COALESCE(SUM(minutes), 0) AS m FROM pomodoros WHERE date = ?", (today_iso,)
    ).fetchone()
    total = db.execute("SELECT COUNT(*) AS n, COALESCE(SUM(minutes), 0) AS m FROM pomodoros").fetchone()
    recent = db.execute(
        """
        SELECT p.id, p.minutes, p.finished_at, p.subject_id, sub.name AS subject, sub.color
        FROM pomodoros p LEFT JOIN subjects sub ON sub.id = p.subject_id
        ORDER BY p.id DESC LIMIT 8
        """
    ).fetchall()
    return jsonify(
        today={"count": today["n"], "minutes": today["m"]},
        total={"count": total["n"], "minutes": total["m"]},
        recent=[dict(r) for r in recent],
    )


# ---------- Flashcards ----------
def parse_manual_cards(text):
    """Turn lines like 'Question :: Answer' into cards. Also accepts ' | ', a tab or ' - '."""
    cards, seen = [], set()
    for line in text.splitlines():
        line = line.strip().lstrip("-*•0123456789.) ").strip() if line[:1].isdigit() else line.strip()
        for sep in ("::", " | ", "\t", " - ", " – ", "="):
            if sep in line:
                front, back = line.split(sep, 1)
                front, back = front.strip()[:300], back.strip()[:700]
                if front and back and front.lower() not in seen:
                    seen.add(front.lower())
                    cards.append((front, back))
                break
    return cards[:100]


@app.post("/api/decks/manual")
def make_manual_deck():
    """Free, no-key way to build a deck from the student's own text."""
    data = request.get_json(force=True)
    title = (data.get("title") or "").strip()[:200]
    if not title:
        return jsonify(error="Give the deck a name"), 400
    cards = parse_manual_cards(data.get("text") or "")
    if not cards:
        return jsonify(error="No cards found. Write one per line like: Question :: Answer"), 400
    db = get_db()
    subject_id = data.get("subject_id") or None
    if subject_id is not None and not db.execute("SELECT 1 FROM subjects WHERE id = ?", (subject_id,)).fetchone():
        subject_id = None
    cur = db.execute(
        "INSERT INTO decks (title, subject_id, created_at) VALUES (?, ?, ?)",
        (title, subject_id, datetime.now().isoformat(timespec="seconds")),
    )
    db.executemany("INSERT INTO cards (deck_id, front, back) VALUES (?, ?, ?)", [(cur.lastrowid, f, b) for f, b in cards])
    db.commit()
    return jsonify(deck_id=cur.lastrowid, count=len(cards)), 201


@app.get("/api/decks")
def list_decks():
    rows = get_db().execute(
        """
        SELECT d.id, d.title, d.subject_id, d.created_at, sub.name AS subject, sub.color,
               COUNT(c.id) AS total, COALESCE(SUM(c.known), 0) AS known
        FROM decks d
        LEFT JOIN subjects sub ON sub.id = d.subject_id
        LEFT JOIN cards c ON c.deck_id = d.id
        GROUP BY d.id
        ORDER BY d.id DESC
        """
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.get("/api/decks/<int:deck_id>")
def get_deck(deck_id):
    db = get_db()
    deck = db.execute(
        """
        SELECT d.id, d.title, d.subject_id, sub.name AS subject, sub.color
        FROM decks d LEFT JOIN subjects sub ON sub.id = d.subject_id WHERE d.id = ?
        """,
        (deck_id,),
    ).fetchone()
    if not deck:
        return jsonify(error="That deck no longer exists"), 404
    cards = db.execute("SELECT id, front, back, known FROM cards WHERE deck_id = ? ORDER BY id", (deck_id,)).fetchall()
    return jsonify(**dict(deck), cards=[dict(c) for c in cards])


@app.delete("/api/decks/<int:deck_id>")
def delete_deck(deck_id):
    db = get_db()
    db.execute("DELETE FROM cards WHERE deck_id = ?", (deck_id,))
    db.execute("DELETE FROM decks WHERE id = ?", (deck_id,))
    db.commit()
    return jsonify(ok=True)


@app.post("/api/decks/<int:deck_id>/reset")
def reset_deck(deck_id):
    db = get_db()
    db.execute("UPDATE cards SET known = 0 WHERE deck_id = ?", (deck_id,))
    db.commit()
    return jsonify(ok=True)


@app.patch("/api/cards/<int:card_id>")
def update_card(card_id):
    known = 1 if request.get_json(force=True).get("known") else 0
    db = get_db()
    db.execute("UPDATE cards SET known = ? WHERE id = ?", (known, card_id))
    db.commit()
    return jsonify(ok=True)


# Create tables on import too, so hosts that load `app` through WSGI work.
init_db()

if __name__ == "__main__":
    app.run(debug=True)
