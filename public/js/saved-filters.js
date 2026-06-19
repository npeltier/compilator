// Per-user saved filter presets for the home view.
//
// Data model: /users/{emailLower}/savedFilters/{id}
//   { name, inc: {authors,seasons,years,emojis}, exc: {authors,seasons,years,emojis}, at }
// where every inner field is a string[] (years stored as strings too, so the
// shape is uniform). Private to the owner.
//
// One read on shell boot (small per-user subcollection); writes happen as the
// user saves or deletes a preset. Listeners are notified after each change so
// the home shuffle row re-renders in sync.

import { db } from './firebase-init.js';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';

const DIMS = ['authors', 'seasons', 'years', 'emojis'];

const cache = new Map(); // id → { id, name, inc, exc, at }
const listeners = new Set();
let userKey = null;

// Normalize a stored doc to a { id, name, inc, exc, at } with all dims present.
function fromDoc(id, data) {
  const pick = (side) => {
    const out = {};
    for (const d of DIMS) out[d] = Array.isArray(data?.[side]?.[d]) ? data[side][d] : [];
    return out;
  };
  return {
    id,
    name: data?.name || '',
    inc: pick('inc'),
    exc: pick('exc'),
    at: data?.at || null,
  };
}

export async function loadSavedFilters(email) {
  userKey = (email || '').toLowerCase();
  cache.clear();
  const snap = await getDocs(collection(db, 'users', userKey, 'savedFilters'));
  snap.forEach((d) => cache.set(d.id, fromDoc(d.id, d.data())));
}

// Oldest first, so newly saved presets append at the end of the shuffle row.
export function savedFilters() {
  return [...cache.values()].sort(
    (a, b) => (a.at?.toMillis?.() || 0) - (b.at?.toMillis?.() || 0),
  );
}

// Persist a preset. `filter` carries { name, inc, exc } where inc/exc hold
// string arrays per dimension. Returns the generated id.
export async function saveFilter(filter) {
  if (!userKey) throw new Error('saved filters not loaded');
  const id = crypto.randomUUID();
  const arr = (side) => {
    const out = {};
    for (const d of DIMS) out[d] = (filter?.[side]?.[d] || []).map(String);
    return out;
  };
  const payload = { name: filter?.name || '', inc: arr('inc'), exc: arr('exc') };
  cache.set(id, fromDoc(id, payload));
  emit(id);
  try {
    await setDoc(doc(db, 'users', userKey, 'savedFilters', id), {
      ...payload,
      at: serverTimestamp(),
    });
  } catch (err) {
    console.error('save filter', err);
  }
  return id;
}

export async function deleteSavedFilter(id) {
  if (!userKey) throw new Error('saved filters not loaded');
  cache.delete(id);
  emit(id);
  try {
    await deleteDoc(doc(db, 'users', userKey, 'savedFilters', id));
  } catch (err) {
    console.error('delete filter', err);
  }
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(id) {
  for (const fn of listeners) {
    try { fn(id); } catch (err) { console.error('saved filter listener', err); }
  }
}
