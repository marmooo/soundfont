// Writes a single RIFF chunk: 4-byte type + 4-byte size (LE) + data,
// padded with one zero byte if data length is odd (the pad byte is not
// counted in the size field, matching how RiffParser.parseRiff skips it).
export function writeChunk(type: string, data: Uint8Array): Uint8Array {
  const padded = (data.length & 1) === 1;
  const result = new Uint8Array(8 + data.length + (padded ? 1 : 0));
  for (let i = 0; i < 4; i++) {
    result[i] = type.charCodeAt(i);
  }
  result[4] = data.length & 0xff;
  result[5] = (data.length >>> 8) & 0xff;
  result[6] = (data.length >>> 16) & 0xff;
  result[7] = (data.length >>> 24) & 0xff;
  result.set(data, 8);
  return result;
}

// Writes a "LIST" (or "RIFF") chunk made of a 4-byte signature followed by
// already-serialized sub-chunks.
export function writeListChunk(
  outerType: "LIST" | "RIFF",
  signature: string,
  chunks: Uint8Array[],
): Uint8Array {
  let size = 4;
  for (let i = 0; i < chunks.length; i++) {
    size += chunks[i].length;
  }
  const data = new Uint8Array(size);
  for (let i = 0; i < 4; i++) {
    data[i] = signature.charCodeAt(i);
  }
  let offset = 4;
  for (let i = 0; i < chunks.length; i++) {
    data.set(chunks[i], offset);
    offset += chunks[i].length;
  }
  return writeChunk(outerType, data);
}

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let size = 0;
  for (let i = 0; i < chunks.length; i++) {
    size += chunks[i].length;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    result.set(chunks[i], offset);
    offset += chunks[i].length;
  }
  return result;
}
