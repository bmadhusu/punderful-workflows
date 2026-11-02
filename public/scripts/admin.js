document.addEventListener("DOMContentLoaded", async () => {
  const list = document.getElementById("pending-list");

  async function decide(punId, approved, row) {
    const response = await fetch(`/api/admin/puns/${punId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved }),
    });
    row.querySelector(".status").textContent = response.ok
      ? approved
        ? "Approved "
        : "Rejected "
      : "Error: no workflow found for this pun";
    row.querySelectorAll("button").forEach((b) => (b.disabled = true));
  }

  const response = await fetch("/api/admin/pending");
  const { results } = await response.json();
  if (results.length === 0) {
    list.textContent = "Nothing waiting. Go submit a pun!";
    return;
  }
  for (const pun of results) {
    const row = document.createElement("div");
    row.className = "pun-box";
    const text = document.createElement("p");
    text.textContent = pun.pun;
    const approve = document.createElement("button");
    approve.textContent = "Approve";
    approve.onclick = () => decide(pun.id, true, row);
    const reject = document.createElement("button");
    reject.textContent = "Reject";
    reject.onclick = () => decide(pun.id, true, row);
    const status = document.createElement("span");
    status.className = "status";
    row.append(text, approve, reject, status);
    list.append(row);
  }
});
