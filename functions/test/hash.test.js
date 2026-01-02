import fs from "fs";
import crypto from "crypto";
import path from "path";
import {fileURLToPath} from "url";
import {jest} from "@jest/globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mock music-metadata
jest.unstable_mockModule("music-metadata", () => ({
  parseBuffer: jest.fn(),
}));

// Dynamic imports after mocking
const musicMetadata = await import("music-metadata");
const {computeMp3Hash, getStorePath} = await import("../hash.js");

describe("computeMp3Hash", () => {
  const mockId3v2Size = 128;
  const mockAudioContent = Buffer.from("fake audio data for testing");
  const mockFileBuffer = Buffer.concat([
    Buffer.alloc(mockId3v2Size), // Simulated ID3v2 tag
    mockAudioContent,
  ]);

  beforeEach(() => {
    jest.clearAllMocks();
    musicMetadata.parseBuffer.mockResolvedValue({
      format: {id3v2Size: mockId3v2Size},
    });
  });

  it("should return SHA-256 hash of audio data (no ID3v2 tags)", async () => {
    const expectedHash = crypto
        .createHash("sha256")
        .update(mockAudioContent)
        .digest("hex");

    const result = await computeMp3Hash(mockFileBuffer);

    expect(result).toBe(expectedHash);
    expect(musicMetadata.parseBuffer).toHaveBeenCalledWith(mockFileBuffer, "audio/mpeg");
  });

  it("should handle files with no ID3v2 tags (tagSize = 0)", async () => {
    musicMetadata.parseBuffer.mockResolvedValue({
      format: {id3v2Size: 0},
    });
    const fullFileBuffer = Buffer.from("audio only no tags");

    const expectedHash = crypto
        .createHash("sha256")
        .update(fullFileBuffer)
        .digest("hex");

    const result = await computeMp3Hash(fullFileBuffer);

    expect(result).toBe(expectedHash);
  });

  it("should propagate errors from music-metadata", async () => {
    const error = new Error("Invalid MP3 file");
    musicMetadata.parseBuffer.mockRejectedValue(error);

    await expect(computeMp3Hash(mockFileBuffer))
        .rejects.toThrow("Invalid MP3 file");
  });
});

describe('getStorePath', () => {
  it('should return correct storage path for given hash', () => {
    const hash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const expectedPath = 'store/ab/abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890.mp3';

    const result = getStorePath(hash);

    expect(result).toBe(expectedPath);
  });
});