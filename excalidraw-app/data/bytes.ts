export const bytesToBase64 = (data: ArrayBuffer | Uint8Array) => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, bytes.length);
    for (let index = offset; index < end; index++) {
      binary += String.fromCharCode(bytes[index]);
    }
  }
  return btoa(binary);
};

export const base64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};
