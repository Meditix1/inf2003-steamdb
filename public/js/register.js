// Create an account, log straight in, then go to ?next=... or the homepage

function nextPage() {
    const next = new URLSearchParams(location.search).get("next") || "/";
    return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

async function post(path, body) {
    const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "Something went wrong. Try again.");
    return data;
}

const form = document.getElementById("registerForm");
const error = document.getElementById("formError");

document.getElementById("loginLink").href = `/login.html${location.search}`;

form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";

    const username = form.username.value.trim();
    const email = form.email.value.trim();
    const password = form.password.value;

    // Same rules as routes/auth.js, checked here first for quicker feedback
    if (!username || !email || !password) {
        error.textContent = "Fill in every field.";
        return;
    }
    if (password.length < 8) {
        error.textContent = "Password must be at least 8 characters.";
        return;
    }
    if (password !== form.confirm.value) {
        error.textContent = "The two passwords don't match.";
        return;
    }

    const button = form.querySelector("button[type=submit]");
    button.disabled = true;

    try {
        await post("/api/auth/register", { username, email, password });
        await post("/api/auth/login", { email, password });
        location.href = nextPage();
    } catch (err) {
        error.textContent = err.message === "Failed to fetch"
            ? "Couldn't reach the server. Is it running?"
            : err.message;
    } finally {
        button.disabled = false;
    }
});
