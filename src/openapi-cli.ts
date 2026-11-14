import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openApiJson } from './interface/web/openapi';

/** `npm run openapi`: grava o contrato em `openapi.json` na raiz do repositório. */
const out = join(__dirname, '..', '..', 'openapi.json');
writeFileSync(out, openApiJson());
console.log(`openapi.json gravado (${out})`);
