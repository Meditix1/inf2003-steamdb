// Account settings: username/email, password, delete account

const box = document.getElementById("accountContent");

function field(label, input) {
    return el("label", { class: "field" }, el("span", {}, label), input);
}

function profileForm(user) {
    const username = el("input", { type: "text", name: "username", autocomplete: "username", maxlength: "50", required: true });
    const email = el("input", { type: "email", name: "email", autocomplete: "email", maxlength: "255", required: true });
    username.value = user.username;
    email.value = user.email;

    const form = el("form", { class: "panel stack" },
        el("h2", {}, "Profile"),
        field("Username", username),
        field("Email", email),
        el("button", { type: "submit", class: "button primary" }, "Save changes"));

    form.addEventListener("submit", (e) => {
        e.preventDefault();
        const changes = {};
        if (username.value.trim() !== user.username) changes.username = username.value;
        if (email.value.trim().toLowerCase() !== user.email) changes.email = email.value;
        if (!Object.keys(changes).length) { toast("Nothing changed"); return; }
        runAction(form.querySelector("button"), async () => {
            const updated = await api("PATCH", "/api/account", changes);
            Object.assign(user, updated);
            toast("Saved");
            await renderAccountNav();
        }).catch(() => {});
    });
    return form;
}

function passwordForm() {
    const current = el("input", { type: "password", autocomplete: "current-password", required: true });
    const next = el("input", { type: "password", autocomplete: "new-password", minlength: "8", required: true });
    const confirm = el("input", { type: "password", autocomplete: "new-password", required: true });

    const form = el("form", { class: "panel stack" },
        el("h2", {}, "Password"),
        field("Current password", current),
        field("New password (at least 8 characters)", next),
        field("Confirm new password", confirm),
        el("button", { type: "submit", class: "button primary" }, "Change password"));

    form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (next.value.length < 8) { toast("New password must be at least 8 characters", true); return; }
        if (next.value !== confirm.value) { toast("The new passwords don't match", true); return; }
        runAction(form.querySelector("button"), async () => {
            await api("PUT", "/api/account/password", { currentPassword: current.value, newPassword: next.value });
            form.reset();
            toast("Password changed");
        }).catch(() => {});
    });
    return form;
}

function deleteForm() {
    const password = el("input", { type: "password", autocomplete: "current-password", required: true });
    const confirmWord = el("input", { type: "text", autocomplete: "off", required: true });

    const form = el("form", { class: "panel stack danger-zone" },
        el("h2", {}, "Delete account"),
        el("p", { class: "muted" },
            "Your library, wishlist, collections and quiz answers are deleted. Your reviews stay, shown as \"[deleted user]\". You can't undo this."),
        field("Password", password),
        field("Type DELETE to confirm", confirmWord),
        el("button", { type: "submit", class: "button danger" }, "Delete my account"));

    form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (confirmWord.value !== "DELETE") { toast("Type DELETE to confirm", true); return; }
        runAction(form.querySelector("button"), async () => {
            await api("DELETE", "/api/account", { password: password.value });
            location.href = "/";
        }).catch(() => {});
    });
    return form;
}

async function init() {
    bindHeaderSearch();
    const me = await renderAccountNav();
    box.innerHTML = "";
    if (!me) { box.append(loginPrompt("Log in to change your account settings.")); return; }

    const user = await api("GET", "/api/account");
    box.append(profileForm(user), passwordForm(), deleteForm());
}

init().catch((err) => toast(err.message, true));
