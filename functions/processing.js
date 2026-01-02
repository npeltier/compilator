
import fs from 'fs';
import JSZip from 'jszip';

import admin from 'firebase-admin';
import { getStorage } from 'firebase-admin/storage';
import { getFirestore } from 'firebase-admin/firestore';

import { computeMp3Hash, getStorePath } from './hash.js';
import { parseBuffer } from 'music-metadata';


function safeName(str) {
    return str.toLowerCase()
              .replace(/\s+/g, "_")
              .replace(/[^a-z0-9_-]/g, "");
};
/**
 * Processes the uploaded zip files.
 * @param {Object<string, {filepath: string}>} uploads An object containing uploaded file info.
 * @returns {Promise<any>} A promise that resolves with the compilation data.
 */
export async function processCompilation(compilationRequest) {
  const db = getFirestore();
  
  const zipBuffer = fs.readFileSync(compilationRequest.filepath);
  const jszip = await JSZip.loadAsync(zipBuffer);

  const songPromises = [];
  for (const filename in jszip.files) {
    if (jszip.files[filename].dir || !filename.toLowerCase().endsWith('.mp3')) {
      continue;
    }
    songPromises.push(processSong(jszip.files[filename]));
  }

  const songs = await Promise.all(songPromises);

  // Filter out any null results (e.g., from parsing errors)
  const validSongs = songs.filter(song => song !== null);

  // Order songs by track number
  validSongs.sort((a, b) => a.track - b.track);

  const title = validSongs[0].album || filename.split('/').split('.zip')[0];
  const author = validSongs[0].author || compilationRequest.author || 'Unknown Author';
  const authorsRef = db.collection('authors').doc(safeName(author));

  const compilationId = safeName(title);
  const compilationRef = db.collection('compilations').doc(compilationId);

  await compilationRef.set({
    title,
    author: authorsRef,
    importDate: admin.firestore.FieldValue.serverTimestamp(),
    songs: validSongs.map(song => song.id),
  });

  return { id: compilationId, songs: validSongs };
}

/**
 * Processes a single MP3 file from the zip.
 * @param {import('jszip').JSZipObject} zipObject The JSZip object for the file.
 * @returns {Promise<any>} A promise that resolves with the song data or null.
 */
export async function processSong(zipObject) {
  const db = getFirestore();
  const storage = getStorage();
  const bucket = storage.bucket();

  try {
    const fileBuffer = await zipObject.async('nodebuffer');
    const hash = await computeMp3Hash(fileBuffer);

    const songsRef = db.collection('songs');
    const query = songsRef.where('hash', '==', hash);
    const snapshot = await query.get();

    if (!snapshot.empty) {
      console.log(`Song with hash ${hash} already exists.`);
      const existingSong = snapshot.docs[0];
      return { id: existingSong.id, ...existingSong.data() };
    }

    console.log(`New song with hash ${hash}. Processing...`);
    const metadata = await parseBuffer(fileBuffer, 'audio/mpeg');
    const { duration } = metadata.format;
    const { album, artist, year, title, track } = metadata.common;

    const storagePath = getStorePath(hash);
    await bucket.file(storagePath).save(fileBuffer, {
      metadata: {
        contentType: 'audio/mpeg',
      },
    });
    console.log(`Uploaded ${storagePath} to Cloud Storage.`);

    const songRef = songsRef.doc();
    const newSong = {
      album,
      artist,
      duration,
      hash,
      importDate: admin.firestore.FieldValue.serverTimestamp(),      
      title,    
      track,
      year,   
    };

    await songRef.set(newSong);
    console.log(`Saved new song metadata to Firestore with ID: ${songRef.id}`);

    return { id: songRef.id, ...newSong };
  } catch (error) {
    console.error(`Error processing song ${zipObject.name}:`, error);
    return null; // Return null to indicate failure for this song
  }
}
