// Rankings: top by genre and best of each year (MongoDB window functions),
// community rankings (MySQL RANK / DENSE_RANK over views)

const content = document.getElementById("rankingContent");
const note = document.getElementById("rankingNote");

const NOTES = {
    genres: "Top 5 games in each genre by review score (games with at least 500 positive reviews).",
    years: "Top 3 games released each year by review score (at least 200 positive reviews).",
    community: "What this site's users own, want and rate. Ties share a rank."
};

function gameRow(g, extra) {
    return el("li", { class: "rank-row" },
        el("span", { class: "rank-num" }, `#${g.rank}`),
        el("a", { href: gameUrl(g.app_id), class: "rank-thumb" }, gameImage(g, "thumb small-thumb")),
        el("a", { href: gameUrl(g.app_id), class: "row-title" }, g.name),
        el("span", { class: "muted small" }, extra));
}

function groupBlock(title, games, extra) {
    return el("section", { class: "panel rank-group" },
        el("h2", {}, title),
        el("ol", { class: "rank-list" }, games.map((g) => gameRow(g, extra(g)))));
}

async function showGenres() {
    const data = await api("GET", "/api/rankings/genres");
    content.innerHTML = "";
    const grid = el("div", { class: "rank-grid" });
    for (const g of data) grid.append(groupBlock(g.genre, g.games, (x) => `${x.rating_pct}% · ${x.reviews.toLocaleString()} reviews`));
    content.append(data.length ? grid : el("p", { class: "muted" }, "No rankings yet."));
}

async function showYears() {
    const data = await api("GET", "/api/rankings/years");
    content.innerHTML = "";
    const grid = el("div", { class: "rank-grid" });
    for (const y of data) {
        const block = groupBlock(String(y.year), y.games, (x) => `${x.rating_pct}%`);
        block.querySelector("h2").append(" ",
            el("a", { href: `/?year=${y.year}&sort=rating`, class: "link-button small" }, "see all"));
        grid.append(block);
    }
    content.append(grid);
}

async function showCommunity() {
    const d = await api("GET", "/api/rankings/community");
    content.innerHTML = "";
    const empty = (rows) => (rows.length ? null : el("p", { class: "muted" }, "Not enough activity yet."));
    const grid = el("div", { class: "rank-grid" });

    const owned = groupBlock("Most owned", d.most_owned, (x) => `${x.owners} players (${x.pct_of_players}%)`);
    const wished = groupBlock("Most wishlisted", d.most_wishlisted, (x) => `${x.wishers} wishlists`);
    const rated = groupBlock("Best rated by our users", d.best_rated, (x) => `${x.avg_rating.toFixed(1)}★ from ${x.review_count} reviews`);
    owned.append(empty(d.most_owned) || ""); wished.append(empty(d.most_wishlisted) || ""); rated.append(empty(d.best_rated) || "");

    const reviewers = el("section", { class: "panel rank-group" }, el("h2", {}, "Top reviewers"),
        el("ol", { class: "rank-list" }, d.top_reviewers.map((r) => el("li", { class: "rank-row no-thumb" },
            el("span", { class: "rank-num" }, `#${r.rank}`),
            el("strong", {}, r.username),
            el("span", { class: "muted small" }, `${r.helpful_received} helpful votes · ${r.reviews_written} reviews`)))),
        empty(d.top_reviewers) || "");

    grid.append(owned, wished, rated, reviewers);
    content.append(grid);
}

function route() {
    const tab = ["genres", "years", "community"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "genres";
    document.querySelectorAll(".tabs a").forEach((a) => {
        const on = a.dataset.tab === tab;
        a.classList.toggle("active", on);
        if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    note.textContent = NOTES[tab];
    content.innerHTML = "";
    content.append(el("p", { class: "muted" }, "Loading..."));
    ({ genres: showGenres, years: showYears, community: showCommunity })[tab]()
        .catch((err) => { content.innerHTML = ""; content.append(el("p", { class: "error-text" }, err.message)); });
}

bindHeaderSearch();
renderAccountNav();
window.addEventListener("hashchange", route);
route();
