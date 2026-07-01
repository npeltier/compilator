// Determines which compilation slot is "current" given today's date, plus the
// phase of that slot's reminder.
//
// Each year has two slots: Été (deadline July 1) and Noël (deadline December 21).
// The reminder only opens two months before each deadline — May for Été, November
// for Noël — so nobody is nagged the moment the previous season closes. Between a
// deadline and the next reminder window, the just-closed slot stays "current" in
// the "catchup" phase so latecomers still get an "it's not too late" nudge.
//
// phase: 'reminder' (window open, before the deadline) | 'catchup' (deadline past,
// still open to stragglers).

export function nextCompilationSlot(now = new Date()) {
  const y = now.getFullYear();
  const may1 = new Date(y, 4, 1);
  const july1 = new Date(y, 6, 1);
  const nov1 = new Date(y, 10, 1);
  const dec21 = new Date(y, 11, 21);
  if (now < may1) return { season: 'noel', year: y - 1, deadline: new Date(y - 1, 11, 21), phase: 'catchup' };
  if (now < july1) return { season: 'ete', year: y, deadline: july1, phase: 'reminder' };
  if (now < nov1) return { season: 'ete', year: y, deadline: july1, phase: 'catchup' };
  if (now < dec21) return { season: 'noel', year: y, deadline: dec21, phase: 'reminder' };
  return { season: 'noel', year: y, deadline: dec21, phase: 'catchup' };
}

export function slotLabel(slot) {
  return `${slot.season === 'noel' ? '❄ Noël' : '☀ Été'} ${slot.year}`;
}

export function deadlineLabel(slot) {
  return slot.deadline.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
}
