function escapePdfText(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

export function createTextPdf(pageTexts: string[]): Uint8Array {
  const pageCount = pageTexts.length;
  const fontObjectId = pageCount + 3;
  const firstContentObjectId = fontObjectId + 1;
  const objects: string[] = [];

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const pageReferences = pageTexts.map((_, index) => `${index + 3} 0 R`).join(" ");
  objects[2] = `<< /Type /Pages /Kids [${pageReferences}] /Count ${pageCount} >>`;

  for (let index = 0; index < pageCount; index++) {
    const pageObjectId = index + 3;
    const contentObjectId = firstContentObjectId + index;
    objects[pageObjectId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`;

    const content = pageTexts[index] === ""
      ? ""
      : `BT /F1 12 Tf 72 720 Td (${escapePdfText(pageTexts[index])}) Tj ET`;
    objects[contentObjectId] = `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  }

  objects[fontObjectId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let objectId = 1; objectId < objects.length; objectId++) {
    offsets[objectId] = Buffer.byteLength(pdf, "latin1");
    pdf += `${objectId} 0 obj\n${objects[objectId]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += "0000000000 65535 f \n";
  for (let objectId = 1; objectId < objects.length; objectId++) {
    pdf += `${offsets[objectId].toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

const ENCRYPTED_BLANK_PDF_BASE64 =
  "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDM1YzY5Y2I1ZTA+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCA3MiA3MiBdCi9QYXJlbnQgMiAwIFIKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL1YgMgovUiAzCi9MZW5ndGggMTI4Ci9QIDQyOTQ5NjcyOTIKL0ZpbHRlciAvU3RhbmRhcmQKL08gPDBlNTIyOTI1YTNlNGU4NzRjM2NmYWNiZWY1MTFhNzNhYzRlYzJiZDg2NWRjZDNkNDYyNzYxNDkxN2FiZmQ3ZTQ+Ci9VIDxiNjIzNzAzMjY3YTBjODJlMzliYmIwMTc0YTVlODUzNDI4YmY0ZTVlNGU3NThhNDE2NDAwNGU1NmZmZmEwMTA4Pgo+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAwNTkgMDAwMDAgbiAKMDAwMDAwMDExOCAwMDAwMCBuIAowMDAwMDAwMTY3IDAwMDAwIG4gCjAwMDAwMDAyNTkgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA2Ci9Sb290IDMgMCBSCi9JbmZvIDEgMCBSCi9JRCBbIDw2NDY2NjM2MTY2MzUzNDMyMzczOTMwMzMzMjMwMzY2NDY0MzEzMTM0MzQzMTY0MzA2MjM1NjI2MTM5MzYzMTYyPiA8NjQ2NjYzNjE2NjM1MzQzMjM3MzkzMDMzMzIzMDM2NjQ2NDMxMzEzNDM0MzE2NDMwNjIzNTYyNjEzOTM2MzE2Mj4gXQovRW5jcnlwdCA1IDAgUgo+PgpzdGFydHhyZWYKNDc0CiUlRU9GCg==";

export function createEncryptedPdf(): Uint8Array {
  return new Uint8Array(Buffer.from(ENCRYPTED_BLANK_PDF_BASE64, "base64"));
}
