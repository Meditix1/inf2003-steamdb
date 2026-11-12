// =========================================================
// Profile: library, wishlist, collections and my reviews
// Tabs are driven by the URL hash: #library, #wishlist,
// #collections, #collections/12, #reviews
// =========================================================

const content = document.getElementById("tabContent");
const toolbar = document.getElementById("toolbar");

let me = null;


// ---------- Header and counts ----------

async function refreshSummary() {
    me = await api("GET", "/api/me/summary");

    const header = document.getElementById("profileHeader");
    header.innerHTML = "";
    header.append(
        el("h1", {}, me.username),
        el("p", { class: "muted" },
            `Member since ${formatDate(me.created_at)}`,
            me.role !== "member" && me.role !== "user" ? ` · ${me.role}` : "")
    );

    for (const key of ["library", "wishlist", "collections", "reviews"]) {
        document.getElementById(`count-${key}`).textContent = me[key];
    }
}


// ---------- Routing ----------

function route() {
    const [tab, sub] = (location.hash.slice(1) || "library").split("/");

    document.querySelectorAll(".tabs a").forEach((a) => {
        const active = a.dataset.tab === tab;
        a.classList.toggle("active", active);
        if (active) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
    });

    toolbar.innerHTML = "";
    content.innerHTML = "";
    content.append(el("p", { class: "muted" }, "Loading..."));

    const views = {
        library: showLibrary,
        wishlist: showWishlist,
        collections: sub ? () => showCollection(sub) : showCollections,
        reviews: showReviews
    };

    (views[tab] || showLibrary)().catch((err) => {
        content.innerHTML = "";
        content.append(el("p", { class: "error-text" }, err.message));
    });
}

function sortControl(options, current, onChange) {
    const select = el("select", { "aria-label": "Sort" },
        Object.entries(options).map(([value, label]) => el("option", { value, selected: value === current }, label))
    );
    select.addEventListener("change", () => onChange(select.value));
    return el("label", { class: "sort" }, "Sort ", select);
}

function emptyState(message, linkText = "Browse games", href = "/") {
    return el("div", { class: "empty-state" },
        el("p", {}, message),
        el("a", { class: "button primary", href }, linkText)
    );
}


// ---------- Library ----------

let librarySort = "recent";

async function showLibrary() {
    const data = await api("GET", `/api/library?sort=${librarySort}`);

    toolbar.innerHTML = "";
    toolbar.append(sortControl({ recent: "Recently added", name: "Name (A–Z)" }, librarySort, (v) => {
        librarySort = v;
        showLibrary();
    }));

    content.innerHTML = "";
    if (!data.games.length) {
        content.append(emptyState("Your library is empty. Add games you own from any game page."));
        return;
    }

    const grid = el("div", { class: "games-grid" });

    for (const item of data.games) {
        grid.append(el("article", { class: "game-card" },
            el("a", { href: gameUrl(item.game_id), class: "card-link" },
                gameImage(item.game),
                el("div", { class: "game-info" },
                    el("h2", { class: "game-name" }, item.game.name),
                    el("div", { class: "game-details" }, `Added ${formatDate(item.added_at)}`)
                )
            ),
            el("div", { class: "card-actions" },
                el("a", { class: "button small", href: `${gameUrl(item.game_id)}#myReview` },
                    item.reviewed ? "✓ Reviewed" : "Write review"),
                el("button", {
                    type: "button", class: "button small subtle",
                    onclick: (e) => runAction(e.currentTarget, async () => {
                        await api("DELETE", `/api/library/${item.game_id}`);
                        toast(`Removed ${item.game.name} from your library`);
                        await Promise.all([showLibrary(), refreshSummary()]);
                    }).catch(() => {})
                }, "Remove")
            )
        ));
    }

    content.append(grid);
}


// ---------- Wishlist ----------

let wishlistSort = "priority";

async function showWishlist() {
    const data = await api("GET", `/api/wishlist?sort=${wishlistSort}`);

    toolbar.innerHTML = "";
    toolbar.append(sortControl(
        { priority: "Priority", recent: "Recently added", name: "Name (A–Z)", price: "Price: low to high" },
        wishlistSort,
        (v) => { wishlistSort = v; showWishlist(); }
    ));

    content.innerHTML = "";
    if (!data.games.length) {
        content.append(emptyState("Your wishlist is empty. Add games you want from any game page."));
        return;
    }

    const list = el("div", { class: "row-list" });
    for (const item of data.games) list.append(wishlistRow(item));
    content.append(list);
}

function wishlistRow(item) {
    const priority = el("select", { "aria-label": `Priority for ${item.game.name}` },
        PRIORITY_LABELS.map((label, value) => el("option", { value, selected: value === item.priority }, label))
    );
    priority.addEventListener("change", () => runAction(priority, async () => {
        await api("PATCH", `/api/wishlist/${item.game_id}`, { priority: Number(priority.value) });
        item.priority = Number(priority.value);
        toast("Priority updated");
    }).catch(() => { priority.value = item.priority; }));

    // Notes save when you leave the box, only if they changed
    const notes = el("textarea", {
        rows: "2", maxlength: "500", placeholder: "Notes, e.g. wait for a sale",
        "aria-label": `Notes for ${item.game.name}`
    });
    notes.value = item.notes || "";
    notes.addEventListener("blur", () => {
        const value = notes.value.trim();
        if (value === (item.notes || "")) return;
        runAction(null, async () => {
            await api("PATCH", `/api/wishlist/${item.game_id}`, { notes: value });
            item.notes = value || null;
            toast("Notes saved");
        }).catch(() => {});
    });

    return el("article", { class: "row-item" },
        el("a", { href: gameUrl(item.game_id), class: "row-thumb" }, gameImage(item.game, "thumb")),
        el("div", { class: "row-main" },
            el("a", { href: gameUrl(item.game_id), class: "row-title" }, item.game.name),
            el("div", { class: "muted small" },
                [formatPrice(item.game.price), `Added ${formatDate(item.added_at)}`].filter(Boolean).join(" · ")),
            notes
        ),
        el("div", { class: "row-side" },
            priority,
            el("button", {
                type: "button", class: "button small primary",
                title: "Moves it from your wishlist to your library",
                onclick: (e) => runAction(e.currentTarget, async () => {
                    await api("POST", `/api/library/${item.game_id}`);
                    toast(`${item.game.name} moved to your library`);
                    await Promise.all([showWishlist(), refreshSummary()]);
                }).catch(() => {})
            }, "I own this"),
            el("button", {
                type: "button", class: "button small subtle",
                onclick: (e) => runAction(e.currentTarget, async () => {
                    await api("DELETE", `/api/wishlist/${item.game_id}`);
                    toast(`Removed ${item.game.name} from your wishlist`);
                    await Promise.all([showWishlist(), refreshSummary()]);
                }).catch(() => {})
            }, "Remove")
        )
    );
}


// ---------- Collections ----------

async function showCollections() {
    const collections = await api("GET", "/api/collections");

    const name = el("input", { type: "text", maxlength: "150", placeholder: "New collection name", "aria-label": "New collection name", required: true });
    const form = el("form", { class: "inline-form" }, name, el("button", { type: "submit", class: "button primary" }, "Create collection"));
    form.addEventListener("submit", (e) => {
        e.preventDefault();
        runAction(form.querySelector("button"), async () => {
            const created = await api("POST", "/api/collections", { name: name.value });
            toast(`Created ${created.name}`);
            await refreshSummary();
            location.hash = `collections/${created.collection_id}`;
        }).catch(() => {});
    });

    toolbar.innerHTML = "";
    toolbar.append(form);

    content.innerHTML = "";
    if (!collections.length) {
        content.append(el("div", { class: "empty-state" },
            el("p", {}, "Collections are your own lists, like “Cozy weekend games” or “Play with friends”. Create one above, then open it to add games.")));
        return;
    }

    const grid = el("div", { class: "collection-grid" });
    for (const c of collections) {
        const covers = el("div", { class: "covers" });
        for (const src of c.covers) covers.append(el("img", { src, alt: "", loading: "lazy" }));
        for (let i = c.covers.length; i < 4; i++) covers.append(el("span", { class: "cover-blank" }));

        grid.append(el("a", { href: `#collections/${c.collection_id}`, class: "collection-tile" },
            covers,
            el("strong", {}, c.name),
            el("span", { class: "muted small" }, `${c.game_count} game${c.game_count === 1 ? "" : "s"}`)
        ));
    }
    content.append(grid);
}

function collectionGameAdder(collection) {
    const input = el("input", {
        type: "text", placeholder: "Search games to add", required: true,
        "aria-label": "Search games to add"
    });
    const searchButton = el("button", { type: "submit", class: "button" }, "Search");
    const searchForm = el("form", { class: "inline-form" }, input, searchButton);
    const results = el("div", {}, el("p", { class: "muted", role: "status" }, "Search the catalogue by game name."));
    const existing = new Set(collection.games.map((game) => Number(game.game_id)));

    searchForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const search = input.value.trim();
        if (!search) { toast("Enter a game name.", true); return; }

        runAction(searchButton, async () => {
            const data = await api("GET", `/api/games?search=${encodeURIComponent(search)}&limit=20`);
            const games = (data.games || []).filter((game) => !existing.has(Number(game.app_id)));
            results.innerHTML = "";
            if (!games.length) {
                results.append(el("p", { class: "muted", role: "status" }, "No new games found. Try another name."));
                return;
            }

            const select = el("select", { "aria-label": "Game to add", required: true },
                el("option", { value: "" }, "Choose a game"),
                games.map((game) => el("option", { value: game.app_id }, game.name))
            );
            const addButton = el("button", { type: "submit", class: "button primary" }, "Add to collection");
            const addForm = el("form", { class: "inline-form" }, select, addButton);
            addForm.addEventListener("submit", (addEvent) => {
                addEvent.preventDefault();
                if (!select.value) return;
                runAction(addButton, async () => {
                    await api("POST", `/api/collections/${collection.collection_id}/games`, { gameId: Number(select.value) });
                    toast(`Added to ${collection.name}`);
                    await showCollection(collection.collection_id);
                }).catch(() => {});
            });
            results.append(
                el("p", { class: "muted", role: "status" }, "Choose a game below. Refine your search if it isn't listed."),
                addForm
            );
        }).catch(() => {});
    });

    return el("section", { class: "panel collection-game-adder", "aria-label": "Add games to collection" },
        el("h2", {}, "Add games"), searchForm, results
    );
}

async function showCollection(collectionId) {
    const collection = await api("GET", `/api/collections/${collectionId}`);

    toolbar.innerHTML = "";
    toolbar.append(el("a", { href: "#collections", class: "link-button" }, "← All collections"));

    // Rename
    const title = el("input", { type: "text", class: "title-input", maxlength: "150", "aria-label": "Collection name" });
    title.value = collection.name;
    title.addEventListener("change", () => runAction(title, async () => {
        await api("PATCH", `/api/collections/${collectionId}`, { name: title.value });
        collection.name = title.value.trim();
        toast("Renamed");
    }).catch(() => { title.value = collection.name; }));

    const del = el("button", {
        type: "button", class: "button small subtle danger",
        onclick: (e) => {
            const b = e.currentTarget;
            if (!b.dataset.armed) {
                b.dataset.armed = "1";
                b.textContent = "Click again to delete";
                setTimeout(() => { delete b.dataset.armed; b.textContent = "Delete collection"; }, 3000);
                return;
            }
            runAction(b, async () => {
                await api("DELETE", `/api/collections/${collectionId}`);
                toast(`Deleted ${collection.name}`);
                await refreshSummary();
                location.hash = "collections";
            }).catch(() => {});
        }
    }, "Delete collection");

    content.innerHTML = "";
    content.append(el("div", { class: "section-heading" }, title, del));
    content.append(collectionGameAdder(collection));

    if (!collection.games.length) {
        content.append(el("p", { class: "muted" }, "This collection is empty. Use the search above to add games."));
        return;
    }

    const order = collection.games.map((g) => g.game_id);
    const list = el("ol", { class: "row-list ordered" });

    async function move(index, delta) {
        const target = index + delta;
        if (target < 0 || target >= order.length) return;
        [order[index], order[target]] = [order[target], order[index]];
        await api("PUT", `/api/collections/${collectionId}/order`, { gameIds: order });
        await showCollection(collectionId);
        // keep keyboard focus on the moved game's arrow
        const moved = content.querySelector(`[data-game="${order[target]}"] .move-${delta < 0 ? "up" : "down"}`);
        (moved && !moved.disabled ? moved : content.querySelector(`[data-game="${order[target]}"] button`))?.focus();
    }

    collection.games.forEach((item, index) => {
        list.append(el("li", { class: "row-item", "data-game": item.game_id },
            el("div", { class: "reorder" },
                el("button", {
                    type: "button", class: "icon-button move-up", disabled: index === 0,
                    "aria-label": `Move ${item.game.name} up`,
                    onclick: (e) => runAction(e.currentTarget, () => move(index, -1)).catch(() => {})
                }, "▲"),
                el("button", {
                    type: "button", class: "icon-button move-down", disabled: index === collection.games.length - 1,
                    "aria-label": `Move ${item.game.name} down`,
                    onclick: (e) => runAction(e.currentTarget, () => move(index, 1)).catch(() => {})
                }, "▼")
            ),
            el("a", { href: gameUrl(item.game_id), class: "row-thumb" }, gameImage(item.game, "thumb")),
            el("div", { class: "row-main" },
                el("a", { href: gameUrl(item.game_id), class: "row-title" }, item.game.name),
                el("div", { class: "muted small" }, `Added ${formatDate(item.added_at)}`)
            ),
            el("div", { class: "row-side" },
                el("button", {
                    type: "button", class: "button small subtle",
                    onclick: (e) => runAction(e.currentTarget, async () => {
                        await api("DELETE", `/api/collections/${collectionId}/games/${item.game_id}`);
                        toast(`Removed ${item.game.name}`);
                        await showCollection(collectionId);
                    }).catch(() => {})
                }, "Remove")
            )
        ));
    });

    content.append(list);
}


// ---------- My reviews ----------

async function showReviews() {
    const reviews = await api("GET", "/api/reviews/mine");

    content.innerHTML = "";
    if (!reviews.length) {
        content.append(emptyState("You haven't reviewed any games yet."));
        return;
    }

    const list = el("div", { class: "review-list" });
    for (const r of reviews) {
        list.append(el("article", { class: "review with-game" },
            el("a", { href: gameUrl(r.game_id), class: "row-thumb" }, gameImage(r.game, "thumb")),
            el("div", {},
                el("header", { class: "review-header" },
                    el("a", { href: gameUrl(r.game_id), class: "row-title" }, r.game.name),
                    stars(r.rating),
                    r.status !== "active"
                        ? el("span", { class: "badge warning" }, r.status === "hidden" ? "Hidden by a moderator" : "Removed by a moderator")
                        : null,
                    el("span", { class: "muted small" }, formatDate(r.created_at), r.updated_at ? " (edited)" : "")
                ),
                r.body ? el("p", { class: "review-body" }, r.body) : null,
                el("div", { class: "review-footer" },
                    el("span", { class: "muted small" }, `👍 ${r.helpful} · 👎 ${r.unhelpful}`),
                    el("a", { class: "link-button", href: `${gameUrl(r.game_id)}#myReview` }, "Edit")
                )
            )
        ));
    }
    content.append(list);
}


// ---------- Start ----------

async function init() {
    bindHeaderSearch();
    const account = await renderAccountNav();

    if (!account) {
        document.querySelector(".tabs").hidden = true;
        content.innerHTML = "";
        content.append(loginPrompt("Log in to see your library, wishlist and collections."));
        return;
    }

    await refreshSummary();
    window.addEventListener("hashchange", route);
    route();
}

init().catch((err) => toast(err.message, true));
