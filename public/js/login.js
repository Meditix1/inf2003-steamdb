// Log in, then return to the page that sent you here (?next=...) or the homepage

// Only allow paths on this site, so ?next= can't send people to another website
function nextPage() {
    const next = new URLSearchParams(location.search).get("next") || "/";
    return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

const form = document.getElementById("loginForm");
const error = document.getElementById("formError");

// Carry ?next= over to the register link too
document.getElementById("registerLink").href = `/register.html${location.search}`;

form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";

    const email = form.email.value.trim();
    const password = form.password.value;

    if (!email || !password) {
        error.textContent = "Enter your email and password.";
        return;
    }

    const button = form.querySelector("button[type=submit]");
    button.disabled = true;

    try {
        const res = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
            error.textContent = data.message || "Couldn't log in. Try again.";
            return;
        }

        location.href = nextPage();

    } catch {
        error.textContent = "Couldn't reach the server. Is it running?";
    } finally {
        button.disabled = false;
    }
});
