
import { readFile } from 'fs/promises';
import admin from 'firebase-admin';
import { getStorage } from 'firebase-admin/storage';
import { getFirestore } from 'firebase-admin/firestore';

import { computeMp3Hash, getStorePath } from './hash.js';
import { parseBuffer } from 'music-metadata';

/**
 * Processes a single MP3 file from the zip.
 * @param {songRequest} songRequest An object containing song file info.
 * @returns {Promise<any>} A promise that resolves with the song data or null.
 */
export async function processSong(songRequest) {
  const db = getFirestore();
  const storage = getStorage();
  const bucket = storage.bucket();

  try {
    const fileBuffer = await readFile(songRequest.filepath);
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
    const { author } = songRequest;
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
      author,
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
    console.error(`Error processing song ${songRequest.filepath}:`, error);
    return null; // Return null to indicate failure for this song
  }
}
