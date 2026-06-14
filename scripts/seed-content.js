#!/usr/bin/env node
/**
 * Seeds the local emulators with demo content: a few authors, several
 * compilations spanning seasons/years, and songs with real (sine-tone) audio so
 * playback, search, filters and likes all work end to end.
 *
 * Idempotent: compilation/song ids are deterministic, so re-running overwrites
 * rather than duplicating. Audio is generated as small mono WAV beeps (one
 * distinct pitch per song) and uploaded to /store/seed/* — the same store the
 * real pipeline uses, just under a `seed` prefix.
 *
 * Run with the emulators already up:
 *   npm run dev          # in another terminal
 *   npm run seed         # creates the allowlist/admin/login account
 *   npm run seed:content # this script
 */
import admin from 'firebase-admin';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= '127.0.0.1:9199';

admin.initializeApp({
  projectId: process.env.GCLOUD_PROJECT || 'demo-compilator',
  storageBucket: 'demo-compilator.appspot.com',
});

const db = admin.firestore();
const auth = admin.auth();
const bucket = admin.storage().bucket();
const { FieldValue, Timestamp } = admin.firestore;

const PASSWORD = 'password';

const AUTHORS = [
  { email: 'peltier.nicolas@gmail.com', name: 'Nicolas P.' },
  { email: 'celine@example.com', name: 'Céline' },
  { email: 'francois.d@example.com', name: 'François D.' },
];

// Each compilation: deterministic id, author email, season/year, and a track
// list of [title, artist]. Pitch + duration are derived per track below.
const COMPILATIONS = [
  {
    id: 'seed-ete-2024-nicolas', author: 'peltier.nicolas@gmail.com', season: 'ete', year: 2024,
    title: 'Soleil sur le périph',
    tracks: [
      ['Évidemment', 'France Gall'],
      ['Marcia Baïla', 'Les Rita Mitsouko'],
      ['Tatouage', 'Étienne Daho'],
      ['Comme un boomerang', 'Serge Gainsbourg'],
      ['Joe le taxi', 'Vanessa Paradis'],
    ],
  },
  {
    id: 'seed-noel-2023-nicolas', author: 'peltier.nicolas@gmail.com', season: 'noel', year: 2023,
    title: 'Noël au balcon',
    tracks: [
      ['Petit papa Noël', 'Tino Rossi'],
      ['Last Christmas', 'Wham!'],
      ['Vive le vent', 'Les Charlots'],
      ['Fairytale of New York', 'The Pogues'],
    ],
  },
  {
    id: 'seed-ete-2024-celine', author: 'celine@example.com', season: 'ete', year: 2024,
    title: 'Plage et transpiration',
    tracks: [
      ['Voyage voyage', 'Desireless'],
      ['Cargo de nuit', 'Axel Bauer'],
      ['Maldón', 'La Compagnie Créole'],
      ['Macumba', 'Jean-Pierre Mader'],
      ['Besoin de rien, envie de toi', 'Peter et Sloane'],
      ['Capitaine abandonné', 'Gold'],
    ],
  },
  {
    id: 'seed-noel-2024-celine', author: 'celine@example.com', season: 'noel', year: 2024,
    title: 'Boules et guirlandes',
    tracks: [
      ['All I Want for Christmas Is You', 'Mariah Carey'],
      ['Noël blanc', 'Dalida'],
      ['Driving Home for Christmas', 'Chris Rea'],
    ],
  },
  {
    id: 'seed-ete-2023-francois', author: 'francois.d@example.com', season: 'ete', year: 2023,
    title: 'Festival de poche',
    tracks: [
      ['Foule sentimentale', 'Alain Souchon'],
      ['La Tribu de Dana', 'Manau'],
      ['Alors on danse', 'Stromae'],
      ['Dernière danse', 'Indila'],
    ],
  },
  {
    id: 'seed-ete-2025-francois', author: 'francois.d@example.com', season: 'ete', year: 2025,
    title: 'Canicule mixtape',
    tracks: [
      ['Bella ciao', 'Chico & The Gypsies'],
      ['Djadja', 'Aya Nakamura'],
      ['Tout oublier', 'Angèle'],
      ['Ça va ça vient', 'Vianney'],
      ['Basique', 'Orelsan'],
    ],
  },
];

// --- audio: a short mono WAV sine tone (distinct pitch per song) ----------
function sineWav(freq, seconds, sampleRate = 16000) {
  const n = Math.floor(seconds * sampleRate);
  const dataLen = n * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  const fade = Math.min(sampleRate * 0.05, n / 2); // 50ms fade in/out, no clicks
  for (let i = 0; i < n; i++) {
    let amp = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.25;
    if (i < fade) amp *= i / fade;
    else if (i > n - fade) amp *= (n - i) / fade;
    buf.writeInt16LE(Math.round(amp * 32767), 44 + i * 2);
  }
  return buf;
}

async function ensureAuthor({ email, name }) {
  const key = email.toLowerCase();
  await db.collection('allowlist').doc(key).set({ addedBy: 'seed-content', addedAt: FieldValue.serverTimestamp() });
  try {
    await auth.getUserByEmail(key);
  } catch (err) {
    if (err.code !== 'auth/user-not-found') throw err;
    await auth.createUser({ email: key, password: PASSWORD, displayName: name, emailVerified: true });
  }
  await db.collection('users').doc(key).set({ displayName: name, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  console.log(`  author ready: ${name} <${key}>`);
}

async function seedCompilation(c, baseFreqOffset) {
  const compRef = db.collection('compilations').doc(c.id);
  const month = c.season === 'noel' ? 11 : 6; // Dec / Jul
  const createdAt = Timestamp.fromDate(new Date(c.year, month, 15));

  let total = 0;
  let order = 0;
  for (const [title, artist] of c.tracks) {
    const songId = `s${order + 1}`;
    const seconds = 3 + (order % 4); // 3–6s
    const freq = 220 + ((baseFreqOffset + order * 37) % 440); // 220–660 Hz
    const storagePath = `store/seed/${c.id}-${songId}.wav`;
    await bucket.file(storagePath).save(sineWav(freq, seconds), {
      metadata: { contentType: 'audio/wav', cacheControl: 'public, max-age=31536000' },
      resumable: false,
    });
    await compRef.collection('songs').doc(songId).set({
      storagePath,
      title,
      artist,
      album: c.id,
      duration: seconds,
      order,
      addedAt: FieldValue.serverTimestamp(),
    });
    total += seconds;
    order += 1;
  }

  await compRef.set({
    title: c.title,
    season: c.season,
    year: c.year,
    author: c.author.toLowerCase(),
    coverPath: null,
    coverSource: null,
    status: 'published',
    trackCount: c.tracks.length,
    totalDuration: total,
    createdAt,
    updatedAt: FieldValue.serverTimestamp(),
  });
  console.log(`  compilation: "${c.title}" — ${c.tracks.length} tracks (${c.season} ${c.year})`);
}

async function main() {
  console.log('Authors:');
  for (const a of AUTHORS) await ensureAuthor(a);

  console.log('Compilations:');
  let i = 0;
  for (const c of COMPILATIONS) {
    await seedCompilation(c, i * 91);
    i += 1;
  }

  const songCount = COMPILATIONS.reduce((n, c) => n + c.tracks.length, 0);
  console.log(`\nDone. Seeded ${COMPILATIONS.length} compilations / ${songCount} songs across ${AUTHORS.length} authors.`);
  console.log(`Extra authors can sign in with password "${PASSWORD}" (e.g. celine@example.com).`);
  console.log('Reload http://localhost:5050 to see them.');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
