// Pure, testable filter for the AssigneePicker's type-to-filter search box.
// Kept out of the component so the matching logic is unit-tested in isolation
// (no popover mount). Empty/whitespace query = match-all; match is a
// case-insensitive substring over the human-meaningful fields.

function normalize(q: string): string {
  return q.trim().toLowerCase();
}

export function filterMembers<M extends { name: string; email: string }>(
  members: M[],
  query: string,
): M[] {
  const q = normalize(query);
  if (!q) return members;
  return members.filter(
    (m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
  );
}

export function filterAgents<A extends { title: string; slug: string }>(
  agents: A[],
  query: string,
): A[] {
  const q = normalize(query);
  if (!q) return agents;
  return agents.filter(
    (a) => a.title.toLowerCase().includes(q) || a.slug.toLowerCase().includes(q),
  );
}
