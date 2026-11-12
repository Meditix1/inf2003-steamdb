// Recommendation quiz: questions -> answers -> preferences + recommended games

const content = document.getElementById("quizContent");
const results = document.getElementById("quizResults");

function renderQuiz(data) {
    const form = el("form", { class: "quiz" });

    data.questions.forEach((q, i) => {
        const group = el("fieldset", { class: "panel quiz-question" },
            el("legend", {}, `${i + 1}. ${q.prompt}`));
        for (const o of q.options) {
            group.append(el("label", { class: "quiz-option" },
                el("input", { type: "radio", name: `q${q.question_id}`, value: o.option_id, required: true,
                    checked: data.answers[q.question_id] === o.option_id }),
                el("span", {}, o.label)));
        }
        form.append(group);
    });

    form.append(el("button", { type: "submit", class: "button primary" },
        Object.keys(data.answers).length ? "Update my recommendations" : "See my recommendations"));

    form.addEventListener("submit", (e) => {
        e.preventDefault();
        const answers = {};
        for (const q of data.questions) {
            const picked = form.querySelector(`input[name="q${q.question_id}"]:checked`);
            if (!picked) { toast("Answer every question first", true); return; }
            answers[q.question_id] = Number(picked.value);
        }
        runAction(form.querySelector("button[type=submit]"), async () => {
            await api("POST", "/api/quiz/answers", { answers });
            await showResults(true);
        }).catch(() => {});
    });

    content.innerHTML = "";
    content.append(form);
}

async function showResults(scroll) {
    const data = await api("GET", "/api/quiz/results");
    results.innerHTML = "";
    if (!data.preferences.length) return;

    const bars = el("div", { class: "rating-bars pref-bars" });
    for (const p of data.preferences) {
        bars.append(el("div", { class: "rating-bar" },
            el("span", { class: "bar-label" }, p.genre),
            el("span", { class: "bar-track" }, el("span", { class: "bar-fill", style: `width:${p.share}%` })),
            el("span", { class: "bar-count" }, `${p.share}%`)));
    }

    const grid = el("div", { class: "games-grid" });
    for (const g of data.games) {
        grid.append(el("a", { class: "game-card", href: gameUrl(g.app_id) },
            gameImage(g),
            el("div", { class: "game-info" },
                el("h3", { class: "game-name" }, g.name),
                el("div", { class: "game-details" }, `${g.genres.slice(0, 3).join(", ")} · ${g.rating_pct}% rating`),
                el("div", { class: "game-price" }, formatPrice(g.price)))));
    }

    results.append(
        el("section", { class: "panel" }, el("h2", {}, "Your genre preferences"), bars),
        el("h2", {}, "Recommended for you"),
        data.games.length ? grid : el("p", { class: "muted" }, "No matching games found."));
    if (scroll) results.scrollIntoView({ behavior: "smooth" });
}

async function init() {
    bindHeaderSearch();
    const me = await renderAccountNav();
    if (!me) { content.innerHTML = ""; content.append(loginPrompt("Log in to take the quiz and save your recommendations.")); return; }

    const data = await api("GET", "/api/quiz");
    if (!data.questions.length) { content.textContent = "The quiz hasn't been set up yet."; return; }
    renderQuiz(data);
    if (Object.keys(data.answers).length) await showResults(false);
}

init().catch((err) => toast(err.message, true));
