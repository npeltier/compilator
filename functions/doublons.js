function normalizeArtist(artist) {
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

/**
 * After a new song is added, recompute doublons for that song and all songs
 * that share its hash or artist, then bulk-write the results.
 */
export async function findAndUpdateDoublons(db, compilationId, songId, hash, artist) {
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

  const normalizedArtist = normalizeArtist(artist);

  // Collect all song keys that need recomputation: the new song + any that share hash or artist.
  const affected = new Set([`${compilationId}/${songId}`]);
  for (const s of allSongs) {
    if ((hash && s.hash === hash) || (normalizedArtist && normalizeArtist(s.artist) === normalizedArtist)) {
      affected.add(`${s.compilationId}/${s.id}`);
    }
  }

  const writer = db.bulkWriter();
  for (const s of allSongs) {
    if (!affected.has(`${s.compilationId}/${s.id}`)) continue;
    const { sameTrack, sameArtist } = computeDoublonsForSong(allSongs, s);
    writer.set(s.ref, { doublons: { sameTrack, sameArtist } }, { merge: true });
  }
  await writer.close();
}

/**
 * Rebuild doublons for every song in the database. Used by the one-shot script.
 */
export async function rebuildAllDoublons(db) {
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

  const writer = db.bulkWriter();
  for (const s of allSongs) {
    const { sameTrack, sameArtist } = computeDoublonsForSong(allSongs, s);
    writer.set(s.ref, { doublons: { sameTrack, sameArtist } }, { merge: true });
  }
  await writer.close();
  return allSongs.length;
}
