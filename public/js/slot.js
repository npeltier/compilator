// Determines which compilation slot is "next" given today's date.
// Each year has two slots: Été (deadline July 1) and Noël (deadline December 21).
// After December 21 the next slot is Été of the following year.

export function nextCompilationSlot(now = new Date()) {
  const y = now.getFullYear();
  const july1 = new Date(y, 6, 1);
  const dec21 = new Date(y, 11, 21);
  if (now < july1) return { season: 'ete', year: y, deadline: july1 };
  if (now < dec21) return { season: 'noel', year: y, deadline: dec21 };
  return { season: 'ete', year: y + 1, deadline: new Date(y + 1, 6, 1) };
}

export function slotLabel(slot) {
  return `${slot.season === 'noel' ? '❄ Noël' : '☀ Été'} ${slot.year}`;
}

export function deadlineLabel(slot) {
  return slot.deadline.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
}
