"""Scheduling logic: turns subjects + daily hours into a day-by-day plan.

Priority of a subject on a given day = difficulty / days_left_until_exam.
The day's study minutes are split in proportion to these priorities, so a
hard subject with a near exam gets the biggest share.
"""
from datetime import date, datetime, timedelta

MIN_SESSION = 20      # sessions shorter than this are merged into the biggest one
ROUND_TO = 5          # round session lengths to 5 minutes
MAX_DAYS = 90         # never plan further than this many days ahead


def _to_minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _to_hhmm(minutes: int) -> str:
    minutes %= 24 * 60
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def split_day(subjects, day, total_minutes):
    """Return [(subject_id, minutes)] for one day, or [] if nothing to study."""
    active = []
    for s in subjects:
        days_left = (s["exam_date"] - day).days
        if days_left < 1:            # exam is today or already over
            continue
        active.append((s, s["difficulty"] / days_left))

    if not active or total_minutes <= 0:
        return []

    total_priority = sum(p for _, p in active)
    allocation = []
    for s, p in active:
        mins = round(total_minutes * p / total_priority / ROUND_TO) * ROUND_TO
        allocation.append([s["id"], mins, p])

    # Merge tiny sessions into the highest-priority subject
    allocation.sort(key=lambda a: a[2], reverse=True)
    top = allocation[0]
    kept = [top]
    for a in allocation[1:]:
        if a[1] >= MIN_SESSION:
            kept.append(a)
        else:
            top[1] += a[1]
    return [(a[0], a[1]) for a in kept if a[1] > 0]


def build_plan(subjects, daily_minutes, start_time, today=None, minutes_done_today=0):
    """Build a list of session dicts from today until the last exam.

    subjects: list of dicts with id, exam_date (date), difficulty (1-5)
    Returns: list of {subject_id, date (ISO), start_time (HH:MM), minutes}
    """
    today = today or date.today()
    if not subjects:
        return []

    last_exam = max(s["exam_date"] for s in subjects)
    horizon = min((last_exam - today).days, MAX_DAYS)
    sessions = []

    for offset in range(0, horizon + 1):
        day = today + timedelta(days=offset)
        available = daily_minutes - (minutes_done_today if offset == 0 else 0)
        cursor = _to_minutes(start_time)
        for subject_id, mins in split_day(subjects, day, available):
            sessions.append({
                "subject_id": subject_id,
                "date": day.isoformat(),
                "start_time": _to_hhmm(cursor),
                "minutes": mins,
            })
            cursor += mins + 10   # 10 minute break between sessions
    return sessions


def parse_date(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()
