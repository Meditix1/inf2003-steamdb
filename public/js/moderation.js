// =========================================================
// Moderation queue: reported reviews grouped by review
// =========================================================

const queue = document.getElementById("queue");

const ACTION_LABELS = {
    hide: "Hide review",
    remove: "Remove review",
    dismiss: "Dismiss reports",
    restore: "Make visible again"
};

const ACTION_DONE = {
    hide: "Review hidden",
    remove: "Review removed",
    dismiss: "Reports dismissed",
    restore: "Review is visible again"
};

function currentTab() {
    const tab = location.hash.slice(1);
    return ["open", "resolved", "dismissed"].includes(tab) ? tab : "open";
}

async function load() {
    const status = currentTab();

    document.querySelectorAll(".tabs a").forEach((a) => {
        const active = a.dataset.tab === status;
        a.classList.toggle("active", active);
        if (active) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
    });

    queue.innerHTML = "";
    queue.append(el("p", { class: "muted" }, "Loading..."));

    const items = await api("GET", `/api/moderation/flags?status=${status}`);

    queue.innerHTML = "";
    if (!items.length) {
        queue.append(el("div", { class: "empty-state" },
            el("p", {}, status === "open" ? "Nothing to review. All reports have been handled." : `No ${status} reports.`)));
        return;
    }

    for (const item of items) queue.append(renderItem(item, status));
}

function renderItem(item, status) {
    const actions = el("div", { class: "action-row" });

    // Which buttons make sense depends on where the report is
    const available = status === "open"
        ? ["hide", "remove", "dismiss"]
        : (item.review_status === "hidden" ? ["restore"] : []);

    for (const action of available) {
        actions.append(el("button", {
            type: "button",
            class: action === "remove" ? "button danger" : action === "dismiss" ? "button" : "button primary",
            onclick: (e) => runAction(e.currentTarget, async () => {
                await api("PATCH", `/api/moderation/reviews/${item.review_id}`, { action });
                toast(ACTION_DONE[action]);
                await Promise.all([load(), renderAccountNav()]);
            }).catch(() => {})
        }, ACTION_LABELS[action]));
    }

    const statusBadge = item.review_status === "active"
        ? null
        : el("span", { class: "badge warning" }, `Review ${item.review_status}`);

    return el("article", { class: "panel report-item" },
        el("header", { class: "review-header" },
            el("a", { href: gameUrl(item.game_id), class: "row-title" }, item.game.name),
            el("span", { class: "badge danger" }, `${item.report_count} report${item.report_count === 1 ? "" : "s"}`),
            statusBadge
        ),
        el("p", { class: "muted small" },
            `Reasons: ${item.reasons} · first reported ${formatDate(item.first_reported)}`,
            status !== "open" && item.resolved_by ? ` · handled by ${item.resolved_by} on ${formatDate(item.resolved_at)}` : ""
        ),
        el("blockquote", { class: "reported-review" },
            el("div", { class: "review-header" },
                stars(item.rating),
                el("strong", {}, item.author),
                el("span", { class: "muted small" }, formatDate(item.created_at))
            ),
            item.body ? el("p", { class: "review-body" }, item.body) : el("p", { class: "muted" }, "(No text, rating only)")
        ),
        actions
    );
}

async function init() {
    bindHeaderSearch();
    const account = await renderAccountNav();

    if (!account) {
        queue.append(loginPrompt("Log in as a moderator to see reported reviews."));
        return;
    }
    if (account.role !== "moderator" && account.role !== "admin") {
        queue.append(el("div", { class: "empty-state" }, el("p", {}, "This page is for moderators.")));
        return;
    }

    window.addEventListener("hashchange", () => load().catch((e) => toast(e.message, true)));
    await load();
}

init().catch((err) => toast(err.message, true));
