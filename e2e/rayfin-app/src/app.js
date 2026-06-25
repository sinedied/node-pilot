// Minimal front-end that would call the Rayfin data API. Uses the public env the
// CLI writes for the active deployment.
const apiUrl = import.meta.env?.RAYFIN_PUBLIC_API_URL ?? "/api";

async function loadTodos() {
  const list = document.getElementById("todos");
  if (!list) return;
  try {
    const res = await fetch(`${apiUrl}/rest/Todo`);
    const { value = [] } = await res.json();
    list.replaceChildren(
      ...value.map((t) => {
        const li = document.createElement("li");
        li.textContent = t.title;
        return li;
      }),
    );
  } catch {
    list.textContent = "Could not load todos.";
  }
}

loadTodos();
