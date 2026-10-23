# Study Planner

A Flask + SQLite web app that builds a day-by-day study schedule from your subjects, exam dates and daily free hours, and helps you study with a Pomodoro timer, streaks, a to-do list and flashcards you write yourself.

## Problem statement

Students often struggle to divide their time across subjects before exams, which leads to last-minute cramming and neglected topics. This app takes subjects, exam dates, difficulty ratings and daily available hours, generates a schedule that gives more time to harder subjects and nearer exams, reminds you when a session is due, and gives you tools to actually study: a focus timer, a to-do list and flashcards.

## Features

**Planning**
- Subjects with exam date, difficulty (1-5) and topics
- Automatic schedule that is rebuilt whenever your inputs change; finished sessions are never overwritten
- Dashboard: today's progress, overall progress, next exam, streak, time-by-subject donut, 14-day workload chart, exam countdown
- Schedule view with Upcoming / Completed / Missed filters
- Reminders: an alert at the top of the page with a chime, plus a browser notification if allowed

**Studying**
- **To-do list** with optional subject and due date, overdue tags, filters and a quick-add box on the dashboard
- **Pomodoro focus timer**: Focus, Short break and Long break, with adjustable lengths, a round counter, a timer that survives page reloads, a live countdown in the tab title and sidebar, and an alert plus chime when a round ends. Finished rounds are logged per subject.
- **Study streak** with fire emoji: a day counts when you finish a session or a focus round. Shows a 7-day strip and your best streak.
- **Flashcards**: write one card per line as `Question :: Answer` and get a deck. Study mode has flip cards, "I know this" / "Still learning", progress, shuffle and keyboard shortcuts (Space to flip, arrows to move).

**General:** light and dark mode, works on phones.

## How the scheduler works

For each day until the last exam:

```
priority(subject) = difficulty / days_left_until_exam
minutes(subject)  = daily_minutes * priority / sum(all priorities)
```

Hard subjects with close exams get the biggest share. Sessions shorter than 20 minutes are merged into the top-priority subject, lengths are rounded to 5 minutes, and a 10 minute break is placed between sessions.

## Project structure

```
study-planner/
├── app.py            Flask app, SQLite, REST API
├── scheduler.py      Scheduling algorithm
├── requirements.txt
├── .gitignore
├── templates/
│   └── index.html
└── static/
    ├── style.css     Layout, light/dark themes
    └── script.js     Views, charts, timer, flashcards
```

## Run it (VS Code terminal)

```bash
cd study-planner
python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate     # macOS / Linux
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000. If port 5000 is busy, change the last line of `app.py` to `app.run(debug=True, port=8000)`.

Existing data is kept when you update the files: new tables and columns are added automatically on start.

## API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET/POST | `/api/subjects` | List or add subjects |
| DELETE | `/api/subjects/<id>` | Remove a subject |
| GET/PUT | `/api/settings` | Daily hours, start time, reminder lead time |
| GET | `/api/schedule` | Full schedule |
| POST | `/api/schedule/regenerate` | Rebuild the schedule |
| PATCH | `/api/sessions/<id>` | Mark a session done or not done |
| GET | `/api/dashboard` | KPIs, streak, per-subject progress, 14-day workload |
| GET | `/api/reminders` | Sessions due for an alert, plus the next one |
| GET/POST | `/api/todos` | List or add tasks |
| PATCH/DELETE | `/api/todos/<id>` | Update, tick off or delete a task |
| DELETE | `/api/todos?done=1` | Clear completed tasks |
| GET/POST | `/api/pomodoros` | Focus round history and stats, log a finished round |
| GET | `/api/decks` | List flashcard decks |
| GET/DELETE | `/api/decks/<id>` | Open or delete a deck |
| POST | `/api/decks/<id>/reset` | Reset a deck's progress |
| PATCH | `/api/cards/<id>` | Mark a card known or still learning |
| POST | `/api/decks/manual` | Make a deck from `Question :: Answer` lines |

## Ideas to extend

- User login so each student has their own plan
- Email or Telegram reminders from the backend
- Spaced repetition for flashcards
- Weekly summary chart of focus time
