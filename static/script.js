"use strict";

/* =========================================================
   Helpers
   ========================================================= */
const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

function build(el, props, kids) {
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.setAttribute("class", value);
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const h = (tag, props, ...kids) => build(document.createElement(tag), props, kids);
const sv = (tag, props, ...kids) => build(document.createElementNS(SVG_NS, tag), props, kids);

async function api(url, method = "GET", body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Something went wrong");
    err.code = data.code;
    throw err;
  }
  return data;
}

const pad = (n) => String(n).padStart(2, "0");
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const parseISO = (iso) => new Date(iso + "T00:00:00");
const fmtDate = (iso, opts) => parseISO(iso).toLocaleDateString(undefined, opts);

function fmtMin(m) {
  const hh = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  if (!hh) return `${mm}m`;
  return mm ? `${hh}h ${mm}m` : `${hh}h`;
}
function addMinutes(hhmm, mins) {
  const [a, b] = hhmm.split(":").map(Number);
  const t = (a * 60 + b + mins) % 1440;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}
const colorVar = (idx) => `var(--s${((idx ?? 0) % 8) + 1})`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function empty(message, actionLabel, href) {
  return h(
    "div",
    { class: "empty" },
    h("p", {}, message),
    actionLabel && h("a", { class: "btn", href, style: "display:inline-block;text-decoration:none" }, actionLabel)
  );
}

let toastTimer;
function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}

/* =========================================================
   Tooltip (shared by every chart)
   ========================================================= */
const tip = $("tooltip");

function moveTip(x, y) {
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - pad;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - pad;
  tip.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
}

function showTip(x, y, title, rows) {
  tip.replaceChildren(
    h("strong", {}, title),
    ...rows.map((r) =>
      h("div", { class: "tip-row" }, r.color && h("i", { style: `background:${r.color}` }), h("span", {}, r.label), h("b", {}, r.value))
    )
  );
  tip.hidden = false;
  moveTip(x, y);
}

function bindTip(el, title, rows) {
  el.addEventListener("mouseenter", (e) => showTip(e.clientX, e.clientY, title, rows));
  el.addEventListener("mousemove", (e) => moveTip(e.clientX, e.clientY));
  el.addEventListener("mouseleave", () => (tip.hidden = true));
  el.addEventListener("focus", () => {
    const r = el.getBoundingClientRect();
    showTip(r.left + r.width / 2, r.top, title, rows);
  });
  el.addEventListener("blur", () => (tip.hidden = true));
}

/* =========================================================
   State
   ========================================================= */
let dash = null;
let sessions = [];
let todos = [];
let scheduleFilter = "upcoming";
let todoFilter = "open";
let decks = [];

async function refresh() {
  try {
    [dash, sessions, todos, pomoStats, decks] = await Promise.all([
      api("/api/dashboard"), api("/api/schedule"), api("/api/todos"),
      api("/api/pomodoros"), api("/api/decks"),
    ]);
    renderAll();
    checkReminders();
  } catch (err) {
    toast("Can't reach the server. Is app.py still running?");
  }
}

function renderAll() {
  renderKpis();
  renderToday();
  renderDonut();
  renderWorkload();
  renderCountdown();
  renderSchedule();
  renderSubjects();
  renderTodoForm();
  renderTodoCard();
  renderTodos();
  renderExtras();
}

async function toggleSession(id, done) {
  try {
    await api(`/api/sessions/${id}`, "PATCH", { done });
    await refresh();
  } catch (err) {
    toast(err.message);
  }
}

/* =========================================================
   Session row (used on Dashboard and Schedule)
   ========================================================= */
function sessionRow(s) {
  const missed = s.date < todayISO() && !s.done;
  return h(
    "label",
    { class: "session" + (s.done ? " done" : ""), style: `--c:${colorVar(s.color)}` },
    h("input", {
      type: "checkbox",
      checked: !!s.done,
      "aria-label": `${s.subject}, ${s.start_time}`,
      onchange: (e) => toggleSession(s.id, e.target.checked),
    }),
    h("span", { class: "check" }),
    h("span", { class: "when" }, s.start_time, h("small", {}, "to " + addMinutes(s.start_time, s.minutes))),
    h("span", { class: "what" }, h("strong", {}, s.subject), h("small", {}, fmtMin(s.minutes))),
    missed && h("span", { class: "tag missed" }, "Missed")
  );
}

/* =========================================================
   Dashboard: KPI tiles
   ========================================================= */
function renderKpis() {
  const t = dash.today;
  const o = dash.overall;

  $("kpi-today-value").replaceChildren(
    t.total_min ? fmtMin(t.done_min) : "Nothing planned",
    t.total_min ? h("small", {}, ` of ${fmtMin(t.total_min)}`) : null
  );
  $("kpi-today-bar").style.width = (t.total_min ? Math.round((100 * t.done_min) / t.total_min) : 0) + "%";
  $("kpi-today-note").textContent = t.count
    ? `${t.done_count} of ${plural(t.count, "session")} done`
    : "No sessions scheduled today";

  $("kpi-overall-value").textContent = o.percent + "%";
  $("kpi-overall-bar").style.width = o.percent + "%";
  $("kpi-overall-note").textContent = o.total_min
    ? `${fmtMin(o.done_min)} of ${fmtMin(o.total_min)} studied` + (o.missed ? `, ${o.missed} missed` : "")
    : "Add a subject to start";

  const ne = dash.next_exam;
  if (ne) {
    $("kpi-exam-value").textContent = ne.days_left === 1 ? "Tomorrow" : `${ne.days_left} days`;
    $("kpi-exam-note").textContent = `${ne.name} on ${fmtDate(ne.exam_date, { weekday: "short", day: "numeric", month: "short" })}`;
  } else {
    $("kpi-exam-value").textContent = "None";
    $("kpi-exam-note").textContent = "No upcoming exams";
  }

  const st = dash.streak;
  $("kpi-streak-value").replaceChildren(
    h("span", { class: "flame" + (st.days ? "" : " off"), "aria-hidden": "true" }, "🔥"),
    " ",
    plural(st.days, "day")
  );
  $("kpi-streak-week").setAttribute("aria-label", `Studied on ${st.week.filter((d) => d.studied).length} of the last 7 days`);
  $("kpi-streak-week").replaceChildren(
    ...st.week.map((d, i) =>
      h(
        "div",
        {
          class: "wk" + (d.studied ? " on" : "") + (i === st.week.length - 1 ? " today" : ""),
          title: `${fmtDate(d.date, { weekday: "short", day: "numeric", month: "short" })}: ${d.studied ? fmtMin(d.minutes) + " studied" : "no study"}`,
        },
        h("span", {}, d.studied ? "🔥" : ""),
        h("small", {}, fmtDate(d.date, { weekday: "narrow" }))
      )
    )
  );
  $("kpi-streak-note").textContent = st.done_today
    ? `Studied today. Best streak: ${plural(st.best, "day")}`
    : st.days
    ? "Study today to keep your streak going"
    : st.best
    ? `Best streak: ${plural(st.best, "day")}. Study today to start a new one`
    : "Finish a session or a focus round to start";
}

/* =========================================================
   Dashboard: today's sessions
   ========================================================= */
function renderToday() {
  const root = $("today-list");
  const t = dash.today;
  root.replaceChildren();

  $("today-meta").textContent = t.count ? `${fmtMin(t.done_min)} done of ${fmtMin(t.total_min)}` : "";

  if (!dash.subjects.length) {
    root.append(empty("Add your first subject and exam date to build a plan.", "Add a subject", "#subjects"));
  } else if (!t.count) {
    root.append(empty("Nothing is scheduled for today. Check the schedule for your next session."));
  } else {
    root.append(...t.sessions.map(sessionRow));
  }
}

/* =========================================================
   Dashboard: donut (planned time per subject)
   ========================================================= */
function renderDonut() {
  const root = $("donut");
  root.replaceChildren();

  const subs = dash.subjects.filter((s) => s.planned_min > 0);
  const total = subs.reduce((a, s) => a + s.planned_min, 0);
  if (!total) {
    root.append(empty("Your time split appears once a plan is generated."));
    return;
  }

  const size = 170, c = size / 2, r = 62, stroke = 24;
  const C = 2 * Math.PI * r;
  const svg = sv("svg", { viewBox: `0 0 ${size} ${size}`, role: "img", "aria-label": "Planned study time by subject" });
  svg.append(sv("circle", { cx: c, cy: c, r, fill: "none", style: "stroke:var(--track)", "stroke-width": stroke }));

  let offset = 0;
  const rows = subs.map((s) => ({ s, pct: Math.round((100 * s.planned_min) / total) }));

  for (const { s, pct } of rows) {
    const len = (s.planned_min / total) * C;
    const gap = subs.length > 1 ? 2 : 0;
    const draw = Math.max(len - gap, 0.5);
    const arc = sv("circle", {
      cx: c, cy: c, r,
      fill: "none",
      style: `stroke:${colorVar(s.color)}`,
      "stroke-width": stroke,
      "stroke-dasharray": `${draw} ${C - draw}`,
      "stroke-dashoffset": -offset,
      transform: `rotate(-90 ${c} ${c})`,
      tabindex: 0,
    });
    bindTip(arc, s.name, [
      { color: colorVar(s.color), label: "Planned", value: fmtMin(s.planned_min) },
      { label: "Share", value: pct + "%" },
      { label: "Studied", value: fmtMin(s.done_min) },
    ]);
    svg.append(arc);
    offset += len;
  }

  svg.append(
    sv("text", { x: c, y: c + 2, "text-anchor": "middle", class: "donut-num" }, Math.round((total / 60) * 10) / 10 + "h"),
    sv("text", { x: c, y: c + 20, "text-anchor": "middle", class: "donut-lab" }, "planned")
  );

  const legend = h(
    "ul",
    { class: "legend" },
    rows.map(({ s, pct }) => {
      const li = h(
        "li",
        { style: `--c:${colorVar(s.color)}` },
        h("i", { class: "swatch" }),
        h("span", { class: "name" }, s.name),
        h("span", { class: "val" }, `${fmtMin(s.planned_min)}, ${pct}%`)
      );
      return li;
    })
  );

  root.append(h("div", { class: "donut-wrap" }, svg, legend));
}

/* =========================================================
   Dashboard: 14-day workload (stacked bars by subject)
   ========================================================= */
function topRoundedRect(x, y, w, hgt, r) {
  r = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + hgt} Z`;
}

function renderWorkload() {
  const root = $("workload");
  root.replaceChildren();

  const days = dash.daily;
  const maxMin = Math.max(...days.map((d) => d.total), 0);
  if (!maxMin) {
    root.append(empty("No study time is planned for the next 14 days."));
    return;
  }

  const byId = Object.fromEntries(dash.subjects.map((s) => [s.id, s]));

  // Round the axis up to whole hours with at most ~4 gridlines
  const maxH = Math.ceil(maxMin / 60);
  const stepH = Math.max(1, Math.ceil(maxH / 4));
  const axisMax = Math.ceil(maxH / stepH) * stepH * 60;

  const W = 560, H = 236, L = 36, R = 6, T = 10, B = 42;
  const plotH = H - T - B;
  const slot = (W - L - R) / days.length;
  const bw = Math.min(24, slot * 0.62);
  const y = (v) => T + plotH * (1 - v / axisMax);

  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img", "aria-label": "Planned study minutes for each of the next 14 days" });

  // Gridlines and y labels
  for (let hr = 0; hr <= axisMax / 60; hr += stepH) {
    const yy = y(hr * 60);
    svg.append(
      sv("line", { x1: L, x2: W - R, y1: yy, y2: yy, style: `stroke:${hr === 0 ? "var(--axis)" : "var(--grid)"}`, "stroke-width": 1 }),
      sv("text", { x: L - 8, y: yy + 4, "text-anchor": "end", class: "tick" }, hr + "h")
    );
  }

  days.forEach((d, i) => {
    const x0 = L + i * slot + (slot - bw) / 2;
    const isToday = i === 0;

    // Stacked segments, bottom to top, with a 2px gap between fills
    let cum = 0;
    const segs = d.by_subject.filter((p) => byId[p.subject_id]);
    segs.forEach((p, j) => {
      const top = y(cum + p.minutes);
      const bottom = y(cum);
      const fullH = bottom - top;
      const isTop = j === segs.length - 1;
      const color = `fill:${colorVar(byId[p.subject_id].color)}`;
      if (isTop) {
        svg.append(sv("path", { d: topRoundedRect(x0, top, bw, Math.max(fullH, 1), 4), style: color }));
      } else {
        svg.append(sv("rect", { x: x0, y: top + 2, width: bw, height: Math.max(fullH - 2, 1), style: color }));
      }
      cum += p.minutes;
    });

    // Axis labels
    const label = fmtDate(d.date, { weekday: "short" });
    svg.append(
      sv("text", { x: x0 + bw / 2, y: H - B + 16, "text-anchor": "middle", class: "tick" + (isToday ? " today" : "") }, parseISO(d.date).getDate()),
      sv("text", { x: x0 + bw / 2, y: H - B + 30, "text-anchor": "middle", class: "tick" + (isToday ? " today" : "") }, isToday ? "Today" : label)
    );

    // Hover / focus target covers the whole column
    const hit = sv("rect", { x: L + i * slot, y: T, width: slot, height: plotH, class: "hit", tabindex: 0 });
    const rows = segs.map((p) => ({
      color: colorVar(byId[p.subject_id].color),
      label: byId[p.subject_id].name,
      value: fmtMin(p.minutes),
    }));
    bindTip(
      hit,
      fmtDate(d.date, { weekday: "long", day: "numeric", month: "short" }),
      rows.length ? [...rows, { label: "Total", value: fmtMin(d.total) }] : [{ label: "Nothing planned", value: "" }]
    );
    svg.append(hit);
  });

  const used = [...new Set(days.flatMap((d) => d.by_subject.map((p) => p.subject_id)))].filter((id) => byId[id]);
  const legend = h(
    "div",
    { class: "chart-legend" },
    used.map((id) => h("span", { style: `--c:${colorVar(byId[id].color)}` }, h("i", { class: "swatch" }), byId[id].name))
  );

  root.append(svg, legend);
}

/* =========================================================
   Dashboard: exam countdown
   ========================================================= */
function whenText(days) {
  if (days < 0) return "Exam over";
  if (days === 0) return "Exam today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

function renderCountdown() {
  const root = $("countdown");
  root.replaceChildren();
  if (!dash.subjects.length) {
    root.append(empty("Your subjects and exam dates will show up here.", "Add a subject", "#subjects"));
    return;
  }
  root.append(
    ...dash.subjects.map((s) =>
      h(
        "div",
        { class: "cd-row" },
        h(
          "div",
          { class: "cd-top" },
          h("i", { class: "dot", style: `background:${colorVar(s.color)}` }),
          h("strong", {}, s.name),
          h("span", { class: "cd-when" }, whenText(s.days_left))
        ),
        h("div", { class: "meter", role: "progressbar", "aria-valuenow": s.percent, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": `${s.name} progress` }, h("i", { style: `width:${s.percent}%;background:${colorVar(s.color)}` })),
        h("span", { class: "cd-note" }, `${fmtMin(s.done_min)} of ${fmtMin(s.planned_min)} studied, ${s.percent}%`)
      )
    )
  );
}

/* =========================================================
   Schedule view
   ========================================================= */
function renderSchedule() {
  const today = todayISO();
  const counts = {
    upcoming: sessions.filter((s) => s.date >= today).length,
    done: sessions.filter((s) => s.done).length,
    missed: sessions.filter((s) => s.date < today && !s.done).length,
    all: sessions.length,
  };
  const labels = [["upcoming", "Upcoming"], ["done", "Completed"], ["missed", "Missed"], ["all", "All"]];

  $("schedule-filters").replaceChildren(
    ...labels.map(([key, text]) =>
      h("button", {
        class: "chip",
        type: "button",
        "aria-pressed": String(scheduleFilter === key),
        onclick: () => { scheduleFilter = key; renderSchedule(); },
      }, `${text} (${counts[key]})`)
    )
  );

  const pick = {
    upcoming: (s) => s.date >= today,
    done: (s) => s.done,
    missed: (s) => s.date < today && !s.done,
    all: () => true,
  }[scheduleFilter];

  const list = $("schedule-list");
  list.replaceChildren();

  const shown = sessions.filter(pick);
  if (!shown.length) {
    list.style.display = "block";
    list.append(
      !dash.subjects.length
        ? empty("Add a subject and exam date to generate your schedule.", "Add a subject", "#subjects")
        : empty(
            { upcoming: "No upcoming sessions.", done: "No completed sessions yet.", missed: "You haven't missed any sessions.", all: "No sessions yet." }[scheduleFilter]
          )
    );
    return;
  }
  list.style.display = "";

  const byDay = {};
  for (const s of shown) (byDay[s.date] ||= []).push(s);

  for (const [day, items] of Object.entries(byDay)) {
    const total = items.reduce((a, s) => a + s.minutes, 0);
    const done = items.filter((s) => s.done).length;
    const isToday = day === today;
    list.append(
      h(
        "article",
        { class: "card day-card" + (isToday ? " today" : "") },
        h(
          "div",
          { class: "day-head" },
          h("h2", {}, fmtDate(day, { weekday: "long", day: "numeric", month: "short" }), isToday && h("span", { class: "badge" }, "Today")),
          h("div", { class: "day-stat" }, h("strong", {}, fmtMin(total)), h("small", {}, `${done} of ${items.length} done`))
        ),
        items.map(sessionRow)
      )
    );
  }
}

/* =========================================================
   Subjects view
   ========================================================= */
function renderSubjects() {
  const root = $("subject-table");
  root.replaceChildren();

  if (!dash.subjects.length) {
    root.append(empty("No subjects yet. Add one using the form."));
    return;
  }

  const head = h("tr", {}, ...["Subject", "Exam", "Difficulty", "Progress", ""].map((t) => h("th", { scope: "col" }, t)));
  const body = dash.subjects.map((s) =>
    h(
      "tr",
      {},
      h("td", { class: "subject" },
        h("i", { class: "dot", style: `background:${colorVar(s.color)}` }),
        h("div", {}, h("span", { class: "sub-name" }, s.name), s.topics && h("small", {}, s.topics))
      ),
      h("td", {}, fmtDate(s.exam_date, { day: "numeric", month: "short" }), h("small", { style: "display:block;color:var(--ink-2);font-size:12px" }, whenText(s.days_left))),
      h("td", {}, h("span", { class: "diff", role: "img", "aria-label": `Difficulty ${s.difficulty} of 5` }, [1, 2, 3, 4, 5].map((n) => h("i", { class: n <= s.difficulty ? "on" : "" })))),
      h("td", { class: "prog" },
        h("div", { class: "meter" }, h("i", { style: `width:${s.percent}%;background:${colorVar(s.color)}` })),
        h("small", {}, `${s.percent}% of ${fmtMin(s.planned_min)}`)
      ),
      h("td", {}, h("button", {
        class: "link-btn",
        type: "button",
        "aria-label": `Remove ${s.name}`,
        onclick: async () => {
          if (!confirm(`Remove ${s.name} and its sessions?`)) return;
          try { await api(`/api/subjects/${s.id}`, "DELETE"); toast(`${s.name} removed`); refresh(); }
          catch (err) { toast(err.message); }
        },
      }, "Remove"))
    )
  );

  root.append(h("table", {}, h("thead", {}, head), h("tbody", {}, body)));
}

$("subject-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/subjects", "POST", {
      name: $("name").value,
      exam_date: $("exam_date").value,
      difficulty: document.querySelector('input[name="difficulty"]:checked').value,
      topics: $("topics").value,
    });
    const added = $("name").value;
    e.target.reset();
    toast(`${added} added and schedule updated`);
    refresh();
  } catch (err) {
    toast(err.message);
  }
});

/* =========================================================
   To-do list
   ========================================================= */
async function toggleTodo(id, done) {
  try { await api(`/api/todos/${id}`, "PATCH", { done }); await refresh(); }
  catch (err) { toast(err.message); }
}

async function deleteTodo(id) {
  try { await api(`/api/todos/${id}`, "DELETE"); await refresh(); }
  catch (err) { toast(err.message); }
}

function todoRow(t) {
  const today = todayISO();
  const overdue = !t.done && t.due_date && t.due_date < today;
  const dueToday = !t.done && t.due_date === today;
  const detail = [t.subject, t.due_date && `Due ${fmtDate(t.due_date, { day: "numeric", month: "short" })}`].filter(Boolean).join(", ");
  return h(
    "div",
    { class: "todo" + (t.done ? " done" : ""), style: `--c:${t.subject_id ? colorVar(t.color) : "var(--axis)"}` },
    h("label", { class: "tick" },
      h("input", { type: "checkbox", checked: !!t.done, "aria-label": `Mark "${t.title}" as done`, onchange: (e) => toggleTodo(t.id, e.target.checked) }),
      h("span", { class: "check" })
    ),
    h("div", { class: "what" }, h("strong", {}, t.title), detail && h("small", {}, detail)),
    overdue && h("span", { class: "tag missed" }, "Overdue"),
    dueToday && h("span", { class: "tag" }, "Due today"),
    h("button", { class: "link-btn", type: "button", "aria-label": `Delete "${t.title}"`, onclick: () => deleteTodo(t.id) }, "Delete")
  );
}

/* Keep the subject dropdown in step with the subject list, without losing the current choice */
function renderTodoForm() {
  const sel = $("todo-subject");
  const keep = sel.value;
  sel.replaceChildren(
    h("option", { value: "" }, "No subject"),
    ...dash.subjects.map((s) => h("option", { value: String(s.id) }, s.name))
  );
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function renderTodoCard() {
  const open = todos.filter((t) => !t.done);
  const overdue = open.filter((t) => t.due_date && t.due_date < todayISO()).length;
  $("todo-card-meta").textContent = open.length
    ? `${open.length} open${overdue ? `, ${overdue} overdue` : ""}`
    : "View all";

  const root = $("todo-card-list");
  root.replaceChildren();
  if (!open.length) {
    root.append(empty(todos.length ? "All tasks done. Nice work." : "No tasks yet. Add one above."));
    return;
  }
  root.append(...open.slice(0, 5).map(todoRow));
  if (open.length > 5) {
    root.append(h("p", { class: "plain small", style: "margin-top:10px" }, `${open.length - 5} more on the `, h("a", { href: "#todos" }, "To-do page")));
  }
}

function renderTodos() {
  const counts = { open: todos.filter((t) => !t.done).length, done: todos.filter((t) => t.done).length, all: todos.length };
  const labels = [["open", "Open"], ["done", "Done"], ["all", "All"]];

  $("todo-filters").replaceChildren(
    ...labels.map(([key, text]) =>
      h("button", {
        class: "chip",
        type: "button",
        "aria-pressed": String(todoFilter === key),
        onclick: () => { todoFilter = key; renderTodos(); },
      }, `${text} (${counts[key]})`)
    )
  );
  $("todo-clear").hidden = counts.done === 0;

  const shown = todos.filter((t) => (todoFilter === "all" ? true : todoFilter === "done" ? t.done : !t.done));
  const root = $("todo-list");
  root.replaceChildren();
  if (!shown.length) {
    root.append(empty(
      { open: counts.all ? "Nothing left to do. Nice work." : "No tasks yet. Add one using the form.", done: "No completed tasks yet.", all: "No tasks yet. Add one using the form." }[todoFilter]
    ));
    return;
  }
  root.append(...shown.map(todoRow));
}

async function addTodo(payload, form) {
  try {
    await api("/api/todos", "POST", payload);
    form.reset();
    await refresh();
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

$("todo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ok = await addTodo(
    { title: $("todo-title").value, subject_id: $("todo-subject").value || null, due_date: $("todo-due").value || null },
    e.target
  );
  if (ok) { toast("Task added"); $("todo-title").focus(); }
});

$("todo-quick").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!$("todo-quick-title").value.trim()) return;
  const ok = await addTodo({ title: $("todo-quick-title").value }, e.target);
  if (ok) $("todo-quick-title").focus();
});

$("todo-clear").addEventListener("click", async () => {
  try { await api("/api/todos?done=1", "DELETE"); toast("Completed tasks cleared"); await refresh(); }
  catch (err) { toast(err.message); }
});

/* =========================================================
   Settings + reminders
   ========================================================= */
async function loadSettings() {
  try {
    const s = await api("/api/settings");
    $("daily_hours").value = s.daily_hours;
    $("start_time").value = s.start_time;
    $("reminder_lead").value = s.reminder_lead;
  } catch (_) { /* shown by refresh() */ }
}

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/settings", "PUT", { daily_hours: $("daily_hours").value, start_time: $("start_time").value, reminder_lead: $("reminder_lead").value });
    toast("Saved. Schedule rebuilt.");
    refresh();
  } catch (err) {
    toast(err.message);
  }
});

$("regen-btn").addEventListener("click", async () => {
  try { await api("/api/schedule/regenerate", "POST"); toast("Schedule rebuilt"); refresh(); }
  catch (err) { toast(err.message); }
});

const notified = new Set(JSON.parse(sessionStorage.getItem("notified") || "[]"));
const canNotify = "Notification" in window;
let reminderInfo = { next: null, lead: 10 };
let permDismissed = false;
let audioCtx = null;

/* A chime needs the page to have been clicked once (browser autoplay rule) */
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (_) {}
}
document.addEventListener("click", unlockAudio);

function chime() {
  if (!audioCtx) return;
  try {
    [784, 988].forEach((freq, i) => {
      const t0 = audioCtx.currentTime + i * 0.22;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.22);
    });
  } catch (_) {}
}

function updateTitle() {
  const n = $("alerts").children.length;
  if (n) document.title = `(${n}) Study reminder`;
  else if (pomo.running) document.title = `${fmtClock(secondsLeft())} ${PHASE_LABEL[pomo.phase]} | Study Planner`;
  else document.title = "Study Planner";
}

function showAlert(key, title, body) {
  const id = "alert-" + key.replace(/[^\w-]/g, "_");
  if ($(id)) return;
  const el = h(
    "div",
    { class: "alert", id, role: "alert" },
    h("div", {}, h("strong", {}, title), h("span", {}, body)),
    h("button", { class: "link-btn", type: "button", onclick: () => { el.remove(); updateTitle(); } }, "Dismiss")
  );
  $("alerts").append(el);
  updateTitle();
}

/* One reminder = on-page alert + chime + browser notification (if allowed) */
function fireReminder(key, title, body) {
  showAlert(key, title, body);
  chime();
  if (canNotify && Notification.permission === "granted") {
    try {
      const n = new Notification(title, { body, tag: key, requireInteraction: true });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (_) { /* some browsers only allow notifications from a service worker */ }
  }
}

function updateNotifyUI() {
  const perm = canNotify ? Notification.permission : "unsupported";
  $("notify-btn").textContent = perm === "granted" ? "Reminders on" : "Reminders off";
  $("notify-btn-2").hidden = perm === "granted" || perm === "unsupported";
  $("perm-strip").hidden = !(perm === "default" && !permDismissed);
  $("reminder-status").textContent = {
    granted: "Browser notifications are on. You'll also see an alert at the top of this page.",
    denied: "Browser notifications are blocked, but you'll still get an alert and a chime on this page. To allow notifications too, click the lock icon in the address bar and allow them.",
    default: "Allow notifications to be reminded even when this tab is in the background. Alerts on this page work either way.",
    unsupported: "This browser doesn't support notifications. You'll still get an alert and a chime on this page.",
  }[perm];
}

async function askPermission() {
  unlockAudio();
  if (!canNotify) return;
  if (Notification.permission === "denied") {
    toast("Notifications are blocked. Allow them from the lock icon in the address bar.");
    return;
  }
  await Notification.requestPermission();
  updateNotifyUI();
}
$("notify-btn").addEventListener("click", askPermission);
$("notify-btn-2").addEventListener("click", askPermission);
$("perm-allow").addEventListener("click", askPermission);
$("perm-dismiss").addEventListener("click", () => { permDismissed = true; updateNotifyUI(); });
$("notify-test").addEventListener("click", () => {
  unlockAudio();
  fireReminder("test-" + Date.now(), "Study reminder", "This is how your session reminders will look.");
});

function untilText(mins) {
  if (mins <= 0) return "now";
  if (mins < 60) return `in ${Math.ceil(mins)} min`;
  return `in ${fmtMin(Math.round(mins))}`;
}

function renderReminderNext() {
  const n = reminderInfo.next;
  const lead = reminderInfo.lead;
  $("reminder-next").textContent = n
    ? `Next session: ${n.subject} at ${n.start_time} (${untilText(n.minutes_until)}). ` +
      (lead ? `You'll be reminded ${plural(lead, "minute")} before and when it starts.` : "You'll be reminded when it starts.")
    : "No more sessions today.";
}

async function checkReminders() {
  try {
    const res = await api("/api/reminders");
    reminderInfo = res;
    for (const s of res.due) {
      const starting = s.minutes_until <= 0;
      const key = `${s.id}:${starting ? "now" : "soon"}`;
      if (notified.has(key)) continue;
      notified.add(key);
      sessionStorage.setItem("notified", JSON.stringify([...notified]));
      const mins = Math.max(1, Math.ceil(s.minutes_until));
      fireReminder(
        key,
        starting ? `Time to study: ${s.subject}` : `${s.subject} starts in ${plural(mins, "minute")}`,
        `${s.start_time} to ${addMinutes(s.start_time, s.minutes)}, ${fmtMin(s.minutes)}`
      );
    }
    renderReminderNext();
  } catch (_) { /* server unreachable, try again next tick */ }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkReminders(); });

/* =========================================================
   Helpers shared by the new pages
   ========================================================= */
function fillSubjects(id, noneLabel) {
  const sel = $(id);
  const keep = sel.value;
  sel.replaceChildren(
    h("option", { value: "" }, noneLabel),
    ...dash.subjects.map((s) => h("option", { value: String(s.id) }, s.name))
  );
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

async function withBusy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* A small, safe Markdown renderer. It builds DOM nodes and never uses innerHTML. */
function inlineMd(text) {
  const out = [];
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
    if (!part) continue;
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) out.push(h("strong", {}, part.slice(2, -2)));
    else if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) out.push(h("code", {}, part.slice(1, -1)));
    else out.push(part);
  }
  return out;
}

function renderMd(text) {
  const root = h("div", { class: "md" });
  const lines = String(text).replace(/\r/g, "").split("\n");
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) root.append(h("p", {}, inlineMd(para.join(" "))));
    para = [];
  };
  const flushList = () => {
    if (list) root.append(h(list.tag, {}, list.items.map((t) => h("li", {}, inlineMd(t)))));
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      flushPara();
      flushList();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      root.append(h("pre", {}, h("code", {}, code.join("\n"))));
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,4})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      root.append(h(heading[1].length === 1 ? "h3" : "h4", {}, inlineMd(heading[2].trim())));
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((bullet || numbered)[1]);
    } else if (!line.trim() || /^\s*-{3,}\s*$/.test(line)) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return root;
}

/* =========================================================
   Focus timer (Pomodoro)
   ========================================================= */
const POMO_KEY = "pomo-v1";
const POMO_DEFAULTS = { focus: 25, short: 5, long: 15, every: 4 };
const POMO_LIMITS = { focus: [1, 180], short: [1, 60], long: [1, 60], every: [2, 12] };
const PHASE_LABEL = { focus: "Focus", short: "Short break", long: "Long break" };
const RING_C = 2 * Math.PI * 96;
let pomoStats = { today: { count: 0, minutes: 0 }, total: { count: 0, minutes: 0 }, recent: [] };

function fmtClock(sec) {
  return `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
}

function loadPomo() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(POMO_KEY) || "{}"); } catch (_) {}
  const cfg = { ...POMO_DEFAULTS, ...(saved.cfg || {}) };
  const phase = PHASE_LABEL[saved.phase] ? saved.phase : "focus";
  const state = {
    cfg,
    phase,
    cycle: Number(saved.cycle) || 0,
    subjectId: saved.subjectId || "",
    running: false,
    endsAt: null,
    total: Number(saved.total) || cfg[phase] * 60,
    remaining: Number.isFinite(saved.remaining) ? saved.remaining : cfg[phase] * 60,
  };
  // Resume a running timer, unless it ended long ago while the page was closed
  if (saved.running && saved.endsAt && Date.now() - saved.endsAt < 10 * 60 * 1000) {
    state.running = true;
    state.endsAt = saved.endsAt;
  } else if (saved.running) {
    state.remaining = state.total;
  }
  return state;
}
let pomo = loadPomo();

function savePomo() {
  try { localStorage.setItem(POMO_KEY, JSON.stringify(pomo)); } catch (_) {}
}

function secondsLeft() {
  return pomo.running ? Math.max(0, Math.ceil((pomo.endsAt - Date.now()) / 1000)) : pomo.remaining;
}

function setPhase(phase) {
  pomo.phase = phase;
  pomo.running = false;
  pomo.endsAt = null;
  pomo.total = pomo.cfg[phase] * 60;
  pomo.remaining = pomo.total;
  savePomo();
  renderPomo();
}

function startPomo() {
  unlockAudio();
  if (!pomo.running) {
    pomo.running = true;
    pomo.endsAt = Date.now() + pomo.remaining * 1000;
  }
  savePomo();
  renderPomo();
}

function pausePomo() {
  pomo.remaining = secondsLeft();
  pomo.running = false;
  pomo.endsAt = null;
  savePomo();
  renderPomo();
}

async function logFocus(minutes) {
  try {
    await api("/api/pomodoros", "POST", { minutes, subject_id: pomo.subjectId || null });
    refresh();
  } catch (err) {
    toast("Couldn't save this focus round: " + err.message);
  }
}

function completePhase() {
  const wasFocus = pomo.phase === "focus";
  const minutes = Math.max(1, Math.round(pomo.total / 60));
  let next = "focus";
  if (wasFocus) {
    pomo.cycle += 1;
    next = pomo.cycle % pomo.cfg.every === 0 ? "long" : "short";
    logFocus(minutes);
  }
  pomo.running = false;
  pomo.endsAt = null;
  pomo.phase = next;
  pomo.total = pomo.cfg[next] * 60;
  pomo.remaining = pomo.total;
  savePomo();
  fireReminder(
    "pomo-" + Date.now(),
    wasFocus ? "Focus round complete" : "Break is over",
    wasFocus ? `Take a ${pomo.cfg[next]} minute ${next === "long" ? "long " : ""}break.` : "Ready for your next focus round?"
  );
  renderPomo();
}

let lastTickSec = -1;
function tickPomo() {
  if (pomo.running && Date.now() >= pomo.endsAt) {
    lastTickSec = -1;
    completePhase();
    return;
  }
  // Every other change redraws the timer itself, so only redraw when the second changes
  const sec = secondsLeft();
  if (sec !== lastTickSec) {
    lastTickSec = sec;
    renderPomo();
  }
}

function renderPomo() {
  const left = secondsLeft();
  const sub = dash && dash.subjects.find((s) => String(s.id) === String(pomo.subjectId));
  const color = pomo.phase === "focus" ? (sub ? colorVar(sub.color) : "var(--s1)") : "var(--s3)";

  $("timer-time").textContent = fmtClock(left);
  $("timer-label").textContent = PHASE_LABEL[pomo.phase] + (pomo.phase === "focus" && sub ? `: ${sub.name}` : "");
  const arc = $("ring-arc");
  arc.style.setProperty("--c", color);
  arc.style.opacity = left >= pomo.total ? "0" : "1";   // no stray dot before the timer starts
  arc.style.strokeDasharray = RING_C;
  arc.style.strokeDashoffset = RING_C * (1 - (pomo.total ? (pomo.total - left) / pomo.total : 0));

  $("timer-start").textContent = pomo.running ? "Pause" : left < pomo.total ? "Resume" : "Start";
  document.querySelectorAll("#phase-tabs .chip").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.phase === pomo.phase)));

  const every = pomo.cfg.every;
  const inSet = pomo.cycle % every;
  const filled = pomo.cycle > 0 && inSet === 0 && pomo.phase === "long" ? every : inSet;
  $("cycle-dots").replaceChildren(...Array.from({ length: every }, (_, n) => h("i", { class: n < filled ? "on" : "" })));
  $("cycle-dots").setAttribute("aria-label", `${filled} of ${every} focus rounds done before the long break`);

  const mini = $("pomo-mini");
  mini.hidden = !pomo.running;
  if (pomo.running) mini.textContent = `${fmtClock(left)}  ${PHASE_LABEL[pomo.phase]}`;
  updateTitle();
}

function renderFocusStats() {
  const t = pomoStats.today;
  $("stat-today-n").textContent = t.count;
  $("stat-today-m").textContent = fmtMin(t.minutes);
  $("stat-total-m").textContent = fmtMin(pomoStats.total.minutes);
  const list = $("focus-recent");
  list.replaceChildren();
  if (!pomoStats.recent.length) {
    list.append(h("li", { class: "plain" }, "Finish a focus round and it will show up here."));
    return;
  }
  for (const r of pomoStats.recent) {
    const day = r.finished_at.slice(0, 10);
    list.append(
      h("li", {},
        h("span", { class: "t" }, day === todayISO() ? r.finished_at.slice(11, 16) : fmtDate(day, { day: "numeric", month: "short" })),
        h("i", { class: "dot", style: `background:${r.subject_id ? colorVar(r.color) : "var(--axis)"}` }),
        h("span", {}, r.subject || "No subject"),
        h("span", { class: "n" }, fmtMin(r.minutes))
      )
    );
  }
}

function renderCfgInputs() {
  for (const key of Object.keys(POMO_DEFAULTS)) $("cfg-" + key).value = pomo.cfg[key];
}

for (const key of Object.keys(POMO_DEFAULTS)) {
  $("cfg-" + key).addEventListener("change", (e) => {
    const [lo, hi] = POMO_LIMITS[key];
    let v = Math.round(Number(e.target.value));
    if (!Number.isFinite(v)) v = POMO_DEFAULTS[key];
    v = Math.min(hi, Math.max(lo, v));
    e.target.value = v;
    pomo.cfg[key] = v;
    if (!pomo.running && key === pomo.phase) {
      pomo.total = v * 60;
      pomo.remaining = pomo.total;
    }
    savePomo();
    renderPomo();
  });
}
document.querySelectorAll("#phase-tabs .chip").forEach((b) => b.addEventListener("click", () => setPhase(b.dataset.phase)));
$("timer-start").addEventListener("click", () => (pomo.running ? pausePomo() : startPomo()));
$("timer-reset").addEventListener("click", () => setPhase(pomo.phase));
$("timer-skip").addEventListener("click", () => setPhase(pomo.phase === "focus" ? "short" : "focus"));
$("timer-subject").addEventListener("change", (e) => {
  pomo.subjectId = e.target.value;
  savePomo();
  renderPomo();
});

/* =========================================================
   Flashcards
   ========================================================= */
let study = null;

function renderDecks() {
  const root = $("deck-grid");
  root.replaceChildren();
  if (!decks.length) {
    root.append(empty("No decks yet. Write your first set of cards above."));
    return;
  }
  root.append(
    ...decks.map((d) => {
      const pct = d.total ? Math.round((100 * d.known) / d.total) : 0;
      return h(
        "article",
        { class: "card deck", style: `--c:${d.subject_id ? colorVar(d.color) : "var(--axis)"}` },
        h("h3", {}, d.title),
        d.subject && h("span", { class: "meta" }, d.subject),
        h("div", { class: "meter" }, h("i", { style: `width:${pct}%;background:var(--c)` })),
        h("p", { class: "kpi-note" }, `${d.known} of ${plural(d.total, "card")} known`),
        h("div", { class: "btn-row" },
          h("button", { class: "btn", type: "button", onclick: () => openDeck(d.id) }, "Study"),
          h("button", { class: "btn ghost", type: "button", onclick: () => removeDeck(d) }, "Delete")
        )
      );
    })
  );
}

async function removeDeck(d) {
  if (!confirm(`Delete "${d.title}" and its ${plural(d.total, "card")}?`)) return;
  try {
    await api(`/api/decks/${d.id}`, "DELETE");
    toast("Deck deleted");
    refresh();
  } catch (err) {
    toast(err.message);
  }
}

function showStudy(on) {
  $("fc-library").hidden = on;
  $("fc-study").hidden = !on;
  if (on) renderStudy();
}

async function openDeck(id) {
  try {
    const deck = await api(`/api/decks/${id}`);
    if (!deck.cards.length) return toast("That deck has no cards.");
    study = { deck, order: deck.cards.map((_, i) => i), pos: Math.max(0, deck.cards.findIndex((c) => !c.known)), flipped: false };
    if (location.hash !== "#flashcards") location.hash = "#flashcards";
    showStudy(true);
  } catch (err) {
    toast(err.message);
  }
}

const currentCard = () => study.deck.cards[study.order[study.pos]];

function renderStudy() {
  const cards = study.deck.cards;
  const known = cards.filter((c) => c.known).length;
  const card = currentCard();
  $("study-title").textContent = study.deck.title;
  $("study-meta").textContent = known === cards.length ? "All cards known. Nice work." : `Card ${study.pos + 1} of ${cards.length}, ${known} known`;
  $("study-bar").style.width = Math.round((100 * known) / cards.length) + "%";
  $("card-front").textContent = card.front;
  $("card-back").textContent = card.back;
  const flip = $("flip");
  flip.classList.toggle("flipped", study.flipped);
  flip.querySelector(".front").setAttribute("aria-hidden", String(study.flipped));
  flip.querySelector(".back").setAttribute("aria-hidden", String(!study.flipped));
  flip.setAttribute("aria-label", study.flipped ? "Showing the answer. Press to see the question." : "Showing the question. Press to see the answer.");
}

function go(pos) {
  const wasFlipped = study.flipped;
  study.pos = pos;
  study.flipped = false;
  if (wasFlipped) {
    $("flip").classList.remove("flipped");   // turn back first so the next answer never shows through
    setTimeout(() => study && renderStudy(), 230);
  } else {
    renderStudy();
  }
}

function flipCard() {
  study.flipped = !study.flipped;
  renderStudy();
}

async function markCard(known) {
  const card = currentCard();
  card.known = known ? 1 : 0;
  try {
    await api(`/api/cards/${card.id}`, "PATCH", { known });
  } catch (err) {
    toast(err.message);
  }
  const n = study.order.length;
  if (study.deck.cards.every((c) => c.known)) {
    study.flipped = false;
    renderStudy();
    return toast("Deck complete. Nice work.");
  }
  for (let k = 1; k <= n; k++) {
    const idx = (study.pos + k) % n;
    if (!study.deck.cards[study.order[idx]].known) return go(idx);
  }
}

$("flip").addEventListener("click", flipCard);
$("card-known").addEventListener("click", () => markCard(true));
$("card-learning").addEventListener("click", () => markCard(false));
$("card-next").addEventListener("click", () => go((study.pos + 1) % study.order.length));
$("card-prev").addEventListener("click", () => go((study.pos - 1 + study.order.length) % study.order.length));
$("deck-shuffle").addEventListener("click", () => {
  for (let i = study.order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [study.order[i], study.order[j]] = [study.order[j], study.order[i]];
  }
  go(0);
});
$("deck-reset").addEventListener("click", async () => {
  try {
    await api(`/api/decks/${study.deck.id}/reset`, "POST");
    study.deck.cards.forEach((c) => (c.known = 0));
    go(0);
  } catch (err) {
    toast(err.message);
  }
});
$("study-exit").addEventListener("click", () => {
  study = null;
  showStudy(false);
  refresh();
});
document.addEventListener("keydown", (e) => {
  if (!study || $("fc-study").hidden || $("view-flashcards").hidden) return;
  if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
  if (e.key === " " && e.target === document.body) { e.preventDefault(); flipCard(); }
  else if (e.key === "ArrowRight") go((study.pos + 1) % study.order.length);
  else if (e.key === "ArrowLeft") go((study.pos - 1 + study.order.length) % study.order.length);
});

$("mc-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const res = await withBusy($("mc-submit"), "Saving…", () =>
      api("/api/decks/manual", "POST", {
        title: $("mc-title").value,
        subject_id: $("mc-subject").value || null,
        text: $("mc-text").value,
      })
    );
    e.target.reset();
    await refresh();
    toast(`Made ${plural(res.count, "card")}`);
    openDeck(res.deck_id);
  } catch (err) {
    toast(err.message);
  }
});

/* Called from renderAll after every data refresh */
function renderExtras() {
  fillSubjects("timer-subject", "No subject");
  if (!$("timer-subject").value && pomo.subjectId) $("timer-subject").value = pomo.subjectId;
  fillSubjects("mc-subject", "No subject");
  renderPomo();
  renderFocusStats();
  renderDecks();
}

/* =========================================================
   Theme
   ========================================================= */
function effectiveTheme() {
  return document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function updateThemeBtn() {
  $("theme-btn").textContent = effectiveTheme() === "dark" ? "Light mode" : "Dark mode";
}
$("theme-btn").addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch (_) {}
  updateThemeBtn();
});

/* =========================================================
   Router (hash based: #dashboard, #schedule, #subjects, #settings)
   ========================================================= */
const VIEWS = {
  dashboard: ["Dashboard", () => new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })],
  schedule: ["Schedule", () => "Your plan, day by day"],
  subjects: ["Subjects", () => "What you're preparing for"],
  todos: ["To-do", () => "Tasks that aren't study sessions"],
  focus: ["Focus timer", () => "Work in short, focused rounds"],
  flashcards: ["Flashcards", () => "Turn any topic into cards you can flip"],
  settings: ["Settings", () => "Study hours and reminders"],
};

function route() {
  const name = location.hash.slice(1);
  const view = VIEWS[name] ? name : "dashboard";
  for (const v of Object.keys(VIEWS)) $("view-" + v).hidden = v !== view;
  document.querySelectorAll(".nav a").forEach((a) => {
    const on = a.dataset.view === view;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("page-title").textContent = VIEWS[view][0];
  $("page-sub").textContent = VIEWS[view][1]();
  tip.hidden = true;
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

/* =========================================================
   Start
   ========================================================= */
// Min date for the exam picker is tomorrow
(() => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  $("exam_date").min = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();

updateThemeBtn();
updateNotifyUI();
route();
loadSettings();
refresh();
checkReminders();
setInterval(checkReminders, 15000);
setInterval(refresh, 5 * 60 * 1000);

renderCfgInputs();
renderPomo();

/* Tick the timer from a Web Worker. Browsers slow normal timers in background tabs to
   about once a minute, which would make a round end late while you read in another tab.
   Workers aren't slowed down. The end time is always checked against the clock, so a
   late tick can never make the timer drift. */
function startPomoTicker() {
  const fallback = () => setInterval(tickPomo, 200);
  try {
    const src = "setInterval(function () { postMessage(0); }, 200);";
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    worker.onmessage = tickPomo;
    worker.onerror = () => { worker.terminate(); fallback(); };
  } catch (_) {
    fallback();
  }
}
startPomoTicker();
document.addEventListener("visibilitychange", () => { if (!document.hidden) tickPomo(); });
