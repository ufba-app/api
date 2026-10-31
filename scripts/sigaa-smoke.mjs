#!/usr/bin/env node
/**
 * Smoke test de uso único: SIGAA real + extração por IA + validador.
 *
 * Uso (depois de `npm run build`):
 *   SIGAA_USER=... SIGAA_PASSWORD=... AI_API_KEY=... node scripts/sigaa-smoke.mjs
 *   (opcionais: AI_PROVIDER, AI_MODEL)
 *
 * Garantias: lê credenciais só do ambiente, não grava nada em disco, não imprime senha, CPF, nome,
 * matrícula nem o PDF. A saída é só um resumo (CR, divergências, contagens).
 */
import { SigaaGateway } from '../dist/src/infrastructure/sources/sigaa/sigaa-gateway.js';
import { createHistoryExtractor } from '../dist/src/infrastructure/sources/sigaa/history/create-history-extractor.js';
import { importTranscript } from '../dist/src/application/academic/import-transcript.js';

const { SIGAA_USER, SIGAA_PASSWORD } = process.env;
if (!SIGAA_USER || !SIGAA_PASSWORD || !process.env.AI_API_KEY) {
  console.error('Defina SIGAA_USER, SIGAA_PASSWORD e AI_API_KEY no ambiente.');
  process.exit(2);
}

/** Qualquer texto que vá para a saída passa por aqui: a senha nunca sai, nem por acidente. */
const safe = (text) => String(text).split(SIGAA_PASSWORD).join('***');

async function main() {
  const gateway = new SigaaGateway();
  const extractor = createHistoryExtractor(process.env);

  console.log('1/3 login no SIGAA, perfil e PDF do histórico...');
  const snapshot = await gateway.fetchSnapshot(
    {
      userId: 'smoke',
      accountKey: 'sigaa',
      credentials: { kind: 'password', username: SIGAA_USER, password: SIGAA_PASSWORD },
    },
    { transcript: true },
  );
  const p = snapshot.profile;
  console.log(
    `    perfil: matrícula ${p.registration ? 'ok' : 'ausente'}, curso ${p.program ? 'ok' : 'ausente'}, ingresso ${p.entryTerm ?? 'ausente'}`,
  );
  console.log(`    PDF: ${snapshot.transcriptPdf.length} bytes (não gravado)`);

  console.log('2/3 extração por IA...');
  const { transcript, validation, insights } = await importTranscript(
    extractor,
    snapshot.transcriptPdf,
  );

  console.log('3/3 resumo');
  const fmt = (n) => (n === null || n === undefined ? 'n/d' : Number(n).toFixed(4));
  console.log(`    linhas cursadas: ${transcript.entries.length}`);
  console.log(`    pendentes: ${transcript.pending.length} (a cursar: ${insights.pending.toTake.length}, cursando: ${insights.pending.enrolled.length})`);
  console.log(`    semestres: ${insights.trajectory.length}`);
  console.log(`    CR declarado: ${fmt(transcript.cr)} | CR recalculado: ${fmt(insights.cr)}`);
  console.log(`    carga integralizada pelas linhas: ${insights.hoursCompleted}h`);
  console.log(`    validação: ${validation.ok ? 'OK' : 'COM ERROS'}, ${validation.divergences.length} divergência(s)`);
  for (const d of validation.divergences) {
    console.log(`      [${d.severity}] ${d.code}: ${d.message}`);
  }
}

main().catch((error) => {
  const code = error && typeof error === 'object' && 'code' in error ? ` (${error.code})` : '';
  console.error(safe(`Falhou: ${error?.name ?? 'Error'}${code}: ${error?.message ?? error}`));
  process.exit(1);
});
