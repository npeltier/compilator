
import crypto from 'crypto';
import { parseBuffer } from 'music-metadata';

/**
 * Computes a SHA256 hash of the audio data of an MP3 file buffer, excluding the ID3 tags.
 * @param {Buffer} fileBuffer The MP3 file content as a buffer.
 * @returns {Promise<string>} The hex-encoded SHA256 hash of the audio data.
 */
export async function computeMp3Hash(fileBuffer) {
  // Parse the buffer to find metadata, including the size of the ID3v2 tag.
  // Providing the MIME type helps music-metadata parse it correctly.
  const metadata = await parseBuffer(fileBuffer, 'audio/mpeg');

  // If an ID3v2 tag exists, its size will be in metadata.format.id3v2Size. Otherwise, start from the beginning.
  const tagSize = metadata?.format?.id3v2Size || 0;

  // Create a subarray of the buffer that contains only the audio data (after the tag).
  const audioData = fileBuffer.subarray(tagSize);

  // Compute the SHA256 hash of the audio data.
  const hash = crypto.createHash('sha256');
  hash.update(audioData);
  return hash.digest('hex');
}
