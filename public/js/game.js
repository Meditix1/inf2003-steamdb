// =========================================================
// Game page: details (MongoDB) + library / wishlist /
// reviews (MySQL)
// =========================================================

const gameId = Number(new URLSearchParams(location.search).get("id"));

const REPORT_REASONS = ["Spam", "Offensive or abusive", "Off-topic", "Spoilers", "Other"];

let me = null;            // account summary, null when logged out
let mine = null;          // my relationship to this game (/api/me/games/:id)
let reviewPage = 1;


// ---------- Game details ----------

async function loadGame() {
    const header = document.getElementById("gameHeader");
    header.setAttribute("aria-busy", "false");

    if (!Number.isInteger(gameId) || gameId <= 0) {
        header.innerHTML = "";
        header.append(el("p", {}, "No game selected. ", el("a", { href: "/" }, "Browse games")));
        return false;
    }

    let game;
    try {
        game = await api("GET", `/api/games/${gameId}`);       // the whole MongoDB document
    } catch (err) {
        if (err.status !== 404) throw err;
        header.innerHTML = "";
        header.append(el("p", {}, "This game isn't in the catalogue. ", el("a", { href: "/" }, "Browse games")));
        return false;
    }

    document.title = `${game.name} · SteamDB`;
    header.innerHTML = "";
    header.append(
        gameImage(game, "hero-image"),
        el("div", { class: "hero-info" },
            el("h1", {}, game.name),
            game.short_description ? el("p", { class: "hero-description" }, game.short_description) : null,
            el("div", { class: "hero-meta" },
                game.release_date ? el("span", {}, `Released ${formatDate(game.release_date)}`) : null,
                el("span", {}, `${game.rating_pct}% rating`),
                el("span", { class: "game-price" }, formatPrice(game.price), game.discount ? ` (−${game.discount}%)` : "")
            ),
            el("div", { class: "chip-row" }, game.tags.slice(0, 8).map((t) =>
                el("a", { class: "chip", href: `/?tags=${encodeURIComponent(t.name)}`, title: `${t.votes} votes` }, t.name)))
        )
    );
    renderDetails(game);
    loadSimilar();
    return true;
}

function renderDetails(game) {
    const box = document.getElementById("gameDetails");
    box.innerHTML = "";

    if (game.screenshots.length) {
        box.append(el("div", { class: "screenshots", role: "list", "aria-label": "Screenshots" },
            game.screenshots.map((src, i) => el("a", { href: src, target: "_blank", rel: "noopener", role: "listitem" },
                el("img", { src, alt: `Screenshot ${i + 1}`, loading: "lazy" })))));
    }

    const platforms = [game.supports_windows && "Windows", game.supports_mac && "macOS", game.supports_linux && "Linux"].filter(Boolean);
    const rows = [
        ["Developers", game.developers.join(", ")],
        ["Publishers", game.publishers.join(", ")],
        ["Genres", game.genres.join(", ")],
        ["Platforms", platforms.join(", ")],
        ["Languages", game.supported_languages.join(", ")],
        ["Full audio", game.full_audio_languages.join(", ")],
        ["Features", game.categories.join(", ")],
        ["Age rating", game.required_age ? `${game.required_age}+` : ""],
        ["Metacritic", game.metacritic_score || ""],
        ["Average playtime", game.avg_playtime_hours ? `${game.avg_playtime_hours} h` : ""],
        ["Owners (estimate)", game.estimated_owners || ""],
        ["Achievements", game.achievements || ""],
        ["DLC", game.dlc_count || ""]
    ].filter(([, v]) => v);

    const info = el("div", { class: "panel details-grid" },
        el("dl", { class: "facts" }, rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, String(v))])),
        game.detailed_description ? el("div", {},
            el("h2", {}, "About this game"),
            el("p", { class: "about" }, game.detailed_description)) : null,
        game.tags.length > 8 ? el("div", {},
            el("h2", {}, "All tags"),
            el("div", { class: "chip-row" }, game.tags.map((t) =>
                el("a", { class: "chip", href: `/?tags=${encodeURIComponent(t.name)}` }, `${t.name} ${t.votes}`)))) : null);
    box.append(info);
}

async function loadSimilar() {
    const box = document.getElementById("similarGames");
    try {
        const data = await api("GET", `/api/games/${gameId}/similar`);
        if (!data.games.length) return;
        box.innerHTML = "";
        box.append(
            el("h2", {}, "Similar games"),
            el("p", { class: "muted small" }, `Ranked by how many of this game's top tags they share: ${data.tags.join(", ")}.`),
            el("div", { class: "games-grid" }, data.games.map((g) => el("a", { class: "game-card", href: gameUrl(g.app_id) },
                gameImage(g),
                el("div", { class: "game-info" },
                    el("h3", { class: "game-name" }, g.name),
                    el("div", { class: "game-details" }, `${g.shared} shared tags: ${g.shared_tags.slice(0, 3).join(", ")}`),
                    el("div", { class: "game-price" }, formatPrice(g.price)))))));
        box.hidden = false;
    } catch (err) {
        console.error("Similar games:", err);
    }
}


// ---------- Library / wishlist ----------

async function loadMine() {
    mine = await api("GET", `/api/me/games/${gameId}`);
    renderActions();
}

function renderActions() {
    const box = document.getElementById("actions");
    box.innerHTML = "";

    if (!mine?.loggedIn) {
        box.append(loginPrompt("Log in to add this game to your library or wishlist."));
        return;
    }

    // Library
    const libraryButton = mine.owned
        ? el("button", {
            type: "button", class: "button owned", "aria-pressed": "true",
            title: "Remove from library",
            onclick: (e) => runAction(e.currentTarget, async () => {
                await api("DELETE", `/api/library/${gameId}`);
                toast("Removed from your library");
                await loadMine();
            })
        }, "✓ In your library")
        : el("button", {
            type: "button", class: "button primary", "aria-pressed": "false",
            onclick: (e) => runAction(e.currentTarget, async () => {
                const result = await api("POST", `/api/library/${gameId}`);
                toast(result.removedFromWishlist ? "Added to your library and removed from your wishlist" : "Added to your library");
                await loadMine();
            })
        }, "+ Add to library");

    // Wishlist (hidden once owned: the API won't allow both)
    let wishlistBlock = null;
    if (!mine.owned) {
        wishlistBlock = mine.wishlist
            ? el("div", { class: "wishlist-edit" },
                el("button", {
                    type: "button", class: "button wished", "aria-pressed": "true",
                    title: "Remove from wishlist",
                    onclick: (e) => runAction(e.currentTarget, async () => {
                        await api("DELETE", `/api/wishlist/${gameId}`);
                        toast("Removed from your wishlist");
                        await loadMine();
                    })
                }, "♥ On your wishlist"),
                prioritySelect(mine.wishlist.priority, async (priority) => {
                    await api("PATCH", `/api/wishlist/${gameId}`, { priority });
                    toast("Priority updated");
                })
            )
            : el("button", {
                type: "button", class: "button", "aria-pressed": "false",
                onclick: (e) => runAction(e.currentTarget, async () => {
                    await api("POST", `/api/wishlist/${gameId}`, {});
                    toast("Added to your wishlist");
                    await loadMine();
                })
            }, "♡ Add to wishlist");
    }

    box.append(
        el("div", { class: "action-row" }, libraryButton, wishlistBlock),
        mine.ownedSince ? el("p", { class: "muted small" }, `In your library since ${formatDate(mine.ownedSince)}`) : ''
    );
}

function prioritySelect(current, onChange) {
    const select = el("select", { "aria-label": "Wishlist priority" },
        PRIORITY_LABELS.map((label, value) =>
            el("option", { value, selected: value === current }, label))
    );
    select.addEventListener("change", () =>
        runAction(select, () => onChange(Number(select.value))).catch(() => {})
    );
    return select;
}

// ---------- Reviews ----------

async function loadReviews(reset = true) {
    if (reset) reviewPage = 1;

    const sort = document.getElementById("reviewSort").value;
    const data = await api("GET", `/api/reviews/game/${gameId}?sort=${sort}&page=${reviewPage}`);

    if (reset) {
        renderSummary(data.summary);
        document.getElementById("reviewList").innerHTML = "";
    }

    const list = document.getElementById("reviewList");
    for (const review of data.reviews) list.append(renderReview(review));

    if (reset && !data.reviews.length) {
        list.append(el("p", { class: "muted" }, "No reviews yet."));
    }

    document.getElementById("moreReviews").hidden = data.reviews.length < data.pageSize;
}

function renderSummary(summary) {
    const box = document.getElementById("reviewSummary");
    box.innerHTML = "";

    if (!summary.count) return;

    const max = Math.max(...summary.distribution, 1);
    const bars = el("div", { class: "rating-bars" });

    for (let s = 5; s >= 1; s--) {
        const count = summary.distribution[s - 1];
        bars.append(el("div", { class: "rating-bar" },
            el("span", { class: "bar-label" }, `${s}★`),
            el("span", { class: "bar-track" },
                el("span", { class: "bar-fill", style: `width:${(count / max) * 100}%` })),
            el("span", { class: "bar-count" }, count)
        ));
    }

    box.append(
        el("div", { class: "rating-average" },
            el("strong", {}, summary.average.toFixed(1)),
            stars(Math.round(summary.average)),
            el("span", { class: "muted" }, `${summary.count} review${summary.count === 1 ? "" : "s"}`)
        ),
        bars
    );
}

function renderReview(review) {
    const helpful = el("button", {
        type: "button", class: "vote", "aria-pressed": String(review.my_vote === "helpful"),
        disabled: !me || review.is_mine
    }, `👍 Helpful (${review.helpful})`);

    const unhelpful = el("button", {
        type: "button", class: "vote", "aria-pressed": String(review.my_vote === "unhelpful"),
        disabled: !me || review.is_mine
    }, `👎 (${review.unhelpful})`);

    // Clicking your current vote again removes it
    async function vote(button, type) {
        const next = review.my_vote === type ? null : type;
        const result = await runAction(button, () => api("PUT", `/api/reviews/${review.review_id}/vote`, { vote: next }));
        Object.assign(review, result);
        helpful.textContent = `👍 Helpful (${result.helpful})`;
        unhelpful.textContent = `👎 (${result.unhelpful})`;
        helpful.setAttribute("aria-pressed", String(next === "helpful"));
        unhelpful.setAttribute("aria-pressed", String(next === "unhelpful"));
    }
    helpful.addEventListener("click", () => vote(helpful, "helpful").catch(() => {}));
    unhelpful.addEventListener("click", () => vote(unhelpful, "unhelpful").catch(() => {}));

    const footer = el("div", { class: "review-footer" }, helpful, unhelpful);

    if (me && !review.is_mine) footer.append(reportControl(review));

    return el("article", { class: review.is_mine ? "review mine" : "review" },
        el("header", { class: "review-header" },
            stars(review.rating),
            el("strong", {}, review.username),
            review.author_owns_game ? el("span", { class: "badge" }, "Owns this game") : null,
            review.is_mine ? el("span", { class: "badge" }, "Your review") : null,
            el("span", { class: "muted small" },
                formatDate(review.created_at),
                review.updated_at ? " (edited)" : "")
        ),
        review.body ? el("p", { class: "review-body" }, review.body) : null,
        footer
    );
}

function reportControl(review) {
    const select = el("select", { "aria-label": "Reason for reporting" },
        el("option", { value: "" }, "Report..."),
        REPORT_REASONS.map((r) => el("option", { value: r }, r))
    );

    select.addEventListener("change", () => {
        if (!select.value) return;
        runAction(select, async () => {
            await api("POST", `/api/reviews/${review.review_id}/flag`, { reason: select.value });
            select.replaceWith(el("span", { class: "muted small" }, "Reported, thanks"));
            toast("Thanks, a moderator will take a look");
        }).catch(() => { select.value = ""; });
    });

    return select;
}


// ---------- My review form ----------

function renderMyReview() {
    const box = document.getElementById("myReview");
    box.innerHTML = "";

    if (!mine?.loggedIn) {
        box.append(el("p", { class: "muted" }, el("a", { href: "/login.html" }, "Log in"), " to write a review."));
        return;
    }

    const existing = mine.review;

    // Already reviewed and not editing: show a compact notice
    if (existing && !box.dataset.editing) {
        const notice = existing.status === "active"
            ? "You've reviewed this game."
            : `A moderator has ${existing.status} your review, so others can't see it.`;

        box.append(el("div", { class: "notice" },
            el("span", {}, notice, " "),
            stars(existing.rating),
            el("button", {
                type: "button", class: "link-button",
                onclick: () => { box.dataset.editing = "1"; renderMyReview(); }
            }, "Edit"),
            el("button", {
                type: "button", class: "link-button danger",
                onclick: (e) => {
                    if (!confirmInline(e.currentTarget, "Delete your review?")) return;
                    runAction(e.currentTarget, async () => {
                        await api("DELETE", `/api/reviews/${existing.review_id}`);
                        toast("Review deleted");
                        await refreshAll();
                    }).catch(() => {});
                }
            }, "Delete")
        ));
        return;
    }

    // Write / edit form
    let rating = existing?.rating || 0;
    const picker = el("div", { class: "star-picker", role: "radiogroup", "aria-label": "Rating" });

    function drawPicker() {
        picker.innerHTML = "";
        for (let s = 1; s <= 5; s++) {
            picker.append(el("button", {
                type: "button", role: "radio", "aria-checked": String(s === rating),
                "aria-label": `${s} star${s > 1 ? "s" : ""}`,
                class: s <= rating ? "star on" : "star",
                onclick: () => { rating = s; drawPicker(); }
            }, "★"));
        }
    }
    drawPicker();

    const text = el("textarea", { rows: "4", maxlength: "8000", placeholder: "What did you think? (optional)", "aria-label": "Review text" });
    text.value = existing?.body || "";

    const form = el("form", { class: "review-form" },
        el("h3", {}, existing ? "Edit your review" : "Write a review"),
        picker,
        text,
        el("div", { class: "action-row" },
            el("button", { type: "submit", class: "button primary" }, existing ? "Save changes" : "Post review"),
            existing ? el("button", {
                type: "button", class: "button",
                onclick: () => { delete box.dataset.editing; renderMyReview(); }
            }, "Cancel") : null
        )
    );

    form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (!rating) { toast("Pick a star rating first", true); return; }

        runAction(form.querySelector("[type=submit]"), async () => {
            if (existing) {
                await api("PATCH", `/api/reviews/${existing.review_id}`, { rating, body: text.value });
                toast("Review updated");
            } else {
                await api("POST", `/api/reviews/game/${gameId}`, { rating, body: text.value });
                toast("Review posted");
            }
            delete box.dataset.editing;
            await refreshAll();
        }).catch(() => {});
    });

    box.append(form);
}

// Two-click confirm without a browser dialog: the first click arms the button
function confirmInline(button, question) {
    if (button.dataset.armed) return true;
    button.dataset.armed = "1";
    const original = button.textContent;
    button.textContent = question;
    setTimeout(() => { delete button.dataset.armed; button.textContent = original; }, 3000);
    return false;
}


// ---------- Start ----------

async function refreshAll() {
    await loadMine();
    renderMyReview();
    await loadReviews(true);
}

async function init() {
    bindHeaderSearch();
    me = await renderAccountNav();

    try {
        if (!(await loadGame())) return;
    } catch (err) {
        document.getElementById("gameHeader").textContent = "Couldn't load this game.";
        console.error(err);
    }

    document.getElementById("reviewSort").addEventListener("change", () => loadReviews(true).catch((e) => toast(e.message, true)));
    document.getElementById("moreReviews").addEventListener("click", () => {
        reviewPage += 1;
        loadReviews(false).catch((e) => toast(e.message, true));
    });

    try {
        await refreshAll();
    } catch (err) {
        toast(err.message, true);
    }
}

init();
