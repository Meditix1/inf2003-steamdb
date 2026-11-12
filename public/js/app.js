// =========================================================
// SteamDB homepage: browsing, filtering and account nav
//
// API contract this file expects:
//   GET /api/games/filters -> { genres, tags, categories, languages, years }
//   GET /api/games?<filters> -> { total, page, limit, games }
// =========================================================

const LIMIT = 24;

const state = {
    search: "",
    genre: "",          // genre_id
    tags: [],           // tag ids (game must have ALL of them)
    categories: [],     // category ids (game must have ALL of them)
    platforms: [],      // "windows" | "mac" | "linux"
    language: "",
    fullAudio: false,
    maxAge: "",
    free: false,
    year: "",
    decade: "",
    sort: "name",
    page: 1
};

const filterData = {
    genres: [],
    tags: [],
    categories: [],
    languages: [],
    years: { min: null, max: null }
};

const $ = (id) => document.getElementById(id);


// ---------- URL <-> state (so "Best of 2019" pages are linkable) ----------

function readStateFromUrl() {
    const p = new URLSearchParams(location.search);
    const list = (key) => (p.get(key) ? p.get(key).split(",").filter(Boolean) : []);

    state.search = p.get("search") || "";
    state.genre = p.get("genre") || "";
    state.tags = list("tags");
    state.categories = list("categories");
    state.platforms = list("platforms");
    state.language = p.get("language") || "";
    state.fullAudio = p.get("fullAudio") === "1";
    state.maxAge = p.get("maxAge") || "";
    state.free = p.get("free") === "1";
    state.year = p.get("year") || "";
    state.decade = p.get("decade") || "";
    state.sort = p.get("sort") || "name";
    state.page = Math.max(1, parseInt(p.get("page"), 10) || 1);
}

function buildQuery() {
    const p = new URLSearchParams();

    if (state.search) p.set("search", state.search);
    if (state.genre) p.set("genre", state.genre);
    if (state.tags.length) p.set("tags", state.tags.join(","));
    if (state.categories.length) p.set("categories", state.categories.join(","));
    if (state.platforms.length) p.set("platforms", state.platforms.join(","));
    if (state.language) p.set("language", state.language);
    if (state.language && state.fullAudio) p.set("fullAudio", "1");
    if (state.maxAge !== "") p.set("maxAge", state.maxAge);
    if (state.free) p.set("free", "1");
    if (state.year) p.set("year", state.year);
    else if (state.decade) p.set("decade", state.decade);
    if (state.sort !== "name") p.set("sort", state.sort);
    if (state.page > 1) p.set("page", state.page);

    return p;
}

function applyChange(mutator) {
    mutator();
    state.page = 1;
    refresh();
}

function refresh() {
    const qs = buildQuery().toString();
    history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
    syncControls();
    loadGames();
}


// ---------- Filter options ----------

async function loadFilters() {
    try {
        const res = await fetch("/api/games/filters");
        if (!res.ok) throw new Error(res.status);
        Object.assign(filterData, await res.json());
    } catch (err) {
        console.error("Could not load filter options:", err);
    }

    renderGenreBar();
    renderCategories();
    renderTagOptions();
    renderLanguages();
    renderEras();
}

function renderGenreBar() {
    const bar = $("genreBar");
    bar.innerHTML = "";

    bar.appendChild(makeChip("All genres", !state.genre, () =>
        applyChange(() => { state.genre = ""; })
    ));

    for (const g of filterData.genres) {
        const id = String(g.id);
        bar.appendChild(makeChip(g.name, state.genre === id, () =>
            applyChange(() => { state.genre = state.genre === id ? "" : id; })
        ));
    }
}

function renderCategories() {
    const list = $("categoryList");
    list.innerHTML = "";

    for (const c of filterData.categories) {
        const label = document.createElement("label");
        label.className = "check";

        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = String(c.id);
        box.checked = state.categories.includes(box.value);
        box.addEventListener("change", () => applyChange(() => {
            state.categories = toggle(state.categories, box.value, box.checked);
        }));

        label.append(box, " ", c.name);
        list.appendChild(label);
    }
}

function renderTagOptions() {
    const options = $("tagOptions");
    options.innerHTML = "";

    for (const t of filterData.tags) {
        const opt = document.createElement("option");
        opt.value = t.name;
        options.appendChild(opt);
    }
}

function renderSelectedTags() {
    const selected = $("selectedTags");
    selected.innerHTML = "";

    for (const id of state.tags) {
        const tag = filterData.tags.find((t) => String(t.id) === id);
        const chip = makeChip(`${tag ? tag.name : `Tag ${id}`} ×`, true, () =>
            applyChange(() => { state.tags = state.tags.filter((x) => x !== id); })
        );
        chip.setAttribute("aria-label", `Remove tag ${tag ? tag.name : id}`);
        selected.appendChild(chip);
    }

    // Quick picks: the most common tags not already selected
    const popular = $("popularTags");
    popular.innerHTML = "";

    filterData.tags
        .filter((t) => !state.tags.includes(String(t.id)))
        .slice(0, 10)
        .forEach((t) => popular.appendChild(makeChip(`+ ${t.name}`, false, () => addTag(t))));
}

function addTag(tag) {
    const id = String(tag.id);
    if (state.tags.includes(id)) return;
    applyChange(() => { state.tags = [...state.tags, id]; });
}

function renderLanguages() {
    const select = $("languageSelect");

    for (const lang of filterData.languages) {
        const opt = document.createElement("option");
        opt.value = lang;
        opt.textContent = lang;
        select.appendChild(opt);
    }
}

function renderEras() {
    const { min, max } = filterData.years || {};
    if (!min || !max) return;

    const chips = $("decadeChips");
    chips.innerHTML = "";

    for (let d = Math.floor(max / 10) * 10; d >= Math.floor(min / 10) * 10; d -= 10) {
        const value = String(d);
        chips.appendChild(makeChip(`${d}s`, state.decade === value && !state.year, () =>
            applyChange(() => {
                state.year = "";
                state.decade = state.decade === value ? "" : value;
            })
        ));
    }

    const yearSelect = $("yearSelect");
    yearSelect.length = 1;   // keep "Any year"

    for (let y = max; y >= min; y--) {
        const opt = document.createElement("option");
        opt.value = String(y);
        opt.textContent = String(y);
        yearSelect.appendChild(opt);
    }
}


// ---------- Keep controls in step with state ----------

function syncControls() {
    // Rebuild option lists first, then set values on them
    renderGenreBar();
    renderCategories();
    renderSelectedTags();
    renderEras();

    $("searchInput").value = state.search;
    $("freeOnly").checked = state.free;
    $("languageSelect").value = state.language;
    $("fullAudio").checked = state.fullAudio;
    $("fullAudio").disabled = !state.language;
    $("maxAge").value = state.maxAge;
    $("yearSelect").value = state.year;
    $("sortSelect").value = state.sort;

    document.querySelectorAll('input[name="platform"]').forEach((box) => {
        box.checked = state.platforms.includes(box.value);
    });

    updateTitle();
}

function updateTitle() {
    const genre = filterData.genres.find((g) => String(g.id) === state.genre);
    let title = "Games";

    if (state.year && state.sort === "rating") title = `Best of ${state.year}`;
    else if (state.year) title = `Games from ${state.year}`;
    else if (state.decade && state.sort === "rating") title = `Best of the ${state.decade}s`;
    else if (state.decade) title = `Games from the ${state.decade}s`;

    if (genre) title = title === "Games" ? `${genre.name} games` : `${title}: ${genre.name}`;
    if (state.free) title = title === "Games" ? "Free-to-play games" : `${title} (free)`;

    $("pageTitle").textContent = title;
    document.title = title === "Games" ? "SteamDB" : `${title} · SteamDB`;
}


// ---------- Games ----------

let gamesRequest = null;

async function loadGames() {
    gamesRequest?.abort();
    const request = new AbortController();
    gamesRequest = request;

    const loading = $("loading");
    const grid = $("gamesGrid");

    grid.replaceChildren();
    grid.setAttribute("aria-busy", "true");
    $("gameCount").textContent = "";
    $("prevPage").disabled = true;
    $("nextPage").disabled = true;
    $("pageInfo").textContent = `Loading page ${state.page}...`;
    loading.textContent = "Loading games...";
    loading.hidden = false;

    try {
        const params = buildQuery();
        params.set("limit", LIMIT);

        const res = await fetch(`/api/games?${params}`, { signal: request.signal });
        if (!res.ok) throw new Error(res.status);

        const data = await res.json();
        if (gamesRequest !== request) return;

        renderGames(data.games || []);
        renderPager(data.total || 0);

        $("gameCount").textContent = `${(data.total || 0).toLocaleString()} found`;
        loading.hidden = true;

    } catch (err) {
        if (gamesRequest !== request || err.name === "AbortError") return;

        console.error("Could not load games:", err);
        grid.innerHTML = "";
        $("gameCount").textContent = "";
        $("pageInfo").textContent = `Page ${state.page} unavailable`;
        $("prevPage").disabled = state.page <= 1;
        loading.textContent = "Couldn't load games. Is the server running?";
    } finally {
        if (gamesRequest === request) {
            grid.setAttribute("aria-busy", "false");
            gamesRequest = null;
        }
    }
}

function renderGames(games) {
    const grid = $("gamesGrid");
    grid.innerHTML = "";

    if (!games.length) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "No games match these filters. Try removing one.";
        grid.appendChild(empty);
        return;
    }

    for (const game of games) {
        const card = document.createElement("a");
        card.className = "game-card";
        card.href = `/game.html?id=${encodeURIComponent(game.app_id)}`;
        card.dataset.appId = game.app_id;

        const img = document.createElement("img");
        img.className = "game-image";
        img.loading = "lazy";
        img.alt = "";
        if (game.header_image) img.src = game.header_image;

        const info = document.createElement("div");
        info.className = "game-info";

        const name = document.createElement("h2");
        name.className = "game-name";
        name.textContent = game.name;

        const details = document.createElement("div");
        details.className = "game-details";
        details.textContent = [formatDate(game.release_date), formatRating(game)]
            .filter(Boolean)
            .join(" · ");

        const price = document.createElement("div");
        price.className = "game-price";
        price.textContent = formatPrice(game.price);

        info.append(name, details, price);
        card.append(img, info);
        grid.appendChild(card);
    }

    markOwnership(games.map((g) => g.app_id));
}

// Badge the cards the user owns or has wishlisted.
// The page of games comes from MongoDB; ownership is one MySQL query for the whole page.
async function markOwnership(ids) {
    if (!ids.length) return;
    try {
        const res = await fetch(`/api/me/status?ids=${ids.join(",")}`);
        if (!res.ok) return;
        const status = await res.json();
        if (!status.loggedIn) return;

        const badge = (ids, text, cls) => {
            for (const id of ids) {
                const card = document.querySelector(`.game-card[data-app-id="${id}"]`);
                if (!card || card.querySelector(".card-badge")) continue;
                const b = document.createElement("span");
                b.className = `card-badge ${cls}`;
                b.textContent = text;
                card.prepend(b);
            }
        };
        badge(status.library, "In library", "owned");
        badge(status.wishlist, "Wishlisted", "wished");
    } catch (err) {
        console.error("Could not load library status:", err);
    }
}

function renderPager(total) {
    const pages = Math.max(1, Math.ceil(total / LIMIT));
    $("pageInfo").textContent = `Page ${state.page} of ${pages}`;
    $("prevPage").disabled = state.page <= 1;
    $("nextPage").disabled = state.page >= pages;
}

function formatPrice(price) {
    const n = Number(price);
    if (!n) return "Free";
    return `$${n.toFixed(2)}`;
}

function formatDate(value) {
    if (!value) return "";
    const d = new Date(value);
    return isNaN(d) ? String(value) : d.toLocaleDateString(undefined, { year: "numeric", month: "short" });
}

function formatRating(game) {
    const pos = Number(game.positive) || 0;
    const neg = Number(game.negative) || 0;
    if (pos + neg === 0) return "";
    return `${Math.round((pos / (pos + neg)) * 100)}% positive`;
}


// ---------- Helpers ----------

function makeChip(text, active, onClick) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = active ? "chip active" : "chip";
    chip.setAttribute("aria-pressed", active ? "true" : "false");
    chip.textContent = text;
    chip.addEventListener("click", onClick);
    return chip;
}

function toggle(list, value, on) {
    return on ? [...new Set([...list, value])] : list.filter((x) => x !== value);
}


// ---------- Account nav ----------

async function loadAccount() {
    const nav = $("accountNav");

    try {
        const res = await fetch("/api/auth/me");
        if (!res.ok) throw new Error("logged out");

        const data = await res.json();
        const user = data.user || data;

        nav.innerHTML = "";

        const name = document.createElement("span");
        name.textContent = user.username;

        const profile = document.createElement("a");
        profile.href = "/profile.html";
        profile.textContent = "Profile";

        const logout = document.createElement("button");
        logout.type = "button";
        logout.textContent = "Logout";
        logout.addEventListener("click", async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            location.reload();
        });

        const link = (href, text) => { const a = document.createElement("a"); a.href = href; a.textContent = text; return a; };
        nav.append(link("/rankings.html", "Rankings"), link("/quiz.html", "Quiz"), name, profile, link("/account.html", "Settings"), logout);

    } catch {
        nav.innerHTML = '<a href="/rankings.html">Rankings</a><a href="/login.html">Login</a><a href="/register.html">Register</a>';
    }
}


// ---------- Wire up ----------

function bindControls() {
    $("searchForm").addEventListener("submit", (e) => {
        e.preventDefault();
        applyChange(() => { state.search = $("searchInput").value.trim(); });
    });

    $("freeOnly").addEventListener("change", (e) =>
        applyChange(() => { state.free = e.target.checked; })
    );

    document.querySelectorAll('input[name="platform"]').forEach((box) =>
        box.addEventListener("change", () => applyChange(() => {
            state.platforms = toggle(state.platforms, box.value, box.checked);
        }))
    );

    $("languageSelect").addEventListener("change", (e) => applyChange(() => {
        state.language = e.target.value;
        if (!state.language) state.fullAudio = false;
    }));

    $("fullAudio").addEventListener("change", (e) =>
        applyChange(() => { state.fullAudio = e.target.checked; })
    );

    $("maxAge").addEventListener("change", (e) =>
        applyChange(() => { state.maxAge = e.target.value; })
    );

    $("yearSelect").addEventListener("change", (e) => applyChange(() => {
        state.year = e.target.value;
        if (state.year) state.decade = "";
    }));

    $("sortSelect").addEventListener("change", (e) =>
        applyChange(() => { state.sort = e.target.value; })
    );

    $("tagInput").addEventListener("change", (e) => {
        const typed = e.target.value.trim().toLowerCase();
        const tag = filterData.tags.find((t) => t.name.toLowerCase() === typed);
        e.target.value = "";
        if (tag) addTag(tag);
    });

    $("clearFilters").addEventListener("click", () => applyChange(() => {
        Object.assign(state, {
            genre: "", tags: [], categories: [], platforms: [],
            language: "", fullAudio: false, maxAge: "", free: false,
            year: "", decade: ""
        });
    }));

    $("prevPage").addEventListener("click", () => {
        state.page = Math.max(1, state.page - 1);
        refresh();
        scrollTo({ top: 0, behavior: "smooth" });
    });

    $("nextPage").addEventListener("click", () => {
        state.page += 1;
        refresh();
        scrollTo({ top: 0, behavior: "smooth" });
    });

    $("filterToggle").addEventListener("click", () => {
        const open = document.body.classList.toggle("filters-open");
        $("filterToggle").setAttribute("aria-expanded", String(open));
    });
}


async function init() {
    readStateFromUrl();
    bindControls();
    loadAccount();
    await loadFilters();
    refresh();
}

init();
