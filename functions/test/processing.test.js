
import { jest } from '@jest/globals';

// Mock Firebase services before importing the functions to be tested
jest.unstable_mockModule('firebase-admin/app', () => ({
  initializeApp: jest.fn(),
}));

const firestoreMock = {
  collection: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  get: jest.fn(() => Promise.resolve({ empty: true, docs: [] })),
  doc: jest.fn().mockReturnThis(),
  set: jest.fn(() => Promise.resolve()),
  id: 'mock_id',
};

jest.unstable_mockModule('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => firestoreMock),
  FieldValue: {
    serverTimestamp: jest.fn(),
  },
}));

const storageMock = {
  bucket: jest.fn().mockReturnThis(),
  file: jest.fn().mockReturnThis(),
  save: jest.fn(() => Promise.resolve()),
};

jest.unstable_mockModule('firebase-admin/storage', () => ({
  getStorage: jest.fn(() => storageMock),
}));

// Mock dependencies
jest.unstable_mockModule('fs', () => ({
  default: {
    readFileSync: jest.fn(),
  }
}));
jest.unstable_mockModule('jszip', () => ({
  default: {
    loadAsync: jest.fn(),
  }
}));
jest.unstable_mockModule('../hash.js', () => ({
  computeMp3Hash: jest.fn(),
}));

jest.unstable_mockModule('music-metadata', () => ({
    parseBuffer: jest.fn().mockResolvedValue({
        common: {
            title: 'Unknown Title',
            artist: 'Unknown Artist',
            track: { no: 0 }
        }
    })
}));


// Dynamic imports after mocking
const { processUploads, processSong } = await import('../processing.js');
const { computeMp3Hash } = await import('../hash.js');
const fs = (await import('fs')).default;
const JSZip = (await import('jszip')).default;
const { getFirestore } = await import('firebase-admin/firestore');
const { getStorage } = await import('firebase-admin/storage');
const { parseBuffer } = await import('music-metadata');


describe('processing.js', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('processUploads', () => {
    it('should throw an error if no file is uploaded', async () => {
      await expect(processUploads({})).rejects.toThrow('No file uploaded.');
    });

    it('should process a zip file and create a compilation', async () => {
      const mockZipBuffer = Buffer.from('zip content');
      const mockMp3Buffer = Buffer.from('mp3 content');
      fs.readFileSync.mockReturnValue(mockZipBuffer);

      const mockZip = {
        files: {
          'song1.mp3': { async: () => Promise.resolve(mockMp3Buffer), name: 'song1.mp3', dir: false },
          'song2.mp3': { async: () => Promise.resolve(mockMp3Buffer), name: 'song2.mp3', dir: false },
          'not_a_song.txt': { name: 'not_a_song.txt', dir: false },
          'a_directory/': { name: 'a_directory/', dir: true },
        },
      };
      JSZip.loadAsync.mockResolvedValue(mockZip);

      computeMp3Hash.mockResolvedValue('mock_hash');
      
      // Reset firestore mock for this test
      firestoreMock.get.mockResolvedValue({ empty: true, docs: [] });

      const result = await processUploads({ file: { filepath: 'path/to/zip' } });

      expect(result.songs).toHaveLength(2);
      expect(result.songs[0].title).toBe('Unknown Title'); // Default title
      expect(getFirestore().collection).toHaveBeenCalledWith('compilations');
      expect(getFirestore().doc).toHaveBeenCalled();
      expect(getFirestore().set).toHaveBeenCalled();
    });
  });

  describe('processSong', () => {
    it('should return existing song if hash matches', async () => {
      const mockMp3Buffer = Buffer.from('mp3 content');
      const mockZipObject = { name: 'song.mp3', async: () => Promise.resolve(mockMp3Buffer) };

      const mockExistingSong = { id: 'existing_id', title: 'Existing Song' };
      firestoreMock.get.mockResolvedValue({ empty: false, docs: [{ id: 'existing_id', data: () => mockExistingSong }] });
      
      computeMp3Hash.mockResolvedValue('existing_hash');

      const result = await processSong(mockZipObject);

      expect(result).toEqual({ id: 'existing_id', ...mockExistingSong });
      expect(getFirestore().collection).toHaveBeenCalledWith('songs');
      expect(getFirestore().where).toHaveBeenCalledWith('hash', '==', 'existing_hash');
    });

    it('should process a new song and save it', async () => {
        const mockMp3Buffer = Buffer.from('mp3 content');
        const mockZipObject = { name: 'new_song.mp3', async: () => Promise.resolve(mockMp3Buffer) };
        
        // Ensure the get() mock for the "new song" test case resolves to an empty snapshot
        firestoreMock.get.mockResolvedValue({ empty: true, docs: [] });

        computeMp3Hash.mockResolvedValue('new_hash');

        const result = await processSong(mockZipObject);

        expect(result.hash).toBe('new_hash');
        expect(result.title).toBe('Unknown Title'); // Default title
        expect(getFirestore().collection).toHaveBeenCalledWith('songs');
        expect(getFirestore().doc).toHaveBeenCalled();
        expect(getStorage().file).toHaveBeenCalledWith('songs/new_hash.mp3');
    });
  });
});
