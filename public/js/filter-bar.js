// Sticky, collapsible filter bar. Wraps one or more `.chip-row`s behind a
// toggle button that stays pinned to the top of the viewport while scrolling.
// Collapsed by default — only the toggle shows until the user opens it.

export function filterBarHTML(innerHTML) {
  return `
    <div class="filter-bar collapsed" id="filterBar">
      <button type="button" class="filter-toggle" id="filterToggle" aria-expanded="false" aria-controls="filterBody">
        <span class="filter-toggle-label">⌕ Filtres</span>
        <span class="filter-caret" aria-hidden="true">▾</span>
      </button>
      <div class="filter-body" id="filterBody">
        ${innerHTML}
      </div>
    </div>
  `;
}

export function wireFilterBar(el) {
  const bar = el.querySelector('#filterBar');
  const toggle = el.querySelector('#filterToggle');
  if (!bar || !toggle) return;
  toggle.addEventListener('click', () => {
    const collapsed = bar.classList.toggle('collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
  });
}
