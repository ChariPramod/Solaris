(() => {
  const table = document.getElementById("task-table");
  if (!table) return;
  const search = document.getElementById("task-search");
  const model = document.getElementById("model-filter");
  const tier = document.getElementById("tier-filter");
  const rows = Array.from(table.tBodies[0].rows);
  function filter() {
    const query = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const row of rows) {
      row.hidden =
        !row.dataset.task.toLocaleLowerCase().includes(query) ||
        (model.value !== "" && row.dataset.model !== model.value) ||
        (tier.value !== "" && row.dataset.tier !== tier.value);
      if (!row.hidden) visible += 1;
    }
    document.getElementById("filter-count").textContent =
      `${visible} of ${rows.length} task rows`;
    document.getElementById("no-matches").hidden = visible !== 0;
  }
  search.addEventListener("input", filter);
  model.addEventListener("change", filter);
  tier.addEventListener("change", filter);
})();
