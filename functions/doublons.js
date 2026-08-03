export function normalizeArtist(artist) {
  return (artist || '').toLowerCase().trim();
}

/**
 * Pure in-memory computation of doublons for one song against the full set.
 * sameArtist excludes songs already in sameTrack.
 */
export function computeDoublonsForSong(allSongs, target) {
  const targetArtist = normalizeArtist(target.artist);
  const sameTrack = [];
  const sameTrackKeys = new Set();

  for (const s of allSongs) {
    if (s.id === target.id && s.compilationId === target.compilationId) continue;
    if (s.hash && s.hash === target.hash) {
      sameTrack.push({ compilationId: s.compilationId, songId: s.id });
      sameTrackKeys.add(`${s.compilationId}/${s.id}`);
    }
  }

  const sameArtist = [];
  if (targetArtist) {
    for (const s of allSongs) {
      if (s.id === target.id && s.compilationId === target.compilationId) continue;
      if (sameTrackKeys.has(`${s.compilationId}/${s.id}`)) continue;
      if (normalizeArtist(s.artist) === targetArtist) {
        sameArtist.push({ compilationId: s.compilationId, songId: s.id });
      }
    }
  }

  return { sameTrack, sameArtist };
}

// One snapshot of every song document in the database, flattened to the fields
// the doublon computation needs plus a ref to write back to.
async function loadAllSongs(db) {
  const snap = await db.collectionGroup('songs').get();
  const allSongs = [];
  snap.forEach((d) => {
    const parentComp = d.ref.parent.parent;
    if (!parentComp) return;
    allSongs.push({
      id: d.id,
      compilationId: parentComp.id,
      hash: d.data().hash,
      artist: d.data().artist,
      ref: d.ref,
    });
  });
  return allSongs;
}

/**
 * Recompute doublons for every song reachable from `seeds` and bulk-write them.
 *
 * A seed is `{ compilationId, songId, hashes, artist }`. `hashes` is a list so a
 * song whose binary was just replaced can pass both its old and its new hash:
 * the songs that pointed at the old one need their `sameTrack` refreshed too,
 * and they are no longer reachable from the new hash alone.
 *
 * Everything is derived from a single snapshot, so a caller adding several songs
 * at once must seed them together (or recompute the whole compilation) rather
 * than firing one call per song: concurrent calls each read a snapshot that may
 * not yet contain the others' songs, and the last write wins.
 *
 * @returns {Promise<number>} how many song docs were rewritten
 */
export async function recomputeDoublonsForSeeds(db, seeds) {
  const allSongs = await loadAllSongs(db);

  // Song keys needing recomputation: the seeds themselves + anything sharing a
  // hash or artist with one of them (their chips have to gain the new entry).
  const affected = new Set();
  for (const seed of seeds) {
    affected.add(`${seed.compilationId}/${seed.songId}`);
    const hashes = new Set((seed.hashes || []).filter(Boolean));
    const seedArtist = normalizeArtist(seed.artist);
    for (const s of allSongs) {
      if ((s.hash && hashes.has(s.hash))
          || (seedArtist && normalizeArtist(s.artist) === seedArtist)) {
        affected.add(`${s.compilationId}/${s.id}`);
      }
    }
  }

  const writer = db.bulkWriter();
  let updated = 0;
  for (const s of allSongs) {
    if (!affected.has(`${s.compilationId}/${s.id}`)) continue;
    const { sameTrack, sameArtist } = computeDoublonsForSong(allSongs, s);
    writer.set(s.ref, { doublons: { sameTrack, sameArtist } }, { merge: true });
    updated += 1;
  }
  await writer.close();
  return updated;
}

/**
 * After a new song is added, recompute doublons for that song and all songs
 * that share its hash or artist, then bulk-write the results.
 */
export async function findAndUpdateDoublons(db, compilationId, songId, hash, artist) {
  return recomputeDoublonsForSeeds(db, [{ compilationId, songId, hashes: [hash], artist }]);
}

/**
 * After a song's binary is swapped, refresh its doublons plus those of the songs
 * attached to either the old or the new hash.
 */
export async function updateDoublonsAfterReplace(db, compilationId, songId, { oldHash, newHash, artist }) {
  return recomputeDoublonsForSeeds(db, [
    { compilationId, songId, hashes: [oldHash, newHash], artist },
  ]);
}

/**
 * Recompute doublons for every song of one compilation (and every song elsewhere
 * that shares a hash or artist with them) in a single pass.
 *
 * This is what converges a compilation after a *batch* of uploads: the per-song
 * recompute each upload runs races with its siblings, so an album whose tracks
 * are doublons of one another can end up with partial chips. One call here from
 * a snapshot that contains all of them fixes the lot.
 */
export async function recomputeDoublonsForCompilation(db, compilationId) {
  const songsSnap = await db.collection('compilations').doc(compilationId).collection('songs').get();
  const seeds = songsSnap.docs.map((d) => ({
    compilationId,
    songId: d.id,
    hashes: [d.data().hash],
    artist: d.data().artist,
  }));
  if (!seeds.length) return 0;
  return recomputeDoublonsForSeeds(db, seeds);
}

/**
 * Rebuild doublons for every song in the database. Used by the one-shot script.
 */
export async function rebuildAllDoublons(db) {
  const allSongs = await loadAllSongs(db);

  const writer = db.bulkWriter();
  for (const s of allSongs) {
    const { sameTrack, sameArtist } = computeDoublonsForSong(allSongs, s);
    writer.set(s.ref, { doublons: { sameTrack, sameArtist } }, { merge: true });
  }
  await writer.close();
  return allSongs.length;
}
