// =========================================================
// Shared helpers for the account pages (profile, game, moderation)
// =========================================================

// ---------- API ----------

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function api(method, path, body) {
    const res = await fetch(path, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }

    if (!res.ok) throw new ApiError(res.status, data?.message || `Request failed (${res.status})`);
    return data;
}


// ---------- DOM ----------

// el("a", { href: "/", class: "x" }, "text", childNode, ...)
function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);

    for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === "class") node.className = value;
        else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
        else if (value === true) node.setAttribute(key, "");
        else node.setAttribute(key, value);
    }

    for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

function gameImage(game, className = "game-image") {
    // No image in the catalogue: an empty block of the same size, not a broken <img>
    if (!game?.header_image) return el("span", { class: `${className} image-placeholder`, "aria-hidden": "true" });

    const img = el("img", { class: className, alt: "", loading: "lazy", src: game.header_image });
    img.addEventListener("error", () => img.replaceWith(
        el("span", { class: `${className} image-placeholder`, "aria-hidden": "true" })), { once: true });
    return img;
}

function gameUrl(appId) {
    return `/game.html?id=${encodeURIComponent(appId)}`;
}


// ---------- Formatting ----------

function formatPrice(price) {
    if (price === null || price === undefined) return "";
    const n = Number(price);
    return n === 0 ? "Free" : `$${n.toFixed(2)}`;
}

function formatDate(value) {
    if (!value) return "";
    const d = new Date(value);
    return isNaN(d) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function stars(rating) {
    const n = Math.max(0, Math.min(5, Number(rating) || 0));
    return el("span", { class: "stars", "aria-label": `${n} out of 5 stars` }, "★".repeat(n) + "☆".repeat(5 - n));
}

const PRIORITY_LABELS = ["No priority", "Low", "Medium", "High"];


// ---------- Feedback ----------

let toastTimer = null;

function toast(message, isError = false) {
    let box = document.getElementById("toast");
    if (!box) {
        box = el("div", { id: "toast", role: "status", "aria-live": "polite" });
        document.body.append(box);
    }
    box.textContent = message;
    box.className = isError ? "toast show error" : "toast show";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.className = "toast"; }, 3000);
}

// Run an action from a button: disables it while working, reports errors
async function runAction(button, work) {
    if (button) button.disabled = true;
    try {
        return await work();
    } catch (err) {
        toast(err.message, true);
        throw err;
    } finally {
        if (button) button.disabled = false;
    }
}


// ---------- Header ----------

// Returns the account summary, or null when logged out
async function renderAccountNav() {
    const nav = document.getElementById("accountNav");
    let me = null;

    try {
        me = await api("GET", "/api/me/summary");
    } catch (err) {
        if (err.status !== 401) console.error(err);
    }

    nav.innerHTML = "";

    if (!me) {
        nav.append(
            el("a", { href: "/rankings.html" }, "Rankings"),
            el("a", { href: "/login.html" }, "Login"),
            el("a", { href: "/register.html" }, "Register")
        );
        return null;
    }

    nav.append(el("a", { href: "/rankings.html" }, "Rankings"));
    nav.append(el("a", { href: "/quiz.html" }, "Quiz"));
    nav.append(el("a", { href: "/profile.html#library" }, "Library"));
    nav.append(el("a", { href: "/profile.html#wishlist" }, "Wishlist"));

    if (me.role === "moderator" || me.role === "admin") {
        nav.append(el("a", { href: "/moderation.html" },
            "Moderation",
            me.open_reports ? el("span", { class: "nav-count" }, me.open_reports) : null
        ));
    }

    nav.append(
        el("a", { href: "/profile.html", class: "nav-user" }, me.username),
        el("a", { href: "/account.html" }, "Settings"),
        el("button", {
            type: "button",
            onclick: async () => {
                await fetch("/api/auth/logout", { method: "POST" });
                location.href = "/";
            }
        }, "Logout")
    );

    return me;
}

// The header search box sends you to the homepage's search
function bindHeaderSearch() {
    const form = document.getElementById("searchForm");
    if (!form) return;
    form.addEventListener("submit", (e) => {
        e.preventDefault();
        const q = document.getElementById("searchInput").value.trim();
        location.href = q ? `/?search=${encodeURIComponent(q)}` : "/";
    });
}

function loginPrompt(message) {
    const next = encodeURIComponent(location.pathname + location.search + location.hash);
    return el("div", { class: "empty-state" },
        el("p", {}, message),
        el("a", { class: "button primary", href: `/login.html?next=${next}` }, "Log in")
    );
}
