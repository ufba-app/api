import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PdfParseTextExtractor } from './pdf-text-extractor';

/** PDF mínimo de uma página com dois trechos de texto em posições conhecidas (sem dado de ninguém). */
function tinyPdf(): Buffer {
  const content = 'BT /F1 12 Tf 72 700 Td (Curso: TESTE) Tj ET\nBT /F1 12 Tf 300 650 Td (CR: 8.5) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// O pdfjs carrega por `import()` dinâmico, que o Jest (CJS) não suporta sem `--experimental-vm-modules`. Por isso a
// extração real roda no JavaScript COMPILADO, num processo Node comum (como em produção). O CI compila antes dos testes;
// localmente o teste é pulado se `dist/` ainda não existe (rode `npm run build`).
const built = join(process.cwd(), 'dist', 'src', 'infrastructure', 'sources', 'sigaa', 'history', 'pdf-text-extractor.js');
const withBuild = existsSync(built) ? it : it.skip;

describe('PdfParseTextExtractor', () => {
  withBuild(
    'devolve cada trecho de texto com a página e a posição em que foi pintado (no build, como em produção)',
    () => {
      const script = `
        const { PdfParseTextExtractor } = require(${JSON.stringify(built)});
        new PdfParseTextExtractor().extract(Buffer.from(process.argv[1], 'base64'))
          .then((r) => { console.log(JSON.stringify(r)); process.exit(0); })
          .catch((e) => { console.error(e.message); process.exit(1); });`;
      const out = execFileSync(process.execPath, ['-e', script, tinyPdf().toString('base64')], { encoding: 'utf8', timeout: 60_000 });
      expect(JSON.parse(out)).toEqual([
        { page: 1, x: 72, y: 700, text: 'Curso: TESTE' },
        { page: 1, x: 300, y: 650, text: 'CR: 8.5' },
      ]);
    },
    90_000,
  );

  it('arquivo que não é PDF: falha (a importação vira PDF_INVALID, nunca texto lixo)', async () => {
    await expect(new PdfParseTextExtractor().extract(Buffer.from('<html>não sou um pdf</html>'))).rejects.toThrow();
  }, 30_000);
});
