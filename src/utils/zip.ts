import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { nanoid } from 'nanoid';

export type ZipInputFile = {
  tempPath: string;
  fileName: string;
};

export type ZipEntry = {
  fileName: string;
  entryName: string;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

export type CreatedZip = {
  tempPath: string;
  sizeBytes: number;
  fileHash: string;
  entries: ZipEntry[];
};

const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const updateCrc32 = (crc: number, chunk: Buffer): number => {
  let value = crc;
  for (const byte of chunk) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
};

const dosDateTime = (date = new Date()): { date: number; time: number } => {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
};

const writeUInt16 = (value: number): Buffer => {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
};

const writeUInt32 = (value: number): Buffer => {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
};

const writeChunk = async (
  writer: ReturnType<typeof createWriteStream>,
  chunk: Buffer,
): Promise<void> => {
  if (!writer.write(chunk)) {
    await new Promise<void>((resolve, reject) => {
      writer.once('drain', resolve);
      writer.once('error', reject);
    });
  }
};

const finishWriter = async (writer: ReturnType<typeof createWriteStream>): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    writer.end(() => resolve());
    writer.once('error', reject);
  });
};

export const sanitizeZipEntryName = (fileName: string, usedNames = new Set<string>()): string => {
  const cleaned = basename(fileName)
    .replace(/[\\/]+/g, '_')
    .replace(/\.\.+/g, '.')
    .trim();
  const fallback = cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file';
  const dotIndex = fallback.lastIndexOf('.');
  const baseName = dotIndex > 0 ? fallback.slice(0, dotIndex) : fallback;
  const extension = dotIndex > 0 ? fallback.slice(dotIndex) : '';
  let candidate = fallback;
  let counter = 1;

  while (usedNames.has(candidate)) {
    candidate = `${baseName}-${counter}${extension}`;
    counter++;
  }

  usedNames.add(candidate);
  return candidate;
};

export const createZip = async (files: ZipInputFile[]): Promise<CreatedZip> => {
  const tempPath = `/tmp/teleuploader-${nanoid()}.zip`;
  const writer = createWriteStream(tempPath);
  const hasher = new Bun.CryptoHasher('sha256');
  const entries: ZipEntry[] = [];
  const usedNames = new Set<string>();
  let offset = 0;

  const writeHashed = async (chunk: Buffer): Promise<void> => {
    hasher.update(chunk);
    await writeChunk(writer, chunk);
    offset += chunk.byteLength;
  };

  try {
    for (const file of files) {
      const entryName = sanitizeZipEntryName(file.fileName, usedNames);
      const nameBuffer = Buffer.from(entryName);
      const fileStats = await stat(file.tempPath);
      const { date, time } = dosDateTime();
      const localHeaderOffset = offset;
      let crc = 0xffffffff;

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        const reader = createReadStream(file.tempPath);
        reader.on('data', (chunk: Buffer) => {
          crc = updateCrc32(crc, chunk);
          chunks.push(chunk);
        });
        reader.once('end', resolve);
        reader.once('error', reject);
      });

      const crc32 = (crc ^ 0xffffffff) >>> 0;
      const localHeader = Buffer.concat([
        writeUInt32(0x04034b50),
        writeUInt16(20),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(time),
        writeUInt16(date),
        writeUInt32(crc32),
        writeUInt32(fileStats.size),
        writeUInt32(fileStats.size),
        writeUInt16(nameBuffer.byteLength),
        writeUInt16(0),
        nameBuffer,
      ]);

      await writeHashed(localHeader);
      for (const chunk of chunks) {
        await writeHashed(chunk);
      }

      entries.push({
        fileName: file.fileName,
        entryName,
        crc32,
        compressedSize: fileStats.size,
        uncompressedSize: fileStats.size,
        localHeaderOffset,
      });
    }

    const centralDirectoryOffset = offset;
    for (const entry of entries) {
      const nameBuffer = Buffer.from(entry.entryName);
      const { date, time } = dosDateTime();
      await writeHashed(
        Buffer.concat([
          writeUInt32(0x02014b50),
          writeUInt16(20),
          writeUInt16(20),
          writeUInt16(0),
          writeUInt16(0),
          writeUInt16(time),
          writeUInt16(date),
          writeUInt32(entry.crc32),
          writeUInt32(entry.compressedSize),
          writeUInt32(entry.uncompressedSize),
          writeUInt16(nameBuffer.byteLength),
          writeUInt16(0),
          writeUInt16(0),
          writeUInt16(0),
          writeUInt16(0),
          writeUInt32(0),
          writeUInt32(entry.localHeaderOffset),
          nameBuffer,
        ]),
      );
    }

    const centralDirectorySize = offset - centralDirectoryOffset;
    await writeHashed(
      Buffer.concat([
        writeUInt32(0x06054b50),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(entries.length),
        writeUInt16(entries.length),
        writeUInt32(centralDirectorySize),
        writeUInt32(centralDirectoryOffset),
        writeUInt16(0),
      ]),
    );

    await finishWriter(writer);

    return {
      tempPath,
      sizeBytes: offset,
      fileHash: hasher.digest('hex'),
      entries,
    };
  } catch (error) {
    writer.destroy();
    throw error;
  }
};

export const extractZipEntry = async (
  zipBuffer: Buffer,
  entryName: string,
): Promise<Buffer | null> => {
  let offset = 0;

  while (offset + 30 <= zipBuffer.byteLength) {
    const signature = zipBuffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;

    const compressionMethod = zipBuffer.readUInt16LE(offset + 8);
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const fileNameLength = zipBuffer.readUInt16LE(offset + 26);
    const extraLength = zipBuffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + fileNameLength;
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    const currentName = zipBuffer.subarray(nameStart, nameEnd).toString();

    if (currentName === entryName) {
      if (compressionMethod !== 0) return null;
      return zipBuffer.subarray(dataStart, dataEnd);
    }

    offset = dataEnd;
  }

  return null;
};
