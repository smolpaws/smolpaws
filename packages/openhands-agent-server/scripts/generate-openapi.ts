import { writeFile } from 'node:fs/promises';

import { generateOpenApiSchema } from '../src/openapi.js';

const schemaPath = process.env.SCHEMA_PATH ?? 'openapi.json';
await writeFile(schemaPath, `${JSON.stringify(generateOpenApiSchema(), null, 2)}\n`);
console.log(`Wrote ${schemaPath}`);
